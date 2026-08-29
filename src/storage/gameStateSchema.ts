import { z } from 'zod';
import {
  BOARD_DESCRIPTION,
  CHARACTER_IDS,
  GAME_ENTITY_IDS,
  GAME_PHASES,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PLAYER_IDS,
  ROLE_IDS,
  WITCH_SKILL_IDS,
} from '../../shared/gamePromptContract.js';
import type { PlayerId } from '../domain/model';

export const playerIdSchema = z.custom<PlayerId>((value) => typeof value === 'number' && GAME_ENTITY_IDS.includes(value as PlayerId));
const regularPlayerIdSchema = z.custom<Exclude<PlayerId, 99>>((value) => typeof value === 'number' && value !== 99 && PLAYER_IDS.some((playerId) => playerId === value));
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
    id: regularPlayerIdSchema,
    characterId: z.enum(CHARACTER_IDS),
    roleAssignmentId: z.string(),
    skillInstanceId: z.string().nullable(),
    alive: z.boolean(),
  })).min(MIN_PLAYERS).max(MAX_PLAYERS),
  roleAssignments: z.array(z.object({
    id: z.string(), ownerPlayerId: playerIdSchema, roleId: roleIdSchema,
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).min(MIN_PLAYERS).max(MAX_PLAYERS + 1),
  skillInstances: z.array(z.object({
    id: z.string(), definitionId: skillIdSchema, ownerPlayerId: playerIdSchema,
    status: z.enum(['ready', 'active', 'exhausted']), remainingUses: z.number().nullable(), data: z.record(z.string(), z.unknown()),
  })).min(MIN_PLAYERS).max(MAX_PLAYERS),
  knowledgeByPlayer: z.record(z.string(), z.array(z.unknown())),
  creatures: z.array(z.object({
    id: z.literal(99),
    ownerPlayerId: regularPlayerIdSchema,
    characterId: z.enum(CHARACTER_IDS),
    roleAssignmentId: z.string(),
    alive: z.boolean(),
    resources: z.object({ antidote: z.union([z.literal(0), z.literal(1)]).optional(), poison: z.union([z.literal(0), z.literal(1)]).optional() }),
  })).default([]),
  speechOrder: z.array(regularPlayerIdSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  publicEvents: z.array(z.unknown()),
  privateEvents: z.array(z.unknown()),
  archivedTimelines: z.array(z.unknown()),
  currentVotes: z.array(z.unknown()),
  pendingDecision: z.unknown().nullable(),
  morningCheckpoint: z.unknown().nullable(),
  causalLocks: z.array(z.string()),
  result: z.unknown().nullable(),
}).superRefine((state, context) => {
  const expectedPlayerIds = Array.from({ length: state.players.length }, (_, index) => index);
  const actualPlayerIds = state.players.map((player) => player.id).sort((left, right) => left - right);
  const playerIds = new Set(state.players.map((player) => player.id));
  const creatureIds = new Set(state.creatures.map((creature) => creature.id));
  const entityIds = new Set([...playerIds, ...creatureIds]);
  const roleIds = new Set(state.roleAssignments.map((assignment) => assignment.id));
  const skillIds = new Set(state.skillInstances.map((skill) => skill.id));
  if (actualPlayerIds.some((id, index) => id !== expectedPlayerIds[index])) context.addIssue({ code: 'custom', message: '玩家席位必须从 0 连续排列' });
  if (new Set(state.players.map((player) => player.characterId)).size !== state.players.length) context.addIssue({ code: 'custom', message: '玩家角色重复' });
  if (new Set(state.roleAssignments.map((assignment) => assignment.id)).size !== state.roleAssignments.length || new Set(state.roleAssignments.map((assignment) => assignment.ownerPlayerId)).size !== state.roleAssignments.length) context.addIssue({ code: 'custom', message: '职业分配重复' });
  if (new Set(state.skillInstances.map((skill) => skill.id)).size !== state.skillInstances.length || new Set(state.skillInstances.map((skill) => skill.ownerPlayerId)).size !== state.skillInstances.length) context.addIssue({ code: 'custom', message: '技能实例重复' });
  if (state.roleAssignments.length !== state.players.length + state.creatures.length) context.addIssue({ code: 'custom', message: '职业数量与实体不一致' });
  for (const player of state.players) {
    const assignment = state.roleAssignments.find((entry) => entry.id === player.roleAssignmentId);
    const skill = player.skillInstanceId === null ? null : state.skillInstances.find((entry) => entry.id === player.skillInstanceId);
    if (!assignment || assignment.ownerPlayerId !== player.id) context.addIssue({ code: 'custom', message: '玩家职业分配不一致' });
    if (player.skillInstanceId !== null && (!skill || skill.ownerPlayerId !== player.id)) context.addIssue({ code: 'custom', message: '玩家技能实例不一致' });
  }
  if (state.roleAssignments.some((assignment) => !entityIds.has(assignment.ownerPlayerId)) || state.skillInstances.some((skill) => ![...playerIds].some((playerId) => playerId === skill.ownerPlayerId))) context.addIssue({ code: 'custom', message: '职业或技能所有者不存在' });
  if (state.speechOrder.length !== state.players.length || new Set(state.speechOrder).size !== state.speechOrder.length || state.speechOrder.some((playerId) => !playerIds.has(playerId))) context.addIssue({ code: 'custom', message: '发言顺序必须恰好覆盖普通玩家' });
  if (state.humanPlayerId !== null && ![...playerIds].some((playerId) => playerId === state.humanPlayerId)) context.addIssue({ code: 'custom', message: '真人席位不存在' });
  for (const creature of state.creatures) {
    const assignment = state.roleAssignments.find((entry) => entry.id === creature.roleAssignmentId);
    if (!assignment || assignment.ownerPlayerId !== creature.id || !playerIds.has(creature.ownerPlayerId)) context.addIssue({ code: 'custom', message: '造物实体关联不一致' });
  }
  if (roleIds.size !== state.roleAssignments.length || skillIds.size !== state.skillInstances.length) context.addIssue({ code: 'custom', message: '实体关联 ID 重复' });
});
