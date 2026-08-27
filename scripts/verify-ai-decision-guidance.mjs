#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { PROMPT_LIMITS } from '../shared/gamePromptContract.js';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let addPrivateEvent;
let addPublicEvent;
let buildDecisionPrompt;
let createGame;
let getHealingDecision;
let getName;
let getRoleAssignment;
let reduceGame;
let selectObservation;
let withFactionStrategyGuidance;
try {
  ({ addPrivateEvent, addPublicEvent } = await server.ssrLoadModule('/src/domain/engine/events.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ getHealingDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
  ({ getName, getRoleAssignment, selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ withFactionStrategyGuidance } = await server.ssrLoadModule('/src/domain/skills/decisionGuidance.ts'));
} finally {
  await server.close();
}

function gameWithSkill(definitionId) {
  for (let seed = 1; seed <= 500; seed += 1) {
    const state = createGame({ mode: 'spectator', humanCharacterId: null, seed });
    if (state.skillInstances.some((skill) => skill.definitionId === definitionId)) {
      return state;
    }
  }
  throw new Error(`无法构造包含技能 ${definitionId} 的测试对局`);
}

function promptForPending(state, pending) {
  const prepared = structuredClone(state);
  prepared.pendingDecision = pending;
  const observation = selectObservation(prepared, { kind: 'player', playerId: pending.actorId });
  return buildDecisionPrompt({ observation, pendingDecision: pending });
}

console.log('=== 白天发言防复读 ===');
{
  const state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 17 });
  state.day = 1;
  state.phase = 'speeches';
  state.pendingDecision = null;
  for (const skill of state.skillInstances) {
    skill.status = 'exhausted';
  }
  const firstSpeakerId = state.speechOrder[0];
  assert.notEqual(firstSpeakerId, undefined);
  addPublicEvent(state, 'speech', '公开魔女技不能用于推断基础职业。', {
    actorPlayerId: firstSpeakerId,
    targetPlayerIds: [firstSpeakerId],
    displayAuthorPlayerId: firstSpeakerId,
    actualAuthorPlayerId: firstSpeakerId,
  });
  const next = reduceGame(state, { type: 'advance' });
  const pending = next.pendingDecision;
  assert.notEqual(pending, null);
  assert.equal(pending.kind, 'speech');
  assert.match(pending.description, /系统规则只作为内部决策边界/);
  assert.match(pending.description, /不得换一种说法重复已有共识/);
  assert.match(pending.description, /新的观察、质疑、矛盾、回应或后续验证建议/);
  const messages = promptForPending(next, pending);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.currentDaySpeeches.length, 1, '不得通过删除前序发言规避复读');
  assert.match(payload.currentDaySpeeches[0], /公开魔女技不能用于推断基础职业/);
  assert.deepEqual(validateGamePrompt(messages), { ok: true });
}

console.log('=== 狼人治愈本队狼刀 ===');
{
  const state = gameWithSkill('healing');
  state.day = 1;
  state.phase = 'night-protection';
  state.pendingDecision = null;
  const skill = state.skillInstances.find((entry) => entry.definitionId === 'healing');
  assert.notEqual(skill, undefined);
  skill.status = 'ready';
  delete skill.data.lastOfferedKey;
  const ownerId = skill.ownerPlayerId;
  getRoleAssignment(state, ownerId).roleId = 'wolf';
  const targetId = state.players.find((player) => player.alive && player.id !== ownerId)?.id;
  assert.notEqual(targetId, undefined);
  getRoleAssignment(state, targetId).roleId = 'villager';
  addPrivateEvent(state, [ownerId], 'wolf-attack', `狼队决定袭击 ${getName(state, targetId)}。`, {
    targetPlayerIds: [targetId],
    data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: targetId },
  });
  const pending = getHealingDecision(state);
  assert.notEqual(pending, null);
  assert.ok(pending.candidates.includes(targetId), '策略提示不得硬性排除狼刀目标');
  assert.match(pending.description, new RegExp(`狼队决定袭击${getName(state, targetId)}`));
  assert.match(pending.description, /治愈她会直接抵消本队狼刀/);
  const messages = promptForPending(state, pending);
  assert.deepEqual(validateGamePrompt(messages), { ok: true });

  const fullBudgetPending = {
    ...pending,
    description: '长'.repeat(PROMPT_LIMITS.actionDescriptionMaxLength),
  };
  const safelyDegraded = withFactionStrategyGuidance(state, fullBudgetPending);
  assert.equal(safelyDegraded.description, fullBudgetPending.description, '策略提示超限时必须保留原始决策');

  const goodState = structuredClone(state);
  getRoleAssignment(goodState, ownerId).roleId = 'villager';
  for (const event of goodState.privateEvents) {
    event.viewerPlayerIds = event.viewerPlayerIds.filter((playerId) => playerId !== ownerId);
  }
  const goodPending = getHealingDecision(goodState);
  assert.notEqual(goodPending, null);
  assert.doesNotMatch(goodPending.description, /本队狼刀/, '好人治愈者不得收到隐藏狼刀提示');
}

console.log('=== 用药同阵营伤害提示 ===');
{
  const state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 29 });
  state.day = 1;
  state.phase = 'witch-action';
  state.pendingDecision = null;
  const witchPlayer = state.players.find((player) => getRoleAssignment(state, player.id).roleId === 'witch');
  assert.notEqual(witchPlayer, undefined);
  const witchAssignment = getRoleAssignment(state, witchPlayer.id);
  witchAssignment.resources = { antidote: 0, poison: 1 };
  const next = reduceGame(state, { type: 'advance' });
  assert.notEqual(next.pendingDecision, null);
  assert.equal(next.pendingDecision.kind, 'witch-action');
  assert.match(next.pendingDecision.description, /毒杀自己已确认的同阵营者通常会直接损害己方/);
  assert.deepEqual(validateGamePrompt(promptForPending(next, next.pendingDecision)), { ok: true });

  const creatureState = structuredClone(state);
  creatureState.roleAssignments.push({
    id: 'creature-role-guidance',
    ownerPlayerId: 99,
    roleId: 'witch',
    resources: { antidote: 0, poison: 1 },
  });
  creatureState.creatures.push({
    id: 99,
    ownerPlayerId: witchPlayer.id,
    characterId: witchPlayer.characterId,
    roleAssignmentId: 'creature-role-guidance',
    alive: true,
    resources: { poison: 1 },
  });
  addPrivateEvent(creatureState, [witchPlayer.id], 'witch-action', `${getName(creatureState, witchPlayer.id)} 已完成女巫行动。`, {
    actorPlayerId: witchPlayer.id,
    data: { actionKind: 'witch-action' },
  });
  const creatureNext = reduceGame(creatureState, { type: 'advance' });
  assert.notEqual(creatureNext.pendingDecision, null);
  assert.equal(creatureNext.pendingDecision.actorId, 99);
  assert.ok(creatureNext.pendingDecision.candidates.includes(witchPlayer.id), '造物主人仍须保留为合法战术目标');
  assert.match(creatureNext.pendingDecision.description, /共享同一基础职业和阵营/);
  assert.match(creatureNext.pendingDecision.description, /毒杀主人等同于伤害己方/);
  assert.deepEqual(validateGamePrompt(promptForPending(creatureNext, creatureNext.pendingDecision)), { ok: true });
}

console.log('PASS AI 决策质量提示验证全部通过');
