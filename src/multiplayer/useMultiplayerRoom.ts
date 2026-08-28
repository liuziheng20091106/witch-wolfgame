import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterId, SubmittedDecision } from '../domain/model';
import {
  encodeMultiplayerMessage,
  type MultiplayerClientMessage,
  type MultiplayerRoomView,
  type MultiplayerServerMessage,
} from './protocol';

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
  createRoom(playerName: string, characterId: CharacterId, seed?: number): void;
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
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/multiplayer`;
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
      setError(message.message);
      return;
    }
    if (message.type === 'welcome') {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ roomCode: message.room.roomCode, resumeToken: message.resumeToken } satisfies ResumeRecord));
    }
    roomRef.current = message.room;
    setRoom(message.room);
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
      if (socketRef.current === socket) socketRef.current = null;
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

  const createRoom = useCallback((playerName: string, characterId: CharacterId, seed?: number) => {
    const message: MultiplayerClientMessage = seed === undefined
      ? { type: 'create-room', playerName, characterId }
      : { type: 'create-room', playerName, characterId, seed };
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
