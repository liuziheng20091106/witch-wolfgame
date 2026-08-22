import { z } from 'zod';
import { BOARD_DESCRIPTION, CHARACTER_IDS, GAME_PHASES, PLAYER_IDS, ROLE_IDS, WITCH_SKILL_IDS } from '../../shared/gamePromptContract.js';
import type { CharacterId, GameMode, GameState, PlayerId } from '../domain/model';
import type { AiProviderConfig } from '../ai/types';

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
  seed: number;
  randomSeed: boolean;
}

export interface SavedGameEnvelope {
  schemaVersion: 1;
  savedAt: string;
  state: GameState;
}

export type StorageResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: string };

const playerIdSchema = z.custom<PlayerId>((value) => typeof value === 'number' && (PLAYER_IDS.includes(value as 0 | 1 | 2 | 3 | 4 | 5) || value === 99));
const roleIdSchema = z.enum(ROLE_IDS);
const skillIdSchema = z.enum(WITCH_SKILL_IDS);

const freeSettingsSchema = z.object({
  provider: z.literal('free'),
  retryCount: z.number().int().min(0).max(5).default(2),
});
const customSettingsSchema = z.object({
  provider: z.literal('custom'),
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']),
  retryCount: z.number().int().min(0).max(5).default(2),
  jsonOutputMode: z.enum(['auto', 'force', 'disabled']).default('auto'),
});
const settingsSchema = z.discriminatedUnion('provider', [freeSettingsSchema, customSettingsSchema]);
const legacySettingsSchema = z.object({
  endpoint: z.string(),
  apiKey: z.string(),
  model: z.string(),
  reasoningEffort: z.enum(['none', 'low', 'high', 'max']),
}).passthrough();
const setupSchema = z.strictObject({
  mode: z.enum(['spectator', 'player']),
  humanCharacterId: z.enum(CHARACTER_IDS).nullable(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  randomSeed: z.boolean().default(true),
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  gameId: z.string().min(1),
  board: z.string().default(BOARD_DESCRIPTION),
  mode: z.enum(['spectator', 'player']),
  automationMode: z.enum(['remote', 'local']),
  usedFreeProvider: z.boolean().default(false),
  humanPlayerId: playerIdSchema.nullable(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  rngState: z.number().int().min(0).max(0xffff_ffff),
  day: z.number().int().min(0),
  phase: z.enum(GAME_PHASES),
  players: z.array(z.object({
    id: playerIdSchema,
    characterId: z.enum(CHARACTER_IDS),
    roleAssignmentId: z.string(),
    skillInstanceId: z.string().nullable(),
    alive: z.boolean(),
  })).length(6),
  roleAssignments: z.array(z.object({
    id: z.string(), ownerPlayerId: playerIdSchema, roleId: roleIdSchema,
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).length(6),
  skillInstances: z.array(z.object({
    id: z.string(), definitionId: skillIdSchema, ownerPlayerId: playerIdSchema,
    status: z.enum(['ready', 'active', 'exhausted']), remainingUses: z.number().nullable(), data: z.record(z.string(), z.unknown()),
  })).min(6),
  knowledgeByPlayer: z.record(z.string(), z.array(z.unknown())),
  creatures: z.array(z.object({
    id: playerIdSchema,
    ownerPlayerId: playerIdSchema,
    characterId: z.enum(CHARACTER_IDS),
    roleAssignmentId: z.string(),
    alive: z.boolean(),
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).default([]),
  speechOrder: z.array(playerIdSchema).length(6),
  publicEvents: z.array(z.unknown()),
  privateEvents: z.array(z.unknown()),
  archivedTimelines: z.array(z.unknown()),
  currentVotes: z.array(z.unknown()),
  pendingDecision: z.unknown().nullable(),
  morningCheckpoint: z.unknown().nullable(),
  causalLocks: z.array(z.string()),
  result: z.unknown().nullable(),
});
const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  savedAt: z.iso.datetime(),
  state: stateSchema,
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
        model: legacy.data.model,
        reasoningEffort: legacy.data.reasoningEffort,
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

export function loadGame(): StorageResult<SavedGameEnvelope> {
  const result = readValue(GAME_KEY, envelopeSchema);
  if (!result.ok || result.value === null) return result as StorageResult<SavedGameEnvelope>;
  const envelope = result.value as unknown as SavedGameEnvelope;
  // 旧存档迁移：补造物知识键（99 号），避免造物相关代码访问 undefined
  if (!envelope.state.knowledgeByPlayer[99]) {
    envelope.state.knowledgeByPlayer[99] = [];
  }
  return { ok: true, value: envelope };
}

export function saveGame(state: GameState): SavedGameEnvelope {
  const envelope: SavedGameEnvelope = { schemaVersion: 1, savedAt: new Date().toISOString(), state };
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
