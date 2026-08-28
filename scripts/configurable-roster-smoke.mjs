#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import {
  CHARACTER_CATALOG,
  formatBoardDescription,
  rolePoolForPlayerCount,
} from '../shared/gamePromptContract.js';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let buildDecisionPrompt;
let createGame;
let reduceGame;
let selectObservation;
try {
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  await server.close();
}

for (const playerCount of [6, 10, 14]) {
  const setup = { mode: 'spectator', humanCharacterId: null, playerCount, selectedCharacterIds: [], seed: 20260828 };
  const first = createGame(setup);
  const second = createGame(setup);
  assert.deepEqual(first, second, `${playerCount} 人局必须可由种子确定性复现`);
  assert.equal(first.players.length, playerCount);
  assert.equal(new Set(first.players.map((player) => player.characterId)).size, playerCount);
  assert.deepEqual(first.players.map((player) => player.id), Array.from({ length: playerCount }, (_, index) => index));
  const expectedRolePool = rolePoolForPlayerCount(playerCount);
  assert.equal(first.board, formatBoardDescription(expectedRolePool));
  const actualRoleCounts = Object.groupBy(first.roleAssignments, (assignment) => assignment.roleId);
  const expectedRoleCounts = Object.groupBy(expectedRolePool, (roleId) => roleId);
  for (const roleId of ['wolf', 'seer', 'witch', 'villager']) {
    assert.equal(actualRoleCounts[roleId]?.length ?? 0, expectedRoleCounts[roleId]?.length ?? 0);
  }
  assert.equal(first.speechOrder.length, playerCount);
  assert.equal(Object.keys(first.knowledgeByPlayer).length, playerCount + 1);
}

const explicitCharacterIds = CHARACTER_CATALOG.slice(2, 12).map((character) => character.id);
const explicitSetup = {
  mode: 'player',
  humanCharacterId: explicitCharacterIds[3],
  playerCount: 10,
  selectedCharacterIds: explicitCharacterIds,
  seed: 91,
};
const explicitGame = createGame(explicitSetup);
assert.deepEqual(new Set(explicitGame.players.map((player) => player.characterId)), new Set(explicitCharacterIds));
assert.equal(explicitGame.players.find((player) => player.id === explicitGame.humanPlayerId)?.characterId, explicitSetup.humanCharacterId);
assert.throws(
  () => createGame({ ...explicitSetup, humanCharacterId: CHARACTER_CATALOG[0].id }),
  /必须包含在出庭阵容/,
);
assert.throws(
  () => createGame({ ...explicitSetup, selectedCharacterIds: explicitCharacterIds.slice(0, 9) }),
  /必须选择 10 名/,
);

let protocolGame = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 14, selectedCharacterIds: [], seed: 314 });
let guard = 0;
while (protocolGame.pendingDecision === null && guard < 50) {
  protocolGame = reduceGame(protocolGame, { type: 'advance' });
  guard += 1;
}
assert.notEqual(protocolGame.pendingDecision, null);
const observation = selectObservation(protocolGame, { kind: 'spectator' });
const promptMessages = buildDecisionPrompt({ observation, pendingDecision: protocolGame.pendingDecision, sessionId: 'roster-protocol' });
assert.deepEqual(validateGamePrompt(promptMessages), { ok: true }, '14 人提示必须通过后端协议');
const mismatchedMessages = structuredClone(promptMessages);
const mismatchedPrompt = JSON.parse(mismatchedMessages[1].content);
mismatchedPrompt.board = formatBoardDescription(rolePoolForPlayerCount(10));
mismatchedMessages[1].content = JSON.stringify(mismatchedPrompt);
assert.deepEqual(validateGamePrompt(mismatchedMessages), { ok: false, reason: 'board_player_count', path: 'board' });

console.log('PASS 可配置 6–14 人阵容验证全部通过');
