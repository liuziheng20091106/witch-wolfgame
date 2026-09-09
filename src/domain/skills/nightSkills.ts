import { roleNames } from '../catalog/roles';
import type {
  GameState,
  IgnitionDecision,
  OptionalTargetDecision,
  PendingDecision,
  PlayerId,
  SubmittedDecision,
} from '../model';
import { addPrivateEvent, addPublicEvent } from '../engine/events';
import { getAlivePlayerIds, getName, getPlayer, getPlayerAlignment, getRoleAssignment } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, requireTarget, wasOffered } from './types';
import { withFactionStrategyGuidance } from './decisionGuidance';
import { applyCreaturePotion, createCreature } from './creature';
import { getLevitationDecision, isFloatingActive } from './levitation';
import { getNightIgnitionDecision } from './ignition';

export { getVisionSkillDecision, applyVisionSkillDecision, describeNightTrajectory } from './vision';
export { getLevitationDecision, applyLevitation, isFloatingActive } from './levitation';
export { burnAllSkills, getNightIgnitionDecision, getNightIgnitionPotionDecision, applyNightIgnition, applyNightIgnitionPotion, getDayIgnitionDecision, applyDayIgnition, burnedVoters } from './ignition';

const priority: Record<string, number> = {
  'soul-exchange': 0,
  'witch-killer': 1,
  'liquid-control': 2,
  'levitation': 3,
  'ignition': 4,
  'witch-factor-recovery': 5,
};

function updateSelfRoleKnowledge(state: GameState, playerId: PlayerId, sourceEventId: string): void {
  const expectedId = `${state.gameId}-fact-${playerId}-self`;
  const fact = state.knowledgeByPlayer[playerId].find(
    (entry) => entry.id === expectedId && entry.subjectPlayerId === playerId && entry.kind === 'role',
  );
  if (!fact) {
    throw new Error(`座位 ${playerId} 缺少当前自身份事实`);
  }
  fact.value = getRoleAssignment(state, playerId).roleId;
  fact.observedDay = state.day;
  fact.sourceEventId = sourceEventId;
}

function candidatesForNightSkill(state: GameState, skillId: string, ownerId: PlayerId): PlayerId[] {
  if (skillId === 'witch-factor-recovery') {
    return state.players
      .filter((player) => !player.alive && player.skillInstanceId !== null)
      .filter((player) => {
        const skill = state.skillInstances.find((entry) => entry.id === player.skillInstanceId);
        return skill !== undefined && skill.status !== 'exhausted';
      })
      .map((player) => player.id);
  }
  const aliveOthers = getAlivePlayerIds(state).filter((playerId) => playerId !== ownerId);
  if (skillId === 'soul-exchange') {
    // 灵魂交换无法选中造物（保持造物与主人同身份，简化维护）
    return aliveOthers.filter((playerId) => playerId !== 99);
  }
  if (skillId === 'witch-killer' && getPlayerAlignment(state, ownerId) === 'wolf') {
    // 狼人持有魔女杀手时，禁止标记狼队友为精准击杀（此前候选含全部存活者，
    // AI 或本地策略可能刀到狼队友；灵魂交换后阵营随新职业，此处按当前阵营过滤）。
    return aliveOthers.filter((playerId) => getPlayerAlignment(state, playerId) !== 'wolf');
  }
  return aliveOthers;
}

