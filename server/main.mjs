import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { validateChatCompletionsResponse, validatePublicPayload } from './gameProtocol.mjs';
import {
  PUBLIC_PATHS,
  configPath,
  createSignedHeaders,
  normalizeClientIp,
  parseJsonBody,
  readBody,
  readJsonFile,
  logEvent,
  requireEnv,
  sendJson,
  watchRestartSignal,
} from './shared.mjs';

class SlidingWindowLimiter {
  constructor({ windowMs, maxRequests, maxConcurrent }) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
    this.maxConcurrent = maxConcurrent;
    this.entries = new Map();
  }

  acquire(ip) {
    const now = Date.now();
    const entry = this.entries.get(ip) ?? { timestamps: [], concurrent: 0 };
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp > now - this.windowMs);
    if (entry.concurrent >= this.maxConcurrent || entry.timestamps.length >= this.maxRequests) return false;
    entry.timestamps.push(now);
    entry.concurrent += 1;
    this.entries.set(ip, entry);
    return true;
  }

  release(ip) {
    const entry = this.entries.get(ip);
    if (entry) entry.concurrent = Math.max(0, entry.concurrent - 1);
  }
}

function corsHeaders(origin, allowedOrigins) {
  if (!origin || !allowedOrigins.has(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Majo-Wolf-Client, X-Majo-Wolf-Version, X-Majo-Wolf-Session',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function loadProxyNode(configFile, proxy) {
  if (!proxy || typeof proxy !== 'object' || typeof proxy.name !== 'string' || !proxy.name.trim()) throw new Error('代理节点缺少名称');
  const url = new URL(proxy.url);
  if (url.protocol !== 'https:' || url.pathname !== '/internal/v1/chat/completions') throw new Error(`代理节点 ${proxy.name} 必须使用内部 HTTPS 路径`);
  return {
    ...proxy,
    url,
    password: requireEnv(proxy.connectionPasswordEnv),
    ca: await readFile(configPath(configFile, proxy.ca)),
    cert: await readFile(configPath(configFile, proxy.clientCert)),
    key: await readFile(configPath(configFile, proxy.clientKey)),
  };
}

function callProxy(node, body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...createSignedHeaders(node.password, 'POST', node.url.pathname, body, sessionId),
  };
  return new Promise((resolvePromise, reject) => {
    const request = https.request(node.url, {
      method: 'POST', headers, ca: node.ca, cert: node.cert, key: node.key,
      servername: node.serverName, minVersion: 'TLSv1.3', rejectUnauthorized: true, timeout: node.timeoutMs,
    }, async (response) => {
      try { resolvePromise({ statusCode: response.statusCode ?? 502, body: await readBody(response), nodeName: node.name }); }
      catch (error) { reject(error); }
    });
    request.on('timeout', () => request.destroy(new Error(`代理节点 ${node.name} 请求超时`)));
    request.on('error', reject);
    request.end(body);
  });
}
class ProxyPool {
  constructor(nodes) { if (nodes.length === 0) throw new Error('至少需要一个代理节点'); this.nodes = nodes; this.cursor = 0; }
  async request(body, sessionId) {
    const start = this.cursor++ % this.nodes.length;
    let lastError = new Error('没有可用代理节点');
    for (let attempt = 0; attempt < this.nodes.length; attempt += 1) {
      const node = this.nodes[(start + attempt) % this.nodes.length];
      try {
        const result = await callProxy(node, body, sessionId);
        if (result.statusCode >= 200 && result.statusCode < 300) return result;
        let details = null;
        try { details = JSON.parse(result.body); } catch {}
        const error = new Error(typeof details?.message === 'string' ? details.message : typeof details?.error === 'string' ? details.error : `代理节点 ${node.name} 返回 HTTP ${result.statusCode}`);
        error.statusCode = result.statusCode;
        error.rawOutput = typeof details?.rawOutput === 'string' ? details.rawOutput : result.body;
        lastError = error;
        if (result.statusCode < 500) break;
      } catch (error) {
        lastError = error;
        if (Number.isInteger(error.statusCode) && error.statusCode < 500) break;
      }
      logEvent('warn', 'proxy_node_failure', { proxy: node.name, sessionId, message: lastError.message });
    }
    throw lastError;
  }
}


export async function startMainServer(configFile = process.env.MAJO_MAIN_CONFIG ?? resolve('server/main.config.json')) {
  const config = await readJsonFile(configFile);
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) throw new Error('proxies 至少需要一个代理节点');
  const proxyPool = new ProxyPool(await Promise.all(config.proxies.map((proxy) => loadProxyNode(configFile, proxy))));
  const allowedOrigins = new Set(config.cors.allowedOrigins);
  const acceptedVersions = new Set(config.acceptedClientVersions);
  if (acceptedVersions.size === 0) throw new Error('acceptedClientVersions 不能为空');
  const limiter = new SlidingWindowLimiter(config.rateLimit);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(response, 200, { ok: true, service: 'majo-main' });
    if (!PUBLIC_PATHS.has(url.pathname)) return sendJson(response, 404, { error: 'not_found' });
    const cors = corsHeaders(request.headers.origin, allowedOrigins);
    if (request.method === 'OPTIONS') return cors ? sendJson(response, 204, {}, cors) : sendJson(response, 403, { error: 'origin_denied' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' }, cors ?? {});
    if (!cors) return sendJson(response, 403, { error: 'origin_denied' });

    const ip = normalizeClientIp(request.headers['cf-connecting-ip']) ?? normalizeClientIp(request.socket.remoteAddress) ?? 'unknown';
    if (!limiter.acquire(ip)) {
      return sendJson(response, 429, { error: 'rate_limited', message: '请求过于频繁，请稍后重试' }, { ...cors, 'Retry-After': Math.ceil(config.rateLimit.windowMs / 1000) });
    }
    const sessionId = request.headers['x-majo-wolf-session'];
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{22,128}$/.test(sessionId)) {
      limiter.release(ip);
      return sendJson(response, 400, { error: 'invalid_session' }, cors);
    }
    const startedAt = Date.now();
    logEvent('info', 'ai_request', { ip, sessionId, path: url.pathname, bytes: request.headers['content-length'] ?? null });
    try {
      const body = await readBody(request);
      const payload = parseJsonBody(body);
      const validationError = validatePublicPayload(payload, acceptedVersions);
      if (validationError) {
        logEvent('warn', 'ai_error', { ip, sessionId, status: 400, durationMs: Date.now() - startedAt, message: validationError });
        return sendJson(response, 400, { error: 'invalid_game_request', message: validationError }, cors);
      }
      const upstream = await proxyPool.request(body, sessionId);
      if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
        let responsePayload;
        try { responsePayload = JSON.parse(upstream.body); } catch {
          const error = new Error('代理返回非 JSON 响应');
          error.statusCode = 502;
          error.rawOutput = upstream.body;
          throw error;
        }
        if (!validateChatCompletionsResponse(responsePayload)) {
          const error = new Error('代理返回的 Chat Completions 响应结构无效');
          error.statusCode = 502;
          error.rawOutput = upstream.body;
          throw error;
        }
      }
      logEvent('info', 'ai_success', { ip, sessionId, status: upstream.statusCode, proxy: upstream.nodeName, durationMs: Date.now() - startedAt, bytes: upstream.body.length });
      response.writeHead(upstream.statusCode, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Majo-Proxy': upstream.nodeName });
      response.end(upstream.body);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      const rawOutput = typeof error.rawOutput === 'string' ? error.rawOutput.slice(0, 4000) : null;
      const errorCode = status >= 500 ? 'proxy_unavailable' : status >= 400 ? 'upstream_error' : 'bad_request';
      logEvent('warn', 'ai_error', { ip, sessionId, status, durationMs: Date.now() - startedAt, message: error.message });
      sendJson(response, status, { error: errorCode, message: error.message, rawOutput }, cors);
    } finally {
      limiter.release(ip);
    }
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, resolvePromise);
  });
  const stopWatchingRestart = await watchRestartSignal(process.env.MAJO_RESTART_SIGNAL, async () => {
    logEvent('warn', 'main_restart', { message: '检测到共享代码更新，正在重启' });
    const forceExit = setTimeout(() => process.exit(0), 5_000);
    forceExit.unref();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    clearTimeout(forceExit);
    process.exit(0);
  }, (message) => logEvent('warn', 'main_restart_watch_error', { message }));
  server.on('close', stopWatchingRestart);
  const address = server.address();
  logEvent('info', 'main_listening', { address: typeof address === 'object' && address ? address.address : config.listen.host, port: typeof address === 'object' && address ? address.port : config.listen.port });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  startMainServer().catch((error) => {
    logEvent('error', 'main_startup_error', { message: error.message });
    process.exitCode = 1;
  });
}
