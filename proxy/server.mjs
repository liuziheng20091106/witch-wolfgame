import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve } from 'node:path';
import { validateChatCompletionsResponse, validateProviderResponse, validatePublicPayload } from '../server/gameProtocol.mjs';
import { INTERNAL_PATH, configPath, logEvent, parseJsonBody, pruneNonces, readBody, readJsonFile, requireEnv, sendJson, verifySignedRequest, watchRestartSignal } from '../server/shared.mjs';
import { createUpdateHandler, recoverInterruptedUpdate } from './update.mjs';

const PROVIDER_PROTOCOLS = new Set(['openai', 'deepseek']);
const REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_TIMEOUT_MS = 3_600_000;

function requireBoundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} 必须是 ${minimum}~${maximum} 的整数`);
  }
  return value;
}


function validateEndpoint(value) {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`上游端点必须使用 HTTPS: ${value}`);
  if (!url.pathname.endsWith('/chat/completions')) throw new Error(`上游端点必须是完整 /chat/completions 地址: ${value}`);
  return url.toString();
}

function loadProviders(value) {
  if (!value || !Array.isArray(value.providers) || value.providers.length === 0) throw new Error('providers.json 至少需要一个服务商');
  const names = new Set();
  const providers = value.providers.map((provider, index) => {
    if (!provider || typeof provider !== 'object') throw new Error(`服务商 ${index} 配置无效`);
    if (typeof provider.name !== 'string' || !provider.name.trim()) throw new Error(`服务商 ${index} 缺少名称`);
    if (names.has(provider.name)) throw new Error(`服务商名称重复: ${provider.name}`);
    names.add(provider.name);
    if (typeof provider.enabled !== 'boolean') throw new Error(`服务商 ${provider.name} enabled 必须是布尔值`);
    if (!provider.enabled) return null;
    if (!PROVIDER_PROTOCOLS.has(provider.protocol)) throw new Error(`服务商 ${provider.name} 协议无效`);
    if (typeof provider.model !== 'string' || !provider.model.trim()) throw new Error(`服务商 ${provider.name} 缺少模型`);
    if (!REASONING_EFFORTS.has(provider.reasoningEffort)) throw new Error(`服务商 ${provider.name} 思考强度无效`);
    if (!['auto', 'force', 'disabled'].includes(provider.jsonOutputMode)) throw new Error(`服务商 ${provider.name} JSON Output 模式无效`);
    const totalTimeoutMs = requireBoundedInteger(provider.totalTimeoutMs, 100, MAX_PROVIDER_TIMEOUT_MS, `服务商 ${provider.name} totalTimeoutMs`);
    const firstByteTimeoutMs = requireBoundedInteger(provider.firstByteTimeoutMs, 50, totalTimeoutMs, `服务商 ${provider.name} firstByteTimeoutMs`);
    const retryCount = requireBoundedInteger(provider.retryCount, 0, 20, `服务商 ${provider.name} retryCount`);
    const keys = requireEnv(provider.apiKeysEnv).split(',').map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error(`服务商 ${provider.name} 没有可用 API Key`);
    return { ...provider, endpoint: validateEndpoint(provider.endpoint), totalTimeoutMs, firstByteTimeoutMs, retryCount, keys };
  }).filter(Boolean);
  if (providers.length === 0) throw new Error('providers.json 至少需要一个已启用服务商');
  return providers;
}

export function buildUpstreamPayload(input, provider, jsonOutput) {
  const payload = { model: provider.model, messages: input.messages, stream: true };
  if (jsonOutput) payload.response_format = { type: 'json_object' };
  if (provider.protocol === 'deepseek') {
    payload.thinking = { type: provider.reasoningEffort === 'none' ? 'disabled' : 'enabled' };
  } else {
    payload.reasoning_effort = provider.reasoningEffort;
  }
  return payload;
}

function parseUpstreamResponse(text, provider, jsonOutput) {
  let value;
  try { value = JSON.parse(text); } catch {
    const error = new Error(`服务商 ${provider.name} 返回非 JSON`);
    error.responseFormatError = false;
    error.rawOutput = text;
    throw error;
  }
  if (!validateChatCompletionsResponse(value)) {
    const error = new Error(`服务商 ${provider.name} 响应缺少合法 choices[0].message.content`);
    error.responseFormatError = false;
    error.rawOutput = text;
    throw error;
  }
  if (jsonOutput && !validateProviderResponse(value)) {
    const error = new Error(`服务商 ${provider.name} 的模型输出不是合法 JSON`);
    error.responseFormatError = true;
    error.rawOutput = text;
    throw error;
  }
  return value;
}

function parseSseResponse(text, provider, jsonOutput) {
  let content = '';
  let id;
  let created;
  let model;
  let finishReason = null;
  let usage;
  let parsedChunks = 0;
  const events = text.replaceAll('\r\n', '\n').split(/\n\n+/);
  for (const event of events) {
    const data = event.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch {
      const error = new Error(`服务商 ${provider.name} 返回无效 SSE 数据`);
      error.rawOutput = text;
      throw error;
    }
    parsedChunks += 1;
    id ??= typeof chunk.id === 'string' ? chunk.id : undefined;
    created ??= Number.isFinite(chunk.created) ? chunk.created : undefined;
    model ??= typeof chunk.model === 'string' ? chunk.model : undefined;
    usage = chunk.usage ?? usage;
    const choice = chunk.choices?.[0];
    const fragment = choice?.delta?.content ?? choice?.message?.content;
    if (typeof fragment === 'string') content += fragment;
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
  }
  if (parsedChunks === 0) {
    const error = new Error(`服务商 ${provider.name} 未返回有效 SSE 数据`);
    error.rawOutput = text;
    throw error;
  }
  const value = {
    ...(id ? { id } : {}),
    object: 'chat.completion',
    ...(created !== undefined ? { created } : {}),
    model: model ?? provider.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
  if (!validateChatCompletionsResponse(value)) {
    const error = new Error(`服务商 ${provider.name} 的流式响应缺少有效内容`);
    error.rawOutput = text;
    throw error;
  }
  if (jsonOutput && !validateProviderResponse(value)) {
    const error = new Error(`服务商 ${provider.name} 的模型输出不是合法 JSON`);
    error.responseFormatError = true;
    error.rawOutput = text;
    throw error;
  }
  return value;
}

async function readUpstreamText(response, provider, controller, onFirstByte) {
  if (!response.body) {
    const error = new Error(`服务商 ${provider.name} 返回空响应体`);
    error.retryable = true;
    throw error;
  }
  const chunks = [];
  let size = 0;
  let received = false;
  for await (const chunk of response.body) {
    if (!received) {
      received = true;
      onFirstByte();
    }
    size += chunk.byteLength;
    if (size > MAX_UPSTREAM_RESPONSE_BYTES) {
      controller.abort();
      const error = new Error(`服务商 ${provider.name} 响应超过 ${MAX_UPSTREAM_RESPONSE_BYTES} 字节`);
      error.retryable = false;
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!received) {
    const error = new Error(`服务商 ${provider.name} 返回空响应体`);
    error.retryable = true;
    throw error;
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

async function callProvider(provider, apiKey, input, jsonOutput) {
  const controller = new AbortController();
  let timeoutType = null;
  const totalTimer = setTimeout(() => {
    timeoutType = 'total';
    controller.abort();
  }, provider.totalTimeoutMs);
  const firstByteTimer = setTimeout(() => {
    timeoutType = 'first_byte';
    controller.abort();
  }, provider.firstByteTimeoutMs);
  const clearFirstByteTimer = () => clearTimeout(firstByteTimer);
  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildUpstreamPayload(input, provider, jsonOutput)),
      signal: controller.signal,
    });
    const text = await readUpstreamText(response, provider, controller, clearFirstByteTimer);
    if (!response.ok) {
      const error = new Error(`服务商 ${provider.name} 返回 HTTP ${response.status}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      error.rawOutput = text;
      throw error;
    }
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.includes('text/event-stream') || text.trimStart().startsWith('data:')
      ? parseSseResponse(text, provider, jsonOutput)
      : parseUpstreamResponse(text, provider, jsonOutput);
  } catch (error) {
    if (timeoutType) {
      const timeoutError = new Error(timeoutType === 'first_byte'
        ? `服务商 ${provider.name} 首字节超时（${provider.firstByteTimeoutMs}ms）`
        : `服务商 ${provider.name} 总请求超时（${provider.totalTimeoutMs}ms）`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(firstByteTimer);
    clearTimeout(totalTimer);
  }
}

class ProviderPool {
  constructor(providers) {
    this.providers = providers;
    this.keyCursors = new Map(providers.map((provider) => [provider.name, 0]));
    this.sessionFallback = new Map();
  }

  nextKey(provider) {
    const cursor = this.keyCursors.get(provider.name) ?? 0;
    this.keyCursors.set(provider.name, cursor + 1);
    return provider.keys[cursor % provider.keys.length];
  }

  async request(input, sessionId) {
    let lastError = new Error('没有可用服务商');
    for (const provider of this.providers) {
      const maxAttempts = provider.retryCount + 1;
      const fallbackKey = `${sessionId ?? 'anonymous'}:${provider.name}`;
      const expires = this.sessionFallback.get(fallbackKey) ?? 0;
      if (expires <= Date.now()) this.sessionFallback.delete(fallbackKey);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const jsonOutput = provider.jsonOutputMode === 'force'
          || (provider.jsonOutputMode === 'auto' && !this.sessionFallback.has(fallbackKey));
        const startedAt = Date.now();
        logEvent('info', 'provider_attempt', { provider: provider.name, attempt, maxAttempts, jsonOutput, sessionId: sessionId ?? null });
        try {
          const value = await callProvider(provider, this.nextKey(provider), input, jsonOutput);
          logEvent('info', 'provider_success', { provider: provider.name, attempt, maxAttempts, durationMs: Date.now() - startedAt, sessionId: sessionId ?? null });
          return { value, providerName: provider.name };
        } catch (error) {
          lastError = error;
          let fallbackActivated = false;
          if (provider.jsonOutputMode === 'auto' && jsonOutput && error.responseFormatError === true) {
            this.sessionFallback.set(fallbackKey, Date.now() + 30 * 60_000);
            fallbackActivated = true;
          }
          logEvent('warn', 'provider_failure', {
            provider: provider.name,
            attempt,
            maxAttempts,
            durationMs: Date.now() - startedAt,
            retryable: error.retryable !== false,
            responseFormatFallback: fallbackActivated,
            message: error.message,
            sessionId: sessionId ?? null,
          });
          if (error.retryable === false && !fallbackActivated) break;
        }
      }
    }
    throw lastError;
  }
}

