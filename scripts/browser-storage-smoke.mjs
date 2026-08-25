#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let APP_VERSION;
let GAME_KEY;
let createGame;
let getSavedGameCompatibilityWarning;
let loadGame;
let saveGame;
try {
  ({ APP_VERSION } = await server.ssrLoadModule('/src/config/version.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ GAME_KEY, getSavedGameCompatibilityWarning, loadGame, saveGame } = await server.ssrLoadModule('/src/storage/browserStorage.ts'));
} finally {
  await server.close();
}

const values = new Map();
globalThis.localStorage = {
  getItem(key) {
    if (values.has(key)) return values.get(key);
    return null;
  },
  setItem(key, value) {
    values.set(key, value);
  },
  removeItem(key) {
    values.delete(key);
  },
};

const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 58 });
const saved = saveGame(game, APP_VERSION);
assert.equal(saved.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(saved), null);
const currentResult = loadGame();
assert.equal(currentResult.ok, true);
assert.notEqual(currentResult.value, null);
assert.equal(currentResult.value.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(currentResult.value), null);

const mismatched = { ...saved, appVersion: '0.0.0' };
localStorage.setItem(GAME_KEY, JSON.stringify(mismatched));
const mismatchedResult = loadGame();
assert.equal(mismatchedResult.ok, true);
assert.notEqual(mismatchedResult.value, null);
assert.match(getSavedGameCompatibilityWarning(mismatchedResult.value), /v0\.0\.0/);
assert.match(getSavedGameCompatibilityWarning(mismatchedResult.value), new RegExp(`v${APP_VERSION.replaceAll('.', '\\.')}\\b`));
const mismatchedResaved = saveGame(mismatchedResult.value.state, mismatchedResult.value.appVersion);
assert.equal(mismatchedResaved.appVersion, '0.0.0');
assert.match(getSavedGameCompatibilityWarning(mismatchedResaved), /v0\.0\.0/);

const legacy = { ...saved };
delete legacy.appVersion;
localStorage.setItem(GAME_KEY, JSON.stringify(legacy));
const legacyResult = loadGame();
assert.equal(legacyResult.ok, true);
assert.notEqual(legacyResult.value, null);
assert.equal(legacyResult.value.appVersion, null);
assert.match(getSavedGameCompatibilityWarning(legacyResult.value), /未记录创建版本/);
const legacyResaved = saveGame(legacyResult.value.state, legacyResult.value.appVersion);
assert.equal(legacyResaved.appVersion, null);
assert.match(getSavedGameCompatibilityWarning(legacyResaved), /未记录创建版本/);

const restartedGame = createGame({ mode: 'spectator', humanCharacterId: null, seed: 58 });
assert.equal(restartedGame.gameId, game.gameId);
const restartedSaved = saveGame(restartedGame, APP_VERSION);
assert.equal(restartedSaved.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(restartedSaved), null);

function asLegacySixPlayerSave(source) {
  const legacySave = structuredClone(source);
  const state = legacySave.state;
  delete state.seatCount;
  delete state.freeSpeechOrder;
  state.players = state.players.filter((player) => player.id < 6);
  state.roleAssignments = state.roleAssignments.filter((assignment) => assignment.ownerPlayerId < 6);
  state.skillInstances = state.skillInstances.filter((skill) => skill.ownerPlayerId < 6);
  delete state.knowledgeByPlayer[6];
  delete state.knowledgeByPlayer[7];
  state.speechOrder = state.speechOrder.filter((playerId) => playerId < 6);
  state.morningCheckpoint = null;
  state.pendingDecision = null;
  state.board = '6人局：狼人×2、预言家×1、女巫×1、村民×2';
  return legacySave;
}

const activeSixPlayer = asLegacySixPlayerSave(saved);
localStorage.setItem(GAME_KEY, JSON.stringify(activeSixPlayer));
const migratedActive = loadGame();
assert.equal(migratedActive.ok, true);
assert.equal(migratedActive.value.state.seatCount, 8);
assert.equal(migratedActive.value.state.players.length, 8);
assert.equal(migratedActive.value.state.freeSpeechOrder.length, 8);
assert.equal(migratedActive.value.state.roleAssignments.find((assignment) => assignment.ownerPlayerId === 6).roleId, 'hunter');
assert.equal(migratedActive.value.state.roleAssignments.find((assignment) => assignment.ownerPlayerId === 7).roleId, 'villager');

const endedSixPlayer = asLegacySixPlayerSave(saved);
endedSixPlayer.state.phase = 'ended';
endedSixPlayer.state.result = { winner: 'good', reason: 'wolves-eliminated', finishedDay: 2 };
localStorage.setItem(GAME_KEY, JSON.stringify(endedSixPlayer));
const preservedEnded = loadGame();
assert.equal(preservedEnded.ok, true);
assert.equal(preservedEnded.value.state.seatCount, 6);
assert.equal(preservedEnded.value.state.players.length, 6);
assert.deepEqual(preservedEnded.value.state.result, endedSixPlayer.state.result);

console.log('PASS 存档版本兼容性验证全部通过');
