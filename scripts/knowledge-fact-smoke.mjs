import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let AiCommandError;
let addKnowledge;
let applyNightSkillDecision;
let getNextNightSkillDecision;
let getRoleAssignment;
let reduceGame;
let parseDecision;
try {
  ({ AiCommandError } = await server.ssrLoadModule('/src/ai/types.ts'));
  ({ addKnowledge } = await server.ssrLoadModule('/src/domain/engine/events.ts'));
  ({ applyNightSkillDecision, getNextNightSkillDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
  ({ getRoleAssignment } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ parseDecision } = await server.ssrLoadModule('/src/ai/schemas.ts'));
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
    creatures: [],
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

function wolfAttackEvent(day, targetPlayerId) {
  return {
    id: `wolf-attack-${day}-${targetPlayerId}`,
    kind: 'wolf-attack',
    day,
    phase: 'wolf-decision',
    text: '狼队完成袭击选择。',
    actorPlayerId: 0,
    targetPlayerIds: [targetPlayerId],
    displayAuthorPlayerId: null,
    actualAuthorPlayerId: null,
    data: { actionKind: 'wolf-decision', targetPlayerId },
    viewerPlayerIds: [0, 5],
  };
}

function assertTargetError(run, message) {
  assert.throws(run, (caught) => {
    assert.ok(caught instanceof AiCommandError);
    assert.equal(caught.kind, 'target');
    assert.equal(caught.message, message);
    return true;
  });
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
  assert.equal(liquidPending?.schemaKey, 'ignition');
  assert.equal(liquidPending?.title, '操控液体');

  const creatureState = structuredClone(state);
  applyNightSkillDecision(creatureState, liquidPending, { use: true });
  assert.equal(creatureState.creatures.length, 1);
  assert.equal(creatureState.creatures[0].id, 99);
  assert.equal(creatureState.creatures[0].ownerPlayerId, 1);
  assert.equal(getRoleAssignment(creatureState, 99).roleId, 'wolf');
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

{
  const witchPending = {
    id: 'witch-contract-validation',
    kind: 'witch-action',
    schemaKey: 'witch',
    actorId: 2,
    title: '女巫行动',
    description: '验证女巫行动契约',
    candidates: [1, 2],
    allowAbstain: true,
    skillInstanceId: null,
    options: { attackedPlayerId: 1, canSave: false, canPoison: false },
  };
  assertTargetError(
    () => parseDecision(witchPending, { save: true, poisonTargetPlayerId: null }),
    '当前决策不能使用解药',
  );
  assertTargetError(
    () => parseDecision(witchPending, { save: false, poisonTargetPlayerId: 2 }),
    '当前决策不能使用毒药',
  );
  assertTargetError(
    () => parseDecision(
      { ...witchPending, options: { attackedPlayerId: 1, canSave: true, canPoison: true } },
      { save: true, poisonTargetPlayerId: 1 },
    ),
    '不能同时救下并毒杀同一目标',
  );
}

{
  const state = makeState();
  state.phase = 'witch-action';
  state.roleAssignments[2].resources = { antidote: 1, poison: 0 };
  const next = reduceGame(state, { type: 'advance' });
  assert.equal(next.pendingDecision, null, '无狼刀且仅有解药时不应生成空女巫决策');
  assert.equal(next.phase, 'seer-action');
}

{
  const state = makeState();
  state.phase = 'witch-action';
  state.roleAssignments[2].resources = { antidote: 1, poison: 0 };
  state.privateEvents.push(wolfAttackEvent(state.day, 1));
  const next = reduceGame(state, { type: 'advance' });
  assert.equal(next.pendingDecision?.kind, 'witch-action');
  assert.deepEqual(next.pendingDecision?.candidates, [], '毒药不可用时不应暴露毒药目标候选');
  assert.deepEqual(next.pendingDecision?.options, { attackedPlayerId: 1, canSave: true, canPoison: false });
  assert.match(next.pendingDecision?.description ?? '', /解药可用/);
  assert.match(next.pendingDecision?.description ?? '', /毒药不可用/);
}

{
  const state = makeState();
  state.phase = 'witch-action';
  state.roleAssignments[2].resources = { antidote: 0, poison: 1 };
  const next = reduceGame(state, { type: 'advance' });
  assert.deepEqual(next.pendingDecision?.candidates, [0, 1, 3, 4, 5]);
  assert.deepEqual(next.pendingDecision?.options, { attackedPlayerId: null, canSave: false, canPoison: true });
  assert.match(next.pendingDecision?.description ?? '', /解药不可用/);
  assert.match(next.pendingDecision?.description ?? '', /毒药可用/);
}

console.log('Knowledge fact smoke tests passed');
