import { randomBytes } from 'node:crypto';
import { type IncomingMessage, createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { CHARACTER_IDS, PLAYER_IDS } from '../shared/gamePromptContract.js';
import { fallbackDecision } from '../src/ai/fallback.js';
import { createGame } from '../src/domain/engine/createGame.js';
import { reduceGame } from '../src/domain/engine/reducer.js';
import { selectObservation } from '../src/domain/engine/selectors.js';
import { gameStateSchema, playerIdSchema } from '../src/storage/gameStateSchema.js';
import type { CharacterId, GameState, PlayerId } from '../src/domain/model.js';
import {
  encodeMultiplayerMessage,
  multiplayerClientMessageSchema,
  playerIdFromSeatIndex,
  submittedDecisionFromWire,
  type MultiplayerParticipantView,
  type MultiplayerRoomView,
  type MultiplayerServerMessage,
  type PlayerDriver,
} from '../src/multiplayer/protocol.js';

const PORT = Number(process.env.MAJO_MULTIPLAYER_PORT ?? 34024);
const HOST = process.env.MAJO_MULTIPLAYER_HOST ?? '127.0.0.1';
const STATE_FILE = resolve(process.env.MAJO_MULTIPLAYER_STATE ?? '.runtime/multiplayer-rooms.json');
const MAX_ROOMS = 200;
const MAX_CONNECTIONS = 500;
const MAX_MESSAGE_BYTES = 32 * 1024;
const MAX_CONNECTIONS_PER_ADDRESS = 20;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 60;
const CREATE_RATE_WINDOW_MS = 60_000;
const MAX_CREATES_PER_WINDOW = 10;
const DISCONNECT_GRACE_MS = Number(process.env.MAJO_MULTIPLAYER_DISCONNECT_GRACE_MS ?? 15_000);
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TICK_DELAY_MS = 80;
const MULTIPLAYER_PLAYER_COUNT = 6;
const ROOM_PLAYER_IDS = PLAYER_IDS.slice(0, MULTIPLAYER_PLAYER_COUNT);
interface RateWindow { startedAt: number; count: number }

interface Participant {
  participantId: string;
  resumeToken: string;
  playerId: PlayerId;
  playerName: string;
  characterId: CharacterId;
  ready: boolean;
  connected: boolean;
}

interface Room {
  roomCode: string;
  status: 'lobby' | 'playing' | 'ended';
  hostParticipantId: string;
  seed: number;
  participants: Participant[];
  drivers: PlayerDriver[];
  game: GameState | null;
  updatedAt: number;
}

interface PersistedRoom extends Omit<Room, 'participants'> {
  participants: Participant[];
}
const participantSchema = z.strictObject({
  participantId: z.string().min(1),
  resumeToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  playerId: playerIdSchema.refine((value) => ROOM_PLAYER_IDS.some((playerId) => playerId === value), '多人席位超出范围'),
  playerName: z.string().trim().min(1).max(24),
  characterId: z.enum(CHARACTER_IDS),
  ready: z.boolean(),
  connected: z.boolean(),
});
const driverSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ai') }),
  z.strictObject({ kind: z.literal('human'), participantId: z.string().min(1) }),
]);
const persistedRoomSchema = z.strictObject({
  roomCode: z.string().regex(/^[A-Z2-9]{6}$/),
  status: z.enum(['lobby', 'playing', 'ended']),
  hostParticipantId: z.string().min(1),
  seed: z.number().int().min(0).max(0xffff_ffff),
  participants: z.array(participantSchema).min(1).max(MULTIPLAYER_PLAYER_COUNT),
  drivers: z.array(driverSchema).length(MULTIPLAYER_PLAYER_COUNT),
  game: gameStateSchema.nullable(),
  updatedAt: z.number().int().nonnegative(),
}).superRefine((room, context) => {
  const participantIds = new Set(room.participants.map((participant) => participant.participantId));
  const playerIds = new Set(room.participants.map((participant) => participant.playerId));
  const characterIds = new Set(room.participants.map((participant) => participant.characterId));
  if (!participantIds.has(room.hostParticipantId)) context.addIssue({ code: 'custom', message: '房主不在参与者中' });
  if (participantIds.size !== room.participants.length || playerIds.size !== room.participants.length || characterIds.size !== room.participants.length) context.addIssue({ code: 'custom', message: '参与者身份、席位或角色重复' });
  room.drivers.forEach((driver, index) => {
    if (driver.kind !== 'human') return;
    const participant = room.participants.find((entry) => entry.participantId === driver.participantId);
    if (!participant || participant.playerId !== index) context.addIssue({ code: 'custom', message: '真人驱动与参与者席位不一致' });
  });
  if ((room.status === 'lobby' && room.game !== null) || (room.status !== 'lobby' && room.game === null)) context.addIssue({ code: 'custom', message: '房间状态与游戏状态不一致' });
});

