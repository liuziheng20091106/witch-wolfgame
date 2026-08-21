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
  TimelineEvent,
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
  'ignition': 3,
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

// ===== 幻视（奈叶香）：白天主动技，触碰目标概率查看其夜间行动轨迹 =====
// 概率：25% 失败 / 50% 小成功（昨夜）/ 25% 大成功（所有夜）
// 信息规则：显示目标"被做了什么 / 做了什么"，不泄露执行者与被作用者身份

/** 白天询问：幻视持有者选择一名未查看过的存活者作为触碰目标。 */
export function getVisionSkillDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'day-start');
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'mind-reading'
      && entry.status === 'ready'
      && getPlayer(state, entry.ownerPlayerId).alive
      && !wasOffered(entry, key),
  );
  if (!skill) {
    return null;
  }
  let viewed: PlayerId[] = [];
  if (Array.isArray(skill.data.viewedIds)) {
    viewed = skill.data.viewedIds as PlayerId[];
  }
  const viewedSet = new Set(viewed);
  const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== skill.ownerPlayerId && !viewedSet.has(playerId));
  if (candidates.length === 0) {
    return null;
  }
  return makeSkillDecision(state, skill, '幻视', '触碰一名存活者，概率看到其夜间行动轨迹（25% 失败、50% 昨夜、25% 所有夜）。', candidates, 'target');
}

/**
 * 轨迹聚合：从事件时间线中提取与目标相关的夜间行动，生成脱敏描述。
 * - 目标被作用："X 遭到袭击 / 被毒杀 / 被治愈 / 被查验 / 被使用魔法"
 * - 目标主动行动："X 袭击了某人 / 毒杀了某人 / 查验了某人 / 使用了魔法"
 * 不显示执行者名字，也不显示被作用者的身份。
 */
export function describeNightTrajectory(state: GameState, targetPlayerId: PlayerId, fromDay: number, toDay: number): string[] {
  const lines: string[] = [];
  const targetName = nameOf(state, targetPlayerId);
  const events: TimelineEvent[] = [...state.publicEvents, ...state.privateEvents]
    .filter((event) => event.day >= fromDay && event.day <= toDay);

  const describeEvent = (event: TimelineEvent): string | null => {
    const data = event.data ?? {};
    const targetIsSubject = data.targetPlayerId === targetPlayerId;
    const targetIsActor = event.actorPlayerId === targetPlayerId;
    const dayLabel = `第${event.day}夜`;

    // 目标被作用：狼刀 / 毒杀 / 精准击杀（这些是"意图/行动"，不一定是最终结果）
    // 注意：意图事件存在 ≠ 目标死亡（可能被解药救、被治愈挡），因此一律用行为语义而非结果语义。
    if (targetIsSubject && data.intentSource === 'wolf') {
      return `${targetName} 在第${event.day}夜遭到狼人袭击。`;
    }
    if (targetIsSubject && data.intentSource === 'poison') {
      return `${targetName} 在第${event.day}夜被下了毒。`;
    }
    if (targetIsSubject && data.intentSource === 'precise-kill') {
      return `${targetName} 在第${event.day}夜被魔女杀手标记。`;
    }
    // 目标被救 / 被治愈（这些代表实际生效：能挡下意图即说明救/保护真实发生）
    if (data.savedWolfTargetPlayerId === targetPlayerId) {
      return `${targetName} 在第${event.day}夜被救下。`;
    }
    if (data.protectTargetPlayerId === targetPlayerId) {
      return `${targetName} 在第${event.day}夜被治愈保护。`;
    }
    // 目标被查验 / 被抽取（目标在 targetPlayerIds，不在 data）
    if (event.targetPlayerIds.includes(targetPlayerId) && event.kind === 'seer-check') {
      return `${targetName} 在第${event.day}夜被查验。`;
    }
    if (event.targetPlayerIds.includes(targetPlayerId) && event.kind === 'knowledge' && data.factId !== undefined) {
      return `${targetName} 在第${event.day}夜被抽取了情报。`;
    }
    // 目标主动行动（意图语义，不表述为成功结果）
    if (targetIsActor && data.intentSource === 'wolf') {
      return `${targetName} 在第${event.day}夜袭击了某人。`;
    }
    if (targetIsActor && data.intentSource === 'poison') {
      return `${targetName} 在第${event.day}夜对某人下了毒。`;
    }
    if (targetIsActor && data.intentSource === 'precise-kill') {
      return `${targetName} 在第${event.day}夜标记了某人。`;
    }
    if (targetIsActor && event.kind === 'seer-check') {
      return `${targetName} 在第${event.day}夜查验了某人。`;
    }
    if (targetIsActor && event.kind === 'role-exchange') {
      return `${targetName} 在第${event.day}夜进行了灵魂交换。`;
    }
    if (targetIsActor && event.kind === 'knowledge' && data.factId !== undefined) {
      return `${targetName} 在第${event.day}夜抽取了某人的情报。`;
    }
    return null;
  };

  for (const event of events) {
    const line = describeEvent(event);
    if (line && !lines.includes(line)) {
      lines.push(line);
    }
  }
  return lines;
}

