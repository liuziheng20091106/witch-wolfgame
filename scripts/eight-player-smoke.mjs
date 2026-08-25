import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame;
let fallbackDecision;
let getRoleAssignment;
let reduceGame;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getRoleAssignment } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
} finally {
  await server.close();
}

function submit(state, decision) {
  const pending = state.pendingDecision;
  assert.ok(pending);
  return reduceGame(state, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision });
}

{
  const first = createGame({ mode: 'spectator', humanCharacterId: null, seed: 12345 });
  const second = createGame({ mode: 'spectator', humanCharacterId: null, seed: 12345 });
  assert.equal(first.players.length, 8);
  assert.equal(first.seatCount, 8);
  assert.deepEqual(first.speechOrder, second.speechOrder);
  assert.deepEqual(first.freeSpeechOrder, second.freeSpeechOrder);
  const roles = first.players.map((player) => getRoleAssignment(first, player.id).roleId).sort();
  assert.deepEqual(roles, ['hunter', 'seer', 'villager', 'villager', 'villager', 'witch', 'wolf', 'wolf']);
}

{
  let state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 7 });
  state.phase = 'speeches';
  state.day = 1;
  for (const skill of state.skillInstances) skill.status = 'exhausted';
  for (let count = 0; count < 8; count += 1) {
    state = reduceGame(state, { type: 'advance' });
    assert.equal(state.pendingDecision?.options.speechRound, 1);
    state = submit(state, { speech: `第一轮${count}` });
  }
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.phase, 'free-speeches');
  for (let count = 0; count < 8; count += 1) {
    state = reduceGame(state, { type: 'advance' });
    assert.equal(state.pendingDecision?.options.speechRound, 2);
    state = submit(state, { speech: `第二轮${count}` });
  }
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.phase, 'vote-skills');
}

{
  const state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 9 });
  const wolf = state.players.find((player) => getRoleAssignment(state, player.id).roleId === 'wolf');
  assert.ok(wolf);
  const pending = { id: 'vote', kind: 'vote', schemaKey: 'target', actorId: wolf.id, title: '公开投票', description: '', candidates: state.players.filter((player) => player.id !== wolf.id).map((player) => player.id), allowAbstain: true, skillInstanceId: null, options: {} };
  const noVotes = fallbackDecision(state, pending);
  assert.ok('targetPlayerId' in noVotes.decision);
  state.currentVotes.push({ voterPlayerId: state.players.find((player) => player.id !== wolf.id).id, targetPlayerId: pending.candidates[0], round: 1 });
  const withVotes = fallbackDecision(state, pending);
  assert.equal(withVotes.decision.targetPlayerId, pending.candidates[0]);
}

{
  let state = null;
  for (let seed = 1; seed <= 1000; seed += 1) {
    const candidate = createGame({ mode: 'player', humanCharacterId: 'soul-0', seed });
    const humanId = candidate.humanPlayerId;
    const wolves = candidate.players
      .filter((player) => getRoleAssignment(candidate, player.id).roleId === 'wolf')
      .map((player) => player.id);
    if (humanId !== null && wolves.includes(humanId) && wolves.some((wolfId) => wolfId < humanId)) {
      state = candidate;
      break;
    }
  }
  assert.ok(state, '应找到玩家狼人且队友座位更靠前的固定种子');
  state.phase = 'wolf-decision';
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.pendingDecision?.kind, 'wolf-decision');
  assert.equal(state.pendingDecision?.actorId, state.humanPlayerId, '参与模式的存活狼人玩家应固定拍板最终袭击');
}

{
  let state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 11 });
  state.day = 1;
  state.phase = 'voting';
  for (const skill of state.skillInstances) skill.status = 'exhausted';
  state.currentVotes = state.players.map((player, index) => ({ voterPlayerId: player.id, targetPlayerId: index < 4 ? state.players[0].id : state.players[1].id, round: 1 }));
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.phase, 'runoff-speeches');
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.pendingDecision?.options.speechRound, 3);
  state = submit(state, { speech: '平票补充' });
  state = reduceGame(state, { type: 'advance' });
  state = submit(state, { speech: '平票补充' });
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.phase, 'runoff');
}

{
  let state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 12 });
  state.day = 1;
  state.phase = 'voting';
  for (const skill of state.skillInstances) skill.status = 'exhausted';
  state.currentVotes = state.players.map((player, index) => ({ voterPlayerId: player.id, targetPlayerId: state.players[index % 4].id, round: 1 }));
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.phase, 'day-resolution');
  assert.equal(state.pendingDecision, null);
}

{
  let state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 13 });
  const hunter = state.players.find((player) => getRoleAssignment(state, player.id).roleId === 'hunter');
  assert.ok(hunter);
  state.causalLocks = state.skillInstances.filter((skill) => skill.definitionId === 'death-rewind').map((skill) => skill.id);
  hunter.alive = false;
  state.phase = 'day-resolution';
  state = reduceGame(state, { type: 'advance' });
  assert.equal(state.pendingDecision?.kind, 'hunter-shot');
  const target = state.pendingDecision.candidates[0];
  state = submit(state, { targetPlayerId: target });
  assert.equal(state.players.find((player) => player.id === target).alive, false);
  assert.ok(state.publicEvents.some((event) => event.data.actionKind === 'hunter-shot'));
}

console.log('Eight-player smoke tests passed');
