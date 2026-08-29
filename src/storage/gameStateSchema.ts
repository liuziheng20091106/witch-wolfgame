import { z } from 'zod';
import {
  BOARD_DESCRIPTION,
  CHARACTER_IDS,
  GAME_ENTITY_IDS,
  GAME_PHASES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROLE_IDS,
  WITCH_SKILL_IDS,
} from '../../shared/gamePromptContract.js';
import type { PlayerId } from '../domain/model';

export const playerIdSchema = z.custom<PlayerId>((value) => typeof value === 'number' && GAME_ENTITY_IDS.includes(value as PlayerId));
const roleIdSchema = z.enum(ROLE_IDS);
const skillIdSchema = z.enum(WITCH_SKILL_IDS);

export const gameStateSchema = z.object({
  schemaVersion: z.literal(1),
  gameId: z.string().min(1),
  seriesId: z.string().min(1).optional(),
  roundNumber: z.number().int().min(1).default(1),
  board: z.string().default(BOARD_DESCRIPTION),
  mode: z.enum(['spectator', 'player']),
  automationMode: z.enum(['remote', 'local']),
  usedFreeProvider: z.boolean().default(false),
  aiFailureOccurred: z.boolean().default(false),
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
  })).min(MIN_PLAYERS).max(MAX_PLAYERS + 1),
  roleAssignments: z.array(z.object({
    id: z.string(), ownerPlayerId: playerIdSchema, roleId: roleIdSchema,
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).min(MIN_PLAYERS).max(MAX_PLAYERS + 1),
  skillInstances: z.array(z.object({
    id: z.string(), definitionId: skillIdSchema, ownerPlayerId: playerIdSchema,
    status: z.enum(['ready', 'active', 'exhausted']), remainingUses: z.number().nullable(), data: z.record(z.string(), z.unknown()),
  })).min(MIN_PLAYERS).max(MAX_PLAYERS + 1),
  knowledgeByPlayer: z.record(z.string(), z.array(z.unknown())),
  creatures: z.array(z.object({
    id: playerIdSchema,
    ownerPlayerId: playerIdSchema,
    characterId: z.enum(CHARACTER_IDS),
    roleAssignmentId: z.string(),
    alive: z.boolean(),
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).default([]),
  speechOrder: z.array(playerIdSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  publicEvents: z.array(z.unknown()),
  privateEvents: z.array(z.unknown()),
  archivedTimelines: z.array(z.unknown()),
  currentVotes: z.array(z.unknown()),
  pendingDecision: z.unknown().nullable(),
  morningCheckpoint: z.unknown().nullable(),
  causalLocks: z.array(z.string()),
  result: z.unknown().nullable(),
});
