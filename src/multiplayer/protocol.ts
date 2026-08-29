import { z } from 'zod';
import { CHARACTER_IDS, PLAYER_IDS } from '../../shared/gamePromptContract.js';
import type { CharacterId, GameObservation, PlayerId, SubmittedDecision } from '../domain/model';

export const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;
export const RESUME_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const PLAYER_NAME_PATTERN = /^[^\r\n\t]{1,24}$/u;

const roomCodeSchema = z.string().regex(ROOM_CODE_PATTERN);
const resumeTokenSchema = z.string().regex(RESUME_TOKEN_PATTERN);
const playerNameSchema = z.string().trim().regex(PLAYER_NAME_PATTERN);
const characterIdSchema = z.enum(CHARACTER_IDS);
const decisionSchema = z.record(z.string(), z.unknown());

export const multiplayerClientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('create-room'), playerName: playerNameSchema, characterId: characterIdSchema, seed: z.number().int().min(0).max(0xffff_ffff).optional() }),
  z.strictObject({ type: z.literal('join-room'), roomCode: roomCodeSchema, playerName: playerNameSchema, characterId: characterIdSchema }),
  z.strictObject({ type: z.literal('resume-room'), roomCode: roomCodeSchema, resumeToken: resumeTokenSchema }),
  z.strictObject({ type: z.literal('set-ready'), ready: z.boolean() }),
  z.strictObject({ type: z.literal('start-game') }),
  z.strictObject({ type: z.literal('submit-decision'), pendingDecisionId: z.string().min(1).max(160), decision: decisionSchema }),
  z.strictObject({ type: z.literal('leave-room') }),
]);

export type MultiplayerClientMessage = z.infer<typeof multiplayerClientMessageSchema>;
export type PlayerDriver = { kind: 'ai' } | { kind: 'human'; participantId: string };

export interface MultiplayerParticipantView {
  participantId: string;
  playerId: PlayerId;
  playerName: string;
  characterId: CharacterId;
  ready: boolean;
  connected: boolean;
  host: boolean;
}

export interface MultiplayerRoomView {
  roomCode: string;
  status: 'lobby' | 'playing' | 'ended' | 'failed';
  selfParticipantId: string;
  selfPlayerId: PlayerId;
  hostParticipantId: string;
  participants: MultiplayerParticipantView[];
  drivers: PlayerDriver[];
  observation: GameObservation | null;
  failureMessage: string | null;
}

export type MultiplayerServerMessage =
  | { type: 'welcome'; room: MultiplayerRoomView; resumeToken: string }
  | { type: 'room-state'; room: MultiplayerRoomView }
  | { type: 'error'; code: string; message: string };

export function encodeMultiplayerMessage(message: MultiplayerClientMessage | MultiplayerServerMessage): string {
  return JSON.stringify(message);
}

export function playerIdFromSeatIndex(index: number): PlayerId {
  const playerId = PLAYER_IDS[index];
  if (playerId === undefined) throw new Error(`非法多人席位：${index}`);
  return playerId;
}

export function submittedDecisionFromWire(value: Record<string, unknown>): SubmittedDecision {
  return value as unknown as SubmittedDecision;
}
