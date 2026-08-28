import { z } from 'zod';
import { FREE_CLIENT_PROTOCOL, buildFreeClientPayload } from '../../shared/gamePromptContract.js';
import { APP_VERSION } from '../config/version';
import type { SubmittedDecision } from '../domain/model';
import { buildAiDebugReport } from './debugReport';
import { buildDecisionPrompt, type PromptMessage } from './prompts';
import { parseDecision } from './schemas';
import {
  AiCommandError,
  FREE_PROVIDER_ENDPOINT,
  isRetryableAiError,
  type AiDecisionRequest,
  type AiProviderKind,
  type AiProviderConfig,
  resolveAiProfile,
  type CustomAiProviderConfig,
  type AiRemoteError,
  type ResolvedAiProfile,
} from './types';

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
});
const sessionJsonFallback = new Set<string>();
const REMOTE_CODE = /^[a-z0-9_]{1,64}$/;
const REMOTE_PATH = /^[A-Za-z0-9_.[\]-]+$/;

export function validateAiEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiCommandError('config', '端点不是合法 URL');
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) throw new AiCommandError('config', '端点必须使用 HTTPS；开发时仅允许 localhost/127.0.0.1 的 HTTP');
  if (!url.pathname.endsWith('/chat/completions')) throw new AiCommandError('config', '端点必须是完整的 /chat/completions 地址');
}

function validateCustomConfig(config: CustomAiProviderConfig): void {
  validateAiEndpoint(config.endpoint);
  if (!config.apiKey.trim() || !config.profiles.default.model.trim()) throw new AiCommandError('config', 'API Key 和默认模型不能为空');
}

function buildPayload(config: AiProviderConfig, messages: PromptMessage[], jsonOutput: boolean, profile: ResolvedAiProfile | null): Record<string, unknown> {
  if (config.provider === 'free') return buildFreeClientPayload(APP_VERSION, messages);
  if (profile === null) throw new AiCommandError('config', '缺少自定义模型档位');
  const payload: Record<string, unknown> = { model: profile.model, messages };
  if (jsonOutput) payload.response_format = { type: 'json_object' };
  payload.reasoning_effort = profile.reasoningEffort;
  return payload;
}

export function parseRemoteError(responseText: string): AiRemoteError | null {
  let value: unknown;
  try {
    value = JSON.parse(responseText);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.error !== 'string' || !REMOTE_CODE.test(record.error)) return null;
  const reason = typeof record.reason === 'string' && REMOTE_CODE.test(record.reason) ? record.reason : null;
  const path = typeof record.path === 'string' && record.path.length <= 128 && REMOTE_PATH.test(record.path) ? record.path : null;
  return { code: record.error, reason, path };
}

