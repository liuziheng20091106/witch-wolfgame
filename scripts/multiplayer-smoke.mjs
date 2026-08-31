#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
const temp = await mkdtemp(join(tmpdir(), 'majo-multiplayer-'));
const port = 34124;
const stateFile = join(temp, 'rooms.json');
let aiRequestCount = 0;
const failedRooms = new Set();
const projectRoot = new URL('..', import.meta.url);
const aiServer = createServer((request, response) => {
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    aiRequestCount += 1;
    const sessionId = String(request.headers['x-majo-wolf-session'] ?? '');
    const recoverableFailure = sessionId.includes('ERR234') && !failedRooms.has('ERR234');
    if (recoverableFailure) failedRooms.add('ERR234');
    if (recoverableFailure || sessionId.includes('BADERR')) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'fake_unavailable' }));
      return;
    }
    try {
      const payload = JSON.parse(raw);
      const prompt = JSON.parse(payload.messages[1].content);
      const candidate = prompt.legalCandidates[0]?.playerId ?? null;
      const decision = prompt.action.schema === 'speech'
        ? { speech: '[FAKE-AI] 这是模型生成的公开判断。' }
        : prompt.action.schema === 'wolf-council'
          ? { message: '[FAKE-AI] 依据公开信息选择目标。', recommendedTargetPlayerId: candidate }
          : prompt.action.schema === 'target'
            ? { targetPlayerId: candidate }
            : prompt.action.schema === 'witch'
              ? { save: false, poisonTargetPlayerId: null }
              : prompt.action.schema === 'optional-target'
                ? { use: false, targetPlayerId: null }
                : prompt.action.schema === 'liquid-control'
                  ? { use: false, mode: null, targetPlayerId: null, factId: null }
                  : prompt.action.schema === 'levitation'
                    ? { use: false, mode: null, targetPlayerId: null }
                    : prompt.action.schema === 'voice-mimic'
                      ? { use: false, targetPlayerId: null, forgedSpeech: null }
                      : { use: false };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'fake_invalid_request' }));
    }
  });
});
await new Promise((resolve, reject) => {
  aiServer.once('error', reject);
  aiServer.listen(0, '127.0.0.1', resolve);
});
const aiPort = aiServer.address().port;
function startServer(testPort = port, testStateFile = stateFile) {
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'multiplayer/server.ts'], {
    env: { ...process.env, MAJO_MULTIPLAYER_PORT: String(testPort), MAJO_MULTIPLAYER_HOST: '127.0.0.1', MAJO_MULTIPLAYER_STATE: testStateFile, MAJO_MULTIPLAYER_DISCONNECT_GRACE_MS: '150', MAJO_MULTIPLAYER_AI_ENDPOINT: `http://127.0.0.1:${aiPort}/chat/completions`, MAJO_MULTIPLAYER_AI_RETRY_COUNT: '0', MAJO_MULTIPLAYER_ALLOWED_ORIGINS: 'http://127.0.0.1:5173' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__stderr = '';
  child.stderr.on('data', (chunk) => { child.__stderr += chunk.toString(); });
  return child;
}
const child = startServer();
async function waitReady(process = child) {
  let output = '';
  for await (const chunk of process.stdout) {
    output += chunk.toString();
    if (output.includes('Multiplayer server listening')) return output;
  }
  throw new Error(`多人服务器启动失败：${output}${process.__stderr}`);
}

function client() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
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
    async next(predicate, label = '未知阶段', timeout = 5000) {
      const existing = messages.find(predicate);
      if (existing) return existing;
      return new Promise((resolve, reject) => {
        const waiter = () => {
          const found = messages.find(predicate);
          if (found) {
            resolve(found);
            return;
          }
          waiters.push(waiter);
        };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`等待多人消息超时（${label}）；已收消息：${JSON.stringify(messages)}`));
        }, timeout).unref();
      });
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
  const blankName = client();
  await blankName.open();
  blankName.send({ type: 'create-room', playerName: '   ', characterId: 'soul-0', playerCount: 6 });
  const blankNameError = await blankName.next((message) => message.type === 'error', '空白名称拒绝');
  assert.equal(blankNameError.code, 'invalid_message');
  blankName.socket.close();

  const host = client();
  await host.open();
  host.send({ type: 'create-room', playerName: '  房主  ', characterId: 'soul-0', playerCount: 14, seed: 20260829 });
  const hostWelcome = await host.next((message) => message.type === 'welcome', '房主创建');
  assert.equal(hostWelcome.room.participants[0].playerName, '房主', '服务端必须保存规范化名称');
  assert.match(hostWelcome.room.roomCode, /^[A-Z2-9]{6}$/);
  assert.equal(hostWelcome.room.playerCount, 14);
  assert.equal(hostWelcome.room.drivers.length, 14);
  assert.equal(hostWelcome.room.drivers[0].kind, 'human');
  assert.equal(hostWelcome.room.drivers.slice(1).every((driver) => driver.kind === 'ai'), true);

  const guest = client();
  await guest.open();
  guest.send({ type: 'join-room', roomCode: hostWelcome.room.roomCode, playerName: ' 客人 ', characterId: 'soul-1' });
  const guestWelcome = await guest.next((message) => message.type === 'welcome', '客人加入');
  assert.equal(guestWelcome.room.participants.find((participant) => participant.playerId === 1)?.playerName, '客人', '加入房间名称必须被规范化');
  assert.equal(guestWelcome.room.selfPlayerId, 1);
  assert.equal(guestWelcome.room.drivers[1].kind, 'human');

  const duplicate = client();
  await duplicate.open();
  duplicate.send({ type: 'join-room', roomCode: hostWelcome.room.roomCode, playerName: '重复', characterId: 'soul-1' });
  const duplicateError = await duplicate.next((message) => message.type === 'error', '重复角色拒绝');
  assert.match(duplicateError.message, /角色已被选择/);
  duplicate.socket.close();
  const invalidResume = client();
  await invalidResume.open();
  invalidResume.send({ type: 'resume-room', roomCode: 'BAD234', resumeToken: 'x'.repeat(32) });
  const invalidResumeError = await invalidResume.next((message) => message.type === 'error', '无效恢复凭据拒绝');
  assert.equal(invalidResumeError.code, 'resume_invalid');
  invalidResume.socket.close();
  const denied = new WebSocket(`ws://127.0.0.1:${port}/multiplayer`, { origin: 'https://evil.example' });
  denied.on('error', () => {});
  const deniedStatus = await new Promise((resolve, reject) => {
    denied.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    setTimeout(() => reject(new Error('未允许的 WebSocket Origin 未被拒绝')), 5000).unref();
  });
  assert.equal(deniedStatus, 403, '未允许的 WebSocket Origin 必须在升级阶段被拒绝');
  const oversized = client();
  oversized.socket.on('error', () => {});
  await oversized.open();
  const oversizedClosed = new Promise((resolve, reject) => {
    oversized.socket.once('close', resolve);
    setTimeout(() => reject(new Error('超大 WebSocket 消息未关闭连接')), 5000).unref();
  });
  oversized.send({ type: 'oversized', payload: 'x'.repeat(40 * 1024) });
  const oversizedCloseCode = await oversizedClosed;
  assert.equal(oversizedCloseCode, 1009, '超大 WebSocket 消息必须以消息过大关闭');
  assert.equal(child.exitCode, null, '超大 WebSocket 消息不得终止多人服务');
  const transferHost = client();
  await transferHost.open();
  transferHost.send({ type: 'create-room', playerName: '临时房主', characterId: 'soul-2', playerCount: 6, seed: 20260830 });
  const transferHostWelcome = await transferHost.next((message) => message.type === 'welcome', '转移测试房主创建');
  const transferGuest = client();
  await transferGuest.open();
  transferGuest.send({ type: 'join-room', roomCode: transferHostWelcome.room.roomCode, playerName: '继任房主', characterId: 'soul-3' });
  const transferGuestWelcome = await transferGuest.next((message) => message.type === 'welcome', '继任房主加入');
  transferHost.send({ type: 'set-ready', ready: true });
  await transferGuest.next((message) => message.type === 'room-state' && message.room.participants.find((participant) => participant.playerId === 0)?.ready === true, '临时房主准备同步');
  transferHost.socket.close();
  const transferred = await transferGuest.next((message) => message.type === 'room-state' && message.room.hostParticipantId === transferGuestWelcome.room.selfParticipantId, '大厅断线房主转移');
  assert.equal(transferred.room.drivers[0].kind, 'ai');
  transferGuest.send({ type: 'set-ready', ready: true });
  await transferGuest.next((message) => message.type === 'room-state' && message.room.participants.every((participant) => participant.ready), '继任房主准备');
  transferGuest.send({ type: 'start-game' });
  await transferGuest.next((message) => message.type === 'room-state' && message.room.status === 'playing', '继任房主开始游戏');
  transferGuest.send({ type: 'leave-room' });
  transferGuest.socket.close();

  host.send({ type: 'set-ready', ready: true });
  guest.send({ type: 'set-ready', ready: true });
  await host.next((message) => message.type === 'room-state' && message.room.participants.every((participant) => participant.ready), '全部玩家准备');
  host.send({ type: 'start-game' });

  let hostState = await host.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.observation !== null, '房主开始游戏');
  let guestState = await guest.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.observation !== null, '客人收到开始状态');
  assert.equal(hostState.room.observation.omniscient, false);
  assert.equal(guestState.room.observation.omniscient, false);
  assert.equal(hostState.room.observation.players.filter((player) => player.roleId !== null).length >= 1, true);
  assert.equal(guestState.room.observation.players.filter((player) => player.roleId !== null).length >= 1, true);
  assert.equal(hostState.room.observation.players.find((player) => player.id === 0).isSelf, true);
  assert.equal(guestState.room.observation.players.find((player) => player.id === 1).isSelf, true);
  assert.equal(hostState.room.observation.players.every((player) => player.avatarUrl === ''), true, '多人 wire 不得携带服务端 file:// 头像路径');

  host.send({ type: 'submit-decision', pendingDecisionId: 'stale-decision', decision: { targetPlayerId: 1 } });
  const staleError = await host.next((message) => message.type === 'error' && /过期|不属于/.test(message.message), '过期决策拒绝');
  assert.equal(staleError.code, 'room_error');

  const resumeToken = guestWelcome.resumeToken;
  const resumedGuest = client();
  await resumedGuest.open();
  resumedGuest.send({ type: 'resume-room', roomCode: hostWelcome.room.roomCode, resumeToken });
  const resumedWelcome = await resumedGuest.next((message) => message.type === 'welcome', '重复连接恢复房间');
  assert.equal(resumedWelcome.room.selfPlayerId, 1);
  guest.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 220));
  const afterStaleClose = [...host.messages].reverse().find((message) => message.type === 'room-state');
  assert.equal(afterStaleClose.room.participants.find((participant) => participant.playerId === 1)?.connected, true, '旧连接关闭及其超时回调不得覆盖新连接状态');
  assert.equal(afterStaleClose.room.drivers[1].kind, 'human', '旧连接超时不得把已恢复真人转为 AI');

  resumedGuest.socket.close();
  let returnedGuest = client();
  await returnedGuest.open();
  returnedGuest.send({ type: 'resume-room', roomCode: hostWelcome.room.roomCode, resumeToken });
  let returnedWelcome = await returnedGuest.next((message) => message.type === 'welcome' && message.room.drivers[1].kind === 'human', '再次重连恢复真人驱动');
  returnedGuest.send({ type: 'leave-room' });
  const racedLeave = await host.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.participants.find((participant) => participant.playerId === 1)?.connected === false && message.room.drivers[1].kind === 'ai', '断线后宽限期内离开转 AI');
  await new Promise((resolve) => setTimeout(resolve, 220));
  const afterRacedLeave = [...host.messages].reverse().find((message) => message.type === 'room-state');
  assert.equal(afterRacedLeave.room.hostParticipantId, hostWelcome.room.hostParticipantId, '过期接管定时器不得改变房主归属');
  assert.equal(afterRacedLeave.room.participants.find((participant) => participant.playerId === 1)?.connected, false, '过期接管定时器不得恢复已离开的席位');
  assert.equal(afterRacedLeave.room.drivers[1].kind, 'ai', '过期接管定时器不得覆盖离开后的 AI 驱动');
  assert.notEqual(racedLeave, undefined);
  returnedGuest.socket.close();
  returnedGuest = client();
  await returnedGuest.open();
  returnedGuest.send({ type: 'resume-room', roomCode: hostWelcome.room.roomCode, resumeToken });
  returnedWelcome = await returnedGuest.next((message) => message.type === 'welcome' && message.room.drivers[1].kind === 'human', '离开竞态后恢复真人驱动');
  await new Promise((resolve) => setTimeout(resolve, 220));
  const afterReconnectRace = [...host.messages].reverse().find((message) => message.type === 'room-state');
  assert.equal(afterReconnectRace.room.participants.find((participant) => participant.playerId === 1)?.connected, true, '断线宽限期间重连必须保持在线');
  assert.equal(afterReconnectRace.room.drivers[1].kind, 'human', '断线宽限期间重连不得被转为 AI');

  let lastSubmittedHost = '';
  let lastSubmittedGuest = '';
  for (let step = 0; step < 600; step += 1) {
    hostState = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation) ?? hostState;
    guestState = [...returnedGuest.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation) ?? returnedWelcome;
    const pendingHost = hostState.room.observation?.pendingDecision;
    const pendingGuest = guestState.room.observation?.pendingDecision;
    if (pendingHost && pendingHost.id !== lastSubmittedHost) {
      host.send({ type: 'submit-decision', pendingDecisionId: pendingHost.id, decision: decisionFor(pendingHost, '继续依据公开事实判断。') });
      lastSubmittedHost = pendingHost.id;
    }
    if (pendingGuest && pendingGuest.id !== lastSubmittedGuest) {
      returnedGuest.send({ type: 'submit-decision', pendingDecisionId: pendingGuest.id, decision: decisionFor(pendingGuest, '我会检查公开票型。') });
      lastSubmittedGuest = pendingGuest.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const progressed = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation?.day > 0);
    const aiSpeech = host.messages.some((message) => message.type === 'room-state' && message.room.observation?.publicEvents.some((event) => event.kind === 'speech' && event.text.includes('[FAKE-AI]')));
    if (progressed && aiSpeech) break;
  }
  const progressed = [...host.messages].reverse().find((message) => message.type === 'room-state' && message.room.observation?.day > 0);
  assert.notEqual(progressed, undefined, `混合真人与 AI 驱动必须推进到白天：${JSON.stringify({ host: hostState.room.observation?.pendingDecision, guest: guestState.room.observation?.pendingDecision, errors: host.messages.filter((message) => message.type === 'error').slice(-5) })}`);
  assert.ok(aiRequestCount > 0, '多人 AI 必须调用兼容 Chat Completions 服务');
  const aiSpeech = host.messages.some((message) => message.type === 'room-state' && message.room.observation?.publicEvents.some((event) => event.kind === 'speech' && event.text.includes('[FAKE-AI]')));
  assert.equal(aiSpeech, true, '多人公开发言必须来自 AI 服务响应');

  returnedGuest.send({ type: 'leave-room' });
  const converted = await host.next((message) => message.type === 'room-state' && message.room.status === 'playing' && message.room.participants.find((participant) => participant.playerId === 1)?.connected === false && message.room.drivers[1].kind === 'ai', '离开后转 AI');
  const leftParticipant = converted.room.participants.find((participant) => participant.playerId === 1);
  assert.notEqual(leftParticipant, undefined, '进行中离开必须保留原真人席位');
  assert.equal(leftParticipant.connected, false, '进行中离开必须标记席位断线');
  assert.equal(converted.room.observation?.players.some((player) => player.id === 1), true, '进行中离开不得从游戏观察删除席位');
  assert.equal(converted.room.drivers[1].kind, 'ai');
  const rejoinedGuest = client();
  await rejoinedGuest.open();
  rejoinedGuest.send({ type: 'resume-room', roomCode: hostWelcome.room.roomCode, resumeToken });
  const rejoinedWelcome = await rejoinedGuest.next((message) => message.type === 'welcome', '进行中离开后恢复席位');
  assert.equal(rejoinedWelcome.room.selfPlayerId, 1);
  assert.equal(rejoinedWelcome.room.participants.find((participant) => participant.playerId === 1)?.connected, true);
  assert.equal(rejoinedWelcome.room.drivers[1].kind, 'human');
  host.socket.close();
  returnedGuest.socket.close();
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  rejoinedGuest.socket.close();
  const persisted = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(Array.isArray(persisted), true);

  const validRoom = persisted[0];
  assert.notEqual(validRoom, undefined);
  assert.notEqual(validRoom.game, null, '终局恢复样本必须包含合法游戏状态');
  const restartParticipant = validRoom.participants.find((participant) => validRoom.drivers[participant.playerId].kind === 'human');
  const restartPlayerId = restartParticipant?.playerId;
  assert.notEqual(restartPlayerId, undefined, '重启样本必须保留真人驱动席位');
  validRoom.participants.forEach((participant) => { participant.connected = true; });
  validRoom.game.pendingDecision = { id: 'restart-human-pending', kind: 'speech', schemaKey: 'speech', actorId: restartPlayerId, title: '重启真人发言', description: '', candidates: [], allowAbstain: true, skillInstanceId: null, options: {} };
  assert.equal(validRoom.drivers[restartPlayerId].kind, 'human', '重启样本必须保留真人驱动');
  const restartDecisionId = validRoom.game.pendingDecision.id;
  const endedRoom = structuredClone(validRoom);
  endedRoom.roomCode = 'END234';
  endedRoom.status = 'ended';
  await writeFile(stateFile, JSON.stringify([validRoom, endedRoom]), 'utf8');
  const reloadPort = port + 1;
  const reloaded = startServer(reloadPort);
  await waitReady(reloaded);
  const reconnect = new WebSocket(`ws://127.0.0.1:${reloadPort}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
  const reloadMessages = [];
  reconnect.on('message', (data) => { reloadMessages.push(JSON.parse(data.toString())); });
  await new Promise((resolve, reject) => { reconnect.once('open', resolve); reconnect.once('error', reject); });
  const reconnectParticipant = validRoom.participants.find((participant) => participant.playerId !== restartPlayerId) ?? validRoom.participants[0];
  reconnect.send(JSON.stringify({ type: 'resume-room', roomCode: validRoom.roomCode, resumeToken: reconnectParticipant.resumeToken }));
  const restored = await new Promise((resolve, reject) => {
    const check = () => {
      const welcome = reloadMessages.find((message) => message.type === 'welcome');
      const takenOver = reloadMessages.find((message) => message.type === 'room-state' && message.room.drivers[restartPlayerId].kind === 'ai');
      const progressed = reloadMessages.find((message) => message.type === 'room-state' && message.room.observation?.pendingDecision?.id !== restartDecisionId);
      if (welcome && takenOver && progressed) resolve({ welcome, takenOver, progressed });
      else setTimeout(check, 20).unref();
    };
    check();
    setTimeout(() => reject(new Error(`重启后真人席位未转 AI 并推进：${JSON.stringify(reloadMessages)}`)), 5000).unref();
  });
  assert.equal(restored.welcome.type, 'welcome');
  assert.equal(restored.takenOver.room.drivers[restartPlayerId].kind, 'ai');
  assert.equal(restored.progressed.type, 'room-state');
  await new Promise((resolve) => setTimeout(resolve, 220));
  const endedReconnect = new WebSocket(`ws://127.0.0.1:${reloadPort}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
  await new Promise((resolve, reject) => { endedReconnect.once('open', resolve); endedReconnect.once('error', reject); });
  endedReconnect.send(JSON.stringify({ type: 'resume-room', roomCode: endedRoom.roomCode, resumeToken: endedRoom.participants[0].resumeToken }));
  const restoredEnded = await new Promise((resolve, reject) => {
    endedReconnect.once('message', (data) => resolve(JSON.parse(data.toString())));
    setTimeout(() => reject(new Error('终局房间重载超时')), 5000).unref();
  });
  const recoverableRoom = structuredClone(validRoom);
  recoverableRoom.roomCode = 'ERR234';
  const recoveryActorId = 0;
  const recoverySkill = recoverableRoom.game.skillInstances.find((skill) => skill.ownerPlayerId === recoveryActorId);
  assert.notEqual(recoverySkill, undefined, '恢复样本必须有技能实例');
  recoverySkill.definitionId = 'ignition';
  recoverySkill.status = 'ready';
  recoverableRoom.game.pendingDecision = { id: 'recoverable-ai-decision', kind: 'skill', schemaKey: 'optional-target', actorId: recoveryActorId, title: '点火', description: '', candidates: [1], allowAbstain: true, skillInstanceId: recoverySkill.id, options: {} };
  recoverableRoom.drivers[recoveryActorId] = { kind: 'ai' };
  const recoverableStateFile = join(temp, 'recoverable-rooms.json');
  await writeFile(recoverableStateFile, JSON.stringify([recoverableRoom]), 'utf8');
  const recoverablePort = port + 3;
  const recoverable = startServer(recoverablePort, recoverableStateFile);
  let recoverableErrors = '';
  recoverable.stderr.on('data', (chunk) => { recoverableErrors += chunk.toString(); });
  await waitReady(recoverable);
  const recoveryParticipant = recoverableRoom.participants.find((participant) => participant.playerId !== recoveryActorId) ?? recoverableRoom.participants[0];
  const recoverySocket = new WebSocket(`ws://127.0.0.1:${recoverablePort}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
  await new Promise((resolve, reject) => { recoverySocket.once('open', resolve); recoverySocket.once('error', reject); });
  recoverySocket.send(JSON.stringify({ type: 'resume-room', roomCode: recoverableRoom.roomCode, resumeToken: recoveryParticipant.resumeToken }));
  await new Promise((resolve, reject) => { recoverySocket.once('message', (data) => resolve(JSON.parse(data.toString()))); setTimeout(() => reject(new Error('可恢复 AI 房间连接超时')), 5000).unref(); });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(recoverable.exitCode, null, '可恢复 AI 驱动异常不得终止多人服务');
  assert.match(recoverableErrors, /multiplayer_ai_drive_recovered/);
  const recoveredState = JSON.parse(await readFile(recoverableStateFile, 'utf8'))[0];
  assert.equal(recoveredState.game.aiFailureOccurred, true);
  assert.equal(recoveredState.game.lastAiFailure.kind, 'multiplayer-recovered');
  assert.equal(recoveredState.game.lastAiFailure.pendingDecisionId, 'recoverable-ai-decision');
  recoverySocket.close();
  recoverable.kill('SIGTERM');
  await new Promise((resolve) => recoverable.once('exit', resolve));

  const brokenRoom = structuredClone(recoverableRoom);
  brokenRoom.roomCode = 'BADERR';
  brokenRoom.game.pendingDecision.id = 'fatal-ai-decision';
  brokenRoom.game.pendingDecision.skillInstanceId = 'missing-skill';
  const brokenStateFile = join(temp, 'broken-rooms.json');
  await writeFile(brokenStateFile, JSON.stringify([brokenRoom]), 'utf8');
  const brokenPort = port + 4;
  const broken = startServer(brokenPort, brokenStateFile);
  let brokenErrors = '';
  broken.stderr.on('data', (chunk) => { brokenErrors += chunk.toString(); });
  await waitReady(broken);
  const brokenParticipant = brokenRoom.participants.find((participant) => participant.playerId !== recoveryActorId) ?? brokenRoom.participants[0];
  const brokenSocket = new WebSocket(`ws://127.0.0.1:${brokenPort}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
  await new Promise((resolve, reject) => { brokenSocket.once('open', resolve); brokenSocket.once('error', reject); });
  brokenSocket.send(JSON.stringify({ type: 'resume-room', roomCode: brokenRoom.roomCode, resumeToken: brokenParticipant.resumeToken }));
  await new Promise((resolve, reject) => { brokenSocket.once('message', (data) => resolve(JSON.parse(data.toString()))); setTimeout(() => reject(new Error('不可恢复 AI 房间连接超时')), 5000).unref(); });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(broken.exitCode, null, '不可恢复 AI 驱动异常不得终止多人服务');
  assert.match(brokenErrors, /multiplayer_ai_drive_fatal/);
  const failedState = JSON.parse(await readFile(brokenStateFile, 'utf8'))[0];
  assert.equal(failedState.status, 'failed');
  assert.match(failedState.failureMessage, /^AI 驱动发生不可恢复错误：/);
  brokenSocket.close();
  broken.kill('SIGTERM');
  await new Promise((resolve) => broken.once('exit', resolve));
  assert.equal(restoredEnded.type, 'welcome');
  assert.equal(restoredEnded.room.status, 'ended');
  reconnect.close();
  endedReconnect.close();
  reloaded.kill('SIGTERM');
  await new Promise((resolve) => reloaded.once('exit', resolve));

  await writeFile(stateFile, '{ damaged', 'utf8');
  const damagedBefore = await readFile(stateFile, 'utf8');
  const damaged = startServer(port + 2);
  let damagedErrors = '';
  damaged.stderr.on('data', (chunk) => { damagedErrors += chunk.toString(); });
  await waitReady(damaged);
  assert.match(damagedErrors, /multiplayer_state_load_error/);
  const healthStatus = await new Promise((resolve, reject) => {
    const health = request({ hostname: '127.0.0.1', port: port + 2, path: '/healthz' }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    health.once('error', reject);
    health.end();
  });
  assert.equal(healthStatus, 503, '状态加载失败时健康检查必须失败');
  const blocked = new WebSocket(`ws://127.0.0.1:${port + 2}/multiplayer`, { origin: 'http://127.0.0.1:5173' });
  blocked.on('error', () => {});
  const blockedStatus = await new Promise((resolve, reject) => {
    blocked.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    setTimeout(() => reject(new Error('损坏状态下 WebSocket 写入入口未被阻断')), 5000).unref();
  });
  assert.equal(blockedStatus, 503, '状态加载失败时必须拒绝 WebSocket 操作');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await readFile(stateFile, 'utf8'), damagedBefore, '状态加载失败不得覆盖原始损坏文件');
  assert.equal(damaged.exitCode, null, '状态加载失败不得终止多人服务');
  damaged.kill('SIGTERM');
  await new Promise((resolve) => damaged.once('exit', resolve));
  console.log('PASS 多人房间、隐私、重连、持久化校验与混合驱动验证全部通过');
} finally {
  if (!child.killed) child.kill('SIGKILL');
  await new Promise((resolve) => aiServer.close(resolve));
}
