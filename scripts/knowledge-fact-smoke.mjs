import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let addKnowledge;
let applyNightSkillDecision;
let getNextNightSkillDecision;
try {
  ({ addKnowledge } = await server.ssrLoadModule('/src/domain/engine/events.ts'));
  ({ applyNightSkillDecision, getNextNightSkillDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
} finally {
  await server.close();
}

const roleIds = ['wolf', 'seer', 'witch', 'villager', 'villager', 'wolf'];
const skillIds = ['soul-exchange', 'liquid-control', 'healing', 'mind-reading', 'levitation', 'witch-killer'];
const characterIds = ['soul-0', 'soul-1', 'soul-2', 'soul-3', 'soul-4', 'soul-5'];

function initialKnowledge(gameId, playerId) {
  return [
    {
      id: `${gameId}-fact-${playerId}-self`,
      subjectPlayerId: playerId,
      kind: 'role',
      value: roleIds[playerId],
      observedDay: 0,
      sourceEventId: `${gameId}-event-0-0`,
    },
    ...skillIds.map((skillId, subjectPlayerId) => ({
      id: `${gameId}-fact-${playerId}-${subjectPlayerId + 1}`,
      subjectPlayerId,
      kind: 'skill',
      value: skillId,
      observedDay: 0,
      sourceEventId: `${gameId}-event-0-1`,
    })),
  ];
}

function makeState() {
  const gameId = 'knowledge-fact-smoke';
  return {
    schemaVersion: 1,
    gameId,
    board: '6人局',
    mode: 'spectator',
    automationMode: 'local',
    usedFreeProvider: false,
    humanPlayerId: null,
    seed: 1,
    rngState: 1,
    day: 1,
    phase: 'night-skills',
    players: characterIds.map((characterId, id) => ({
      id,
      characterId,
      roleAssignmentId: `role-${id}`,
      skillInstanceId: `skill-${id}`,
      alive: true,
    })),
    roleAssignments: roleIds.map((roleId, ownerPlayerId) => ({
      id: `role-${ownerPlayerId}`,
      ownerPlayerId,
      roleId,
      resources: {},
    })),
    skillInstances: skillIds.map((definitionId, ownerPlayerId) => ({
      id: `skill-${ownerPlayerId}`,
      definitionId,
      ownerPlayerId,
      status: ownerPlayerId < 2 ? 'ready' : 'exhausted',
      remainingUses: ownerPlayerId < 2 ? 1 : 0,
      data: {},
    })),
    knowledgeByPlayer: Object.fromEntries(characterIds.map((_, playerId) => [playerId, initialKnowledge(gameId, playerId)])),
    speechOrder: [0, 1, 2, 3, 4, 5],
    publicEvents: [],
    privateEvents: [],
    archivedTimelines: [],
    currentVotes: [],
    pendingDecision: null,
    morningCheckpoint: null,
    causalLocks: [],
    result: null,
  };
}

function soulExchangePending() {
  return {
    id: 'soul-exchange-decision',
    kind: 'skill',
    schemaKey: 'optional-target',
    actorId: 0,
    title: '灵魂交换',
    description: '交换职业',
    candidates: [1],
    allowAbstain: true,
    skillInstanceId: 'skill-0',
    options: {},
  };
}

{
  const state = makeState();
  const ownerFacts = state.knowledgeByPlayer[0];
  const targetFacts = state.knowledgeByPlayer[1];
  applyNightSkillDecision(state, soulExchangePending(), { use: true, targetPlayerId: 1 });

  assert.equal(ownerFacts.length, 7);
  assert.equal(targetFacts.length, 7);
  assert.equal(new Set(ownerFacts.map((fact) => fact.id)).size, ownerFacts.length);
  assert.equal(new Set(targetFacts.map((fact) => fact.id)).size, targetFacts.length);

  const ownerSelfRole = ownerFacts.find((fact) => fact.id === `${state.gameId}-fact-0-self`);
  const targetSelfRole = targetFacts.find((fact) => fact.id === `${state.gameId}-fact-1-self`);
  assert.equal(ownerSelfRole?.value, 'seer');
  assert.equal(targetSelfRole?.value, 'wolf');
  assert.equal(ownerSelfRole?.observedDay, 1);
  assert.equal(targetSelfRole?.observedDay, 1);
  assert.equal(ownerSelfRole?.sourceEventId, targetSelfRole?.sourceEventId);

  const liquidPending = getNextNightSkillDecision(state);
  assert.equal(liquidPending?.skillInstanceId, 'skill-1');
  assert.deepEqual(liquidPending?.options.factIds, targetFacts.map((fact) => fact.id));

  const spreadState = structuredClone(state);
  applyNightSkillDecision(spreadState, liquidPending, {
    use: true,
    mode: 'spread',
    targetPlayerId: null,
    factId: `${state.gameId}-fact-1-self`,
  });
  const spreadEvent = spreadState.publicEvents.at(-1);
  assert.deepEqual(spreadEvent?.targetPlayerIds, [1]);
  assert.match(spreadEvent?.text ?? '', /是狼人/);

  const duplicateState = structuredClone(state);
  duplicateState.knowledgeByPlayer[1].at(-1).id = `${state.gameId}-fact-1-self`;
  assert.throws(() => getNextNightSkillDecision(duplicateState), /知识事实 ID 冲突/);
}

{
  const state = makeState();
  state.knowledgeByPlayer[2] = state.knowledgeByPlayer[2].filter((fact) => fact.id !== `${state.gameId}-fact-2-self`);
  const added = addKnowledge(state, 2, {
    subjectPlayerId: 2,
    kind: 'role',
    value: 'villager',
    observedDay: state.day,
  }, 'replacement-role-event');
  assert.equal(added.id, `${state.gameId}-fact-2-7`);
  assert.equal(new Set(state.knowledgeByPlayer[2].map((fact) => fact.id)).size, state.knowledgeByPlayer[2].length);
}

console.log('Knowledge fact smoke tests passed');
