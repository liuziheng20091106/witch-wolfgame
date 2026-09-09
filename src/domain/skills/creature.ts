import type { GameState, PendingDecision, PlayerId, RoleAssignmentState, SubmittedDecision, WitchSkillInstance } from '../model';
import { addPrivateEvent, addPublicEvent } from '../engine/events';
import { getName, getPlayer, getRoleAssignment } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, requireTarget } from './types';
import { initialRoleResources } from '../catalog/roles';

// ===== 诺亚的造物（忆灵）：操控液体重构 =====
// 造物 id 固定 99，继承诺亚的基础职业（不继承魔女技），可被给予解药/毒药，
// 拥有独立意志（可独立决策，甚至毒杀主人诺亚），不参与白天发言与社交目标池。

export function createCreature(state: GameState, skill: WitchSkillInstance): void {
  const ownerId = skill.ownerPlayerId;
  // 防御：同一局只允许存在一个造物（防止重复创建导致状态错乱）
  if (state.creatures.some((creature) => creature.id === 99)) {
    throw new Error('造物已存在，不能重复创建');
  }
  const owner = getPlayer(state, ownerId);
  const roleId = getRoleAssignment(state, ownerId).roleId;
  // 造物拥有独立的职业分配（同一职业，独立资源）
  const assignment: RoleAssignmentState = {
    id: `creature-role-${ownerId}`,
    ownerPlayerId: 99,
    roleId,
    resources: initialRoleResources(roleId),
  };
  state.roleAssignments.push(assignment);
  state.creatures.push({
    id: 99,
    ownerPlayerId: ownerId,
    characterId: owner.characterId,
    roleAssignmentId: assignment.id,
    alive: true,
    resources: {},
  });
  skill.data.creatureCreated = true;
  exhaustSkill(skill);
  addPublicEvent(state, 'skill', `${getName(state, ownerId)}的造物在圆桌上凝聚成形——液态分身悄然成型！`, {
    actorPlayerId: ownerId,
    targetPlayerIds: [ownerId],
    data: { creatureId: 99 },
  });
  // 给药二级决策：仅在诺亚有可用药时触发
  if (roleId === 'witch') {
    const resources = getRoleAssignment(state, ownerId).resources;
    const potionCandidates: PlayerId[] = [];
    if (resources.antidote === 1) {
      potionCandidates.push(0);
    }
    if (resources.poison === 1) {
      potionCandidates.push(1);
    }
    if (potionCandidates.length > 0) {
      const potionPending = makeSkillDecision(state, skill, '造物-给药', '选择给造物哪瓶药（0=解药 1=毒药）。造物可独立决定对谁使用。', potionCandidates, 'target');
      // 药选择标记：candidates 是药索引（0=解药 1=毒药），不是玩家 id，UI/AI 据此正确渲染
      potionPending.options.potionChoice = true;
      // 决策 id 加后缀保持唯一：创造决策与给药决策用同一 skill，id 相同会导致 UI 不重置 target
      potionPending.id = `${potionPending.id}-potion`;
      state.pendingDecision = potionPending;
    }
  }
}

export function applyCreaturePotion(state: GameState, skill: WitchSkillInstance, pending: PendingDecision, decision: SubmittedDecision): void {
  const targetPlayerId = requireTarget(decision, pending.candidates);
  const creature = state.creatures.find((entry) => entry.id === 99);
  if (!creature) {
    throw new Error('造物不存在');
  }
  const ownerAssignment = getRoleAssignment(state, skill.ownerPlayerId);
  // 给药写入造物的职业分配资源（applyRoleDecision 读的是 roleAssignment.resources）
  const creatureAssignment = getRoleAssignment(state, 99);
  if (targetPlayerId === 0) {
    if (ownerAssignment.resources.antidote !== 1) {
      throw new Error('解药不可用');
    }
    ownerAssignment.resources.antidote = 0;
    creatureAssignment.resources.antidote = 1;
    creature.resources.antidote = 1;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 把解药交给了造物。`, { actorPlayerId: skill.ownerPlayerId });
  } else if (targetPlayerId === 1) {
    if (ownerAssignment.resources.poison !== 1) {
      throw new Error('毒药不可用');
    }
    ownerAssignment.resources.poison = 0;
    creatureAssignment.resources.poison = 1;
    creature.resources.poison = 1;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 把毒药交给了造物。`, { actorPlayerId: skill.ownerPlayerId });
  } else {
    throw new Error('造物给药选择不合法');
  }
}
