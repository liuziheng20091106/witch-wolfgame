import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';

export const INTERNAL_PATH = '/internal/v1/chat/completions';
export const PUBLIC_PATHS = new Set(['/v1/chat/completions', '/api/ai/chat/completions']);
export const MAX_BODY_BYTES = 128 * 1024;

export async function readJsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function configPath(baseFile, value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('配置路径不能为空');
  return resolve(dirname(baseFile), value);
}

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(response, statusCode, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(body);
}

export function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function createSignedHeaders(password, method, path, body, sessionId = '') {
  const timestamp = Date.now().toString();
  const nonce = randomBytes(18).toString('base64url');
  const bodyHash = sha256(body);
  const canonical = `${method}\n${path}\n${sessionId}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const headers = {
    'X-Majo-Timestamp': timestamp,
    'X-Majo-Nonce': nonce,
    'X-Majo-Body-SHA256': bodyHash,
    'X-Majo-Signature': createHmac('sha256', password).update(canonical).digest('hex'),
  };
  if (sessionId) headers['X-Majo-Wolf-Session'] = sessionId;
  return headers;
}

export function verifySignedRequest(password, request, path, body, nonceStore, maxClockSkewMs = 30_000) {
  const timestamp = request.headers['x-majo-timestamp'];
  const nonce = request.headers['x-majo-nonce'];
  const claimedHash = request.headers['x-majo-body-sha256'];
  const signature = request.headers['x-majo-signature'];
  const sessionId = request.headers['x-majo-wolf-session'] ?? '';
  if (![timestamp, nonce, claimedHash, signature].every((value) => typeof value === 'string')) return false;
  if (sessionId && !/^[A-Za-z0-9_-]{22,128}$/.test(sessionId)) return false;
  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > maxClockSkewMs) return false;
  if (nonceStore.has(nonce)) return false;
  const bodyHash = sha256(body);
  if (claimedHash !== bodyHash) return false;
  const canonical = `${request.method}\n${path}\n${sessionId}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const expected = Buffer.from(createHmac('sha256', password).update(canonical).digest('hex'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  nonceStore.set(nonce, requestTime);
  return true;
}

export function pruneNonces(nonceStore, maxAgeMs = 60_000) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [nonce, timestamp] of nonceStore) {
    if (timestamp < cutoff) nonceStore.delete(nonce);
  }
}

export function normalizeClientIp(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.split(',')[0]?.trim();
  if (!candidate) return null;
  const normalized = candidate.startsWith('::ffff:') ? candidate.slice(7) : candidate;
  return isIP(normalized) ? normalized : null;
}

export function parseJsonBody(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    const error = new Error('请求体不是合法 JSON');
    error.statusCode = 400;
    throw error;
  }
}
