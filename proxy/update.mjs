/**
 * 自动更新模块（proxy 专用）：
 * 收到带密钥的更新请求后，从配置的地址下载指定文件清单、原子替换、退出进程重启。
 *
 * 请求：POST /update?pass=<密钥>
 *
 * 配置（proxy.config.json）：
 *   "update": {
 *     "passEnv": "MAJO_UPDATE_PASS",                 // 密钥所在环境变量名（推荐，勿写进配置）
 *     "source": "https://example.com/raw/{file}",    // 下载地址模板，{file} 会被替换为文件相对路径
 *     "files": ["server/gameProtocol.mjs", "proxy/server.mjs"],  // 要更新的文件清单（相对项目根）
 *     "restartOnSuccess": true                       // 成功后退出进程重启（需 docker restart: on-failure 或 always）
 *   }
 *
 * 安全：
 * - 仅 POST + ?pass 密钥匹配（timingSafeEqual 比较，密钥走环境变量）
 * - 文件清单白名单 + 路径越界检查（防任意路径覆盖）
 * - 下载 → 校验 → 临时文件 → 原子 rename
 * - 任一步失败都不替换文件，返回 502；成功才退出进程
 *
 * 重启说明：
 * - docker restart: on-failure → 进程以非零码退出才会重启，因此成功退出用码 1（docker 视为失败但无害）
 * - docker restart: always  → 任意退出都重启，可用码 0
 * 建议把容器 restart 策略设为 always（或 on-failure + 本模块用非零退出）。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { readBody, sendJson } from '../server/shared.mjs';

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024; // 单文件上限 8MB

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function downloadFile(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}: ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) throw new Error('下载内容为空');
    if (buffer.length > MAX_DOWNLOAD_BYTES) throw new Error('下载内容超过 8MB 上限');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 创建更新处理器。
 * @param {object} update 配置段（config.update）
 * @param {string} projectRoot 项目根目录（app/ 的上级）
 * @param {(msg: string) => void} log 日志函数
 */
export function createUpdateHandler(update, projectRoot, log = console.log) {
  if (!update || typeof update !== 'object') {
    log('[update] 未配置 update 段，更新接口未启用');
    return null;
  }
  const passEnv = update.passEnv;
  let pass = null;
  if (typeof passEnv === 'string' && passEnv) {
    pass = process.env[passEnv];
  }
  const sourceTemplate = update.source;
  let files = [];
  if (Array.isArray(update.files) && update.files.length > 0) {
    files = update.files;
  }
  const restartOnSuccess = update.restartOnSuccess !== false;
  let downloadTimeoutMs = 30_000;
  if (Number.isFinite(update.downloadTimeoutMs)) {
    downloadTimeoutMs = update.downloadTimeoutMs;
  }

  // 配置校验：任一必需项缺失则返回 null（接口不启用）
  if (!pass || typeof sourceTemplate !== 'string' || !sourceTemplate.includes('{file}') || files.length === 0) {
    log('[update] 未启用：update 配置需包含 passEnv(环境变量已设)、source(含 {file})、files(非空)');
    return null;
  }

  return async function handleUpdate(request, response, url) {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
    const provided = url.searchParams.get('pass');
    if (!provided || !safeEqual(provided, pass)) {
      return sendJson(response, 401, { error: 'invalid_update_pass' });
    }
    try {
      await readBody(request); // 消费请求体（可忽略）
    } catch { /* ignore */ }

    log(`[update] 收到更新请求，共 ${files.length} 个文件`);
    const staged = []; // { file, targetPath, tempPath, size }
    try {
      // 阶段一：全部下载 + 校验到各自的临时文件（任一失败则整体中止，不触碰线上文件）
      for (const file of files) {
        const targetPath = resolve(projectRoot, file);
        // 路径越界检查：目标必须在项目根内
        if (targetPath !== projectRoot && !targetPath.startsWith(projectRoot + sep)) {
          throw new Error(`文件路径越界: ${file}`);
        }
        const downloadUrl = sourceTemplate.replace('{file}', file.split('/').map((segment) => encodeURIComponent(segment)).join('/'));
        const content = await downloadFile(downloadUrl, downloadTimeoutMs);
        // 可选 SHA256 校验：配置 update.sha256 为 {file}:{hash} 映射
        const expectedHash = update.sha256?.[file];
        if (typeof expectedHash === 'string') {
          const actual = createHash('sha256').update(content).digest('hex');
          if (actual !== expectedHash) throw new Error(`SHA256 校验失败: ${file}`);
        }
        const tempPath = `${targetPath}.update-${process.pid}`;
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(tempPath, content);
        staged.push({ file, targetPath, tempPath, size: content.length });
        log(`[update] 已暂存: ${file} (${content.length} 字节)`);
      }
      // 阶段二：全部就绪后逐一原子替换（rename 失败概率极低；若仍失败，已替换的文件保留、
      // 未替换的回滚 —— 但由于阶段一已全部校验通过，此分支几乎不可达）
      const updated = [];
      for (const entry of staged) {
        await rename(entry.tempPath, entry.targetPath);
        updated.push(entry.file);
        log(`[update] 已替换: ${entry.file}`);
      }
      log(`[update] 全部更新成功: ${updated.join(', ')}`);
      sendJson(response, 200, { ok: true, updated, next: 'restarting' });
      if (restartOnSuccess) {
        // 给响应留出发送时间再退出；docker restart: on-failure 需非零退出码
        setTimeout(() => {
          log('[update] 进程退出，等待 docker 重启');
          if (restartOnSuccess === 'code0') {
            process.exit(0);
          } else {
            process.exit(1);
          }
        }, 500);
      }
    } catch (error) {
      log(`[update] 更新失败: ${error.message}`);
      // 清理所有临时文件（阶段一失败时线上文件未被触碰；阶段二失败时已替换的保留）
      for (const entry of staged) {
        await rm(entry.tempPath, { force: true }).catch(() => {});
      }
      sendJson(response, 502, { error: 'update_failed', message: error.message });
    }
  };
}
