import type { GameState, IgnitionDecision, PendingDecision, PlayerId, SubmittedDecision, WitchSkillInstance } from '../model';
import { addPrivateEvent } from '../engine/events';
import { getName } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey } from './types';

// ===== 漂浮（远野汉娜）：隐匿技——夜晚发动，覆盖当夜 + 次日白天 =====
// 效果：自己的行动不留任何可追溯记录；观察类技能（幻视/预言家查验/千里眼）对她无效，
//      选择类技能（女巫药/灵魂交换）对她失败（照常消耗）；魔女杀手不受影响。
// 发动不产生公开播报（隐匿），他人只能从"查无结果/选中失败"反推。

/** 漂浮发动决策（use-only，无目标）。 */
export function getLevitationDecision(state: GameState, skill: WitchSkillInstance): PendingDecision {
  // 即使提示词不显示姓名，仍校验持有者是否存在。
  getName(state, skill.ownerPlayerId);
  return makeSkillDecision(
    state,
    skill,
    '漂浮',
    `发动漂浮，隐藏自己的脚印吗？【选择：是/否】\n发动后直到第二天白天结束，你的行动不留任何可追溯记录：预言家查验、幻视、千里眼都看不到你，女巫药、灵魂交换对你无效。本技能每局仅能发动一次，发动不公开播报。`,
    [],
    'ignition',
  );
}

/** 漂浮结算：发动后标记生效起始夜（覆盖当夜 + 次日白天）。 */
export function applyLevitation(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'levitation' || skill.status !== 'ready') {
    throw new Error('漂浮技能不可用');
  }
  const levitation = decision as IgnitionDecision;
  if (!levitation.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了漂浮。`, { actorPlayerId: skill.ownerPlayerId });
    // 关键：保留也必须标记调度 key（night-start），否则下一轮仍会询问，导致死循环。
    // offerKey 含当天号，只屏蔽当天；下一天 key 变化，漂浮仍可正常询问（每局限一次，未发动则保留可下一天用）。
    markOffered(skill, offerKey(state, 'night-start'));
    return;
  }
  skill.data.floatingStartDay = state.day;
  exhaustSkill(skill);
  // 无公开播报（隐匿）；仅持有者本人知晓已发动
  addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 发动了漂浮，隐藏了自己的脚印：直到明天白天结束，${getName(state, skill.ownerPlayerId)} 的行动不留痕迹。`, {
    actorPlayerId: skill.ownerPlayerId,
  });
}

/**
 * 查询 playerId 在给定 day 是否处于漂浮生效期。
 * 生效窗口：发动夜（night-start，day=N）保护当夜结算 + 次日白天（day=N+1）。
 */
export function isFloatingActive(state: GameState, playerId: PlayerId, day: number): boolean {
  return state.skillInstances.some(
    (skill) => skill.definitionId === 'levitation'
      && skill.ownerPlayerId === playerId
      && typeof skill.data.floatingStartDay === 'number'
      && (skill.data.floatingStartDay === day || skill.data.floatingStartDay === day - 1),
  );
}
