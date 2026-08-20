import { characterById } from '../catalog/characters';
import { roleAlignment, roleNames } from '../catalog/roles';
import { witchSkillDefinitions } from '../catalog/witchSkills';
import type {
  GameState,
  IgnitionDecision,
  LiquidControlDecision,
  OptionalTargetDecision,
  PendingDecision,
  PlayerId,
  SubmittedDecision,
  TargetDecision,
  WitchSkillId,
} from '../model';
import { addKnowledge, addPrivateEvent, addPublicEvent } from '../engine/events';
import { chooseWithState } from '../engine/random';
import { getAlivePlayerIds, getPlayer, getPlayerAlignment, getRoleAssignment, getSkillInstance } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, wasOffered } from './types';

const priority: Record<string, number> = {
  'soul-exchange': 0,
  'witch-killer': 1,
  'liquid-control': 2,
  'mind-reading': 3,
  'witch-factor-recovery': 4,
};

function nameOf(state: GameState, playerId: PlayerId): string {
  return characterById[getPlayer(state, playerId).characterId].name;
}

function uniqueKnowledgeFactIds(state: GameState, playerId: PlayerId): string[] {
  const factIds = state.knowledgeByPlayer[playerId].map((fact) => fact.id);
  if (new Set(factIds).size !== factIds.length) {
    throw new Error(`座位 ${playerId} 的知识事实 ID 冲突`);
  }
  return factIds;
}

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
    const targets = candidatesForNightSkill(state, skill.definitionId, skill.ownerPlayerId);
    if (targets.length === 0) {
      continue;
    }
    if (skill.definitionId === 'liquid-control') {
      return makeSkillDecision(state, skill, '操控液体', '抽取一名角色的职业，或公开一条你已知的事实。', targets, 'liquid-control', {
        factIds: uniqueKnowledgeFactIds(state, skill.ownerPlayerId),
      });
    }
    const titleBySkill: Record<string, string> = {
      'soul-exchange': '灵魂交换',
      'witch-killer': '魔女杀手',
      'mind-reading': '看到内心',
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
  return makeSkillDecision(state, skill, '治愈', '选择一名存活者，移除她本夜所有可防止的死亡意图。', getAlivePlayerIds(state), 'target');
}

function requireTarget(decision: SubmittedDecision, candidates: PlayerId[]): PlayerId {
  const targetPlayerId = (decision as TargetDecision).targetPlayerId;
  if (targetPlayerId === null || !candidates.includes(targetPlayerId)) {
    throw new Error('目标不在当前合法候选中');
  }
  return targetPlayerId;
}

export function applyNightSkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.ownerPlayerId !== pending.actorId || skill.status === 'exhausted') {
    throw new Error('技能实例不可用');
  }
  const key = offerKey(state, skill.definitionId === 'healing' ? 'night-protection' : 'night-start');
  markOffered(skill, key);

  if (skill.definitionId === 'healing') {
    const targetPlayerId = requireTarget(decision, pending.candidates);
    skill.data.lastUsedNight = state.day;
    addPrivateEvent(state, [skill.ownerPlayerId], 'protection', `你选择治愈 ${nameOf(state, targetPlayerId)}。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { protectTargetPlayerId: targetPlayerId },
    });
    return;
  }

  const optional = decision as OptionalTargetDecision;
  if (!optional.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你保留了${pending.title}。`, { actorPlayerId: skill.ownerPlayerId });
    return;
  }

  if (skill.definitionId === 'liquid-control') {
    const liquid = decision as LiquidControlDecision;
    if (liquid.mode === 'extract') {
      const targetPlayerId = requireTarget(liquid, pending.candidates);
      const roleId = getRoleAssignment(state, targetPlayerId).roleId;
      const event = addPrivateEvent(state, [skill.ownerPlayerId], 'knowledge', `你抽取到 ${nameOf(state, targetPlayerId)} 的当前职业：${roleNames[roleId]}。`, {
        actorPlayerId: skill.ownerPlayerId,
        targetPlayerIds: [targetPlayerId],
      });
      addKnowledge(state, skill.ownerPlayerId, { subjectPlayerId: targetPlayerId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
    } else if (liquid.mode === 'spread' && liquid.factId) {
      const fact = state.knowledgeByPlayer[skill.ownerPlayerId].find((entry) => entry.id === liquid.factId);
      if (!fact) {
        throw new Error('只能传播已经获得的事实');
      }
      const valueText = fact.kind === 'role'
        ? `是${roleNames[fact.value as keyof typeof roleNames]}`
        : fact.kind === 'skill'
          ? `的魔法技是${witchSkillDefinitions[fact.value as WitchSkillId].name}`
          : fact.value === 'wolf' ? '是狼人阵营' : '是好人阵营';
      addPublicEvent(state, 'knowledge', `${nameOf(state, skill.ownerPlayerId)} 公开事实：${nameOf(state, fact.subjectPlayerId)} ${valueText}。`, {
        actorPlayerId: skill.ownerPlayerId,
        targetPlayerIds: [fact.subjectPlayerId],
        data: { factId: fact.id },
      });
    } else {
      throw new Error('操控液体的模式与事实不合法');
    }
    exhaustSkill(skill);
    return;
  }

  const targetPlayerId = requireTarget(optional, pending.candidates);
  if (skill.definitionId === 'witch-killer') {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你对 ${nameOf(state, targetPlayerId)} 标记了精准击杀。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { intentSource: 'precise-kill', preventable: false, targetPlayerId },
    });
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'mind-reading') {
    const alignment = getPlayerAlignment(state, targetPlayerId);
    const event = addPrivateEvent(state, [skill.ownerPlayerId], 'knowledge', `你看见 ${nameOf(state, targetPlayerId)} 属于${alignment === 'wolf' ? '狼人' : '好人'}阵营。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addKnowledge(state, skill.ownerPlayerId, { subjectPlayerId: targetPlayerId, kind: 'alignment', value: alignment, observedDay: state.day }, event.id);
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'soul-exchange') {
    const owner = getPlayer(state, skill.ownerPlayerId);
    const target = getPlayer(state, targetPlayerId);
    const ownerAssignmentId = owner.roleAssignmentId;
    owner.roleAssignmentId = target.roleAssignmentId;
    target.roleAssignmentId = ownerAssignmentId;
    getRoleAssignment(state, owner.id).ownerPlayerId = owner.id;
    getRoleAssignment(state, target.id).ownerPlayerId = target.id;
    const ownerRole = getRoleAssignment(state, owner.id).roleId;
    const targetRole = getRoleAssignment(state, target.id).roleId;
    // 私密播报：仅交换双方可见（观战视角全知可见），播报具体职业
    const exchangeEvent = addPrivateEvent(state, [owner.id, target.id], 'role-exchange', `${nameOf(state, owner.id)}使用了灵魂交换：${nameOf(state, owner.id)}成为${roleNames[ownerRole]}，${nameOf(state, target.id)}成为${roleNames[targetRole]}。`, {
      actorPlayerId: owner.id,
      targetPlayerIds: [target.id],
    });
    // 自身份事实使用稳定 ID；交换后只更新内容，避免删除后按数组长度重新编号。
    updateSelfRoleKnowledge(state, owner.id, exchangeEvent.id);
    updateSelfRoleKnowledge(state, target.id, exchangeEvent.id);
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
    addPublicEvent(state, 'factor-recovered', `${nameOf(state, skill.ownerPlayerId)} 回收了 ${nameOf(state, targetPlayerId)} 的魔女因子。`, {
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
