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
let getSavedGameCompatibilityWarning;
let loadSettings;
let loadGame;
let saveGame;
let saveSettings;
try {
  ({ APP_VERSION } = await server.ssrLoadModule('/src/config/version.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
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

const restartedGame = createGame({ mode: 'spectator', humanCharacterId: null, seed: 58, playerCount: 6, selectedCharacterIds: [] });
assert.equal(restartedGame.gameId, game.gameId);
const restartedSaved = saveGame(restartedGame, APP_VERSION);
assert.equal(restartedSaved.appVersion, APP_VERSION);
assert.equal(getSavedGameCompatibilityWarning(restartedSaved), null);

console.log('PASS 存档版本兼容性验证全部通过');
