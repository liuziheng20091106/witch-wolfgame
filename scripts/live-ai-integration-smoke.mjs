#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const vite = await createViteServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let buildDecisionPrompt;
let createGame;
let fallbackDecision;
let reduceGame;
let selectObservation;
let requestDecision;
try {
  ({ buildDecisionPrompt } = await vite.ssrLoadModule('/src/ai/prompts.ts'));
  ({ createGame } = await vite.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ fallbackDecision } = await vite.ssrLoadModule('/src/ai/fallback.ts'));
  ({ reduceGame } = await vite.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ selectObservation } = await vite.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ requestDecision } = await vite.ssrLoadModule('/src/ai/client.ts'));
} finally {
  await vite.close();
}

globalThis.window = { setTimeout, clearTimeout };
const configPath = process.env.OMP_AI_CONFIG_FILE ?? `${process.env.USERPROFILE ?? ''}/.omp/agent/models.yml`;
const providerName = process.env.OMP_AI_PROVIDER ?? 'NOFX';
const configText = readFileSync(configPath, 'utf8');
const configLines = configText.split(/\r?\n/);
let inProviders = false;
let providerBlock = '';
for (const line of configLines) {
  if (/^providers:\s*$/.test(line)) { inProviders = true; continue; }
  if (inProviders && /^\S/.test(line)) break;
  if (inProviders && new RegExp(`^  ${providerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$`).test(line)) { providerBlock = []; continue; }
  if (inProviders && Array.isArray(providerBlock) && /^  \S/.test(line)) break;
  if (inProviders && Array.isArray(providerBlock)) providerBlock.push(line);
}
providerBlock = Array.isArray(providerBlock) ? providerBlock.join('\n') : providerBlock;
const upstreamBaseUrl = (process.env.OMP_AI_BASE_URL ?? providerBlock.match(/^    baseUrl:\s*(\S+)/m)?.[1] ?? '').trim().replace(/\/+$/, '');
const upstreamApiKey = (process.env.OMP_AI_API_KEY ?? providerBlock.match(/^    apiKey:\s*(\S+)/m)?.[1] ?? '').trim();
const model = (process.env.OMP_AI_MODEL ?? 'gpt-5.6-sol').trim();
assert.ok(upstreamBaseUrl && upstreamApiKey, '真实 AI 烟测需要 OMP 配置中的提供商端点和密钥');

const proxy = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(request.url === '/healthz' ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: request.url === '/healthz' }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const upstream = await fetch(`${upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstreamApiKey}` },
    body: Buffer.concat(chunks),
  });
  response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
  response.end(Buffer.from(await upstream.arrayBuffer()));
});
await new Promise((resolvePromise) => proxy.listen(0, '127.0.0.1', resolvePromise));
const address = proxy.address();
assert.ok(address && typeof address === 'object');
const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
const evidenceDir = resolve(root, '.runtime', 'ai-evidence');
const evidenceFile = process.env.AI_EVIDENCE_FILE ?? 'live-ai-decisions.json';
await mkdir(evidenceDir, { recursive: true });

function initialGame(playerCount) {
  return createGame({ mode: 'spectator', humanCharacterId: null, playerCount, selectedCharacterIds: [], seed: 20260829 });
}
function summarizeDecision(pending, decision) {
  if (pending.schemaKey === 'speech') return { text: decision.speech, length: decision.speech.length };
  if (pending.schemaKey === 'wolf-council') return { text: decision.message, length: decision.message.length, targetPlayerId: decision.recommendedTargetPlayerId };
  if ('targetPlayerId' in decision) return { targetPlayerId: decision.targetPlayerId };
  if (pending.schemaKey === 'witch') return { save: decision.save, poisonTargetPlayerId: decision.poisonTargetPlayerId };
  if ('use' in decision) return { use: decision.use, mode: decision.mode ?? null, targetPlayerId: decision.targetPlayerId ?? null };
  return {};
}

async function aiAdvance(game, sessionId, responseLog) {
  let current = game;
  let guard = 0;
  while (current.pendingDecision === null && current.phase !== 'ended' && guard < 8) {
    current = reduceGame(current, { type: 'advance' });
    guard += 1;
  }
  if (!current.pendingDecision) return current;
  const pending = current.pendingDecision;
  const observation = selectObservation(current, { kind: 'player', playerId: pending.actorId });
  const messages = buildDecisionPrompt({ observation, pendingDecision: pending, sessionId }, 'custom');
  const decision = await requestDecision(
    { observation, pendingDecision: pending, sessionId },
    { provider: 'custom', endpoint, apiKey: 'local-proxy', profiles: { default: { model, reasoningEffort: 'low' }, fast: { model, reasoningEffort: 'none' }, deep: { model, reasoningEffort: 'high' } }, retryCount: 1, jsonOutputMode: 'auto' },
    new AbortController().signal,
  );
  responseLog.push({ day: observation.day, phase: pending.kind, schema: pending.schemaKey, model, promptBytes: Buffer.byteLength(messages[1].content, 'utf8'), decision: summarizeDecision(pending, decision) });
  return reduceGame(current, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision });
}

try {
  const responseLog = [];
  for (const playerCount of [6, 14]) {
    let game = initialGame(playerCount);
    for (let step = 0; step < 160 && game.phase !== 'ended'; step += 1) {
      if (game.pendingDecision) {
        game = await aiAdvance(game, `live-${playerCount}-${step}`, responseLog);
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
      const covered = new Set(responseLog.map((entry) => entry.phase));
      if (covered.has('skill') && covered.has('wolf-suggestion') && covered.has('wolf-decision') && covered.has('witch-action') && covered.has('seer-action') && covered.has('speech') && covered.has('vote')) break;
    }
    assert.ok(responseLog.some((entry) => entry.model === model));
    assert.ok(game.publicEvents.length >= 3);
  }
  const phases = [...new Set(responseLog.map((entry) => entry.phase))];
  for (const required of ['skill', 'wolf-suggestion', 'wolf-decision', 'witch-action', 'seer-action', 'speech', 'vote']) assert.ok(phases.includes(required), `真实 AI 烟测未覆盖 ${required}`);
  await writeFile(resolve(evidenceDir, evidenceFile), JSON.stringify({ model, generatedAt: new Date().toISOString(), responses: responseLog }, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, model, requests: responseLog.length, phases }));
} finally {
  proxy.close();
}
