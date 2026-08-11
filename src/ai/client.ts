import { z } from 'zod';
import type { SubmittedDecision } from '../domain/model';
import { buildDecisionPrompt, type PromptMessage } from './prompts';
import { parseDecision } from './schemas';
import { AiCommandError, type AiDecisionRequest, type AiProviderConfig } from './types';

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullable() }),
  })).min(1),
});

export function validateAiEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiCommandError('config', '端点不是合法 URL');
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new AiCommandError('config', '端点必须使用 HTTPS；开发时仅允许 localhost/127.0.0.1 的 HTTP');
  }
  if (!url.pathname.endsWith('/chat/completions')) {
    throw new AiCommandError('config', '端点必须是完整的 /chat/completions 地址');
  }
}

function validateConfig(config: AiProviderConfig): void {
  validateAiEndpoint(config.endpoint);
  if (!config.providerName.trim() || !config.apiKey.trim() || !config.model.trim()) {
    throw new AiCommandError('config', '服务商名称、API Key 和模型均不能为空');
  }
}

function buildPayload(config: AiProviderConfig, messages: PromptMessage[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    response_format: { type: 'json_object' },
  };
  if (config.protocol === 'deepseek') {
    payload.thinking = { type: 'enabled' };
  } else {
    payload.reasoning_effort = config.reasoningEffort;
  }
  return payload;
}

async function requestContent(messages: PromptMessage[], config: AiProviderConfig, signal: AbortSignal): Promise<string> {
  validateConfig(config);
  const timeoutController = new AbortController();
  const timeout = window.setTimeout(() => timeoutController.abort(), 60_000);
  const abort = () => timeoutController.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildPayload(config, messages)),
      signal: timeoutController.signal,
    });
    if (!response.ok) {
      throw new AiCommandError('http', `AI 服务返回 HTTP ${response.status}`, response.status);
    }
    let responseValue: unknown;
    try {
      responseValue = await response.json();
    } catch {
      throw new AiCommandError('json', 'AI 响应不是合法 JSON');
    }
    const parsed = responseSchema.safeParse(responseValue);
    if (!parsed.success) {
      throw new AiCommandError('schema', 'AI 响应缺少 choices[0].message.content');
    }
    const content = parsed.data.choices[0]?.message.content?.trim() ?? '';
    if (!content) {
      throw new AiCommandError('empty', 'AI 返回了空内容');
    }
    return content;
  } catch (error) {
    if (error instanceof AiCommandError) throw error;
    if (timeoutController.signal.aborted) {
      throw new AiCommandError(signal.aborted ? 'network' : 'timeout', signal.aborted ? 'AI 请求已取消' : 'AI 请求超过 60 秒');
    }
    throw new AiCommandError('network', error instanceof Error ? `AI 网络请求失败：${error.message}` : 'AI 网络请求失败，可能被 CORS 阻止');
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

export async function requestDecision<T extends SubmittedDecision>(
  request: AiDecisionRequest<T>,
  config: AiProviderConfig,
  signal: AbortSignal,
): Promise<T> {
  const content = await requestContent(buildDecisionPrompt(request), config, signal);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AiCommandError('json', 'AI 内容不是合法 JSON 对象');
  }
  return parseDecision(request.pendingDecision, value) as T;
}

export async function testAiConnection(config: AiProviderConfig, signal: AbortSignal): Promise<void> {
  const content = await requestContent([
    { role: 'system', content: '只返回 JSON 对象，不要解释。' },
    { role: 'user', content: '返回 {"ok":true}' },
  ], config, signal);
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new AiCommandError('json', '连接测试内容不是合法 JSON');
  }
  if (!z.strictObject({ ok: z.literal(true) }).safeParse(value).success) {
    throw new AiCommandError('schema', '连接测试未返回 {"ok":true}');
  }
}
