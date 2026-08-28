#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let continueGameWithNewRoles;
let createGame;
let fallbackDecision;
let reduceGame;
try {
  ({ continueGameWithNewRoles, createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
} finally {
  await server.close();
}

function runToEnd(state) {
  let current = state;
  let guard = 0;
  while (current.phase !== 'ended' && guard < 3000) {
    guard += 1;
    if (current.pendingDecision) {
      const fallback = fallbackDecision(current, current.pendingDecision);
      current = reduceGame(current, { type: 'set-rng-state', rngState: fallback.rngState });
      current = reduceGame(current, {
        type: 'submit-decision',
        pendingDecisionId: current.pendingDecision.id,
        actorId: current.pendingDecision.actorId,
        decision: fallback.decision,
      });
    } else {
      current = reduceGame(current, { type: 'advance' });
    }
  }
  assert.equal(current.phase, 'ended');
  return current;
}

const first = createGame({ mode: 'spectator', humanCharacterId: null, seed: 711 });
assert.equal(first.roundNumber, 1);
assert.equal(first.seriesId, first.gameId);
assert.throws(() => continueGameWithNewRoles(first), /只有已结束/);
const ended = runToEnd(first);
const continuedA = continueGameWithNewRoles(ended);
const continuedB = continueGameWithNewRoles(ended);
assert.deepEqual(continuedA, continuedB, '相同终局必须确定性生成相同下一轮');
assert.equal(continuedA.roundNumber, 2);
assert.equal(continuedA.seriesId, ended.seriesId);
assert.notEqual(continuedA.gameId, ended.gameId);
assert.equal(continuedA.phase, 'first-night');
assert.equal(continuedA.day, 0);
assert.equal(continuedA.result, null);
assert.equal(continuedA.pendingDecision, null);
assert.equal(continuedA.publicEvents.some((event) => event.text.includes('连续审判第 2 轮')), true);
assert.equal(continuedA.players.every((player) => player.alive), true);
assert.equal(continuedA.creatures.length, 0);
assert.equal(continuedA.privateEvents.length, 0);
assert.equal(continuedA.archivedTimelines.length, 0);
assert.equal(continuedA.currentVotes.length, 0);
assert.equal(continuedA.usedFreeProvider, false);
assert.equal(continuedA.automationMode, ended.automationMode);
assert.deepEqual(
  continuedA.players.map((player) => player.characterId),
  ended.players.slice().sort((left, right) => left.id - right.id).map((player) => player.characterId),
  '连续审判必须保留参赛角色和座位',
);
assert.notDeepEqual(
  continuedA.roleAssignments.map((assignment) => assignment.roleId),
  ended.roleAssignments.map((assignment) => assignment.roleId),
  '连续审判必须重新分配职业',
);

const playerFirst = createGame({ mode: 'player', humanCharacterId: 'soul-0', seed: 712 });
const playerEnded = runToEnd(playerFirst);
const playerContinued = continueGameWithNewRoles(playerEnded);
assert.equal(playerContinued.humanPlayerId, playerEnded.humanPlayerId);
assert.equal(
  playerContinued.players.find((player) => player.id === playerContinued.humanPlayerId)?.characterId,
  'soul-0',
);

console.log('PASS 连续审判重新分配身份验证全部通过');
