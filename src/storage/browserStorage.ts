import { z } from 'zod';
import { BOARD_DESCRIPTION, CHARACTER_IDS, GAME_ENTITY_IDS, GAME_PHASES, ROLE_IDS, WITCH_SKILL_IDS } from '../../shared/gamePromptContract.js';
import { APP_VERSION } from '../config/version';
import type { CharacterId, GameMode, GameState, PlayerId, RewindSnapshot } from '../domain/model';
import type { AiProviderConfig } from '../ai/types';
import { characters } from '../domain/catalog/characters';
import { defaultSkillByCharacterId, witchSkillDefinitions } from '../domain/catalog/witchSkills';

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
  appVersion: string | null;
  savedAt: string;
  state: GameState;
}

export type StorageResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; error: string };

const playerIdSchema = z.custom<PlayerId>((value) => typeof value === 'number' && GAME_ENTITY_IDS.includes(value as PlayerId));
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
  seatCount: z.union([z.literal(6), z.literal(8)]).optional(),
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
  })).refine((players) => players.length === 6 || players.length === 8),
  roleAssignments: z.array(z.object({
    id: z.string(), ownerPlayerId: playerIdSchema, roleId: roleIdSchema,
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).min(6),
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
  speechOrder: z.array(playerIdSchema).refine((order) => order.length === 6 || order.length === 8),
  freeSpeechOrder: z.array(playerIdSchema).optional(),
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
  appVersion: z.string().trim().min(1).max(64).nullable().default(null),
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

function migrateCreatureFields(state: GameState | RewindSnapshot): void {
  if (!Array.isArray(state.creatures)) state.creatures = [];
  if (!state.knowledgeByPlayer[99]) state.knowledgeByPlayer[99] = [];
}

function migrateSpeechFields(state: GameState | RewindSnapshot): void {
  if (!Array.isArray(state.freeSpeechOrder)) state.freeSpeechOrder = [...state.speechOrder];
  for (const event of state.publicEvents) {
    if ((event.kind === 'speech' || event.kind === 'restrained') && typeof event.data.speechRound !== 'number') {
      event.data.speechRound = 1;
    }
  }
  if (state.pendingDecision?.kind === 'speech'
    && state.pendingDecision.options.lastWords !== true
    && state.pendingDecision.options.postGame !== true
    && typeof state.pendingDecision.options.speechRound !== 'number') {
    state.pendingDecision.options.speechRound = 1;
  }
}

/** 仅扩展仍在进行的旧六人存档；已结束牌局保留原版型和既有胜负结果。 */
function extendActiveSixPlayerGame(state: GameState): void {
  state.seatCount ??= 6;
  migrateSpeechFields(state);
  if (state.seatCount !== 6 || state.players.length !== 6 || state.phase === 'ended' || state.phase === 'post-game' || state.result !== null) return;
  const usedCharacters = new Set(state.players.map((player) => player.characterId));
  const additions = characters.filter((character) => !usedCharacters.has(character.id)).slice(0, 2);
  const roles = ['hunter', 'villager'] as const;
  const migrated = [];
  for (let index = 0; index < 2; index += 1) {
    const playerId = (6 + index) as PlayerId;
    const character = additions[index];
    if (!character) throw new Error('旧存档缺少可用于扩展的角色');
    const roleId = roles[index];
    if (!roleId) throw new Error('旧存档扩展缺少职业');
    const definitionId = defaultSkillByCharacterId[character.id];
    const usage = witchSkillDefinitions[definitionId].usage;
    const roleAssignmentId = `role-${playerId}`;
    const skillInstanceId = `skill-${playerId}-${definitionId}`;
    state.roleAssignments.push({ id: roleAssignmentId, ownerPlayerId: playerId, roleId, resources: {} });
    state.skillInstances.push({ id: skillInstanceId, definitionId, ownerPlayerId: playerId, status: usage === 'passive' ? 'active' : 'ready', remainingUses: usage === 'once' ? 1 : null, data: {} });
    state.players.push({ id: playerId, characterId: character.id, roleAssignmentId, skillInstanceId, alive: true });
    state.knowledgeByPlayer[playerId] = [{ id: `${state.gameId}-fact-${playerId}-migrated`, subjectPlayerId: playerId, kind: 'role', value: roleId, observedDay: state.day, sourceEventId: 'migration' }];
    state.speechOrder.push(playerId);
    state.freeSpeechOrder.push(playerId);
    migrated.push({ playerId, definitionId });
  }
  for (const owner of state.players.map((player) => player.id)) {
    state.knowledgeByPlayer[owner] ??= [];
    for (const entry of migrated) {
      if (state.knowledgeByPlayer[owner].some((fact) => fact.subjectPlayerId === entry.playerId && fact.kind === 'skill')) continue;
      state.knowledgeByPlayer[owner].push({
        id: `${state.gameId}-fact-${owner}-migrated-skill-${entry.playerId}`,
        subjectPlayerId: entry.playerId,
        kind: 'skill',
        value: entry.definitionId,
        observedDay: state.day,
        sourceEventId: 'migration',
      });
    }
  }
  state.seatCount = 8;
  state.board = BOARD_DESCRIPTION;
}

function extendCheckpointFromState(state: GameState): void {
  const checkpoint = state.morningCheckpoint;
  if (!checkpoint || checkpoint.players.length !== 6 || state.players.length !== 8) return;
  for (const player of state.players.filter((entry) => entry.id === 6 || entry.id === 7)) {
    const assignment = state.roleAssignments.find((entry) => entry.id === player.roleAssignmentId);
    const skill = state.skillInstances.find((entry) => entry.id === player.skillInstanceId);
    if (!assignment || !skill) continue;
    checkpoint.players.push(structuredClone(player));
    checkpoint.roleAssignments.push(structuredClone(assignment));
    checkpoint.skillInstances.push(structuredClone(skill));
    checkpoint.knowledgeByPlayer[player.id] = structuredClone(state.knowledgeByPlayer[player.id]);
    checkpoint.speechOrder.push(player.id);
    checkpoint.freeSpeechOrder.push(player.id);
  }
  checkpoint.seatCount = 8;
  checkpoint.board = BOARD_DESCRIPTION;
}

export function loadGame(): StorageResult<SavedGameEnvelope> {
  const result = readValue(GAME_KEY, envelopeSchema);
  if (!result.ok || result.value === null) return result as StorageResult<SavedGameEnvelope>;
  const envelope = result.value as unknown as SavedGameEnvelope;
  envelope.state.seatCount ??= 6;
  migrateCreatureFields(envelope.state);
  migrateSpeechFields(envelope.state);
  extendActiveSixPlayerGame(envelope.state);
  extendCheckpointFromState(envelope.state);
  if (envelope.state.morningCheckpoint) {
    migrateCreatureFields(envelope.state.morningCheckpoint);
    migrateSpeechFields(envelope.state.morningCheckpoint);
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
