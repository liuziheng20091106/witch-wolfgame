import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import {
  BOARD_DESCRIPTION,
  buildGameSystemPrompt,
  CREATURE_ID,
  CHARACTER_CATALOG,
  DECISION_KIND_SCHEMAS,
  formatCreatureName,
  PROMPT_LIMITS,
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

assert.match(buildGameSystemPrompt('target'), /legalCandidates 是唯一合法目标集合/);

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

const postGamePending = {
  ...pendingDecision,
  id: 'contract-post-game-speech',
  kind: 'speech',
  schemaKey: 'speech',
  title: '赛后复盘',
  description: '复盘这一局的经过。',
  candidates: [],
  allowAbstain: true,
  options: { postGame: true },
};
const postGameObservation = {
  ...observation,
  phase: 'post-game',
  pendingDecision: postGamePending,
};
const postGameMessages = buildDecisionPrompt({ observation: postGameObservation, pendingDecision: postGamePending, sessionId: 'contract-post-game' });
const postGamePrompt = JSON.parse(postGameMessages[1].content);
assert.equal(typeof postGamePrompt.postGameContext, 'string');
assert.deepEqual(validateGamePrompt(postGameMessages), { ok: true }, '赛后复盘上下文必须被后端提示词契约识别');

const oversizedPostGameObservation = structuredClone(postGameObservation);
oversizedPostGameObservation.publicEvents = Array.from({ length: 300 }, (_, index) => ({
  kind: 'system',
  day: 1,
  phase: 'post-game',
  text: `超长回归事件-${index}-${'x'.repeat(500)}`,
  actorPlayerId: null,
  targetPlayerIds: [],
  displayAuthorPlayerId: null,
  actualAuthorPlayerId: null,
  data: {},
}));
const oversizedPostGameMessages = buildDecisionPrompt({
  observation: oversizedPostGameObservation,
  pendingDecision: postGamePending,
  sessionId: 'contract-post-game-oversized',
});
const oversizedPostGamePrompt = JSON.parse(oversizedPostGameMessages[1].content);
assert.ok(oversizedPostGameMessages[1].content.length <= PROMPT_LIMITS.userContentMaxLength, '超长赛后提示词必须符合完整 user 内容上限');
assert.match(oversizedPostGamePrompt.postGameContext, /赛后复盘上下文过长/);
assert.deepEqual(validateGamePrompt(oversizedPostGameMessages), { ok: true }, '截断后的赛后提示词必须通过后端协议校验');

const creatureOwner = players[3];
assert.ok(creatureOwner);
const creaturePlayer = {
  id: CREATURE_ID,
  characterId: creatureOwner.characterId,
  name: formatCreatureName(creatureOwner.name),
  avatarUrl: creatureOwner.avatarUrl,
  alive: true,
  roleId: 'seer',
  skillId: null,
  isSelf: true,
};
const sevenPlayers = [...players.map((player) => ({ ...player, alive: true, isSelf: false })), creaturePlayer];
const creaturePending = {
  ...pendingDecision,
  id: 'contract-creature-actor',
  kind: 'seer-action',
  schemaKey: 'target',
  actorId: CREATURE_ID,
  title: '造物查验',
  candidates: [0],
  allowAbstain: false,
};
const creatureObservation = {
  ...observation,
  phase: 'seer-action',
  viewerPlayerId: CREATURE_ID,
  players: sevenPlayers,
  pendingDecision: creaturePending,
  knowledge: [{ subjectPlayerId: CREATURE_ID, kind: 'role', value: 'seer', observedDay: observation.day }],
};
const creatureMessages = buildDecisionPrompt({ observation: creatureObservation, pendingDecision: creaturePending, sessionId: 'contract-creature' });
assert.deepEqual(validateGamePrompt(creatureMessages), { ok: true }, '造物行动与七个存活实体必须通过 Node 提示词验证');
const creaturePrompt = JSON.parse(creatureMessages[1].content);
assert.equal(creaturePrompt.alivePlayers.length, 7);
assert.equal(creaturePrompt.publicSkills.length, 6, '造物不应扩充六座位公开技能目录');

const healingPending = {
  ...pendingDecision,
  id: 'contract-seven-healing-targets',
  kind: 'healing',
  schemaKey: 'target',
  title: '治愈',
  candidates: sevenPlayers.map((player) => player.id),
  allowAbstain: false,
};
const healingObservation = { ...creatureObservation, phase: 'night-protection', viewerPlayerId: 0, pendingDecision: healingPending };
assert.deepEqual(
  validateGamePrompt(buildDecisionPrompt({ observation: healingObservation, pendingDecision: healingPending, sessionId: 'contract-healing-seven' })),
  { ok: true },
  '七个治愈候选必须通过 Node 提示词验证',
);

const potionPending = {
  ...pendingDecision,
  id: 'contract-potion-choice',
  kind: 'skill',
  schemaKey: 'target',
  title: '点火-烧药',
  candidates: [0, 1],
  allowAbstain: false,
  options: { potionChoice: true },
};
assert.deepEqual(
  validateGamePrompt(buildDecisionPrompt({ observation: { ...observation, pendingDecision: potionPending }, pendingDecision: potionPending, sessionId: 'contract-potion' })),
  { ok: true },
  '药水候选必须通过 Node 提示词验证',
);

const mimicPending = {
  ...pendingDecision,
  id: 'contract-voice-mimic-options',
  kind: 'skill',
  schemaKey: 'voice-mimic',
  title: '声音模仿',
  candidates: [1, 2],
  options: {
    mimicVoices: [
      { playerId: 1, name: players[1].name, speechStyle: '冷静简洁。' },
      { playerId: 2, name: players[2].name, speechStyle: '直接果断。' },
    ],
  },
};
const mimicMessages = buildDecisionPrompt({ observation: { ...observation, pendingDecision: mimicPending }, pendingDecision: mimicPending, sessionId: 'contract-mimic' });
assert.deepEqual(validateGamePrompt(mimicMessages), { ok: true }, '声音模仿提示词必须通过 Node 验证');
const mimicPrompt = JSON.parse(mimicMessages[1].content);
assert.equal(mimicPrompt.legalCandidates.every((candidate) => !Object.hasOwn(candidate, 'speechStyle')), true);

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

calls = installFetch([
  chatResponse('{"targetPlayerId":0}'),
  chatResponse('{"targetPlayerId":1}'),
]);
const correctedTargetDecision = await requestDecision(
  { ...request, sessionId: 'illegal-target-correction' },
  { ...config, retryCount: 1 },
  new AbortController().signal,
);
assert.equal(correctedTargetDecision.targetPlayerId, 1);
assert.equal(calls.length, 2, '非法目标应携带纠错信息重试一次');
const initialTargetPrompt = JSON.parse(calls[0].body.messages[1].content);
const correctedTargetPrompt = JSON.parse(calls[1].body.messages[1].content);
assert.equal(Object.hasOwn(initialTargetPrompt.options, 'retryCorrection'), false);
assert.deepEqual(correctedTargetPrompt.legalCandidates.map((candidate) => candidate.playerId), [1, 2]);
assert.deepEqual(correctedTargetPrompt.options.retryCorrection, {
  previousAttempt: 1,
  errorKind: 'target',
  message: 'AI 返回了非法目标：0',
});
assert.deepEqual(validateGamePrompt(calls[1].body.messages), { ok: true }, '纠错重试提示必须通过后端契约校验');

const cancelled = new AbortController();
cancelled.abort();
calls = installFetch([]);
requestError = await captureError(() => requestDecision({ ...request, sessionId: 'cancelled' }, freeConfig, cancelled.signal));
assert.equal(calls.length, 0, '预先取消不应调用 fetch');
assert.equal(requestError.kind, 'cancelled');
assert.equal(requestError.debugReport, null);

const cancelledAfterBody = new AbortController();
calls = installFetch([() => ({
  ok: true,
  status: 200,
  async text() {
    cancelledAfterBody.abort();
    return JSON.stringify({ choices: [{ message: { content: '{"targetPlayerId":1}' } }] });
  },
})]);
requestError = await captureError(() => requestDecision(
  { ...request, sessionId: 'cancelled-after-body' },
  freeConfig,
  cancelledAfterBody.signal,
));
assert.equal(calls.length, 1, '响应体读取后取消不应重试');
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
