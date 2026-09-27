#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';

// Record on the original revision, then check the same file after a refactor.
// Hash every transition and every viewer's projection, including post-game.
const [mode, file] = process.argv.slice(2);
assert.ok((mode === '--record' || mode === '--check') && file,
  'Usage: node scripts/verify-refactor-equivalence.mjs --record|--check <baseline.json>');
const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, reduceGame, fallbackDecision, selectObservation;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  await server.close();
}

const results = [];
for (let playerCount = 6; playerCount <= 14; playerCount += 1) {
  for (let index = 0; index < 12; index += 1) {
    const seed = 1000 + playerCount * 100 + index;
    let state = createGame({ mode: 'spectator', humanCharacterId: null, seed, playerCount, selectedCharacterIds: [] });
    const hash = createHash('sha256');
    const decisions = new Set();
    let steps = 0;
    const capture = () => {
      hash.update(JSON.stringify(state));
      hash.update('\n');
      for (const player of [...state.players, ...state.creatures]) {
        hash.update(JSON.stringify(selectObservation(state, { kind: 'player', playerId: player.id })));
        hash.update('\n');
      }
      hash.update(JSON.stringify(selectObservation(state, { kind: 'spectator' })));
      hash.update('\n');
    };
    capture();
    while (true) {
      assert.ok(++steps <= 6000, `Game did not finish: ${playerCount}/${seed}`);
      if (state.pendingDecision) {
        const pending = state.pendingDecision;
        decisions.add(`${pending.kind}:${pending.title}`);
        const fallback = fallbackDecision(state, pending);
        hash.update(JSON.stringify(fallback));
        state = reduceGame(state, { type: 'set-rng-state', rngState: fallback.rngState });
        capture();
        state = reduceGame(state, {
          type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fallback.decision,
        });
      } else {
        const previous = state;
        state = reduceGame(state, { type: 'advance' });
        if (previous.phase === 'post-game' && !state.pendingDecision) {
          capture();
          break;
        }
      }
      capture();
    }
    results.push({ playerCount, seed, steps, decisions: [...decisions].sort(), digest: hash.digest('hex') });
  }
  console.log(`Captured ${playerCount}-player games`);
}
if (mode === '--record') {
  await writeFile(resolve(file), `${JSON.stringify(results, null, 2)}\n`);
} else {
  const baseline = JSON.parse(await readFile(resolve(file), 'utf8'));
  assert.deepEqual(results, baseline, 'State, observations, RNG, decisions or event order changed');
}
console.log(`${mode === '--record' ? 'Recorded' : 'Matched'} ${results.length} deterministic game traces`);