const rooms = new Map<string, Room>();
const socketsByParticipant = new Map<string, WebSocket>();
let connectionCount = 0;
let persistChain = Promise.resolve();
const connectionsByAddress = new Map<string, number>();
const createRatesByAddress = new Map<string, RateWindow>();

function token(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function roomCode(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(6);
    let code = '';
    for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error('房间号生成失败');
}

function errorMessage(code: string, message: string): MultiplayerServerMessage {
  return { type: 'error', code, message };
}

function send(socket: WebSocket, message: MultiplayerServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeMultiplayerMessage(message));
}

function participantById(room: Room, participantId: string): Participant | null {
  return room.participants.find((participant) => participant.participantId === participantId) ?? null;
}

function roomView(room: Room, participant: Participant): MultiplayerRoomView {
  const observation = room.game === null
    ? null
    : { ...selectObservation(room.game, { kind: 'player', playerId: participant.playerId }), mode: 'player' as const };
  const participants: MultiplayerParticipantView[] = room.participants.map((entry) => ({
    participantId: entry.participantId,
    playerId: entry.playerId,
    playerName: entry.playerName,
    characterId: entry.characterId,
    ready: entry.ready,
    connected: entry.connected,
    host: entry.participantId === room.hostParticipantId,
  }));
  return {
    roomCode: room.roomCode,
    status: room.status,
    selfParticipantId: participant.participantId,
    selfPlayerId: participant.playerId,
    hostParticipantId: room.hostParticipantId,
    participants,
    drivers: room.drivers.map((driver) => ({ ...driver })),
    observation,
  };
}

function broadcast(room: Room): void {
  for (const participant of room.participants) {
    const socket = socketsByParticipant.get(participant.participantId);
    if (socket) send(socket, { type: 'room-state', room: roomView(room, participant) });
  }
}

function persistRooms(): Promise<void> {
  const payload: PersistedRoom[] = [...rooms.values()].map((room) => ({
    ...room,
    participants: room.participants.map((participant) => ({ ...participant, connected: false })),
  }));
  persistChain = persistChain.then(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const tempFile = `${STATE_FILE}.${process.pid}.tmp`;
    await writeFile(tempFile, JSON.stringify(payload), 'utf8');
    await rename(tempFile, STATE_FILE);
  }).catch((error) => {
    console.error(JSON.stringify({ event: 'multiplayer_persist_error', message: error instanceof Error ? error.message : String(error) }));
  });
  return persistChain;
}

