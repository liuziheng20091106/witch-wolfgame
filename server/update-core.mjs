import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname, resolve, sep } from 'node:path';
import { readBody, sendJson } from './shared.mjs';

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateDownloadUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`更新源必须使用 HTTPS: ${url}`);
  return url;
}

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readDownloadBody(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('下载内容超过 8MB 上限');
  }
  if (!response.body) throw new Error('下载响应没有内容');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_DOWNLOAD_BYTES) {
      await response.body.cancel().catch(() => {});
      throw new Error('下载内容超过 8MB 上限');
    }
    chunks.push(buffer);
  }
  if (size === 0) throw new Error('下载内容为空');
  return Buffer.concat(chunks, size);
}

async function downloadOnce(initialUrl, timeoutMs, maxRedirects) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = validateDownloadUrl(initialUrl);
    for (let redirects = 0; ; redirects += 1) {
      const response = await fetch(currentUrl, { signal: controller.signal, redirect: 'manual' });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) throw new Error(`更新源重定向缺少 Location: ${currentUrl}`);
        if (redirects >= maxRedirects) throw new Error(`更新源重定向超过 ${maxRedirects} 次`);
        currentUrl = validateDownloadUrl(new URL(location, currentUrl));
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const error = new Error(`下载失败 HTTP ${response.status}: ${currentUrl}`);
        error.retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
        throw error;
      }
      return await readDownloadBody(response);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function downloadFile(url, options, expectedHash, log) {
  let lastError;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      const content = await downloadOnce(url, options.timeoutMs, options.maxRedirects);
      if (expectedHash) {
        const actual = createHash('sha256').update(content).digest('hex');
        if (actual !== expectedHash) throw new Error('SHA256 校验失败');
      }
      return content;
    } catch (error) {
      lastError = error;
      if (error.retryable === false || attempt === options.attempts) throw error;
      const delayMs = options.retryDelayMs * (2 ** (attempt - 1));
      log(`[update] 下载失败，第 ${attempt}/${options.attempts} 次，${delayMs}ms 后重试: ${error.message}`);
      await wait(delayMs);
    }
  }
  throw lastError;
}

export function getBearerToken(request) {
  const authorization = request.headers?.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
  return authorization.slice('Bearer '.length);
}

export function parseUpdateConfig(update, projectRoot, log) {
  if (!update || typeof update !== 'object') {
    log('[update] 未配置 update 段，更新接口未启用');
    return null;
  }
  const passEnv = typeof update.passEnv === 'string' ? update.passEnv : '';
  const pass = passEnv ? process.env[passEnv] : null;
  const sourceTemplate = update.source;
  const files = Array.isArray(update.files) ? update.files : [];
  const root = resolve(projectRoot ?? '.');
  const restartOnSuccess = update.restartOnSuccess !== false;
  const restartSignalPath = typeof update.restartSignalFile === 'string'
    ? resolve(root, update.restartSignalFile)
    : null;
  const downloadOptions = {
    timeoutMs: Number.isFinite(update.downloadTimeoutMs) && update.downloadTimeoutMs > 0 ? update.downloadTimeoutMs : 30_000,
    attempts: Number.isInteger(update.downloadAttempts) && update.downloadAttempts > 0 ? Math.min(update.downloadAttempts, 10) : 3,
    retryDelayMs: Number.isFinite(update.retryDelayMs) && update.retryDelayMs >= 0 ? update.retryDelayMs : 500,
    maxRedirects: Number.isInteger(update.maxRedirects) && update.maxRedirects >= 0 ? Math.min(update.maxRedirects, 10) : 5,
  };
  const validFiles = files.length > 0
    && files.every((file) => typeof file === 'string' && file.length > 0)
    && new Set(files).size === files.length;
  try {
    if (typeof sourceTemplate === 'string' && sourceTemplate.includes('{file}')) {
      validateDownloadUrl(sourceTemplate.replaceAll('{file}', 'server/gameProtocol.mjs'));
    }
    if (restartSignalPath && restartSignalPath !== root && !restartSignalPath.startsWith(root + sep)) {
      throw new Error('restartSignalFile 路径越界');
    }
  } catch (error) {
    log(`[update] 未启用：${error.message}`);
    return null;
  }
  if (!pass || typeof sourceTemplate !== 'string' || !sourceTemplate.includes('{file}') || !validFiles) {
    log('[update] 未启用：需设置 passEnv 对应环境变量、含 {file} 的 HTTPS source，以及非空且无重复的 files');
    return null;
  }
  return { pass, sourceTemplate, files, root, restartOnSuccess, restartSignalPath, downloadOptions, update };
}

