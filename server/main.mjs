import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { INVALID_GAME_REQUEST_MESSAGE } from '../shared/gamePromptContract.js';
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
import { confirmNodeUpdate, createUpdateHandler, getBearerToken, recoverInterruptedUpdate, requestNodeUpdate, safeEqual } from './update-core.mjs';

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

async function loadUpdateNode(configFile, entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name.trim()) throw new Error('更新节点缺少名称');
  const url = new URL(entry.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`更新节点 ${entry.name} 必须使用 HTTP(S)`);
  let updatePassEnv = '';
  if (typeof entry.updatePassEnv === 'string') updatePassEnv = entry.updatePassEnv;
  let updatePass = null;
  if (updatePassEnv) updatePass = process.env[updatePassEnv] ?? null;
  if (!updatePass) throw new Error(`更新节点 ${entry.name} 缺少 updatePassEnv 对应环境变量`);
  let ca = null;
  let cert = null;
  let key = null;
  if (url.protocol === 'https:') {
    if (entry.ca) ca = await readFile(configPath(configFile, entry.ca));
    if (entry.clientCert) cert = await readFile(configPath(configFile, entry.clientCert));
    if (entry.clientKey) key = await readFile(configPath(configFile, entry.clientKey));
  }
  let updateTimeoutMs = 60_000;
  if (Number.isFinite(entry.updateTimeoutMs) && entry.updateTimeoutMs > 0) {
    updateTimeoutMs = entry.updateTimeoutMs;
  }
  let serverName = url.hostname;
  if (typeof entry.serverName === 'string' && entry.serverName.length > 0) {
    serverName = entry.serverName;
  }
  return {
    name: entry.name,
    url,
    updatePass,
    updateTimeoutMs,
    ca, cert, key,
    serverName,
  };
}


