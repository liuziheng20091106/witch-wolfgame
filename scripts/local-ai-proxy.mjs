#!/usr/bin/env node
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

// 可选请求日志（游戏内 AI 决策调试）：LOCAL_AI_LOG=文件路径 或 LOCAL_AI_LOG=stdout
const logTarget = process.env.LOCAL_AI_LOG ?? '';
function writeLog(line) {
  if (!logTarget) return;
  const text = `[${new Date().toISOString()}] ${line}`;
  if (logTarget === 'stdout') {
    console.log(text);
    return;
  }
  try {
    appendFileSync(logTarget, `${text}\n`, 'utf8');
  } catch (error) {
    // 日志失败不影响转发
  }
}

const HOST = process.env.LOCAL_AI_HOST ?? '127.0.0.1';
const PORT = Number(process.env.LOCAL_AI_PORT ?? 34025);
const allowedOrigins = new Set((process.env.LOCAL_AI_ALLOWED_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean));
const configFile = process.env.OMP_AI_CONFIG_FILE ?? `${process.env.USERPROFILE ?? ''}/.omp/agent/models.yml`;
let configText = '';
try {
  configText = readFileSync(configFile, 'utf8');
} catch (error) {
  const code = error instanceof Error && 'code' in error ? String(error.code) : '';
  if (code !== 'ENOENT') throw error;
}
const providerName = process.env.OMP_AI_PROVIDER ?? 'NOFX';
const providerHeader = `  ${providerName}:`;
const configLines = configText.split(/\r?\n/);
const providerIndex = configLines.findIndex((line) => line.trimEnd() === providerHeader);
const providerLines = [];
if (providerIndex >= 0) {
  for (let index = providerIndex + 1; index < configLines.length; index += 1) {
    const line = configLines[index];
    if (line !== undefined && /^  \S/.test(line)) break;
    providerLines.push(line ?? '');
  }
}
const providerBlock = providerLines.join('\n');
const configuredBaseUrl = providerBlock.match(/^    baseUrl:\s*(\S+)/m)?.[1] ?? '';
const configuredApiKey = providerBlock.match(/^    apiKey:\s*(\S+)/m)?.[1] ?? '';
const configuredModelFromConfig = providerBlock.match(/^      - id:\s*(\S+)/m)?.[1] ?? '';
const upstreamBaseUrl = (process.env.OMP_AI_BASE_URL ?? configuredBaseUrl).trim().replace(/\/+$/, '');
const upstreamApiKey = (process.env.OMP_AI_API_KEY ?? configuredApiKey).trim();
const configuredModel = (process.env.OMP_AI_MODEL ?? configuredModelFromConfig).trim();
const MAX_BODY_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;


if (!upstreamBaseUrl || !upstreamApiKey || !configuredModel) {
  throw new Error(`需要在 OMP 配置中提供 ${providerName} 的 baseUrl、apiKey 和模型，或设置 OMP_AI_BASE_URL/OMP_AI_API_KEY/OMP_AI_MODEL`);
}

function normalizeRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象');
  const input = value;
  if (!Array.isArray(input.messages)) throw new Error('请求体缺少 messages');
  return {
    ...input,
    model: typeof input.model === 'string' && input.model.trim() ? input.model : configuredModel,
  };
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return {
    ...(origin && allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Majo-Wolf-Session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
}

function respond(request, response, status, body) {
  response.writeHead(status, { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过本地 AI 服务限制');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function forwardChat(request, response) {
  let body;
  try {
    body = await readBody(request);
    body = JSON.stringify(normalizeRequest(JSON.parse(body)));
  } catch (error) {
    respond(request, response, 400, { error: 'invalid_request', message: error instanceof Error ? error.message : '请求体不是合法 JSON' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(`${upstreamBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${upstreamApiKey}`,
      },
      body,
      signal: controller.signal,
    });
    const upstreamBody = await upstreamResponse.arrayBuffer();
    response.writeHead(upstreamResponse.status, {
      ...corsHeaders(request),
      'Content-Type': upstreamResponse.headers.get('content-type') ?? 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(Buffer.from(upstreamBody));
    // 请求日志：非流式响应下可解析出 AI 决策原文，便于游戏内调试观察
    let requestMeta = '';
    try {
      const parsedRequest = JSON.parse(body);
      const messages = Array.isArray(parsedRequest.messages) ? parsedRequest.messages : [];
      const last = messages[messages.length - 1];
      const lastLen = last !== undefined && typeof last.content === 'string' ? last.content.length : 0;
      requestMeta = `model=${parsedRequest.model ?? '?'} msgs=${messages.length} lastContentChars=${lastLen}`;
    } catch {
      requestMeta = 'meta-unavailable';
    }
    if (upstreamResponse.ok) {
      let replySummary = '';
      try {
        const upstreamText = Buffer.from(upstreamBody).toString('utf8');
        const parsed = JSON.parse(upstreamText);
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          replySummary = content.slice(0, 600).replace(/\s+/g, ' ');
        }
      } catch {
        replySummary = '(响应不可解析)';
      }
      writeLog(`OK status=${upstreamResponse.status} ${requestMeta} reply=${replySummary}`);
    } else {
      const upstreamText = Buffer.from(upstreamBody).toString('utf8');
      writeLog(`ERR status=${upstreamResponse.status} ${requestMeta} body=${upstreamText.slice(0, 300)}`);
    }
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? '上游 AI 请求超时' : '上游 AI 请求失败';
    writeLog(`FAIL ${message}`);
    respond(request, response, 502, { error: 'upstream_unavailable', message });
  } finally {
    clearTimeout(timer);
  }
}

const server = createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }
  if (request.method === 'GET' && request.url === '/healthz') {
    respond(request, response, 200, { ok: true, model: configuredModel });
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    void forwardChat(request, response);
    return;
  }
  respond(request, response, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Local AI proxy listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