export function createUpdateHandler(update, projectRoot, log = console.log) {
  const config = parseUpdateConfig(update, projectRoot, log);
  if (!config) return null;
  let updateInProgress = false;

  return async function handleUpdate(request, response) {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
    const provided = getBearerToken(request);
    if (!provided || !safeEqual(provided, config.pass)) {
      return sendJson(response, 401, { error: 'invalid_update_pass' });
    }
    if (updateInProgress) return sendJson(response, 409, { error: 'update_in_progress' });
    updateInProgress = true;

    const transactionId = `${process.pid}-${randomUUID()}`;
    const staged = [];
    try {
      try {
        await readBody(request);
      } catch { /* 请求体与更新无关 */ }

      log(`[update] 收到更新请求，共 ${config.files.length} 个文件`);
      for (const file of config.files) {
        const targetPath = resolve(config.root, file);
        if (targetPath !== config.root && !targetPath.startsWith(config.root + sep)) {
          throw new Error(`文件路径越界: ${file}`);
        }
        const encodedFile = file.split('/').map((segment) => encodeURIComponent(segment)).join('/');
        const downloadUrl = config.sourceTemplate.replaceAll('{file}', encodedFile);
        const expectedHash = typeof config.update.sha256?.[file] === 'string' ? config.update.sha256[file] : null;
        const content = await downloadFile(downloadUrl, config.downloadOptions, expectedHash, log);
        const tempPath = `${targetPath}.update-${transactionId}`;
        const backupPath = `${targetPath}.backup-${transactionId}`;
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(tempPath, content, { flag: 'wx' });
        staged.push({ file, targetPath, tempPath, backupPath, installed: false, backedUp: false });
        log(`[update] 已暂存: ${file} (${content.length} 字节)`);
      }

      const updated = [];
      for (const entry of staged) {
        await rename(entry.targetPath, entry.backupPath);
        entry.backedUp = true;
        try {
          await rename(entry.tempPath, entry.targetPath);
          entry.installed = true;
          updated.push(entry.file);
          log(`[update] 已替换: ${entry.file}`);
        } catch (error) {
          await rename(entry.backupPath, entry.targetPath);
          entry.backedUp = false;
          throw error;
        }
      }

      if (config.restartOnSuccess && config.restartSignalPath) {
        await mkdir(dirname(config.restartSignalPath), { recursive: true });
        await writeFile(config.restartSignalPath, randomUUID());
      }
      for (const entry of staged) {
        await rm(entry.backupPath, { force: true }).catch((error) => {
          log(`[update] 清理备份失败: ${entry.file}: ${error.message}`);
        });
        entry.backedUp = false;
      }
      log(`[update] 全部更新成功: ${updated.join(', ')}`);
      sendJson(response, 200, { ok: true, updated, next: config.restartOnSuccess ? 'restarting' : 'running' });
      if (config.restartOnSuccess) {
        setTimeout(() => {
          log('[update] 进程退出，等待容器重启');
          process.exit(config.restartOnSuccess === 'code0' ? 0 : 1);
        }, config.restartSignalPath ? 1_500 : 500);
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const entry of [...staged].reverse()) {
        try {
          if (entry.installed) await rm(entry.targetPath, { force: true });
          if (entry.backedUp) await rename(entry.backupPath, entry.targetPath);
        } catch (rollbackError) {
          rollbackErrors.push(`${entry.file}: ${rollbackError.message}`);
        }
        await rm(entry.tempPath, { force: true }).catch(() => {});
      }
      const rollbackSuffix = rollbackErrors.length > 0 ? `；回滚失败: ${rollbackErrors.join(', ')}` : '';
      log(`[update] 更新失败: ${error.message}${rollbackSuffix}`);
      sendJson(response, 502, { error: 'update_failed', message: `${error.message}${rollbackSuffix}` });
    } finally {
      updateInProgress = false;
    }
  };
}

export function requestNodeUpdate(node) {
  return new Promise((resolvePromise, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': 0,
      Authorization: `Bearer ${node.updatePass}`,
    };
    const request = https.request(node.url, {
      method: 'POST', headers, ca: node.ca, cert: node.cert, key: node.key,
      servername: node.serverName, minVersion: 'TLSv1.3', rejectUnauthorized: true, timeout: node.updateTimeoutMs ?? 60_000,
    }, async (response) => {
      try {
        const bodyText = await readBody(response);
        let parsed = null;
        try { parsed = JSON.parse(bodyText); } catch {}
        resolvePromise({ statusCode: response.statusCode ?? 502, body: bodyText, parsed });
      } catch (error) {
        reject(error);
      }
    });
    request.on('timeout', () => request.destroy(new Error(`节点 ${node.name} 更新请求超时`)));
    request.on('error', reject);
    request.end();
  });
}