async function loadRooms(): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code !== 'ENOENT') console.error(JSON.stringify({ event: 'multiplayer_state_load_error', message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (!Array.isArray(raw)) {
    console.error(JSON.stringify({ event: 'multiplayer_state_load_error', message: '持久化状态必须是房间数组' }));
    return;
  }
  const now = Date.now();
  for (const candidate of raw) {
    const parsed = persistedRoomSchema.safeParse(candidate);
    if (!parsed.success) {
      const roomCode = typeof candidate === 'object' && candidate !== null && 'roomCode' in candidate ? String(candidate.roomCode) : null;
      console.error(JSON.stringify({ event: 'multiplayer_room_discarded', roomCode, message: parsed.error.issues[0]?.message ?? '未知结构错误' }));
      continue;
    }
    const room = parsed.data as Room;
    if (now - room.updatedAt > ROOM_IDLE_MS) continue;
    room.participants.forEach((participant) => { participant.connected = false; });
    rooms.set(room.roomCode, room);
    if (room.status === 'playing') {
      for (const participant of room.participants) {
        const driver = room.drivers[participant.playerId];
        if (driver?.kind === 'human' && driver.participantId === participant.participantId) scheduleDisconnectTakeover(room, participant);
      }
      scheduleGame(room);
    }
  }
}

function scheduleGame(room: Room): void {
  windowlessSetTimeout(() => {
    try {
      driveGame(room);
    } catch (error) {
      if (room.game !== null) room.game = reduceGame(room.game, { type: 'mark-ai-failure' });
      room.updatedAt = Date.now();
      console.error(JSON.stringify({ event: 'multiplayer_ai_drive_error', roomCode: room.roomCode, pendingDecisionId: room.game?.pendingDecision?.id ?? null, message: error instanceof Error ? error.message : String(error) }));
      broadcast(room);
      void persistRooms();
    }
  }, TICK_DELAY_MS);
}

function windowlessSetTimeout(callback: () => void, delay: number): void {
  setTimeout(callback, delay).unref();
}

function driveGame(room: Room): void {
  if (room.status !== 'playing' || room.game === null) return;
  let game = room.game;
  let guard = 0;
  while (guard < 100) {
    guard += 1;
    if (game.phase === 'ended' || (game.phase === 'post-game' && game.pendingDecision === null)) {
      room.status = 'ended';
      room.game = game;
      room.updatedAt = Date.now();
      broadcast(room);
      void persistRooms();
      return;
    }
    const pending = game.pendingDecision;
    if (pending === null) {
      game = reduceGame(game, { type: 'advance' });
      continue;
    }
    const driver = room.drivers[pending.actorId];
    if (driver?.kind === 'human') {
      room.game = game;
      room.updatedAt = Date.now();
      broadcast(room);
      void persistRooms();
      return;
    }
    const fallback = fallbackDecision(game, pending);
    game = reduceGame(game, { type: 'set-rng-state', rngState: fallback.rngState });
    game = reduceGame(game, {
      type: 'submit-decision',
      pendingDecisionId: pending.id,
      actorId: pending.actorId,
      decision: fallback.decision,
    });
  }
  room.game = game;
  room.updatedAt = Date.now();
  broadcast(room);
  void persistRooms();
  scheduleGame(room);
}

function attachParticipant(socket: WebSocket, room: Room, participant: Participant, welcome: boolean): void {
  const previousSocket = socketsByParticipant.get(participant.participantId);
  if (previousSocket && previousSocket !== socket) previousSocket.close(4001, 'session replaced');
  participant.connected = true;
  room.drivers[participant.playerId] = { kind: 'human', participantId: participant.participantId };
  socketsByParticipant.set(participant.participantId, socket);
  room.updatedAt = Date.now();
  const message: MultiplayerServerMessage = welcome
    ? { type: 'welcome', room: roomView(room, participant), resumeToken: participant.resumeToken }
    : { type: 'room-state', room: roomView(room, participant) };
  send(socket, message);
  broadcast(room);
  void persistRooms();
}
function scheduleDisconnectTakeover(room: Room, participant: Participant): void {
  windowlessSetTimeout(() => {
    if (participant.connected || participantById(room, participant.participantId) === null) return;
    const driver = room.drivers[participant.playerId];
    if (driver?.kind !== 'human' || driver.participantId !== participant.participantId) return;
    room.drivers[participant.playerId] = { kind: 'ai' };
    if (room.hostParticipantId === participant.participantId) {
      const nextHost = room.participants.find((candidate) => candidate.connected && candidate.participantId !== participant.participantId);
      if (nextHost) room.hostParticipantId = nextHost.participantId;
    }
    room.updatedAt = Date.now();
    broadcast(room);
    void persistRooms();
    scheduleGame(room);
  }, DISCONNECT_GRACE_MS);
}


function leaveRoom(room: Room, participant: Participant): void {
  room.participants = room.participants.filter((entry) => entry.participantId !== participant.participantId);
  room.drivers[participant.playerId] = { kind: 'ai' };
  socketsByParticipant.delete(participant.participantId);
  if (room.participants.length === 0) {
    rooms.delete(room.roomCode);
    void persistRooms();
    return;
  }
  if (room.hostParticipantId === participant.participantId) {
    const nextHost = room.participants[0];
    if (!nextHost) throw new Error('房间缺少继任房主');
    room.hostParticipantId = nextHost.participantId;
  }
  room.updatedAt = Date.now();
  broadcast(room);
  void persistRooms();
  scheduleGame(room);
}

function consumeRateLimit(rates: Map<string, RateWindow>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = rates.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    rates.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

await loadRooms();
const httpServer = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: connectionCount }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});
const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
httpServer.on('upgrade', (request, socket, head) => {
  const address = request.socket.remoteAddress ?? 'unknown';
  const addressConnections = connectionsByAddress.get(address) ?? 0;
  if (request.url !== '/multiplayer' || connectionCount >= MAX_CONNECTIONS || addressConnections >= MAX_CONNECTIONS_PER_ADDRESS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit('connection', webSocket, request, address));
});

