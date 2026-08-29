#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const evidenceDir = resolve(root, '.runtime', 'ai-evidence');
await mkdir(evidenceDir, { recursive: true });
const vite = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame;
let fallbackDecision;
let reduceGame;
let selectObservation;
let buildDecisionPrompt;
try {
  ({ createGame } = await vite.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ fallbackDecision } = await vite.ssrLoadModule('/src/ai/fallback.ts'));
  ({ reduceGame } = await vite.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ selectObservation } = await vite.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ buildDecisionPrompt } = await vite.ssrLoadModule('/src/ai/prompts.ts'));
} finally {
  await vite.close();
}

async function capture(name, payload) {
  await writeFile(resolve(evidenceDir, `${name}.json`), JSON.stringify(payload, null, 2), 'utf8');
}
function advanceLocal(game) {
  let current = game;
  let guard = 0;
  while (!current.pendingDecision && current.phase !== 'ended' && guard < 20) {
    current = reduceGame(current, { type: 'advance' });
    guard += 1;
  }
  if (!current.pendingDecision) return current;
  const fallback = fallbackDecision(current, current.pendingDecision);
  return reduceGame(
    reduceGame(current, { type: 'set-rng-state', rngState: fallback.rngState }),
    { type: 'submit-decision', pendingDecisionId: current.pendingDecision.id, actorId: current.pendingDecision.actorId, decision: fallback.decision },
  );
}

const six = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 6, selectedCharacterIds: [], seed: 610 });
await capture('six-initial', { phase: six.phase, playerCount: six.players.length, board: six.board, events: six.publicEvents.length });
const sixStep = advanceLocal(six);
await capture('six-step', { phase: sixStep.phase, day: sixStep.day, pending: sixStep.pendingDecision?.kind ?? null, events: sixStep.publicEvents.length });
const fourteen = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 14, selectedCharacterIds: [], seed: 1410 });
await capture('fourteen-initial', { phase: fourteen.phase, playerCount: fourteen.players.length, board: fourteen.board, events: fourteen.publicEvents.length });
const fourteenStep = advanceLocal(fourteen);
await capture('fourteen-step', { phase: fourteenStep.phase, day: fourteenStep.day, playerCount: fourteenStep.players.length, pending: fourteenStep.pendingDecision?.kind ?? null });
const player = createGame({ mode: 'player', humanCharacterId: 'soul-0', playerCount: 6, selectedCharacterIds: [], seed: 711 });
await capture('player-initial', { humanPlayerId: player.humanPlayerId, phase: player.phase, pending: player.pendingDecision?.kind ?? null });
const playerObservation = selectObservation(player, { kind: 'player', playerId: player.humanPlayerId });
assert.equal(playerObservation.omniscient, false);
await capture('player-observation', { viewerPlayerId: playerObservation.viewerPlayerId, omniscient: playerObservation.omniscient, roleVisible: playerObservation.players.find((entry) => entry.isSelf)?.roleId ?? null });
const prompt = buildDecisionPrompt({ observation: playerObservation, pendingDecision: player.pendingDecision ?? { kind: 'speech', schemaKey: 'speech', actorId: player.humanPlayerId, id: 'evidence', title: '发言', description: '', candidates: [], allowAbstain: false, options: {} }, sessionId: 'visual-evidence' }, 'custom');
await capture('prompt-sample', { systemLength: prompt[0].content.length, userLength: prompt[1].content.length, systemHead: prompt[0].content.slice(0, 180) });
console.log(`PASS visual evidence written to ${evidenceDir}`);
