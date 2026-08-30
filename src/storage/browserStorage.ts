import { z } from 'zod';
import { CHARACTER_IDS, MAX_PLAYERS, MIN_PLAYERS } from '../../shared/gamePromptContract.js';
import { APP_VERSION } from '../config/version';
import type { CharacterId, GameMode, GameState, PlayerId, RewindSnapshot } from '../domain/model';
import type { AiProviderConfig } from '../ai/types';
import { gameStateSchema } from './gameStateSchema';

export const SETTINGS_KEY = 'majo-wolf.settings.v1';
export const GAME_KEY = 'majo-wolf.game.v1';
export const SETUP_KEY = 'majo-wolf.setup.v1';
export const SESSION_KEY = 'majo-wolf.session.v1';
export type ThemePreference = 'light' | 'dark' | 'system';

export interface ThemeSettings {
  preference: ThemePreference;
  judgmentMode: boolean;
}

export const THEME_KEY = 'majo-wolf.theme.v1';

export const defaultThemeSettings: ThemeSettings = {
  preference: 'system',
  judgmentMode: false,
};

export interface SetupPreferences {
  mode: GameMode;
  humanCharacterId: CharacterId | null;
  playerCount: number;
  selectedCharacterIds: CharacterId[];
  seed: number;
  randomSeed: boolean;
}

export interface SavedGameEnvelope {
  schemaVersion: 1;
  appVersion: string | null;
  savedAt: string;
  state: GameState;
}

export type StorageResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: string };

const reasoningEffortSchema = z.enum(['none', 'low', 'high', 'max']);
const modelProfileSchema = z.strictObject({
  model: z.string(),
  reasoningEffort: reasoningEffortSchema,
});
const modelProfileOverrideSchema = z.strictObject({
  model: z.string().default(''),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
});

const freeSettingsSchema = z.object({
  provider: z.literal('free'),
  retryCount: z.number().int().min(0).max(5).default(2),
});
const customSettingsSchema = z.object({
  provider: z.literal('custom'),
  endpoint: z.string(),
  apiKey: z.string(),
  profiles: z.strictObject({
    default: modelProfileSchema,
    fast: modelProfileOverrideSchema,
    deep: modelProfileOverrideSchema,
  }),
  retryCount: z.number().int().min(0).max(5).default(2),
  jsonOutputMode: z.enum(['auto', 'force', 'disabled']).default('auto'),
});
const settingsSchema = z.discriminatedUnion('provider', [freeSettingsSchema, customSettingsSchema]);
const singleProfileSettingsSchema = z.object({
  provider: z.literal('custom'),
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  reasoningEffort: reasoningEffortSchema.default('low'),
  retryCount: z.number().int().min(0).max(5).default(2),
  jsonOutputMode: z.enum(['auto', 'force', 'disabled']).default('auto'),
});
const legacySettingsSchema = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  reasoningEffort: reasoningEffortSchema.default('low'),
}).passthrough();
const setupSchema = z.strictObject({
  mode: z.enum(['spectator', 'player']),
  humanCharacterId: z.enum(CHARACTER_IDS).nullable(),
  playerCount: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS).default(MIN_PLAYERS),
  selectedCharacterIds: z.array(z.enum(CHARACTER_IDS)).max(MAX_PLAYERS).default([]),
  seed: z.number().int().min(0).max(0xffff_ffff),
  randomSeed: z.boolean().default(true),
});
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  appVersion: z.string().trim().min(1).max(64).nullable().default(null),
  savedAt: z.iso.datetime(),
  state: gameStateSchema,
});

function readValue<T>(key: string, schema: z.ZodType<T>): StorageResult<T> {
  const raw = localStorage.getItem(key);
  if (raw === null) return { ok: true, value: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${key} 不是合法 JSON` };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: `${key} 版本或结构不受支持：${parsed.error.issues[0]?.message ?? '未知错误'}` };
}

export function loadSettings(): StorageResult<AiProviderConfig> {
  const raw = localStorage.getItem(SETTINGS_KEY);
  if (raw === null) return { ok: true, value: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${SETTINGS_KEY} 不是合法 JSON` };
  }
  const current = settingsSchema.safeParse(value);
  if (current.success) return { ok: true, value: current.data };
  const singleProfile = singleProfileSettingsSchema.safeParse(value);
  if (singleProfile.success) {
    return {
      ok: true,
      value: {
        provider: 'custom',
        endpoint: singleProfile.data.endpoint,
        apiKey: singleProfile.data.apiKey,
        profiles: {
          default: { model: singleProfile.data.model, reasoningEffort: singleProfile.data.reasoningEffort },
          fast: { model: '', reasoningEffort: 'none' },
          deep: { model: '', reasoningEffort: 'high' },
        },
        retryCount: singleProfile.data.retryCount,
        jsonOutputMode: singleProfile.data.jsonOutputMode,
      },
    };
  }
  const legacy = legacySettingsSchema.safeParse(value);
  if (legacy.success) {
    if (!legacy.data.endpoint.trim() || !legacy.data.apiKey.trim() || !legacy.data.model.trim()) {
      return { ok: true, value: { provider: 'free', retryCount: 2 } };
    }
    return {
      ok: true,
      value: {
        provider: 'custom',
        endpoint: legacy.data.endpoint,
        apiKey: legacy.data.apiKey,
        profiles: {
          default: { model: legacy.data.model, reasoningEffort: legacy.data.reasoningEffort },
          fast: { model: '', reasoningEffort: 'none' },
          deep: { model: '', reasoningEffort: 'high' },
        },
        retryCount: 2,
        jsonOutputMode: 'auto',
      },
    };
  }
  return { ok: false, error: `${SETTINGS_KEY} 版本或结构不受支持` };
}

