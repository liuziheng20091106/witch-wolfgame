#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const temp = await mkdtemp(join(tmpdir(), 'majo-multiplayer-'));
const port = 34124;
const stateFile = join(temp, 'rooms.json');
const projectRoot = new URL('..', import.meta.url);
const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'multiplayer/server.ts'], {
  cwd: projectRoot,
  env: { ...process.env, MAJO_MULTIPLAYER_PORT: String(port), MAJO_MULTIPLAYER_HOST: '127.0.0.1', MAJO_MULTIPLAYER_STATE: stateFile },
  stdio: ['ignore', 'pipe', 'pipe'],
});

async function waitReady() {
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk.toString();
    if (output.includes('Multiplayer server listening')) return;
  }
  throw new Error(`多人服务器启动失败：${output}`);
}

function client() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`);
  const messages = [];
  const waiters = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString());
    messages.push(message);
    for (const waiter of waiters.splice(0)) waiter();
  });
  return {
    socket,
    messages,
    async open() {
      if (socket.readyState === WebSocket.OPEN) return;
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    },
    send(message) { socket.send(JSON.stringify(message)); },
    async next(predicate, timeout = 5000) {
      const existing = messages.find(predicate);
      if (existing) return existing;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await Promise.race([
          new Promise((resolve) => waiters.push(resolve)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('等待多人消息超时')), Math.min(250, deadline - Date.now()))),
        ]).catch((error) => {
          if (Date.now() >= deadline) throw error;
        });
        const found = messages.find(predicate);
        if (found) return found;
      }
      throw new Error('等待多人消息超时');
    },
  };
}

function decisionFor(pending, speech) {
  const targetPlayerId = pending.candidates[0] ?? null;
  if (pending.schemaKey === 'speech') return { speech };
  if (pending.schemaKey === 'wolf-council') return { message: '优先处理公开判断最准确的目标。', recommendedTargetPlayerId: targetPlayerId };
  if (pending.schemaKey === 'target') return { targetPlayerId };
  if (pending.schemaKey === 'witch') return { save: false, poisonTargetPlayerId: null };
  if (pending.schemaKey === 'optional-target') return { use: false, targetPlayerId: null };
  if (pending.schemaKey === 'liquid-control') return { use: false, mode: null, targetPlayerId: null, factId: null };
  if (pending.schemaKey === 'levitation') return { use: false, mode: null, targetPlayerId: null };
  if (pending.schemaKey === 'voice-mimic') return { use: false, targetPlayerId: null, forgedSpeech: null };
  return { use: false };
}

try {
  await waitReady();
  const host = client();
  await host.open();
  host.send({ type: 'create-room', playerName: '房主', characterId: 'soul-0', seed: 20260829 });
  const hostWelcome = await host.next((message) => message.type === 'welcome');
  assert.match(hostWelcome.room.roomCode, /^[A-Z2-9]{6}$/);
  assert.equal(hostWelcome.room.drivers[0].kind, 'human');
  assert.equal(hostWelcome.room.drivers.slice(1).every((driver) => driver.kind === 'ai'), true);

  const guest = client();
  await guest.open();
  guest.send({ type: 'join-room', roomCode: hostWelcome.room.roomCode, playerName: '客人', characterId: 'soul-1' });
  const guestWelcome = await guest.next((message) => message.type === 'welcome');
  assert.equal(guestWelcome.room.selfPlayerId, 1);
  assert.equal(guestWelcome.room.drivers[1].kind, 'human');

  const duplicate = client();
  await duplicate.open();
  duplicate.send({ type: 'join-room', roomCode: hostWelcome.room.roomCode, playerName: '重复', characterId: 'soul-1' });
  const duplicateError = await duplicate.next((message) => message.type === 'error');
  assert.match(duplicateError.message, /角色已被选择/);
  duplicate.socket.close();

  host.send({ type: 'set-ready', ready: true });
  guest.send({ type: 'set-ready', ready: true });
  await host.next((message) => message.type === 'room-state' && message.room.participants.every((participant) => participant.ready));
  host.send({ type: 'start-game' });

  let hostState = await host.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.observation !== null);
  let guestState = await guest.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.observation !== null);
  assert.equal(hostState.room.observation.omniscient, false);
  assert.equal(guestState.room.observation.omniscient, false);
  assert.equal(hostState.room.observation.players.filter((player) => player.roleId !== null).length >= 1, true);
  assert.equal(guestState.room.observation.players.filter((player) => player.roleId !== null).length >= 1, true);
  assert.equal(hostState.room.observation.players.find((player) => player.id === 0).isSelf, true);
  assert.equal(guestState.room.observation.players.find((player) => player.id === 1).isSelf, true);

  host.send({ type: 'submit-decision', pendingDecisionId: 'stale-decision', decision: { targetPlayerId: 1 } });
  const staleError = await host.next((message) => message.type === 'error' && /过期|不属于/.test(message.message));
  assert.equal(staleError.code, 'room_error');

  const resumeToken = guestWelcome.resumeToken;
  guest.socket.close();
  await host.next((message) => message.type === 'room-state' && message.room.participants.some((participant) => participant.playerId === 1 && !participant.connected));
  const resumedGuest = client();
  await resumedGuest.open();
  resumedGuest.send({ type: 'resume-room', roomCode: hostWelcome.room.roomCode, resumeToken });
  const resumedWelcome = await resumedGuest.next((message) => message.type === 'welcome');
  assert.equal(resumedWelcome.room.selfPlayerId, 1);
  assert.equal(resumedWelcome.room.participants.find((participant) => participant.playerId === 1).connected, true);

  for (let step = 0; step < 120; step += 1) {
    hostState = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation) ?? hostState;
    guestState = [...resumedGuest.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation) ?? resumedWelcome;
    const pendingHost = hostState.room.observation?.pendingDecision;
    const pendingGuest = guestState.room.observation?.pendingDecision;
    if (pendingHost) host.send({ type: 'submit-decision', pendingDecisionId: pendingHost.id, decision: decisionFor(pendingHost, '继续依据公开事实判断。') });
    if (pendingGuest) resumedGuest.send({ type: 'submit-decision', pendingDecisionId: pendingGuest.id, decision: decisionFor(pendingGuest, '我会检查公开票型。') });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const progressed = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation?.day > 0);
    if (progressed) break;
  }
  const progressed = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation?.day > 0);
  assert.notEqual(progressed, undefined, '混合真人与 AI 驱动必须推进到白天');

  resumedGuest.send({ type: 'leave-room' });
  const converted = await host.next((message) => message.type === 'room-state' && message.room.drivers[1].kind === 'ai');
  assert.equal(converted.room.participants.some((participant) => participant.playerId === 1), false);
  host.socket.close();
  resumedGuest.socket.close();

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Array.isArray(persisted), true);
  console.log('PASS 多人房间、隐私、重连与混合驱动验证全部通过');
} finally {
  if (!child.killed) child.kill('SIGKILL');
}
