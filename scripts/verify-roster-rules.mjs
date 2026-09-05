#!/usr/bin/env node
/**
 * Issue #95 关键规则定向回归（构造最小场景，验证引擎行为）
 * - 呆头鹅被放逐 → 中立独自获胜（优先于放逐死亡/遗言/反击）
 * - 隐狼被预言家查验 → 结果伪造为村民
 * - 猎人被放逐 → 可开枪带走一名存活者（一次性）
 * - 守卫 → night-protection 阶段生成守护决策并记录保护
 * 用法: node scripts/verify-roster-rules.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, reduceGame;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
} finally {
  await server.close();
}

function newGame(playerCount, seed) {
  return createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount, selectedCharacterIds: [] });
}
function roleOf(state, playerId) {
  return state.roleAssignments.find((a) => a.id === state.players[playerId].roleAssignmentId).roleId;
}
function exileEvent(state, targetPlayerId) {
  return {
    id: `test-exile-${targetPlayerId}`,
    kind: 'exile',
    day: state.day,
    phase: 'day-resolution',
    text: '被放逐',
    actorPlayerId: null,
    targetPlayerIds: [targetPlayerId],
    displayAuthorPlayerId: null,
    actualAuthorPlayerId: null,
    data: { exileTargetPlayerId: targetPlayerId },
  };
}

// ===== 场景 1：呆头鹅被放逐 → 中立独自获胜 =====
{
  const g = newGame(6, 1001);
  const dodoPlayer = 2;
  g.roleAssignments.find((a) => a.ownerPlayerId === dodoPlayer).roleId = 'dodo';
  g.phase = 'day-resolution';
  g.pendingDecision = null;
  g.publicEvents.push(exileEvent(g, dodoPlayer));
  const next = reduceGame(g, { type: 'advance' });
  assert.equal(next.result?.winner, 'neutral', '呆头鹅被放逐应中立胜');
  assert.equal(next.result?.reason, 'dodo-exiled');
  assert.equal(next.phase, 'ended');
  console.log('场景1 呆头鹅被放逐 → 中立独自获胜 ✓');
}

// ===== 场景 2：隐狼被预言家查验 → 伪造为村民 =====
{
  const g = newGame(6, 1002);
  const hiddenPlayer = 3;
  g.roleAssignments.find((a) => a.ownerPlayerId === hiddenPlayer).roleId = 'hidden-wolf';
  const seer = g.players.findIndex((p) => roleOf(g, p.id) === 'seer');
  assert.ok(seer >= 0, '预言家存在');
  const pending = {
    id: 'test-seer-check',
    kind: 'seer-action',
    schemaKey: 'target',
    actorId: seer,
    title: '预言家查验',
    description: '查验',
    candidates: [hiddenPlayer],
    allowAbstain: false,
    skillInstanceId: null,
    options: {},
  };
  g.pendingDecision = pending;
  const next = reduceGame(g, {
    type: 'submit-decision',
    pendingDecisionId: pending.id,
    actorId: seer,
    decision: { targetPlayerId: hiddenPlayer },
  });
  const fact = next.knowledgeByPlayer[seer].find((f) => f.subjectPlayerId === hiddenPlayer && f.kind === 'role');
  assert.ok(fact, '预言家应获得查验知识');
  assert.equal(fact.value, 'villager', '隐狼查验结果应伪造为村民');
  console.log('场景2 隐狼被预言家查验 → 结果村民 ✓');
}

// ===== 场景 3：猎人被放逐 → 开枪带走一名存活者 =====
{
  const g = newGame(8, 1003);
  const hunter = g.players.findIndex((p) => roleOf(g, p.id) === 'hunter');
  assert.ok(hunter >= 0, '猎人存在');
  g.phase = 'day-resolution';
  g.pendingDecision = null;
  g.publicEvents.push(exileEvent(g, hunter));
  const afterExile = reduceGame(g, { type: 'advance' });
  assert.equal(afterExile.pendingDecision?.kind, 'hunter-shot', '猎人被放逐应生成开枪决策');
  const shotPending = afterExile.pendingDecision;
  const shotTarget = shotPending.candidates.find((playerId) => {
    const player = afterExile.players[playerId];
    const skill = player?.skillInstanceId === null ? null : afterExile.skillInstances.find((entry) => entry.id === player?.skillInstanceId);
    return skill?.definitionId !== 'death-rewind';
  });
  assert.ok(shotTarget !== undefined && shotTarget !== hunter, '存在可开枪目标');
  const afterShot = reduceGame(afterExile, {
    type: 'submit-decision',
    pendingDecisionId: shotPending.id,
    actorId: shotPending.actorId,
    decision: { targetPlayerId: shotTarget },
  });
  assert.equal(afterShot.players[shotTarget].alive, false, '开枪目标应死亡');
  const hunterAssignment = afterShot.roleAssignments.find((a) => a.ownerPlayerId === hunter);
  assert.equal(hunterAssignment.resources.hunterShot, 0, '猎人子弹应消耗');
  const death = afterShot.publicEvents.findLast((e) => e.kind === 'death' && e.targetPlayerIds.includes(shotTarget));
  assert.ok(death && Array.isArray(death.data.sources) && death.data.sources.includes('hunter-gun'), '开枪死亡来源应为 hunter-gun');
  console.log('场景3 猎人被放逐 → 开枪带走目标 ✓');
}

// ===== 场景 4：守卫生成守护决策并记录保护 =====
{
  const g = newGame(9, 1004);
  const guard = g.players.findIndex((p) => roleOf(g, p.id) === 'guard');
  assert.ok(guard >= 0, '守卫存在');
  g.phase = 'night-protection';
  g.pendingDecision = null;
  const first = reduceGame(g, { type: 'advance' });
  assert.equal(first.pendingDecision?.kind, 'guard-action', '守卫应在 night-protection 首先生成决策');
  const guardPending = first.pendingDecision;
  assert.ok(!guardPending.candidates.includes(guard), '守卫不能守护自己');
  const protectTarget = guardPending.candidates[0];
  const afterGuard = reduceGame(first, {
    type: 'submit-decision',
    pendingDecisionId: guardPending.id,
    actorId: guardPending.actorId,
    decision: { targetPlayerId: protectTarget },
  });
  const assignment = afterGuard.roleAssignments.find((a) => a.ownerPlayerId === guard);
  assert.equal(assignment.resources.lastGuardNight, afterGuard.day);
  assert.equal(assignment.resources.lastGuardTargetPlayerId, protectTarget);
  const protectEvent = afterGuard.privateEvents.some((e) => typeof e.data.protectTargetPlayerId === 'number' && e.data.protectTargetPlayerId === protectTarget);
  assert.ok(protectEvent, '守卫应写入保护事件');
  console.log('场景4 守卫守护决策/资源/保护事件 ✓');
}

// ===== 场景 5：守卫不可连续两夜守护同一人 =====
{
  const g = newGame(9, 1005);
  const guard = g.players.findIndex((p) => roleOf(g, p.id) === 'guard');
  const assignment = g.roleAssignments.find((a) => a.ownerPlayerId === guard);
  assignment.resources.lastGuardNight = g.day - 1;
  assignment.resources.lastGuardTargetPlayerId = 0;
  g.phase = 'night-protection';
  g.pendingDecision = null;
  const next = reduceGame(g, { type: 'advance' });
  assert.equal(next.pendingDecision?.kind, 'guard-action', '守卫应生成决策');
  assert.ok(!next.pendingDecision.candidates.includes(0), '上夜守护目标应被排除');
  console.log('场景5 守卫不可连守同一人 ✓');
}

// ===== 场景 6：复合死亡（狼刀+毒药）不触发猎人开枪 =====
{
  const g = newGame(8, 1006);
  const hunter = g.players.findIndex((p) => roleOf(g, p.id) === 'hunter');
  assert.ok(hunter >= 0, '猎人存在');
  const hunterSkill = g.skillInstances.find((entry) => entry.id === g.players[hunter].skillInstanceId);
  if (hunterSkill) {
    hunterSkill.definitionId = 'ignition';
  }
  const intentEvent = (source) => ({
    id: `test-intent-${source}-${hunter}`,
    kind: 'wolf-attack',
    day: g.day,
    phase: 'night-resolution',
    text: '复合死亡意图',
    actorPlayerId: null,
    targetPlayerIds: [hunter],
    displayAuthorPlayerId: null,
    actualAuthorPlayerId: null,
    data: { intentSource: source, preventable: true, targetPlayerId: hunter },
  });
  g.privateEvents.push(intentEvent('wolf'));
  g.privateEvents.push(intentEvent('poison'));
  g.phase = 'night-resolution';
  g.pendingDecision = null;
  const afterNight = reduceGame(g, { type: 'advance' });
  assert.equal(afterNight.players[hunter].alive, false, '复合死亡下猎人应死亡');
  assert.notEqual(afterNight.pendingDecision?.kind, 'hunter-shot', '狼刀+毒药复合死亡不得触发猎人开枪');
  const shotResource = afterNight.roleAssignments.find((a) => a.ownerPlayerId === hunter);
  assert.equal(shotResource.resources.hunterShot, 1, '未开枪时猎人子弹不应消耗');
  console.log('场景6 复合死亡（狼刀+毒药）不触发猎人开枪 ✓');
}

console.log('\n全部定向规则场景通过 ✓');