webSocketServer.on('connection', (socket: WebSocket, _request: IncomingMessage, address: string) => {
  connectionCount += 1;
  connectionsByAddress.set(address, (connectionsByAddress.get(address) ?? 0) + 1);
  let messageRate: RateWindow = { startedAt: Date.now(), count: 0 };
  let activeRoom: Room | null = null;
  let activeParticipant: Participant | null = null;

  socket.on('message', (data, isBinary) => {
    const now = Date.now();
    if (now - messageRate.startedAt >= MESSAGE_RATE_WINDOW_MS) messageRate = { startedAt: now, count: 0 };
    messageRate.count += 1;
    if (messageRate.count > MAX_MESSAGES_PER_WINDOW) {
      socket.close(1008, 'message rate exceeded');
      return;
    }
    if (isBinary || data.toString('utf8').length > MAX_MESSAGE_BYTES) {
      send(socket, errorMessage('invalid_message', '只接受受限大小的 JSON 文本消息'));
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString('utf8'));
    } catch {
      send(socket, errorMessage('invalid_json', '消息不是合法 JSON'));
      return;
    }
    const parsed = multiplayerClientMessageSchema.safeParse(raw);
    if (!parsed.success) {
      send(socket, errorMessage('invalid_message', '消息结构不受支持'));
      return;
    }
    const message = parsed.data;
    try {
      if (message.type === 'create-room') {
        if (!consumeRateLimit(createRatesByAddress, address, MAX_CREATES_PER_WINDOW, CREATE_RATE_WINDOW_MS)) throw new Error('创建房间过于频繁，请稍后重试');
        if (activeRoom !== null || rooms.size >= MAX_ROOMS) throw new Error('无法创建更多房间');
        const code = roomCode();
        const participantId = token(16);
        const participant: Participant = {
          participantId,
          resumeToken: token(32),
          playerId: playerIdFromSeatIndex(0),
          playerName: message.playerName,
          characterId: message.characterId,
          ready: false,
          connected: true,
        };
        const room: Room = {
          roomCode: code,
          status: 'lobby',
          hostParticipantId: participantId,
          seed: message.seed ?? randomBytes(4).readUInt32LE(0),
          participants: [participant],
          drivers: ROOM_PLAYER_IDS.map((playerId) => playerId === 0 ? { kind: 'human', participantId } : { kind: 'ai' }),
          game: null,
          updatedAt: Date.now(),
        };
        rooms.set(code, room);
        activeRoom = room;
        activeParticipant = participant;
        attachParticipant(socket, room, participant, true);
        return;
      }
      if (message.type === 'join-room') {
        if (activeRoom !== null) throw new Error('当前连接已经加入房间');
        const room = rooms.get(message.roomCode);
        if (!room || room.status !== 'lobby') throw new Error('房间不存在或已经开始');
        if (room.participants.length >= ROOM_PLAYER_IDS.length) throw new Error('房间已满');
        if (room.participants.some((participant) => participant.characterId === message.characterId)) throw new Error('该角色已被选择');
        const participantId = token(16);
        const usedSeats = new Set(room.participants.map((participant) => participant.playerId));
        const playerId = ROOM_PLAYER_IDS.find((candidate) => !usedSeats.has(candidate));
        if (playerId === undefined) throw new Error('没有可用席位');
        const participant: Participant = { participantId, resumeToken: token(32), playerId, playerName: message.playerName, characterId: message.characterId, ready: false, connected: true };
        room.participants.push(participant);
        room.drivers[playerId] = { kind: 'human', participantId };
        activeRoom = room;
        activeParticipant = participant;
        attachParticipant(socket, room, participant, true);
        return;
      }
      if (message.type === 'resume-room') {
        if (activeRoom !== null) throw new Error('当前连接已经加入房间');
        const room = rooms.get(message.roomCode);
        const participant = room?.participants.find((entry) => entry.resumeToken === message.resumeToken);
        if (!room || !participant) throw new Error('恢复令牌无效');
        activeRoom = room;
        activeParticipant = participant;
        attachParticipant(socket, room, participant, true);
        return;
      }
      if (!activeRoom || !activeParticipant) throw new Error('请先创建、加入或恢复房间');
      if (message.type === 'leave-room') {
        leaveRoom(activeRoom, activeParticipant);
        activeRoom = null;
        activeParticipant = null;
        return;
      }
      if (message.type === 'set-ready') {
        if (activeRoom.status !== 'lobby') throw new Error('游戏开始后不能修改准备状态');
        activeParticipant.ready = message.ready;
        activeRoom.updatedAt = Date.now();
        broadcast(activeRoom);
        void persistRooms();
        return;
      }
      if (message.type === 'start-game') {
        if (activeRoom.hostParticipantId !== activeParticipant.participantId) throw new Error('只有房主可以开始游戏');
        if (activeRoom.status !== 'lobby') throw new Error('游戏已经开始');
        if (!activeRoom.participants.every((participant) => participant.ready)) throw new Error('所有真人玩家必须先准备');
        const selected = new Set(activeRoom.participants.map((participant) => participant.characterId));
        const remainingCharacters = CHARACTER_IDS.filter((characterId) => !selected.has(characterId));
        let aiCharacterIndex = 0;
        const seatCharacterIds: CharacterId[] = ROOM_PLAYER_IDS.map((playerId) => {
          const participant = activeRoom?.participants.find((entry) => entry.playerId === playerId);
          if (participant) return participant.characterId;
          const characterId = remainingCharacters[aiCharacterIndex];
          aiCharacterIndex += 1;
          if (!characterId) throw new Error('无法为 AI 席位分配角色');
          return characterId;
        });
        if (new Set(seatCharacterIds).size !== ROOM_PLAYER_IDS.length) throw new Error('无法分配唯一角色');
        activeRoom.game = createGame({ mode: 'spectator', humanCharacterId: null, playerCount: MULTIPLAYER_PLAYER_COUNT, selectedCharacterIds: [], seatCharacterIds, seed: activeRoom.seed });
        activeRoom.status = 'playing';
        activeRoom.updatedAt = Date.now();
        broadcast(activeRoom);
        void persistRooms();
        scheduleGame(activeRoom);
        return;
      }
      if (message.type === 'submit-decision') {
        const game = activeRoom.game;
        if (activeRoom.status !== 'playing' || game === null) throw new Error('游戏尚未开始');
        const pending = game.pendingDecision;
        if (!pending || pending.id !== message.pendingDecisionId || pending.actorId !== activeParticipant.playerId) throw new Error('决策已过期或不属于你的席位');
        const driver = activeRoom.drivers[activeParticipant.playerId];
        if (driver?.kind !== 'human' || driver.participantId !== activeParticipant.participantId) throw new Error('该席位当前不是由你驱动');
        activeRoom.game = reduceGame(game, {
          type: 'submit-decision',
          pendingDecisionId: pending.id,
          actorId: pending.actorId,
          decision: submittedDecisionFromWire(message.decision),
        });
        activeRoom.updatedAt = Date.now();
        broadcast(activeRoom);
        void persistRooms();
        scheduleGame(activeRoom);
      }
    } catch (error) {
      send(socket, errorMessage('room_error', error instanceof Error ? error.message : '多人房间操作失败'));
    }
  });

  socket.on('close', () => {
    connectionCount -= 1;
    const remainingConnections = (connectionsByAddress.get(address) ?? 1) - 1;
    if (remainingConnections > 0) connectionsByAddress.set(address, remainingConnections);
    else connectionsByAddress.delete(address);
    if (activeRoom && activeParticipant) {
      const currentSocket = socketsByParticipant.get(activeParticipant.participantId);
      if (currentSocket === socket) {
        socketsByParticipant.delete(activeParticipant.participantId);
        activeParticipant.connected = false;
        activeRoom.updatedAt = Date.now();
        broadcast(activeRoom);
        void persistRooms();
        scheduleDisconnectTakeover(activeRoom, activeParticipant);
      }
    }
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Multiplayer server listening on ws://${HOST}:${PORT}/multiplayer`);
});

function shutdown(): void {
  void persistRooms().finally(() => httpServer.close(() => process.exit(0)));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
