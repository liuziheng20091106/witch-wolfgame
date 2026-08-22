import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import {
  BOARD_DESCRIPTION,
  CHARACTER_CATALOG,
  DECISION_KIND_SCHEMAS,
} from '../shared/gamePromptContract.js';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let AiCommandError;
let buildAiDebugReport;
let buildDecisionPrompt;
let formatAiDebugReport;
let parseRemoteError;
let requestDecision;
let sanitizeAiBaseUrl;
let sanitizeApiKey;
try {
  ({ AiCommandError } = await server.ssrLoadModule('/src/ai/types.ts'));
  ({ buildAiDebugReport, formatAiDebugReport, sanitizeAiBaseUrl, sanitizeApiKey } = await server.ssrLoadModule('/src/ai/debugReport.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ parseRemoteError, requestDecision } = await server.ssrLoadModule('/src/ai/client.ts'));
} finally {
  await server.close();
}

globalThis.window = { setTimeout, clearTimeout };

const pendingDecision = {
  id: 'debug-decision',
  kind: 'vote',
  schemaKey: 'target',
  actorId: 0,
  title: '公开投票',
  description: '选择放逐目标',
  candidates: [1, 2],
  allowAbstain: true,
  skillInstanceId: null,
  options: {},
};
const players = CHARACTER_CATALOG.slice(0, 6).map((character, id) => ({
  id,
  characterId: character.id,
  name: character.name,
  avatarUrl: `/avatar-${id}.png`,
  alive: id !== 5,
  roleId: id === 0 ? 'villager' : null,
  skillId: id === 0 ? 'healing' : null,
  isSelf: id === 0,
}));
const observation = {
  gameId: 'debug-game',
  mode: 'spectator',
  automationMode: 'remote',
  board: BOARD_DESCRIPTION,
  seed: 12345,
  usedFreeProvider: false,
  day: 2,
  phase: 'voting',
  viewerPlayerId: 0,
  omniscient: false,
  players,
  publicEvents: [],
  privateEvents: [],
  archivedTimelines: [],
  knowledge: [],
  currentVotes: [{ voterPlayerId: 1, targetPlayerId: 2, round: 1 }],
  pendingDecision,
  result: null,
};
const request = { observation, pendingDecision, sessionId: 'session-secret-must-not-export' };
const secret = 'sk-live-super-secret-value';
const endpoint = 'https://debug-user:debug-pass@private-api.example.com/v1/chat/completions?api_key=query-secret#fragment-secret';
const config = {
  provider: 'custom',
  endpoint,
  apiKey: secret,
  model: 'debug-model',
  reasoningEffort: 'high',
  retryCount: 2,
  jsonOutputMode: 'force',
};
const messages = [
  { role: 'system', content: 'system prompt exact text' },
  { role: 'user', content: '{"visible":"game prompt exact text"}' },
];
const error = new AiCommandError('schema', '模型返回结构错误', {
  status: 200,
  rawOutput: '{"unexpected":true}',
  remoteError: { code: 'invalid_game_request', reason: 'action_schema', path: 'action.schema' },
});
const report = buildAiDebugReport({
  request,
  config,
  messages,
  error,
  attempt: 3,
  maxAttempts: 3,
  jsonOutputRequested: true,
  generatedAt: new Date('2026-08-22T12:00:00.000Z'),
});
const text = formatAiDebugReport(report);

assert.equal(report.formatVersion, 2);
assert.match(report.appVersion, /^\d+\.\d+\.\d+$/);
assert.equal(report.game.gameId, observation.gameId);
assert.equal(report.game.seed, observation.seed);
assert.equal(report.game.players.length, 6);
assert.deepEqual(report.game.pendingDecision, pendingDecision);
assert.deepEqual(report.request.promptMessages, messages);
assert.equal(report.response.rawOutput, error.rawOutput);
assert.deepEqual(report.error.remoteError, error.remoteError);
assert.equal(report.error.retryable, true);
assert.equal(report.request.provider.model, config.model);
assert.equal(report.request.provider.reasoningEffort, config.reasoningEffort);
assert.equal(report.request.jsonOutputRequested, true);
assert.equal(report.error.attempt, 3);
assert.equal(report.error.maxAttempts, 3);
assert.equal(report.request.provider.apiKey, `[REDACTED; length=${secret.length}]`);
assert.equal(report.request.provider.baseUrl, 'https://p***.example.com/v1/chat/completions');
assert.equal(sanitizeApiKey(''), '[not configured]');
assert.equal(sanitizeAiBaseUrl('not a URL'), '[invalid endpoint]');
for (const forbidden of [secret, 'private-api.example.com', 'debug-user', 'debug-pass', 'query-secret', 'fragment-secret', request.sessionId]) {
  assert.equal(text.includes(forbidden), false, `debug report leaked ${forbidden}`);
}

for (const [kind, schemaKeys] of Object.entries(DECISION_KIND_SCHEMAS)) {
  for (const schemaKey of schemaKeys) {
    const pending = {
      ...pendingDecision,
      id: `contract-${kind}-${schemaKey}`,
      kind,
      schemaKey,
    };
    const contractRequest = {
      observation: { ...observation, pendingDecision: pending },
      pendingDecision: pending,
      sessionId: `contract-${kind}-${schemaKey}`,
    };
    const validation = validateGamePrompt(buildDecisionPrompt(contractRequest));
    assert.deepEqual(validation, { ok: true }, `${kind} + ${schemaKey} 必须通过 Node 提示词验证`);
  }
}

function chatResponse(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(steps) {
  const calls = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init, body: init?.body ? JSON.parse(init.body) : null });
    const step = steps.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(input, init);
    assert.ok(step instanceof Response, 'fetch stub 缺少响应步骤');
    return step;
  };
  return calls;
}

