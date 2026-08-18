import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve } from 'node:path';
import { validateChatCompletionsResponse, validateProviderResponse, validatePublicPayload } from '../server/gameProtocol.mjs';
import { INTERNAL_PATH, configPath, parseJsonBody, pruneNonces, readBody, readJsonFile, requireEnv, sendJson, verifySignedRequest } from '../server/shared.mjs';

const PROVIDER_PROTOCOLS = new Set(['openai', 'deepseek']);
const REASONING_EFFORTS = new Set(['none', 'low', 'high', 'max']);

function validateEndpoint(value) {
  const url = new URL(value);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error(`上游端点必须使用 HTTPS: ${value}`);
  if (!url.pathname.endsWith('/chat/completions')) throw new Error(`上游端点必须是完整 /chat/completions 地址: ${value}`);
  return url.toString();
}

function loadProviders(value) {
  if (!value || !Array.isArray(value.providers) || value.providers.length === 0) throw new Error('providers.json 至少需要一个服务商');
  return value.providers.map((provider, index) => {
    if (!provider || typeof provider !== 'object') throw new Error(`服务商 ${index} 配置无效`);
    if (typeof provider.name !== 'string' || !provider.name.trim()) throw new Error(`服务商 ${index} 缺少名称`);
    if (!PROVIDER_PROTOCOLS.has(provider.protocol)) throw new Error(`服务商 ${provider.name} 协议无效`);
    if (typeof provider.model !== 'string' || !provider.model.trim()) throw new Error(`服务商 ${provider.name} 缺少模型`);
    if (!REASONING_EFFORTS.has(provider.reasoningEffort)) throw new Error(`服务商 ${provider.name} 思考强度无效`);
    if (!['auto', 'force', 'disabled'].includes(provider.jsonOutputMode)) throw new Error(`服务商 ${provider.name} JSON Output 模式无效`);
    const keys = requireEnv(provider.apiKeysEnv).split(',').map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) throw new Error(`服务商 ${provider.name} 没有可用 API Key`);
    return { ...provider, endpoint: validateEndpoint(provider.endpoint), keys };
  });
}

function buildUpstreamPayload(input, provider, jsonOutput) {
  const payload = { model: provider.model, messages: input.messages };
  if (jsonOutput) payload.response_format = { type: 'json_object' };
  if (provider.reasoningEffort !== 'none') {
    if (provider.protocol === 'deepseek') payload.thinking = { type: 'enabled' };
    else payload.reasoning_effort = provider.reasoningEffort;
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

async function callProvider(provider, apiKey, input, timeoutMs, jsonOutput) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(provider.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(buildUpstreamPayload(input, provider, jsonOutput)), signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`服务商 ${provider.name} 返回 HTTP ${response.status}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      error.rawOutput = text;
      throw error;
    }
    return parseUpstreamResponse(text, provider, jsonOutput);
  } finally { clearTimeout(timeout); }
}

class ProviderPool {
  constructor(providers, timeoutMs, maxAttempts) {
    this.slots = providers.flatMap((provider) => provider.keys.map((key) => ({ provider, key })));
    this.timeoutMs = timeoutMs;
    this.maxAttempts = Math.min(Math.max(1, maxAttempts), this.slots.length);
    this.cursor = 0;
    this.sessionFallback = new Map();
  }
  async request(input, sessionId) {
    const start = this.cursor++ % this.slots.length;
    let lastError = new Error('没有可用服务商');
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      const slot = this.slots[(start + attempt) % this.slots.length];
      const fallbackKey = `${sessionId}:${slot.provider.name}`;
      const expires = this.sessionFallback.get(fallbackKey) ?? 0;
      if (expires <= Date.now()) this.sessionFallback.delete(fallbackKey);
      const jsonOutput = slot.provider.jsonOutputMode === 'force' || (slot.provider.jsonOutputMode === 'auto' && !this.sessionFallback.has(fallbackKey));
      try { return await callProvider(slot.provider, slot.key, input, this.timeoutMs, jsonOutput); }
      catch (error) {
        lastError = error;
        if (slot.provider.jsonOutputMode === 'auto' && jsonOutput && error.responseFormatError === true) {
          this.sessionFallback.set(fallbackKey, Date.now() + 30 * 60_000);
          try { return await callProvider(slot.provider, slot.key, input, this.timeoutMs, false); }
          catch (fallbackError) { lastError = fallbackError; }
        }
        console.warn(`[proxy] ${slot.provider.name} 第 ${attempt + 1} 次尝试失败: ${error.message}`);
        if (error.retryable === false && error.responseFormatError !== true) break;
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
  const pool = new ProviderPool(providers, config.upstreamTimeoutMs, config.maxAttempts);
  const ca = await readFile(configPath(configFile, config.tls.ca));
  const cert = await readFile(configPath(configFile, config.tls.cert));
  const key = await readFile(configPath(configFile, config.tls.key));
  const nonceStore = new Map();
  const pruneTimer = setInterval(() => pruneNonces(nonceStore), 30_000);
  pruneTimer.unref();
  const server = https.createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3' }, async (request, response) => {
    if (!request.socket.authorized) return sendJson(response, 401, { error: 'unauthorized_client_certificate' });
    const url = new URL(request.url ?? '/', 'https://localhost');
    if (url.pathname === '/healthz') return sendJson(response, 200, { ok: true, service: 'majo-proxy' });
    if (url.pathname !== INTERNAL_PATH) return sendJson(response, 404, { error: 'not_found' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'method_not_allowed' });
    try {
      const body = await readBody(request);
      if (!verifySignedRequest(password, request, url.pathname, body, nonceStore)) return sendJson(response, 401, { error: 'invalid_internal_signature' });
      const payload = parseJsonBody(body);
      const sessionId = request.headers['x-majo-wolf-session'];
      const validationError = validatePublicPayload(payload, acceptedVersions);
      if (validationError) return sendJson(response, 400, { error: 'invalid_game_request', message: validationError });
      sendJson(response, 200, await pool.request(payload, sessionId));
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 502;
      sendJson(response, status, { error: status === 502 ? 'upstream_unavailable' : 'bad_request', message: error.message, rawOutput: typeof error.rawOutput === 'string' ? error.rawOutput.slice(0, 4000) : null });
    }
  });
  server.on('close', () => clearInterval(pruneTimer));
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(config.listen.port ?? 34023, config.listen.host ?? '0.0.0.0', resolvePromise); });
  const address = server.address();
  console.log(`Majo proxy listening on https://${typeof address === 'object' && address ? address.address : config.listen.host}:${typeof address === 'object' && address ? address.port : config.listen.port}`);
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) startProxyServer().catch((error) => {
  const safeMessage = error && typeof error.message === 'string' ? error.message : '启动失败';
  console.error(`[proxy] startup failed: ${safeMessage}`);
  process.exitCode = 1;
});
