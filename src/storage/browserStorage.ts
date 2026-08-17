import { z } from 'zod';
import type { CharacterId, GameMode, GamePhase, GameState, PlayerId, RoleId, WitchSkillId } from '../domain/model';
import type { AiProviderConfig } from '../ai/types';

export const SETTINGS_KEY = 'majo-wolf.settings.v1';
export const GAME_KEY = 'majo-wolf.game.v1';
export const SETUP_KEY = 'majo-wolf.setup.v1';
export const SESSION_KEY = 'majo-wolf.session.v1';

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

const characterIds = [
  'soul-0', 'soul-1', 'soul-2', 'soul-3', 'soul-4', 'soul-5', 'soul-6',
  'soul-7', 'soul-8', 'soul-9', 'soul-10', 'soul-11', 'soul-12', 'soul-13',
] as const;
const phases = [
  'first-night', 'night-skills', 'wolf-suggestions', 'wolf-decision', 'witch-action', 'seer-action',
  'night-protection', 'night-resolution', 'dawn', 'day-skills', 'speeches', 'vote-skills', 'voting',
  'runoff', 'day-resolution', 'ended',
] as const satisfies readonly GamePhase[];
const playerIdSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const roleIdSchema = z.enum(['wolf', 'seer', 'witch', 'villager'] satisfies RoleId[]);
const skillIdSchema = z.enum([
  'witch-killer', 'death-rewind', 'brainwash', 'liquid-control', 'speech-restrain', 'levitation', 'healing',
  'clairvoyance', 'gaze-guidance', 'soul-exchange', 'mind-reading', 'ignition', 'voice-mimic', 'witch-factor-recovery',
] satisfies WitchSkillId[]);

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
  humanCharacterId: z.enum(characterIds).nullable(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  randomSeed: z.boolean().default(true),
});
const stateSchema = z.object({
  schemaVersion: z.literal(1),
  gameId: z.string().min(1),
  board: z.string().default('6人局：狼人×2、预言家×1、女巫×1、村民×2'),
  mode: z.enum(['spectator', 'player']),
  automationMode: z.enum(['remote', 'local']),
  usedFreeProvider: z.boolean().default(false),
  humanPlayerId: playerIdSchema.nullable(),
  seed: z.number().int().min(0).max(0xffff_ffff),
  rngState: z.number().int().min(0).max(0xffff_ffff),
  day: z.number().int().min(0),
  phase: z.enum(phases),
  players: z.array(z.object({
    id: playerIdSchema,
    characterId: z.enum(characterIds),
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
  return { ok: true, value: result.value as unknown as SavedGameEnvelope };
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

export type { CharacterId, PlayerId };
