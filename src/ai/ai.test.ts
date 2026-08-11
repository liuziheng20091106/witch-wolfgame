import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createGame } from '../domain/engine/createGame';
import { selectObservation } from '../domain/engine/selectors';
import type { PendingDecision, PlayerId, TargetDecision } from '../domain/model';
import { requestDecision } from './client';
import { AiCommandError, type AiProviderConfig } from './types';

const config: AiProviderConfig = {
  providerName: '测试服务',
  protocol: 'openai-compatible',
  endpoint: 'https://fake.example/v1/chat/completions',
  apiKey: 'secret-key',
  model: 'reasoning-model',
  reasoningEffort: 'low',
};

function requestFixture() {
  const state = createGame({ mode: 'player', humanCharacterId: 'soul-0', seed: 1 });
  const pending: PendingDecision = {
    id: 'pending-test', kind: 'seer-action', schemaKey: 'target', actorId: 0,
    title: '测试目标', description: '选择合法目标', candidates: [1, 2], allowAbstain: false,
    skillInstanceId: null, options: {},
  };
  return { observation: selectObservation(state, { kind: 'player', playerId: 0 }), pendingDecision: pending };
}

function aiResponse(content: string | null, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('结构化 AI 客户端', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('兼容协议发送默认 low、JSON 模式且密钥只在请求头', async () => {
    fetchMock.mockResolvedValue(aiResponse('{"targetPlayerId":1}'));
    const result = await requestDecision<TargetDecision>(requestFixture(), config, new AbortController().signal);
    expect(result).toEqual({ targetPlayerId: 1 });
    const init = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(payload.reasoning_effort).toBe('low');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload).not.toHaveProperty('temperature');
    expect(JSON.stringify(payload)).not.toContain('secret-key');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-key');
  });

  it('DeepSeek 协议发送 thinking 且不发送 reasoning_effort', async () => {
    fetchMock.mockResolvedValue(aiResponse('{"targetPlayerId":2}'));
    await requestDecision<TargetDecision>(requestFixture(), { ...config, protocol: 'deepseek' }, new AbortController().signal);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(payload.thinking).toEqual({ type: 'enabled' });
    expect(payload).not.toHaveProperty('reasoning_effort');
    expect(payload).not.toHaveProperty('temperature');
  });

  it('把 HTTP、空内容、非法 JSON、schema 和非法目标分类为可恢复错误', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await expect(requestDecision(requestFixture(), config, new AbortController().signal)).rejects.toMatchObject({ kind: 'http', status: 429 });

    fetchMock.mockResolvedValueOnce(aiResponse(''));
    await expect(requestDecision(requestFixture(), config, new AbortController().signal)).rejects.toMatchObject({ kind: 'empty' });

    fetchMock.mockResolvedValueOnce(aiResponse('{broken'));
    await expect(requestDecision(requestFixture(), config, new AbortController().signal)).rejects.toMatchObject({ kind: 'json' });

    fetchMock.mockResolvedValueOnce(aiResponse('{"speech":"不属于目标 schema"}'));
    await expect(requestDecision(requestFixture(), config, new AbortController().signal)).rejects.toMatchObject({ kind: 'schema' });

    fetchMock.mockResolvedValueOnce(aiResponse('{"targetPlayerId":5}'));
    await expect(requestDecision(requestFixture(), config, new AbortController().signal)).rejects.toMatchObject({ kind: 'target' });
  });

  it('60 秒后中止悬挂请求并返回 timeout', async () => {
    vi.useFakeTimers();
    const { promise, reject } = Promise.withResolvers<Response>();
    fetchMock.mockImplementation((_input, init) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      return promise;
    });
    const pending = requestDecision(requestFixture(), config, new AbortController().signal);
    const assertion = expect(pending).rejects.toEqual(expect.objectContaining<Partial<AiCommandError>>({ kind: 'timeout' }));
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
  });

  it('提示词只包含裁剪观察中的合法候选', async () => {
    fetchMock.mockResolvedValue(aiResponse('{"targetPlayerId":1}'));
    const fixture = requestFixture();
    await requestDecision(fixture, config, new AbortController().signal);
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ content: string }> };
    const prompt = payload.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain('legalCandidates');
    expect(prompt).toContain('"playerId":1');
    expect(prompt).not.toContain('secret-key');
    const hiddenRole = fixture.observation.players.find((player) => player.id === 1)?.roleId;
    expect(hiddenRole).toBeNull();
  });
});