export function saveSettings(config: AiProviderConfig): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSchema.parse(config)));
}

const themeSettingsSchema = z.strictObject({
  preference: z.enum(['light', 'dark', 'system']),
  judgmentMode: z.boolean(),
});

export function loadThemeSettings(): StorageResult<ThemeSettings> {
  return readValue(THEME_KEY, themeSettingsSchema);
}

export function saveThemeSettings(settings: ThemeSettings): void {
  localStorage.setItem(THEME_KEY, JSON.stringify(themeSettingsSchema.parse(settings)));
}

export function loadSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing && /^[A-Za-z0-9_-]{22,128}$/.test(existing)) return existing;
  const next = crypto.randomUUID().replaceAll('-', '');
  localStorage.setItem(SESSION_KEY, next);
  return next;
}

export function loadSetup(): StorageResult<SetupPreferences> {
  return readValue(SETUP_KEY, setupSchema);
}

export function saveSetup(setup: SetupPreferences): void {
  localStorage.setItem(SETUP_KEY, JSON.stringify(setupSchema.parse(setup)));
}

function migrateCreatureFields(state: GameState | RewindSnapshot): void {
  if (!Array.isArray(state.creatures)) state.creatures = [];
  if (!state.knowledgeByPlayer[99]) state.knowledgeByPlayer[99] = [];
}

export function loadGame(): StorageResult<SavedGameEnvelope> {
  const result = readValue(GAME_KEY, envelopeSchema);
  if (!result.ok || result.value === null) return result as StorageResult<SavedGameEnvelope>;
  const envelope = result.value as unknown as SavedGameEnvelope;
  migrateCreatureFields(envelope.state);
  envelope.state.seriesId ??= envelope.state.gameId;
  if (envelope.state.morningCheckpoint) migrateCreatureFields(envelope.state.morningCheckpoint);
  if (envelope.state.morningCheckpoint) {
    envelope.state.morningCheckpoint.seriesId ??= envelope.state.seriesId;
    envelope.state.morningCheckpoint.roundNumber ??= envelope.state.roundNumber;
  }
  return { ok: true, value: envelope };
}

export function getSavedGameCompatibilityWarning(envelope: SavedGameEnvelope): string | null {
  if (envelope.appVersion === APP_VERSION) return null;
  if (envelope.appVersion === null) {
    return `此存档未记录创建版本，当前游戏为 v${APP_VERSION}，继续游戏可能出现兼容性问题。`;
  }
  return `此存档由 v${envelope.appVersion} 创建，当前游戏为 v${APP_VERSION}，继续游戏可能出现兼容性问题。`;
}

export function saveGame(state: GameState, appVersion: string | null): SavedGameEnvelope {
  const envelope: SavedGameEnvelope = { schemaVersion: 1, appVersion, savedAt: new Date().toISOString(), state };
  envelopeSchema.parse(envelope);
  localStorage.setItem(GAME_KEY, JSON.stringify(envelope));
  return envelope;
}

export function clearSavedGame(): void {
  localStorage.removeItem(GAME_KEY);
}

export function clearCorruptedValue(key: typeof SETTINGS_KEY | typeof GAME_KEY | typeof SETUP_KEY): void {
  localStorage.removeItem(key);
}

export const HISTORY_KEY = 'majo-wolf.history.v1';

export interface GameHistoryEntry {
  gameId: string;
  seed: number;
  finishedDay: number;
  winner: 'wolf' | 'good';
  finishedAt: string;
}

const historySchema = z.array(z.strictObject({
  gameId: z.string().min(1),
  seed: z.number().int().min(0).max(0xffff_ffff),
  finishedDay: z.number().int().min(0),
  winner: z.enum(['wolf', 'good']),
  finishedAt: z.iso.datetime(),
})).max(50);

export function loadHistory(): StorageResult<GameHistoryEntry[]> {
  return readValue(HISTORY_KEY, historySchema);
}

export function saveHistory(entries: GameHistoryEntry[]): void {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(historySchema.parse(entries.slice(0, 50))));
}

export function clearHistory(): void {
  localStorage.removeItem(HISTORY_KEY);
}

export type { CharacterId, PlayerId };
