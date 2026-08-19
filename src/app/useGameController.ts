import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fallbackDecision } from '../ai/fallback';
import { requestDecision } from '../ai/client';
import { AiCommandError, defaultAiConfig, type AiProviderConfig } from '../ai/types';
import { createGame } from '../domain/engine/createGame';
import { reduceGame } from '../domain/engine/reducer';
import { selectObservation } from '../domain/engine/selectors';
import type { GameEvent, GameObservation, GameState, SubmittedDecision } from '../domain/model';
import {
  clearSavedGame,
  clearHistory as clearStoredHistory,
  loadGame,
  loadHistory,
  loadSessionId,
  loadSettings,
  loadSetup,
  saveGame,
  saveHistory,
  saveSettings,
  saveSetup,
  type GameHistoryEntry,
  type SavedGameEnvelope,
  type SetupPreferences,
} from '../storage/browserStorage';

export type AppView = 'setup' | 'game';

export interface GameController {
  view: AppView;
  game: GameState | null;
  observation: GameObservation | null;
  savedGame: SavedGameEnvelope | null;
  history: GameHistoryEntry[];
  settings: AiProviderConfig;
  setup: SetupPreferences;
  storageError: string | null;
  historyError: string | null;
  aiError: AiCommandError | null;
  decisionError: string | null;
  awaitingRetry: boolean;
  thinking: boolean;
  paused: boolean;
  settingsOpen: boolean;
  setSettingsOpen(open: boolean): void;
  updateSetup(next: SetupPreferences): void;
  saveAiSettings(next: AiProviderConfig): void;
  startNewGame(): void;
  continueSavedGame(): void;
  returnToSetup(): void;
  discardSavedGame(): void;
  clearHistory(): void;
  submitHumanDecision(decision: SubmittedDecision): void;
  retryAi(): void;
  useLocalFallback(): void;
  setPaused(paused: boolean): void;
}

interface InitialBrowserState {
  settings: AiProviderConfig;
  setup: SetupPreferences;
  savedGame: SavedGameEnvelope | null;
  history: GameHistoryEntry[];
  historyError: string | null;
  error: string | null;
}

function readInitialBrowserState(): InitialBrowserState {
  const settingsResult = loadSettings();
  const setupResult = loadSetup();
  const gameResult = loadGame();
  const historyResult = loadHistory();
  const errors = [settingsResult, setupResult, gameResult]
    .filter((result) => !result.ok)
    .map((result) => result.ok ? '' : result.error);
  return {
    settings: settingsResult.ok && settingsResult.value ? settingsResult.value : defaultAiConfig,
    setup: setupResult.ok && setupResult.value ? setupResult.value : { mode: 'spectator', humanCharacterId: null, seed: 1, randomSeed: true },
    savedGame: gameResult.ok ? gameResult.value : null,
    history: historyResult.ok && historyResult.value ? historyResult.value : [],
    historyError: historyResult.ok ? null : historyResult.error,
    error: errors[0] ?? null,
  };
}

export function rollSeed(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
}

