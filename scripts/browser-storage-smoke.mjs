#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let APP_VERSION;
let GAME_KEY;
let SETTINGS_KEY;
let createGame;
let reduceGame;
let getSavedGameCompatibilityWarning;
let loadSettings;
let loadGame;
let saveGame;
let saveSettings;
try {
  ({ APP_VERSION } = await server.ssrLoadModule('/src/config/version.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ GAME_KEY, SETTINGS_KEY, getSavedGameCompatibilityWarning, loadGame, loadSettings, saveGame, saveSettings } = await server.ssrLoadModule('/src/storage/browserStorage.ts'));
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

const currentProfiles = {
  provider: 'custom',
  endpoint: 'https://example.com/v1/chat/completions',
  apiKey: 'test-key',
  profiles: {
    default: { model: 'default-model', reasoningEffort: 'low' },
    fast: { model: 'fast-model', reasoningEffort: 'none' },
    deep: { model: 'deep-model', reasoningEffort: 'max' },
  },
  retryCount: 3,
  jsonOutputMode: 'auto',
};
saveSettings(currentProfiles);
assert.deepEqual(loadSettings(), { ok: true, value: currentProfiles });

localStorage.setItem(SETTINGS_KEY, JSON.stringify({
  provider: 'custom',
  endpoint: 'https://legacy.example.com/v1/chat/completions',
  apiKey: 'legacy-key',
  model: 'legacy-model',
  reasoningEffort: 'low',
  retryCount: 4,
  jsonOutputMode: 'force',
}));
const migratedSettings = loadSettings();
assert.equal(migratedSettings.ok, true);
assert.equal(migratedSettings.value.profiles.default.model, 'legacy-model');
assert.equal(migratedSettings.value.profiles.default.reasoningEffort, 'low');
assert.equal(migratedSettings.value.profiles.fast.reasoningEffort, 'none');
assert.equal(migratedSettings.value.profiles.deep.reasoningEffort, 'high');
assert.equal(migratedSettings.value.retryCount, 4);
assert.equal(migratedSettings.value.jsonOutputMode, 'force');
localStorage.setItem(SETTINGS_KEY, JSON.stringify({
  endpoint: 'https://oldest.example.com/v1/chat/completions',
  apiKey: 'oldest-key',
  model: 'oldest-model',
}));
const oldestSettings = loadSettings();
assert.equal(oldestSettings.ok, true);
assert.equal(oldestSettings.value.profiles.default.model, 'oldest-model');
assert.equal(oldestSettings.value.profiles.default.reasoningEffort, 'low');

localStorage.setItem(SETTINGS_KEY, JSON.stringify({
  provider: 'custom',
  endpoint: 'https://single.example.com/v1/chat/completions',
  apiKey: 'single-key',
  model: 'single-model',
}));
const singleSettings = loadSettings();
assert.equal(singleSettings.ok, true);
assert.equal(singleSettings.value.profiles.default.reasoningEffort, 'low');

const game = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 6, selectedCharacterIds: [], seed: 58 });
const saved = saveGame(game, APP_VERSION);
assert.equal(saved.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(saved), null);
const currentResult = loadGame();
assert.equal(currentResult.ok, true);
assert.notEqual(currentResult.value, null);
assert.equal(currentResult.value.appVersion, APP_VERSION);
assert.equal(currentResult.value.state.aiFailureOccurred, false);
assert.equal(currentResult.value.state.lastAiFailure, null);
assert.equal(getSavedGameCompatibilityWarning(currentResult.value), null);

const mismatched = { ...saved, appVersion: '0.0.0' };
localStorage.setItem(GAME_KEY, JSON.stringify(mismatched));
const mismatchedResult = loadGame();
assert.equal(mismatchedResult.ok, true);
assert.notEqual(mismatchedResult.value, null);
assert.match(getSavedGameCompatibilityWarning(mismatchedResult.value), /v0\.0\.0/);
assert.match(getSavedGameCompatibilityWarning(mismatchedResult.value), new RegExp(`v${APP_VERSION.replaceAll('.', '\\.')}`));
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

const largeGame = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 14, selectedCharacterIds: [], seed: 1414 });
largeGame.creatures.push({ id: 99, ownerPlayerId: 0, characterId: largeGame.players[0].characterId, roleAssignmentId: 'role-creature-99', alive: true, resources: {} });
largeGame.roleAssignments.push({ id: 'role-creature-99', ownerPlayerId: 99, roleId: 'villager', resources: {} });
saveGame(largeGame, APP_VERSION);
const largeResult = loadGame();
assert.equal(largeResult.ok, true, '14 人局加造物的 15 个职业实体必须能保存和恢复');
assert.equal(largeResult.value.state.players.length, 14);
assert.equal(largeResult.value.state.creatures.length, 1);
assert.equal(largeResult.value.state.roleAssignments.length, 15);
assert.equal(largeResult.value.state.skillInstances.length, 14);
const duplicateSeat = structuredClone(saved);
duplicateSeat.state.players[1].id = duplicateSeat.state.players[0].id;
localStorage.setItem(GAME_KEY, JSON.stringify(duplicateSeat));
assert.equal(loadGame().ok, false, '重复或非连续席位存档必须拒绝');
const missingAssignment = structuredClone(saved);
missingAssignment.state.roleAssignments.pop();
localStorage.setItem(GAME_KEY, JSON.stringify(missingAssignment));
assert.equal(loadGame().ok, false, '缺失职业分配的存档必须拒绝');
saveGame(game, APP_VERSION);
assert.match(getSavedGameCompatibilityWarning(legacyResaved), /未记录创建版本/);

const legacyFailureState = structuredClone(saved);
delete legacyFailureState.state.aiFailureOccurred;
delete legacyFailureState.state.lastAiFailure;
localStorage.setItem(GAME_KEY, JSON.stringify(legacyFailureState));
const migratedFailureResult = loadGame();
assert.equal(migratedFailureResult.ok, true);
assert.equal(migratedFailureResult.value.state.aiFailureOccurred, false);
assert.equal(migratedFailureResult.value.state.lastAiFailure, null);

let failedGame = structuredClone(game);
while (failedGame.pendingDecision === null && failedGame.phase !== 'ended') failedGame = reduceGame(failedGame, { type: 'advance' });
const pending = failedGame.pendingDecision;
assert.notEqual(pending, null);
const failure = { kind: 'network', message: 'Failed to fetch', pendingDecisionId: pending.id, actorId: pending.actorId };
const failedState = reduceGame(failedGame, { type: 'mark-ai-failure', failure });
saveGame(failedState, APP_VERSION);
const failedGameResult = loadGame();
assert.equal(failedGameResult.ok, true);
assert.equal(failedGameResult.value.state.aiFailureOccurred, true);
assert.deepEqual(failedGameResult.value.state.lastAiFailure, { ...failure, day: failedGame.day, phase: failedGame.phase });

const restartedGame = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: 6, selectedCharacterIds: [], seed: 58 });
assert.equal(restartedGame.gameId, game.gameId);
const restartedSaved = saveGame(restartedGame, APP_VERSION);
assert.equal(restartedSaved.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(restartedSaved), null);

console.log('PASS 存档版本兼容性验证全部通过');