async function captureError(run) {
  try {
    await run();
  } catch (caught) {
    assert.ok(caught instanceof AiCommandError);
    return caught;
  }
  assert.fail('预期 AI 请求失败');
}

const freeConfig = { provider: 'free', retryCount: 2 };
const invalidRemoteBody = {
  error: 'invalid_game_request',
  message: 'REMOTE_MESSAGE_MUST_NOT_REACH_UI',
  reason: 'action_schema',
  path: 'action.schema',
};
let calls = installFetch([errorResponse(400, invalidRemoteBody)]);
let requestError = await captureError(() => requestDecision(request, freeConfig, new AbortController().signal));
assert.equal(calls.length, 1, '永久 HTTP 400 不应重试');
assert.equal(requestError.kind, 'http');
assert.equal(requestError.status, 400);
assert.deepEqual(requestError.remoteError, { code: 'invalid_game_request', reason: 'action_schema', path: 'action.schema' });
assert.equal(requestError.message.includes(invalidRemoteBody.message), false);
assert.equal(requestError.debugReport.error.attempt, 1);
assert.equal(requestError.debugReport.error.maxAttempts, 3);
assert.equal(requestError.debugReport.error.retryable, false);
assert.deepEqual(requestError.debugReport.error.remoteError, requestError.remoteError);
assert.equal(requestError.debugReport.response.rawOutput, JSON.stringify(invalidRemoteBody));

calls = installFetch([errorResponse(401, { error: 'unauthorized' })]);
requestError = await captureError(() => requestDecision({ ...request, sessionId: 'http-401' }, freeConfig, new AbortController().signal));
assert.equal(calls.length, 1, '永久 HTTP 401 不应重试');
assert.equal(requestError.status, 401);

calls = installFetch([
  errorResponse(429, { error: 'rate_limited' }),
  chatResponse('{"targetPlayerId":1}'),
]);
const rateDecision = await requestDecision({ ...request, sessionId: 'http-429' }, freeConfig, new AbortController().signal);
assert.equal(calls.length, 2, 'HTTP 429 应重试一次后成功');
assert.equal(rateDecision.targetPlayerId, 1);