async function requestContent(
  messages: PromptMessage[],
  config: AiProviderConfig,
  sessionId: string,
  signal: AbortSignal,
  jsonOutput: boolean,
  profile: ResolvedAiProfile | null,
): Promise<string> {
  if (signal.aborted) throw new AiCommandError('cancelled', 'AI 请求已取消');
  if (config.provider === 'custom') validateCustomConfig(config);
  const timeoutController = new AbortController();
  const timeout = window.setTimeout(() => timeoutController.abort(), 60_000);
  const abort = () => timeoutController.abort();
  signal.addEventListener('abort', abort, { once: true });
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Majo-Wolf-Session': sessionId };
  if (config.provider === 'free') {
    headers['X-Majo-Wolf-Client'] = FREE_CLIENT_PROTOCOL.name;
    headers['X-Majo-Wolf-Version'] = APP_VERSION;
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }
  const endpoint = config.provider === 'free' ? FREE_PROVIDER_ENDPOINT : config.endpoint;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildPayload(config, messages, jsonOutput, profile)),
      signal: timeoutController.signal,
    });
    const responseText = await response.text();
    if (signal.aborted) throw new AiCommandError('cancelled', 'AI 请求已取消');
    if (!response.ok) {
      throw new AiCommandError('http', `AI 服务返回 HTTP ${response.status}`, {
        status: response.status,
        rawOutput: responseText,
        remoteError: parseRemoteError(responseText),
      });
    }
    let responseValue: unknown;
    try {
      responseValue = JSON.parse(responseText);
    } catch {
      throw new AiCommandError('json', 'AI 响应不是合法 JSON', { status: response.status, rawOutput: responseText });
    }
    const parsed = responseSchema.safeParse(responseValue);
    if (!parsed.success) {
      throw new AiCommandError('schema', 'AI 响应缺少 choices[0].message.content', { status: response.status, rawOutput: responseText });
    }
    const content = parsed.data.choices[0]?.message.content?.trim() ?? '';
    if (!content) throw new AiCommandError('empty', 'AI 返回了空内容', { status: response.status, rawOutput: responseText });
    return content;
  } catch (error) {
    if (error instanceof AiCommandError) throw error;
    if (signal.aborted) throw new AiCommandError('cancelled', 'AI 请求已取消');
    if (timeoutController.signal.aborted) throw new AiCommandError('timeout', 'AI 请求超过 60 秒');
    throw new AiCommandError('network', error instanceof Error ? `AI 网络请求失败：${error.message}` : 'AI 网络请求失败，可能被 CORS 阻止');
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function retryLimit(config: AiProviderConfig): number {
  return Math.min(5, Math.max(0, Math.trunc(config.retryCount)));
}

function shouldDisableJsonOutput(error: AiCommandError, config: AiProviderConfig, jsonOutput: boolean): boolean {
  return config.provider === 'custom'
    && config.jsonOutputMode === 'auto'
    && jsonOutput
    && (error.kind === 'json' || error.kind === 'schema' || error.kind === 'empty');
}

function isModelOutputError(error: AiCommandError): boolean {
  return error.kind === 'empty'
    || error.kind === 'json'
    || error.kind === 'schema'
    || error.kind === 'target';
}

function buildRetryMessages<T extends SubmittedDecision>(
  request: AiDecisionRequest<T>,
  error: AiCommandError,
  previousAttempt: number,
  provider: AiProviderKind,
): PromptMessage[] {
  return buildDecisionPrompt({
    ...request,
    pendingDecision: {
      ...request.pendingDecision,
      options: {
        ...request.pendingDecision.options,
        retryCorrection: {
          previousAttempt,
          errorKind: error.kind,
          message: error.message,
        },
      },
    },
  }, provider);
}

function withDebugReport(
  error: AiCommandError,
  request: AiDecisionRequest,
  config: AiProviderConfig,
  messages: PromptMessage[],
  attempt: number,
  maxAttempts: number,
  jsonOutputRequested: boolean,
  profile: ResolvedAiProfile | null,
): AiCommandError {
  return new AiCommandError(error.kind, error.message, {
    status: error.status,
    rawOutput: error.rawOutput,
    remoteError: error.remoteError,
    debugReport: buildAiDebugReport({ request, config, messages, error, attempt, maxAttempts, jsonOutputRequested, profile }),
  });
}

export async function requestDecision<T extends SubmittedDecision>(
  request: AiDecisionRequest<T>,
  config: AiProviderConfig,
  signal: AbortSignal,
): Promise<T> {
  const profile = config.provider === 'custom' ? resolveAiProfile(config, request.pendingDecision) : null;
  const maxAttempts = retryLimit(config) + 1;
  let jsonOutput = config.provider === 'custom' && config.jsonOutputMode !== 'disabled';
  if (config.provider === 'custom' && config.jsonOutputMode === 'auto' && sessionJsonFallback.has(request.sessionId)) jsonOutput = false;
  if (signal.aborted) throw new AiCommandError('cancelled', 'AI 请求已取消');

  let messages: PromptMessage[];
  try {
    messages = buildDecisionPrompt(request, config.provider);
  } catch (error) {
    const commandError = new AiCommandError('config', error instanceof Error ? error.message : 'AI 提示词构建失败');
    throw withDebugReport(commandError, request, config, [], 0, maxAttempts, jsonOutput, profile);
  }

  let lastError: AiCommandError | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const content = await requestContent(messages, config, request.sessionId, signal, jsonOutput, profile);
      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new AiCommandError('json', 'AI 内容不是合法 JSON 对象', { rawOutput: content });
      }
      try {
        return parseDecision(request.pendingDecision, value) as T;
      } catch (error) {
        if (error instanceof AiCommandError) {
          throw new AiCommandError(error.kind, error.message, { status: error.status, rawOutput: content, remoteError: error.remoteError });
        }
        throw error;
      }
    } catch (error) {
      const commandError = error instanceof AiCommandError
        ? error
        : new AiCommandError('network', error instanceof Error ? error.message : '未知 AI 错误');
      lastError = commandError;
      if (commandError.kind === 'cancelled') throw commandError;
      const hasNextAttempt = attempt < maxAttempts - 1;
      if (hasNextAttempt && isModelOutputError(commandError)) {
        messages = buildRetryMessages(request, commandError, attempt + 1, config.provider);
      }
      if (hasNextAttempt && shouldDisableJsonOutput(commandError, config, jsonOutput)) {
        sessionJsonFallback.add(request.sessionId);
        jsonOutput = false;
        continue;
      }
      if (!hasNextAttempt || !isRetryableAiError(commandError)) {
        throw withDebugReport(commandError, request, config, messages, attempt + 1, maxAttempts, jsonOutput, profile);
      }
    }
  }
  const fallbackError = lastError ?? new AiCommandError('network', 'AI 请求失败');
  throw withDebugReport(fallbackError, request, config, messages, maxAttempts, maxAttempts, jsonOutput, profile);
}