export function getNextNightSkillDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'night-start');
  const candidates = state.skillInstances
    .filter((skill) => skill.status === 'ready' && !wasOffered(skill, key))
    .filter((skill) => getPlayer(state, skill.ownerPlayerId).alive)
    .filter((skill) => priority[skill.definitionId] !== undefined)
    .filter((skill) => skill.data.recoveredNight !== state.day)
    .sort((left, right) => (priority[left.definitionId] ?? 99) - (priority[right.definitionId] ?? 99) || left.ownerPlayerId - right.ownerPlayerId);

  for (const skill of candidates) {
    if (skill.definitionId === 'levitation') {
      // 漂浮：use-only，无目标（隐匿自身行动，无公开播报）
      return getLevitationDecision(state, skill);
    }
    if (skill.definitionId === 'liquid-control') {
      // 防重复创建：已创建过造物（含魔女因子回收恢复后的场景）则跳过，不再询问
      if (skill.data.creatureCreated === true || state.creatures.some((creature) => creature.id === 99)) {
        markOffered(skill, key);
        continue;
      }
      // 操控液体：创造造物（use-only，无需目标，继承诺亚职业）
      // 策略提示按阵营区分：好人首夜召唤收益最大（造物是独立战力）；狼人保留（造物继承狼身份，被查验会暴露）
      let creatureStrategyHint = '你是好人：强烈建议首个夜晚就召唤造物——它是独立战力，可独立查验或用药，投票跟随你；越早召唤收益越大，首夜使用通常是最优解。';
      if (getPlayerAlignment(state, skill.ownerPlayerId) === 'wolf') {
        creatureStrategyHint = '你是狼人：造物会继承你的狼身份，被查验或公开阵营会直接暴露你，建议保留不召唤。';
      }
      return makeSkillDecision(
        state,
        skill,
        '操控液体',
        `创造诺亚的造物吗？【选择：是/否】\n造物是与你绑定的液态分身，你和它都明确知道双方始终共享同一基础职业与阵营（不继承魔女技）。它拥有独立意志，不参与白天发言，投票跟随你。每局限一次。\n${creatureStrategyHint}`,
        [],
        'ignition',
      );
    }
    const targets = candidatesForNightSkill(state, skill.definitionId, skill.ownerPlayerId);
    if (targets.length === 0) {
      continue;
    }
    if (skill.definitionId === 'ignition') {
      return getNightIgnitionDecision(state);
    }
    const titleBySkill: Record<string, string> = {
      'soul-exchange': '灵魂交换',
      'witch-killer': '魔女杀手',
      'witch-factor-recovery': '魔女因子回收',
    };
    return makeSkillDecision(state, skill, titleBySkill[skill.definitionId] ?? '夜间魔女技', '可选择本夜使用一次，或暂时保留。', targets, 'optional-target');
  }
  return null;
}

export function getHealingDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'night-protection');
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'healing'
      && entry.status !== 'exhausted'
      && getPlayer(state, entry.ownerPlayerId).alive
      && !wasOffered(entry, key),
  );
  if (!skill) {
    return null;
  }
  const pending = makeSkillDecision(
    state,
    skill,
    '治愈',
    '选择一名存活者，移除她本夜所有可防止的死亡意图。',
    getAlivePlayerIds(state),
    'target',
  );
  return withFactionStrategyGuidance(state, pending);
}

