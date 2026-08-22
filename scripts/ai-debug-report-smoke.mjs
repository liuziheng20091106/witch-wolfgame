import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let AiCommandError;
let buildAiDebugReport;
let formatAiDebugReport;
let requestDecision;
let sanitizeAiBaseUrl;
let sanitizeApiKey;
try {
  ({ AiCommandError } = await server.ssrLoadModule('/src/ai/types.ts'));
  ({ buildAiDebugReport, formatAiDebugReport, sanitizeAiBaseUrl, sanitizeApiKey } = await server.ssrLoadModule('/src/ai/debugReport.ts'));
  ({ requestDecision } = await server.ssrLoadModule('/src/ai/client.ts'));
} finally {
  await server.close();
}

const secret = 'sk-live-super-secret-value';
const endpoint = 'https://debug-user:debug-pass@private-api.example.com/v1/chat/completions?api_key=query-secret#fragment-secret';
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
const observation = {
  gameId: 'debug-game',
  mode: 'spectator',
  automationMode: 'remote',
  board: '6人局：狼人×2、预言家×1、女巫×1、村民×2',
  seed: 12345,
  usedFreeProvider: false,
  day: 2,
  phase: 'voting',
  viewerPlayerId: 0,
  omniscient: false,
  players: Array.from({ length: 6 }, (_, id) => ({
    id,
    characterId: `soul-${id}`,
    name: `${id + 1}号`,
    avatarUrl: `/avatar-${id}.png`,
    alive: id !== 5,
    roleId: id === 0 ? 'villager' : null,
    skillId: id === 0 ? 'healing' : null,
    isSelf: id === 0,
  })),
  publicEvents: [],
  privateEvents: [],
  archivedTimelines: [],
  knowledge: [],
  currentVotes: [{ voterPlayerId: 1, targetPlayerId: 2, round: 1 }],
  pendingDecision,
  result: null,
};
const request = { observation, pendingDecision, sessionId: 'session-secret-must-not-export' };
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
const error = new AiCommandError('schema', '模型返回结构错误', 200, '{"unexpected":true}');
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

assert.equal(report.formatVersion, 1);
assert.match(report.appVersion, /^\d+\.\d+\.\d+$/);
assert.equal(report.game.gameId, observation.gameId);
assert.equal(report.game.seed, observation.seed);
assert.equal(report.game.players.length, 6);
assert.deepEqual(report.game.pendingDecision, pendingDecision);
assert.deepEqual(report.request.promptMessages, messages);
assert.equal(report.response.rawOutput, error.rawOutput);
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

globalThis.window = { setTimeout, clearTimeout };
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not valid decision JSON' } }] }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});
let requestError = null;
try {
  await requestDecision(request, { ...config, retryCount: 0 }, new AbortController().signal);
} catch (caught) {
  requestError = caught;
}
assert.ok(requestError instanceof AiCommandError);
assert.equal(requestError.kind, 'json');
assert.equal(requestError.rawOutput, 'not valid decision JSON');
assert.ok(requestError.debugReport);
assert.equal(requestError.debugReport.error.attempt, 1);
assert.equal(requestError.debugReport.error.maxAttempts, 1);
assert.equal(requestError.debugReport.response.rawOutput, 'not valid decision JSON');
assert.equal(requestError.debugReport.request.provider.apiKey, `[REDACTED; length=${secret.length}]`);
assert.equal(formatAiDebugReport(requestError.debugReport).includes(secret), false);

console.log('AI debug report smoke passed');
