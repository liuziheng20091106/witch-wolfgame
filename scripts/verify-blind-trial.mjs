#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const server = await createServer({ root: resolve(import.meta.dirname, '..'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, selectObservation, formatCaseFile, saveGame, loadGame;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ formatCaseFile } = await server.ssrLoadModule('/src/app/caseFile.ts'));
  ({ saveGame, loadGame } = await server.ssrLoadModule('/src/storage/browserStorage.ts'));
} finally {
  await server.close();
}

const values = new Map();
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};

const state = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 6, selectedCharacterIds: [], seed: 123 });
assert.equal(selectObservation(state, { kind: 'blind' }).phase, 'night-skills');
state.phase = 'voting';
state.day = 1;
state.currentVotes = [{ voterPlayerId: 0, targetPlayerId: 1, round: 1 }];
state.publicEvents.push({
  id: 'forged', kind: 'speech', day: 1, phase: 'speeches', text: '公开的发言',
  actorPlayerId: 0, targetPlayerIds: [0], displayAuthorPlayerId: 0, actualAuthorPlayerId: 2,
  data: { hasForgedFragment: true, forgedSpeech: '隐藏片段' },
});
state.privateEvents.push({ ...state.publicEvents[0], id: 'secret', text: '狼队秘密', viewerPlayerIds: [1, 2] });
state.pendingDecision = { id: 'secret-decision', kind: 'wolf-decision', schemaKey: 'target', actorId: 1, title: '狼队袭击', description: '', candidates: [0], allowAbstain: false, skillInstanceId: null, options: {} };
const blind = selectObservation(state, { kind: 'blind' });
const playerView = selectObservation(state, { kind: 'player', playerId: 0 });
assert.notEqual(playerView.players[1].skillId, null);
assert.equal(blind.seed, 0);
assert.equal(blind.omniscient, false);
assert.equal(blind.players.every((player) => player.roleId === null && player.skillId === null), true);
assert.deepEqual(blind.privateEvents, []);
assert.deepEqual(blind.currentVotes, []);
assert.equal(blind.pendingDecision, null);
const forged = blind.publicEvents.find((event) => event.id === 'forged');
assert.equal(forged.text, '公开的发言');
assert.equal(forged.displayAuthorPlayerId, 0);
assert.equal(forged.actualAuthorPlayerId, null);
assert.equal(forged.actorPlayerId, null);
assert.deepEqual(forged.data, {});

const notes = { suspects: { 0: { suspicion: 'wolf', reason: '前后矛盾', evidenceIds: ['forged'] } }, snapshots: [{ day: 1, round: 1, notes: { 0: { suspicion: 'wolf', reason: '前后矛盾', evidenceIds: ['forged'] } } }] };
saveGame(state, null, true, notes);
const restored = loadGame();
assert.equal(restored.ok, true);
assert.equal(restored.value?.blindTrial, true);
assert.equal(restored.value?.caseNotes.suspects['0'].reason, '前后矛盾');
state.phase = 'ended';
state.result = { winner: 'good', reason: 'wolves-eliminated', finishedDay: 1 };
assert.equal(selectObservation(state, { kind: 'blind' }).players.every((player) => player.roleId !== null), true);
const file = formatCaseFile(state, notes);
assert.match(file, /案件卷宗/);
assert.match(file, /前后矛盾/);
assert.match(file, /公开的发言/);
assert.match(file, /狼队秘密/);
assert.doesNotMatch(file, /"roleAssignments"/);
console.log('PASS 盲审隐私、存档和人类可读卷宗');
