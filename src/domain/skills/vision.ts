import type { GameState, PendingDecision, PlayerId, SubmittedDecision, TargetDecision, TimelineEvent } from '../model';
import { addPrivateEvent } from '../engine/events';
import { getAlivePlayerIds, getName, getPlayer } from '../engine/selectors';
import { makeSkillDecision, markOffered, offerKey, wasOffered } from './types';
import { chooseWithState } from '../engine/random';
import { isFloatingActive } from './levitation';

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
  const targetName = getName(state, targetPlayerId);
  const events: TimelineEvent[] = [...state.publicEvents, ...state.privateEvents]
    .filter((event) => event.day >= fromDay && event.day <= toDay);

  const describeEvent = (event: TimelineEvent): string | null => {
    const data = event.data ?? {};
    const targetIsSubject = data.targetPlayerId === targetPlayerId;
    const targetIsActor = event.actorPlayerId === targetPlayerId;

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
    if (data.guardTargetPlayerId === targetPlayerId) {
      return `${targetName} 在第${event.day}夜被守卫保护。`;
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

  const targetName = getName(state, targetPlayerId);
  if (outcome === 'fail') {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `本次幻视行为被系统判定为失败，${getName(state, skill.ownerPlayerId)} 什么都没有看到。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    return;
  }
  if (isFloatingActive(state, targetPlayerId, state.day)) {
    // 漂浮隐匿：目标行动不留痕迹，强制空结果（触碰已消耗）
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 通过幻视看到：${targetName} 在现场没有留下任何行动痕迹。`, {
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
  addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 通过幻视看到（${scopeLabel}）：${body}`, {
    actorPlayerId: skill.ownerPlayerId,
    targetPlayerIds: [targetPlayerId],
  });
}