export function applyNightSkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.ownerPlayerId !== pending.actorId) {
    throw new Error('技能实例不可用');
  }
  // 造物-给药是创造流程的延续，允许 skill 已 exhausted
  if (skill.status === 'exhausted' && pending.title !== '造物-给药') {
    throw new Error('技能实例不可用');
  }
  const key = offerKey(state, skill.definitionId === 'healing' ? 'night-protection' : 'night-start');
  markOffered(skill, key);

  if (skill.definitionId === 'healing') {
    const targetPlayerId = requireTarget(decision, pending.candidates);
    skill.data.lastUsedNight = state.day;
    addPrivateEvent(state, [skill.ownerPlayerId], 'protection', `${getName(state, skill.ownerPlayerId)} 选择治愈 ${getName(state, targetPlayerId)}。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { protectTargetPlayerId: targetPlayerId },
    });
    return;
  }

  const optional = decision as OptionalTargetDecision;
  if (pending.schemaKey === 'optional-target' && !optional.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了${pending.title}。`, { actorPlayerId: skill.ownerPlayerId });
    return;
  }

  if (skill.definitionId === 'liquid-control') {
    if (pending.title === '造物-给药') {
      applyCreaturePotion(state, skill, pending, decision);
      return;
    }
    // 创造决策（ignition use-only）
    const ignition = decision as IgnitionDecision;
    if (!ignition.use) {
      addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了操控液体。`, { actorPlayerId: skill.ownerPlayerId });
      return;
    }
    createCreature(state, skill);
    return;
  }

  const targetPlayerId = requireTarget(optional, pending.candidates);
  if (skill.definitionId === 'witch-killer') {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 对 ${getName(state, targetPlayerId)} 标记了精准击杀。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { intentSource: 'precise-kill', preventable: false, targetPlayerId },
    });
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'soul-exchange') {
    if (isFloatingActive(state, targetPlayerId, state.day)) {
      // 漂浮隐匿：灵魂交换无法锁定目标，使用失败（照常消耗）
      addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 对 ${getName(state, targetPlayerId)} 发动灵魂交换，但她的存在若隐若现，交换失败了。`, {
        actorPlayerId: skill.ownerPlayerId,
        targetPlayerIds: [targetPlayerId],
      });
      exhaustSkill(skill);
      return;
    }
    const owner = getPlayer(state, skill.ownerPlayerId);
    const target = getPlayer(state, targetPlayerId);
    // 在交换链接前校验双方职业分配，保持异常时的状态不变。
    getRoleAssignment(state, owner.id);
    getRoleAssignment(state, target.id);
    const ownerAssignmentId = owner.roleAssignmentId;
    owner.roleAssignmentId = target.roleAssignmentId;
    target.roleAssignmentId = ownerAssignmentId;
    getRoleAssignment(state, owner.id).ownerPlayerId = owner.id;
    getRoleAssignment(state, target.id).ownerPlayerId = target.id;
    const ownerRole = getRoleAssignment(state, owner.id).roleId;
    const targetRole = getRoleAssignment(state, target.id).roleId;
    // 私密播报：仅交换双方可见（观战视角全知可见），播报具体职业
    const exchangeEvent = addPrivateEvent(state, [owner.id, target.id], 'role-exchange', `${getName(state, owner.id)}使用了灵魂交换：${getName(state, owner.id)}成为${roleNames[ownerRole]}，${getName(state, target.id)}成为${roleNames[targetRole]}。`, {
      actorPlayerId: owner.id,
      targetPlayerIds: [target.id],
    });
    // 自身份事实使用稳定 ID；交换后只更新内容，避免删除后按数组长度重新编号。
    updateSelfRoleKnowledge(state, owner.id, exchangeEvent.id);
    updateSelfRoleKnowledge(state, target.id, exchangeEvent.id);
    // 造物绑定原职业的灵魂，交换后主人改为持有该灵魂的一方。
    for (const creature of state.creatures) {
      if (!creature.alive) {
        continue;
      }
      if (creature.ownerPlayerId === owner.id) {
        creature.ownerPlayerId = target.id;
      } else if (creature.ownerPlayerId === target.id) {
        creature.ownerPlayerId = owner.id;
      }
    }
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'witch-factor-recovery') {
    const deadPlayer = getPlayer(state, targetPlayerId);
    if (deadPlayer.alive || !deadPlayer.skillInstanceId) {
      throw new Error('只能回收死亡者尚未耗尽的技能');
    }
    const recovered = state.skillInstances.find((entry) => entry.id === deadPlayer.skillInstanceId);
    if (!recovered || recovered.status === 'exhausted') {
      throw new Error('目标没有可回收技能');
    }
    exhaustSkill(skill);
    deadPlayer.skillInstanceId = null;
    recovered.ownerPlayerId = skill.ownerPlayerId;
    recovered.data.recoveredNight = state.day;
    getPlayer(state, skill.ownerPlayerId).skillInstanceId = recovered.id;
    addPublicEvent(state, 'factor-recovered', `${getName(state, skill.ownerPlayerId)} 回收了 ${getName(state, targetPlayerId)} 的魔女因子。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { recoveredSkillId: recovered.definitionId },
    });
    return;
  }
  if ((decision as IgnitionDecision).use) {
    throw new Error('该技能不属于夜间处理器');
  }
}