calls = installFetch([
  errorResponse(502, { error: 'upstream_unavailable', sequence: 1 }),
  errorResponse(502, { error: 'upstream_unavailable', sequence: 2 }),
]);
requestError = await captureError(() => requestDecision({ ...request, sessionId: 'http-502' }, { ...freeConfig, retryCount: 1 }, new AbortController().signal));
assert.equal(calls.length, 2, 'HTTP 502 在 retryCount=1 时应恰好请求两次');
assert.equal(requestError.debugReport.error.attempt, 2);
assert.equal(requestError.debugReport.error.maxAttempts, 2);
assert.match(requestError.rawOutput, /"sequence":2/);
assert.equal(requestError.debugReport.error.retryable, true);

calls = installFetch([
  new TypeError('temporary network failure'),
  chatResponse('{"targetPlayerId":1}'),
]);
const networkDecision = await requestDecision({ ...request, sessionId: 'network-retry' }, freeConfig, new AbortController().signal);
assert.equal(calls.length, 2, '网络失败应按配置重试');
assert.equal(networkDecision.targetPlayerId, 1);

calls = installFetch([
  chatResponse('not valid decision JSON'),
  chatResponse('{"targetPlayerId":1}'),
]);
const jsonDecision = await requestDecision({ ...request, sessionId: 'json-retry' }, { ...config, retryCount: 1 }, new AbortController().signal);
assert.equal(calls.length, 2, '模型 JSON 错误应按配置重试');
assert.equal(jsonDecision.targetPlayerId, 1);

calls = installFetch([
  chatResponse('{"targetPlayerId":"wrong"}'),
  chatResponse('{"targetPlayerId":1}'),
]);
const schemaDecision = await requestDecision({ ...request, sessionId: 'schema-retry' }, { ...config, retryCount: 1 }, new AbortController().signal);
assert.equal(calls.length, 2, '模型 schema 错误应按配置重试');
assert.equal(schemaDecision.targetPlayerId, 1);

const cancelled = new AbortController();
cancelled.abort();
calls = installFetch([]);
requestError = await captureError(() => requestDecision({ ...request, sessionId: 'cancelled' }, freeConfig, cancelled.signal));
assert.equal(calls.length, 0, '预先取消不应调用 fetch');
assert.equal(requestError.kind, 'cancelled');
assert.equal(requestError.debugReport, null);

calls = installFetch([
  chatResponse('not valid decision JSON'),
  chatResponse('{"targetPlayerId":1}'),
]);
const autoConfig = { ...config, retryCount: 1, jsonOutputMode: 'auto' };
const autoDecision = await requestDecision({ ...request, sessionId: 'json-auto-fallback' }, autoConfig, new AbortController().signal);
assert.equal(autoDecision.targetPlayerId, 1);
assert.equal(calls.length, 2, 'JSON auto fallback 只能切换后再请求一次');
assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
assert.equal(calls[1].body.response_format, undefined);

calls = installFetch([]);
const invalidPair = {
  ...request,
  sessionId: 'invalid-contract-pair',
  pendingDecision: { ...pendingDecision, kind: 'vote', schemaKey: 'speech' },
};
invalidPair.observation = { ...observation, pendingDecision: invalidPair.pendingDecision };
requestError = await captureError(() => requestDecision(invalidPair, freeConfig, new AbortController().signal));
assert.equal(calls.length, 0, '非法 kind/schema 组合不应调用 fetch');
assert.equal(requestError.kind, 'config');
assert.equal(requestError.debugReport.error.attempt, 0);
assert.deepEqual(requestError.debugReport.request.promptMessages, []);

assert.equal(parseRemoteError('not json'), null);
assert.equal(parseRemoteError('{"error":"BAD","reason":"valid","path":"action.schema"}'), null);
assert.deepEqual(
  parseRemoteError('{"error":"valid_code","reason":"BAD","path":"invalid path"}'),
  { code: 'valid_code', reason: null, path: null },
);

console.log('AI debug report smoke passed');