async function updateRemoteNodes(nodes, eventName) {
  const results = [];
  let allOk = true;
  for (const node of nodes) {
    const entry = { name: node.name };
    try {
      const result = await requestNodeUpdate(node);
      entry.status = result.statusCode;
      const applied = result.statusCode >= 200 && result.statusCode < 300
        && result.parsed && result.parsed.ok === true;
      if (applied) {
        const confirmation = await confirmNodeUpdate(node, { timeoutMs: node.updateTimeoutMs });
        entry.applied = true;
        entry.confirmed = confirmation.confirmed;
        if (!confirmation.confirmed) {
          allOk = false;
          entry.message = confirmation.message;
        }
        logEvent('info', `${eventName}_request`, { node: node.name, status: result.statusCode, confirmed: confirmation.confirmed });
      } else {
        allOk = false;
        entry.applied = false;
        entry.confirmed = false;
        entry.body = result.parsed ?? result.body.slice(0, 200);
        logEvent('warn', `${eventName}_failed`, { node: node.name, status: result.statusCode });
      }
    } catch (error) {
      allOk = false;
      entry.applied = false;
      entry.confirmed = false;
      entry.error = error.message;
      logEvent('warn', `${eventName}_error`, { node: node.name, message: error.message });
    }
    results.push(entry);
  }
  return { ok: allOk, results };
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
        try { details = JSON.parse(result.body); } catch { }
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

function multiplayerTargetUrl() {
  const target = process.env.MAJO_MULTIPLAYER_URL ?? 'ws://127.0.0.1:34024/multiplayer';
  const url = new URL(target);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/multiplayer') throw new Error('多人转发地址必须是 ws(s)://.../multiplayer');
  return url;
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function attachMultiplayerProxy(server, allowedOrigins) {
  const target = multiplayerTargetUrl();
  const connectTimeoutMs = Number(process.env.MAJO_MULTIPLAYER_CONNECT_TIMEOUT_MS ?? 10_000);
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) throw new Error('多人上游连接超时必须是正数');
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  webSocketServer.on('connection', (client, request) => {
    const origin = request.headers.origin;
    const upstream = new WebSocket(target, origin ? { headers: { origin } } : undefined);
    const queued = [];
    let settled = false;
    let timeout;
    const clearConnectionTimeout = () => clearTimeout(timeout);
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearConnectionTimeout();
      queued.length = 0;
      if (client.readyState !== WebSocket.CLOSED) client.terminate();
      if (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN) upstream.terminate();
      logEvent('warn', 'multiplayer_proxy_closed', { message });
    };
    timeout = setTimeout(() => fail('多人服务连接超时'), connectTimeoutMs);
    client.on('error', (error) => {
      if (settled) return;
      logEvent('warn', 'multiplayer_proxy_client_error', { message: error.message });
      fail('多人客户端连接异常');
    });
    upstream.on('error', (error) => {
      if (settled) return;
      logEvent('warn', 'multiplayer_proxy_upstream_error', { message: error.message });
      fail('多人服务不可用');
    });
    const forwardToUpstream = (data, isBinary) => {
      if (settled) return;
      if (upstream.readyState !== WebSocket.OPEN) {
        if (queued.length < 64) queued.push({ data, isBinary });
        else fail('多人服务响应超时');
        return;
      }
      try {
        upstream.send(data, { binary: isBinary }, (error) => {
          if (error) fail('多人服务发送失败');
        });
      } catch {
        fail('多人服务发送失败');
      }
    };
    client.on('message', forwardToUpstream);

    upstream.on('open', () => {
      if (settled) return;
      clearConnectionTimeout();
      const pending = queued.splice(0);
      for (const message of pending) forwardToUpstream(message.data, message.isBinary);
    });
    upstream.on('message', (data, isBinary) => {
      if (settled || client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(data, { binary: isBinary }, (error) => {
          if (error) fail('多人客户端发送失败');
        });
      } catch {
        fail('多人客户端发送失败');
      }
    });
    upstream.on('close', (code, reason) => {
      clearConnectionTimeout();
      queued.length = 0;
      if (!settled && client.readyState === WebSocket.OPEN) client.close(code, reason);
      settled = true;
    });
    client.on('close', () => {
      settled = true;
      clearConnectionTimeout();
      queued.length = 0;
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/multiplayer') return rejectUpgrade(socket, 404, 'Not Found');
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !allowedOrigins.has(origin)) return rejectUpgrade(socket, 403, 'Forbidden');
    webSocketServer.handleUpgrade(request, socket, head, (client) => webSocketServer.emit('connection', client, request));
  });
}


export async function startMainServer(configFile = process.env.MAJO_MAIN_CONFIG ?? resolve('server/main.config.json')) {
  const config = await readJsonFile(configFile);
  if (!Array.isArray(config.proxies) || config.proxies.length === 0) throw new Error('proxies 至少需要一个代理节点');
  const proxyPool = new ProxyPool(await Promise.all(config.proxies.map((proxy) => loadProxyNode(configFile, proxy))));
  const updateNodes = Array.isArray(config.updateNodes) && config.updateNodes.length > 0
    ? await Promise.all(config.updateNodes.map((entry) => loadUpdateNode(configFile, entry)))
    : [];
  const multiplayerUpdateNodes = Array.isArray(config.multiplayerUpdateNodes) && config.multiplayerUpdateNodes.length > 0
    ? await Promise.all(config.multiplayerUpdateNodes.map((entry) => loadUpdateNode(configFile, entry)))
    : [];
  const allowedOrigins = new Set(config.cors.allowedOrigins);
  const acceptedVersions = new Set(config.acceptedClientVersions);
  if (acceptedVersions.size === 0) throw new Error('acceptedClientVersions 不能为空');
  const limiter = new SlidingWindowLimiter(config.rateLimit);
  const updateProjectRoot = config.update?.projectRoot ?? process.cwd();
  const updateHandler = createUpdateHandler(config.update, updateProjectRoot, (message) => logEvent('info', 'update_log', { message }));
  const recovery = await recoverInterruptedUpdate(config.update, updateProjectRoot, (message) => logEvent('info', 'update_log', { message }));
  if (recovery.restored > 0 || recovery.removedTemp > 0) {
    logEvent('warn', 'update_recovery', { restored: recovery.restored, removedTemp: recovery.removedTemp });
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return sendJson(response, 200, { ok: true, service: 'majo-main' });
    // 更新路由：代理更新、多人服务更新与主服务自更新（独立认证，不走 CORS/限流）
    if (url.pathname === '/update') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
      const provided = getBearerToken(request);
      let mainUpdatePass = null;
      if (config.update && typeof config.update.passEnv === 'string') {
        mainUpdatePass = process.env[config.update.passEnv] ?? null;
      }
      let proxyUpdatePass = null;
      if (typeof config.proxyUpdatePassEnv === 'string') {
        proxyUpdatePass = process.env[config.proxyUpdatePassEnv] ?? null;
      }
      if (proxyUpdatePass && safeEqual(provided, proxyUpdatePass) && updateNodes.length > 0) {
        const result = await updateRemoteNodes(updateNodes, 'proxy_update');
        return sendJson(response, result.ok ? 200 : 502, result);
      }
      // main 自更新前先更新由主后端管理的多人服务。
      if (mainUpdatePass && safeEqual(provided, mainUpdatePass)) {
        if (multiplayerUpdateNodes.length > 0) {
          const result = await updateRemoteNodes(multiplayerUpdateNodes, 'multiplayer_update');
          if (!result.ok) return sendJson(response, 502, result);
        }
        if (updateHandler) {
          return updateHandler(request, response, url);
        }
        return sendJson(response, 503, { error: 'update_not_configured' });
      }
      return sendJson(response, 401, { error: 'invalid_update_request' });
    }
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
      const validation = validatePublicPayload(payload, acceptedVersions);
      if (!validation.ok) {
        logEvent('warn', 'ai_error', {
          ip,
          sessionId,
          status: 400,
          durationMs: Date.now() - startedAt,
          code: 'invalid_game_request',
          reason: validation.reason,
          path: validation.path,
        });
        return sendJson(response, 400, {
          error: 'invalid_game_request',
          message: INVALID_GAME_REQUEST_MESSAGE,
          reason: validation.reason,
          path: validation.path,
        }, cors);
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
      response.writeHead(upstream.statusCode, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Majo-Proxy': encodeURIComponent(upstream.nodeName) });
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
  attachMultiplayerProxy(server, allowedOrigins);
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
