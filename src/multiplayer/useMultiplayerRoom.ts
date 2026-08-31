import { useCallback, useEffect, useRef, useState } from 'react';
import { characterById } from '../domain/catalog/characters';
import type { CharacterId, GameObservation, SubmittedDecision } from '../domain/model';
import {
  encodeMultiplayerMessage,
  type MultiplayerClientMessage,
  type MultiplayerRoomView,
  type MultiplayerServerMessage,
} from './protocol';

function restoreLocalAvatars(room: MultiplayerRoomView): MultiplayerRoomView {
  if (room.observation === null) return room;
  const observation: GameObservation = {
    ...room.observation,
    players: room.observation.players.map((player) => ({
      ...player,
      avatarUrl: characterById[player.characterId]?.avatarUrl ?? '',
    })),
  };
  return { ...room, observation };
}

const RESUME_KEY = 'majo-wolf.multiplayer.resume.v1';

interface ResumeRecord {
  roomCode: string;
  resumeToken: string;
}

export interface MultiplayerController {
  connected: boolean;
  connecting: boolean;
  room: MultiplayerRoomView | null;
  error: string | null;
  createRoom(playerName: string, characterId: CharacterId, playerCount: number, seed?: number): void;
  joinRoom(roomCode: string, playerName: string, characterId: CharacterId): void;
  setReady(ready: boolean): void;
  startGame(): void;
  submitDecision(decision: SubmittedDecision): void;
  leaveRoom(): void;
  clearError(): void;
}

function multiplayerUrl(): string {
  const configured = import.meta.env.VITE_MULTIPLAYER_ENDPOINT?.trim();
  if (configured) return configured;
  if (import.meta.env.DEV) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/multiplayer`;
  }
  const backendEndpoint = import.meta.env.VITE_MAIN_BACKEND_ENDPOINT?.trim()
    || 'https://freeapi.majowolf.tkcloud.online/api/ai/chat/completions';
  const backendUrl = new URL(backendEndpoint, window.location.origin);
  return `${backendUrl.protocol === 'https:' ? 'wss:' : 'ws:'}//${backendUrl.host}/multiplayer`;
}

export function useMultiplayerRoom(): MultiplayerController {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [room, setRoom] = useState<MultiplayerRoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const queuedMessageRef = useRef<MultiplayerClientMessage | null>(null);
  const roomRef = useRef<MultiplayerRoomView | null>(null);

  const handleMessage = useCallback((event: MessageEvent<string>) => {
    let message: MultiplayerServerMessage;
    try {
      message = JSON.parse(event.data) as MultiplayerServerMessage;
    } catch {
      setError('多人服务器返回了无法解析的消息');
      return;
    }
    if (message.type === 'error') {
      if (message.code === 'resume_invalid') localStorage.removeItem(RESUME_KEY);
      setError(message.message);
      return;
    }
    const nextRoom = restoreLocalAvatars(message.room);
    if (message.type === 'welcome') {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ roomCode: nextRoom.roomCode, resumeToken: message.resumeToken } satisfies ResumeRecord));
    }
    roomRef.current = nextRoom;
    setRoom(nextRoom);
    setError(null);
  }, []);

  const connect = useCallback((message: MultiplayerClientMessage) => {
    socketRef.current?.close();
    queuedMessageRef.current = message;
    setConnecting(true);
    setError(null);
    const socket = new WebSocket(multiplayerUrl());
    socketRef.current = socket;
    socket.addEventListener('open', () => {
      setConnected(true);
      setConnecting(false);
      const queued = queuedMessageRef.current;
      if (queued) {
        socket.send(encodeMultiplayerMessage(queued));
        queuedMessageRef.current = null;
      }
    });
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('close', () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      setConnected(false);
      setConnecting(false);
    });
    socket.addEventListener('error', () => setError('无法连接多人服务器'));
  }, [handleMessage]);

  const send = useCallback((message: MultiplayerClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError('多人连接尚未建立');
      return;
    }
    socket.send(encodeMultiplayerMessage(message));
  }, []);

  useEffect(() => {
    const raw = localStorage.getItem(RESUME_KEY);
    if (raw !== null) {
      try {
        const resume = JSON.parse(raw) as ResumeRecord;
        connect({ type: 'resume-room', roomCode: resume.roomCode, resumeToken: resume.resumeToken });
      } catch {
        localStorage.removeItem(RESUME_KEY);
      }
    }
    return () => socketRef.current?.close();
  }, [connect]);

  const createRoom = useCallback((playerName: string, characterId: CharacterId, playerCount: number, seed?: number) => {
    const message: MultiplayerClientMessage = seed === undefined
      ? { type: 'create-room', playerName, characterId, playerCount }
      : { type: 'create-room', playerName, characterId, playerCount, seed };
    connect(message);
  }, [connect]);
  const joinRoom = useCallback((roomCode: string, playerName: string, characterId: CharacterId) => {
    connect({ type: 'join-room', roomCode: roomCode.trim().toUpperCase(), playerName, characterId });
  }, [connect]);
  const setReady = useCallback((ready: boolean) => send({ type: 'set-ready', ready }), [send]);
  const startGame = useCallback(() => send({ type: 'start-game' }), [send]);
  const submitDecision = useCallback((decision: SubmittedDecision) => {
    const pending = roomRef.current?.observation?.pendingDecision;
    if (!pending) {
      setError('当前没有等待你的多人决策');
      return;
    }
    send({ type: 'submit-decision', pendingDecisionId: pending.id, decision: decision as unknown as Record<string, unknown> });
  }, [send]);
  const leaveRoom = useCallback(() => {
    send({ type: 'leave-room' });
    localStorage.removeItem(RESUME_KEY);
    roomRef.current = null;
    setRoom(null);
    socketRef.current?.close();
  }, [send]);

  return {
    connected,
    connecting,
    room,
    error,
    createRoom,
    joinRoom,
    setReady,
    startGame,
    submitDecision,
    leaveRoom,
    clearError: () => setError(null),
  };
}
