import { beforeEach, describe, expect, it } from 'vitest';
import { defaultAiConfig } from '../ai/types';
import { createGame } from '../domain/engine/createGame';
import type { PendingDecision } from '../domain/model';
import {
  GAME_KEY,
  SETTINGS_KEY,
  clearCorruptedValue,
  loadGame,
  loadSettings,
  loadSetup,
  saveGame,
  saveSettings,
  saveSetup,
} from './browserStorage';

describe('版本化浏览器存储', () => {
  beforeEach(() => localStorage.clear());

  it('长期保存完整 AI 设置，包括 API Key 与默认 low', () => {
    const settings = { ...defaultAiConfig, apiKey: 'browser-secret', model: 'model-a' };
    saveSettings(settings);
    expect(loadSettings()).toEqual({ ok: true, value: settings });
    expect(localStorage.getItem(SETTINGS_KEY)).toContain('browser-secret');
    expect(localStorage.getItem(SETTINGS_KEY)).toContain('"reasoningEffort":"low"');
  });

  it('恢复待处理决策、随机状态与私密知识', () => {
    const state = createGame({ mode: 'player', humanCharacterId: 'soul-0', seed: 1 });
    const pending: PendingDecision = {
      id: 'waiting-vote', kind: 'vote', schemaKey: 'target', actorId: 0, title: '公开投票', description: '等待玩家',
      candidates: [1, 2], allowAbstain: true, skillInstanceId: null, options: {},
    };
    state.pendingDecision = pending;
    state.rngState = 123456;
    saveGame(state);
    const loaded = loadGame();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.value) throw new Error('存档读取失败');
    expect(loaded.value.state.pendingDecision).toEqual(pending);
    expect(loaded.value.state.rngState).toBe(123456);
    expect(loaded.value.state.knowledgeByPlayer[0]).toEqual(state.knowledgeByPlayer[0]);
    expect(JSON.stringify(loaded.value.state)).not.toContain('browser-secret');
  });

  it('保存并恢复准备区模式、角色与种子', () => {
    const setup = { mode: 'player' as const, humanCharacterId: 'soul-7' as const, seed: 99 };
    saveSetup(setup);
    expect(loadSetup()).toEqual({ ok: true, value: setup });
  });

  it('拒绝损坏或旧版本值，且只在明确清除时删除', () => {
    localStorage.setItem(GAME_KEY, '{broken');
    const corrupted = loadGame();
    expect(corrupted.ok).toBe(false);
    expect(localStorage.getItem(GAME_KEY)).toBe('{broken');
    clearCorruptedValue(GAME_KEY);
    expect(localStorage.getItem(GAME_KEY)).toBeNull();

    localStorage.setItem(GAME_KEY, JSON.stringify({ schemaVersion: 0, savedAt: new Date().toISOString(), state: {} }));
    expect(loadGame().ok).toBe(false);
  });
});
