import type { GameState, OptionalTargetDecision, PendingDecision, PlayerId, SubmittedDecision, TargetDecision } from '../model';
import { addPrivateEvent } from '../engine/events';
import { getAlivePlayerIds, getName, getPlayer, getRoleAssignment } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, wasOffered } from './types';
import { chooseWithState } from '../engine/random';
import { formatVoteRound, formatVoteTally, tallyVoteRound } from '../engine/vote';

// ===== 点火（亚里沙）：整局一次，夜间烧物品/技能 或 白天烧投票/技能 =====
// 夜间：90% 烧目标一瓶药（可自选毒/解药，无药则落空）/ 10% 烧全部魔女技
// 白天（投票统计后）：90% 烧目标当天投票（票作废）/ 10% 烧全部魔女技
// 烧技能：目标所有 skillInstances 置 exhausted 并标记 burned（魔女因子回收不可用）

/** 烧毁目标全部魔女技（白板）。返回是否实际烧到。 */
export function burnAllSkills(state: GameState, targetPlayerId: PlayerId): boolean {
  // 保留目标存在性校验，失败时不得先修改技能。
  getPlayer(state, targetPlayerId);
  const instances = state.skillInstances.filter((entry) => entry.ownerPlayerId === targetPlayerId);
  let burned = false;
  for (const instance of instances) {
    exhaustSkill(instance);
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
  const decision = makeSkillDecision(state, skill, '点火-烧药', '选择烧毁哪瓶药（0=解药 1=毒药）。', candidates, 'target');
  // 药选择标记：candidates 是药索引（0=解药 1=毒药），不是玩家 id，UI/AI 据此正确渲染
  decision.options.potionChoice = true;
  // 决策 id 加后缀保持唯一：点火主决策与烧药决策用同一 skill，id 相同会导致 UI 不重置 target
  decision.id = `${decision.id}-potion`;
  return decision;
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
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了点火。`, { actorPlayerId: skill.ownerPlayerId });
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
    const targetName = getName(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 用火焰烧毁了 ${targetName} 的全部魔女技！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `${getName(state, targetPlayerId)} 的魔法技能被 ${getName(state, skill.ownerPlayerId)} 烧毁了！`, {
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
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 的火焰在 ${getName(state, targetPlayerId)} 身上没有找到可烧毁的物品，扑了个空。`, {
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
  const targetName = getName(state, targetPlayerId);
  if (choice === 0 && assignment.resources.antidote === 1) {
    assignment.resources.antidote = 0;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 用火焰烧毁了 ${targetName} 的解药！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `${getName(state, targetPlayerId)} 的解药被 ${getName(state, skill.ownerPlayerId)} 的火焰烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else if (choice === 1 && assignment.resources.poison === 1) {
    assignment.resources.poison = 0;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 用火焰烧毁了 ${targetName} 的毒药！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `${getName(state, targetPlayerId)} 的毒药被 ${getName(state, skill.ownerPlayerId)} 的火焰烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else {
    // 选了没有的药（理论上不会，但防御）
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 的火焰在 ${targetName} 身上没有找到对应的药，扑了个空。`, {
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
  let round: 1 | 2 = 1;
  if (state.phase === 'runoff') {
    round = 2;
  }
  const playerName = (playerId: PlayerId) => getName(state, playerId);
  const voteSummary = formatVoteRound(state.currentVotes, round, playerName);
  const voteTally = formatVoteTally(tallyVoteRound(state.currentVotes, round), playerName);
  return makeSkillDecision(
    state,
    skill,
    '点火-白天',
    `第 ${round} 轮完整提交票型已经公布：${voteSummary}。提交票数汇总（点火前）：${voteTally}。选择一名目标：火焰将随机烧毁她的投票（90%）或全部魔女技（10%）。`,
    candidates,
    'optional-target',
  );
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
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了点火。`, { actorPlayerId: skill.ownerPlayerId });
    return;
  }
  const targetPlayerId = optional.targetPlayerId;
  if (targetPlayerId === null || !pending.candidates.includes(targetPlayerId)) {
    throw new Error('点火目标不合法');
  }
  const targetIsCreature = targetPlayerId === 99;
  // 造物没有魔女技可烧：对造物点火 100% 烧掉它的投票（造物的票跟随诺亚，存在即可被烧）
  let burnVote = true;
  if (!targetIsCreature) {
    const roll = chooseWithState([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], state.rngState);
    state.rngState = roll.state;
    burnVote = roll.item !== 0;
  }
  if (!burnVote) {
    // 10% 烧技能
    burnAllSkills(state, targetPlayerId);
    const targetName = getName(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 用火焰烧毁了 ${targetName} 的全部魔女技！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `${getName(state, targetPlayerId)} 的魔法技能被 ${getName(state, skill.ownerPlayerId)} 烧毁了！`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
  } else {
    // 烧投票：标记目标当天投票作废（造物票亦计入 burnedVoters 过滤）
    skill.data.burnedVoteDay = state.day;
    skill.data.burnedVoteTarget = targetPlayerId;
    const targetName = getName(state, targetPlayerId);
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 烧毁了 ${targetName} 今天的投票，她的票将不作数。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    addPrivateEvent(state, [targetPlayerId], 'skill', `${getName(state, targetPlayerId)} 的投票被 ${getName(state, skill.ownerPlayerId)} 的火焰烧毁了，今天的票将不作数！`, {
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