/** 幻视结算：概率 + 目标标记已查看 + 播报轨迹。 */
export function applyVisionSkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.status === 'exhausted') {
    throw new Error('技能实例不可用');
  }
  markOffered(skill, offerKey(state, 'day-start'));
  const targetPlayerId = (decision as TargetDecision).targetPlayerId;
  if (targetPlayerId === null || !pending.candidates.includes(targetPlayerId)) {
    throw new Error('目标不在当前合法候选中');
  }
  // 目标标记为已查看（无论成败，不可重复触碰同一人）
  let viewed: PlayerId[] = [];
  if (Array.isArray(skill.data.viewedIds)) {
    viewed = skill.data.viewedIds as PlayerId[];
  }
  if (!viewed.includes(targetPlayerId)) {
    viewed.push(targetPlayerId);
    skill.data.viewedIds = viewed;
  }

  // 概率判定：25% 失败 / 50% 小成功（昨夜）/ 25% 大成功（所有夜）
  const roll = chooseWithState([0, 1, 2, 3], state.rngState);
  state.rngState = roll.state;
  let outcome = 'small';
  if (roll.item === 0) {
    outcome = 'fail';
  } else if (roll.item === 3) {
    outcome = 'big';
  }

  const targetName = nameOf(state, targetPlayerId);
  if (outcome === 'fail') {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `本次幻视行为被系统判定为失败，你什么都没有看到。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    return;
  }
  let fromDay = Math.max(0, state.day - 1);
  if (outcome === 'big') {
    fromDay = 0;
  }
  const toDay = state.day - 1; // 白天查看的是已发生的夜间（day 从 0 开始，夜间事件 day 为当夜）
  const lines = describeNightTrajectory(state, targetPlayerId, fromDay, toDay);
  let scopeLabel = '昨夜';
  if (outcome === 'big') {
    scopeLabel = '所有夜晚';
  }
  let body = `${targetName} 在${scopeLabel}没有任何可察觉的行动。`;
  if (lines.length > 0) {
    body = lines.join('');
  }
  addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你通过幻视看到（${scopeLabel}）：${body}`, {
    actorPlayerId: skill.ownerPlayerId,
    targetPlayerIds: [targetPlayerId],
  });
}

// ===== 点火（亚里沙）：整局一次，夜间烧物品/技能 或 白天烧投票/技能 =====
// 夜间：90% 烧目标一瓶药（可自选毒/解药，无药则落空）/ 10% 烧全部魔女技
// 白天（投票统计后）：90% 烧目标当天投票（票作废）/ 10% 烧全部魔女技
// 烧技能：目标所有 skillInstances 置 exhausted 并标记 burned（魔女因子回收不可用）