export async function startProxyServer(configFile = process.env.MAJO_PROXY_CONFIG ?? resolve('proxy/proxy.config.json')) {
  const config = await readJsonFile(configFile);
  const password = requireEnv(config.connectionPasswordEnv);
  const providers = loadProviders(await readJsonFile(configPath(configFile, config.providersFile)));
  const acceptedVersions = new Set(config.acceptedClientVersions);
  if (acceptedVersions.size === 0) throw new Error('acceptedClientVersions 不能为空');
  const pool = new ProviderPool(providers);
  const ca = await readFile(configPath(configFile, config.tls.ca));
  const cert = await readFile(configPath(configFile, config.tls.cert));
  const key = await readFile(configPath(configFile, config.tls.key));
  const nonceStore = new Map();
  const pruneTimer = setInterval(() => pruneNonces(nonceStore), 30_000);
  pruneTimer.unref();
  // Docker 将仓库以可写卷挂载到 /app；本地运行则使用当前工作目录。
  const updateProjectRoot = config.update?.projectRoot ?? process.cwd();
  const updateHandler = createUpdateHandler(config.update, updateProjectRoot, (message) => logEvent('info', 'update_log', { message }));
  const recovery = await recoverInterruptedUpdate(config.update, updateProjectRoot, (message) => logEvent('info', 'update_log', { message }));
  if (recovery.restored > 0 || recovery.removedTemp > 0) {
    logEvent('warn', 'proxy_update_recovery', { restored: recovery.restored, removedTemp: recovery.removedTemp });
  }
  const server = https.createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (request, response) => {
    if (!request.socket.authorized) return sendJson(response, 401, { error: 'unauthorized_client_certificate' });
    const url = new URL(request.url ?? '/', 'https://localhost');
    if (url.pathname === '/healthz') return sendJson(response, 200, { ok: true, service: 'majo-proxy' });
    if (updateHandler && url.pathname === '/update') {
      return updateHandler(request, response, url);
    }
    if (url.pathname !== INTERNAL_PATH) return sendJson(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
    const startedAt = Date.now();
    let sessionId = null;
    try {
      const body = await readBody(request);
      if (!verifySignedRequest(password, request, url.pathname, body, nonceStore)) return sendJson(response, 401, { error: 'invalid_internal_signature' });
      const payload = parseJsonBody(body);
      sessionId = request.headers['x-majo-wolf-session'] ?? null;
      const validationError = validatePublicPayload(payload, acceptedVersions);
      if (validationError) return sendJson(response, 400, { error: 'invalid_game_request', message: validationError });
      logEvent('info', 'proxy_request', { sessionId, bytes: body.length });
      const result = await pool.request(payload, sessionId);
      logEvent('info', 'proxy_success', { sessionId, provider: result.providerName, durationMs: Date.now() - startedAt });
      sendJson(response, 200, result.value);
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      logEvent('warn', 'proxy_error', { sessionId, status, durationMs: Date.now() - startedAt, message: error.message });
      sendJson(response, status, { error: status === 502 ? 'upstream_unavailable' : 'bad_request', message: error.message, rawOutput: typeof error.rawOutput === 'string' ? error.rawOutput.slice(0, 4000) : null });
    }
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(config.listen.port ?? 34023, config.listen.host ?? '0.0.0.0', resolvePromise); });
  const stopWatchingRestart = await watchRestartSignal(process.env.MAJO_RESTART_SIGNAL, async () => {
    logEvent('warn', 'proxy_restart', { message: '检测到共享代码更新，正在重启' });
    const forceExit = setTimeout(() => process.exit(0), 5_000);
    forceExit.unref();
    await new Promise((resolvePromise) => server.close(resolvePromise));
    clearTimeout(forceExit);
    process.exit(0);
  }, (message) => logEvent('warn', 'proxy_restart_watch_error', { message }));
  server.on('close', () => {
    clearInterval(pruneTimer);
    stopWatchingRestart();
  });
  const address = server.address();
  logEvent('info', 'proxy_listening', { address: typeof address === 'object' && address ? address.address : config.listen.host, port: typeof address === 'object' && address ? address.port : config.listen.port });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) startProxyServer().catch((error) => {
  logEvent('error', 'proxy_startup_error', { message: error.message });
  process.exitCode = 1;
});