export function useGameController(): GameController {
  const [initial] = useState(readInitialBrowserState);
  const [view, setView] = useState<AppView>('setup');
  const [game, setGame] = useState<GameState | null>(null);
  const gameRef = useRef<GameState | null>(null);
  const [savedGame, setSavedGame] = useState<SavedGameEnvelope | null>(initial.savedGame);
  const [settings, setSettings] = useState(initial.settings);
  const [setup, setSetup] = useState(initial.setup);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const [aiError, setAiError] = useState<AiCommandError | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [awaitingRetry, setAwaitingRetry] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(initial.historyError);
  const [history, setHistory] = useState<GameHistoryEntry[]>(initial.history);
  const historyRef = useRef<GameHistoryEntry[]>(initial.history);
  const sessionIdRef = useRef(loadSessionId());
  const activeRequestRef = useRef<string | null>(null);

  const commit = useCallback((next: GameState) => {
    const prev = gameRef.current;
    gameRef.current = next;
    setGame(next);
    try {
      setSavedGame(saveGame(next));
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '保存游戏失败');
    }
    // 对局结束（phase 首次变为 ended）时记入对局历史，按 gameId 去重，最多保留 50 条
    if (prev?.phase !== 'ended' && next.phase === 'ended' && next.result) {
      const entry: GameHistoryEntry = {
        gameId: next.gameId,
        seed: next.seed,
        finishedDay: next.result.finishedDay,
        winner: next.result.winner,
        finishedAt: new Date().toISOString(),
      };
      const updated = [entry, ...historyRef.current.filter((item) => item.gameId !== entry.gameId)].slice(0, 50);
      historyRef.current = updated;
      setHistory(updated);
      try {
        saveHistory(updated);
        setHistoryError(null);
      } catch (error) {
        setHistoryError(error instanceof Error ? `对局历史保存失败：${error.message}` : '对局历史保存失败');
      }
    }
  }, []);

  const dispatch = useCallback((event: GameEvent, expectedPendingId?: string) => {
    const current = gameRef.current;
    if (!current || (expectedPendingId && current.pendingDecision?.id !== expectedPendingId)) return;
    try {
      commit(reduceGame(current, event));
      setDecisionError(null);
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : '决策无法提交');
    }
  }, [commit]);

  const observation = useMemo(() => {
    if (!game) return null;
    return game.mode === 'spectator'
      ? selectObservation(game, { kind: 'spectator' })
      : selectObservation(game, { kind: 'player', playerId: game.humanPlayerId ?? 0 });
  }, [game]);

  useEffect(() => {
    if (view !== 'game' || !game || game.phase === 'ended' || paused || aiError || awaitingRetry) return;
    const pending = game.pendingDecision;
    if (!pending) {
      const timer = window.setTimeout(() => dispatch({ type: 'advance' }), 460);
      return () => window.clearTimeout(timer);
    }
    if (game.mode === 'player' && pending.actorId === game.humanPlayerId) return;

    const requestKey = `${game.gameId}:${pending.id}:${game.automationMode}`;
    if (activeRequestRef.current === requestKey) return;
    const controller = new AbortController();
    let disposed = false;
    activeRequestRef.current = requestKey;

    if (game.automationMode === 'local') {
      const timer = window.setTimeout(() => {
        const current = gameRef.current;
        if (!current || current.pendingDecision?.id !== pending.id) return;
        try {
          const fallback = fallbackDecision(current, pending);
          let next = reduceGame(current, { type: 'set-rng-state', rngState: fallback.rngState });
          next = reduceGame(next, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fallback.decision });
          commit(next);
        } catch (error) {
          setDecisionError(error instanceof Error ? error.message : '本地策略无法完成决策');
        } finally {
          activeRequestRef.current = null;
        }
      }, 580);
      return () => {
        disposed = true;
        window.clearTimeout(timer);
        if (activeRequestRef.current === requestKey) activeRequestRef.current = null;
      };
    }

    setThinking(true);
    const actorObservation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    void requestDecision({ observation: actorObservation, pendingDecision: pending, sessionId: sessionIdRef.current }, settings, controller.signal)
      .then((decision) => {
        if (disposed) return;
        const current = gameRef.current;
        if (!current || current.pendingDecision?.id !== pending.id) return;
        const marked = settings.provider === 'free' ? reduceGame(current, { type: 'mark-free-provider-used' }) : current;
        commit(reduceGame(marked, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision }));
      })
      .catch((error: unknown) => {
        if (disposed || controller.signal.aborted) return;
        const commandError = error instanceof AiCommandError ? error : new AiCommandError('network', error instanceof Error ? error.message : '未知 AI 错误');
        dispatch({ type: 'record-ai-error', message: commandError.message }, pending.id);
        setAiError(commandError);
      })
      .finally(() => {
        if (!disposed) setThinking(false);
        if (activeRequestRef.current === requestKey) activeRequestRef.current = null;
      });

    return () => {
      disposed = true;
      controller.abort();
      setThinking(false);
      if (activeRequestRef.current === requestKey) activeRequestRef.current = null;
    };
  }, [aiError, awaitingRetry, commit, dispatch, game, paused, settings, view]);

  const updateSetup = useCallback((next: SetupPreferences) => {
    setSetup(next);
    try {
      saveSetup(next);
      setStorageError(null);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '保存准备区设置失败');
    }
  }, []);

  const saveAiSettings = useCallback((next: AiProviderConfig) => {
    saveSettings(next);
    setSettings(next);
    setSettingsOpen(false);
  }, []);

  const beginGame = useCallback((seed: number) => {
    const next = createGame({ ...setup, seed });
    commit(next);
    setAiError(null);
    setDecisionError(null);
    setAwaitingRetry(false);
    setPaused(false);
    setView('game');
  }, [commit, setup]);

  // 输入框有固定种子时复现该种子，否则生成随机种子
  const startNewGame = useCallback(() => {
    beginGame(setup.randomSeed ? rollSeed() : setup.seed);
  }, [beginGame, setup]);

  const continueSavedGame = useCallback(() => {
    if (!savedGame) return;
    const restored = structuredClone(savedGame.state);
    gameRef.current = restored;
    setGame(restored);
    setAiError(null);
    setDecisionError(null);
    const waitsForAi = restored.pendingDecision !== null
      && !(restored.mode === 'player' && restored.pendingDecision.actorId === restored.humanPlayerId);
    setAwaitingRetry(waitsForAi);
    setPaused(false);
    setView('game');
  }, [savedGame]);

  const returnToSetup = useCallback(() => {
    setView('setup');
    setPaused(false);
    setAiError(null);
    setDecisionError(null);
    setAwaitingRetry(false);
  }, []);

  const discardSavedGame = useCallback(() => {
    clearSavedGame();
    setSavedGame(null);
    gameRef.current = null;
    setGame(null);
  }, []);
  const clearHistory = useCallback(() => {
    try {
      clearStoredHistory();
      historyRef.current = [];
      setHistory([]);
      setHistoryError(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? `清除对局历史失败：${error.message}` : '清除对局历史失败');
    }
  }, []);

  const submitHumanDecision = useCallback((decision: SubmittedDecision) => {
    const current = gameRef.current;
    const pending = current?.pendingDecision;
    if (!current || !pending || pending.actorId !== current.humanPlayerId) {
      setDecisionError('当前没有等待你的决策');
      return;
    }
    dispatch({ type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision }, pending.id);
  }, [dispatch]);

  const retryAi = useCallback(() => {
    setAiError(null);
    setAwaitingRetry(false);
  }, []);

  const useLocalFallback = useCallback(() => {
    const current = gameRef.current;
    if (current) commit(reduceGame(current, { type: 'set-automation', automationMode: 'local' }));
    setAiError(null);
    setAwaitingRetry(false);
  }, [commit]);

  return {
    view, game, observation, savedGame, history, historyError, settings, setup, storageError, aiError, decisionError,
    awaitingRetry, thinking, paused, settingsOpen, setSettingsOpen, updateSetup, saveAiSettings,
    startNewGame, continueSavedGame, returnToSetup, discardSavedGame, clearHistory, submitHumanDecision,
    retryAi, useLocalFallback, setPaused,
  };
}