/** 烧毁目标全部魔女技（白板）。返回是否实际烧到。 */
export function burnAllSkills(state: GameState, targetPlayerId: PlayerId): boolean {
  const target = getPlayer(state, targetPlayerId);
  const instances = state.skillInstances.filter((entry) => entry.ownerPlayerId === targetPlayerId);
  let burned = false;
  for (const instance of instances) {
    instance.status = 'exhausted';
    instance.remainingUses = 0;
    instance.data.burned = true;
    burned = true;
  }
  return burned;
}

/** 夜间点火决策：选择目标（烧物品/技能）。 */
export function getNightIgnitionDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'night-ignition');
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'ignition'
      && entry.status === 'ready'
      && getPlayer(state, entry.ownerPlayerId).alive
      && !wasOffered(entry, key),
  );
  if (!skill) {
    return null;
  }
  const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== skill.ownerPlayerId);
  if (candidates.length === 0) {
    return null;
  }
  return makeSkillDecision(state, skill, '点火', '选择一名目标：火焰将随机烧毁她的物品（90%）或全部魔女技（10%）。', candidates, 'optional-target');
}

/** 夜间点火烧物品的第二次决策：选毒药或解药（0=解药 1=毒药，复用 target schema）。 */
export function getNightIgnitionPotionDecision(state: GameState, targetPlayerId: PlayerId): PendingDecision | null {
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'ignition' && entry.status === 'ready' && entry.data.pendingBurnTarget === targetPlayerId,
  );
  if (!skill) {
    return null;
  }
  const assignment = getRoleAssignment(state, targetPlayerId);
  const candidates: PlayerId[] = [];
  if (assignment.resources.antidote === 1) {
    candidates.push(0);
  }
  if (assignment.resources.poison === 1) {
    candidates.push(1);
  }
  if (candidates.length === 0) {
    return null;
  }
  return makeSkillDecision(state, skill, '点火-烧药', '选择烧毁哪瓶药（0=解药 1=毒药）。', candidates, 'target');
}

/** 夜间点火结算：90% 烧物品 / 10% 烧技能。 */
export function applyNightIgnition(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'ignition' || skill.status !== 'ready') {
    throw new Error('点火技能不可用');
  }
  markOffered(skill, offerKey(state, 'night-ignition'));
  const optional = decision as OptionalTargetDecision;
  if (!optional.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', '你保留了点火。', { actorPlayerId: skill.ownerPlayerId });
    return;
  }
  const targetPlayerId = optional.targetPlayerId;
  if (targetPlayerId === null || !pending.candidates.includes(targetPlayerId)) {
    throw new Error('点火目标不合法');
  }
  const roll = chooseWithState([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], state.rngState);
  state.rngState = roll.state;
  if (roll.item === 0) {
    // 10% 烧技能
    const burned = burnAllSkills(state, targetPlayerId);
    const targetName = nameOf(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰吞没了 ${targetName} 的全部魔女技！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `你的魔法技能被 ${nameOf(state, skill.ownerPlayerId)} 烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    exhaustSkill(skill);
    return;
  }
  // 90% 烧物品：检查目标是否有药
  const assignment = getRoleAssignment(state, targetPlayerId);
  const hasAntidote = assignment.resources.antidote === 1;
  const hasPoison = assignment.resources.poison === 1;
  if (!hasAntidote && !hasPoison) {
    // 无药可烧：落空（持有者私密知晓）
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰在 ${nameOf(state, targetPlayerId)} 身上没有找到可烧毁的物品，扑了个空。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    exhaustSkill(skill);
    return;
  }
  // 有药：暂存目标，等待第二次决策选毒/解药
  skill.data.pendingBurnTarget = targetPlayerId;
  skill.data.pendingBurnNight = state.day;
}

/** 点火烧药结算（第二次决策）。 */
export function applyNightIgnitionPotion(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'ignition' || skill.status !== 'ready') {
    throw new Error('点火技能不可用');
  }
  const targetPlayerId = skill.data.pendingBurnTarget as PlayerId | undefined;
  if (typeof targetPlayerId !== 'number') {
    throw new Error('缺少点火烧药目标');
  }
  const choice = (decision as TargetDecision).targetPlayerId; // 0=解药 1=毒药
  const assignment = getRoleAssignment(state, targetPlayerId);
  const targetName = nameOf(state, targetPlayerId);
  if (choice === 0 && assignment.resources.antidote === 1) {
    assignment.resources.antidote = 0;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰烧毁了 ${targetName} 的解药！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `你的解药被 ${nameOf(state, skill.ownerPlayerId)} 的火焰烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else if (choice === 1 && assignment.resources.poison === 1) {
    assignment.resources.poison = 0;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰烧毁了 ${targetName} 的毒药！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `你的毒药被 ${nameOf(state, skill.ownerPlayerId)} 的火焰烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else {
    // 选了没有的药（理论上不会，但防御）
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰在 ${targetName} 身上没有找到对应的药，扑了个空。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  }
  delete skill.data.pendingBurnTarget;
  delete skill.data.pendingBurnNight;
  exhaustSkill(skill);
}

/** 白天点火决策（投票统计后）：选择目标（烧投票/技能）。 */
export function getDayIgnitionDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'day-ignition');
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'ignition'
      && entry.status === 'ready'
      && getPlayer(state, entry.ownerPlayerId).alive
      && !wasOffered(entry, key),
  );
  if (!skill) {
    return null;
  }
  const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== skill.ownerPlayerId);
  if (candidates.length === 0) {
    return null;
  }
  return makeSkillDecision(state, skill, '点火-白天', '选择一名目标：火焰将随机烧毁她的投票（90%）或全部魔女技（10%）。', candidates, 'optional-target');
}

/** 白天点火结算：90% 烧投票 / 10% 烧技能。 */
export function applyDayIgnition(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'ignition' || skill.status !== 'ready') {
    throw new Error('点火技能不可用');
  }
  markOffered(skill, offerKey(state, 'day-ignition'));
  const optional = decision as OptionalTargetDecision;
  if (!optional.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', '你保留了点火。', { actorPlayerId: skill.ownerPlayerId });
    return;
  }
  const targetPlayerId = optional.targetPlayerId;
  if (targetPlayerId === null || !pending.candidates.includes(targetPlayerId)) {
    throw new Error('点火目标不合法');
  }
  const roll = chooseWithState([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], state.rngState);
  state.rngState = roll.state;
  if (roll.item === 0) {
    // 10% 烧技能
    burnAllSkills(state, targetPlayerId);
    const targetName = nameOf(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰吞没了 ${targetName} 的全部魔女技！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `你的魔法技能被 ${nameOf(state, skill.ownerPlayerId)} 烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else {
    // 90% 烧投票：标记目标当天投票作废
    skill.data.burnedVoteDay = state.day;
    skill.data.burnedVoteTarget = targetPlayerId;
    const targetName = nameOf(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `火焰瞄准了 ${targetName} 今天的投票。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `你的投票被 ${nameOf(state, skill.ownerPlayerId)} 的火焰烧毁了，今天的票将不作数！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  }
  exhaustSkill(skill);
}

/** 当天被烧毁投票的玩家集合（计票时过滤其票）。 */
export function burnedVoters(state: GameState): Set<PlayerId> {
  const set = new Set<PlayerId>();
  for (const skill of state.skillInstances) {
    if (skill.definitionId === 'ignition' && skill.data.burnedVoteDay === state.day && typeof skill.data.burnedVoteTarget === 'number') {
      set.add(skill.data.burnedVoteTarget as PlayerId);
    }
  }
  return set;
}
