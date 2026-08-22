import { CHARACTER_CATALOG, WITCH_SKILL_CATALOG } from '../../../shared/gamePromptContract.js';
import type { CharacterId, SkillTiming, WitchSkillDefinition, WitchSkillId } from '../model';

export const witchSkillDefinitions = Object.fromEntries(
 WITCH_SKILL_CATALOG.map((definition) => [definition.id, {
  ...definition,
  timings: [...definition.timings] as SkillTiming[],
 }]),
) as Record<WitchSkillId, WitchSkillDefinition>;

export const defaultSkillByCharacterId = Object.fromEntries(
 CHARACTER_CATALOG.map((character) => [character.id, character.defaultSkillId]),
) as Record<CharacterId, WitchSkillId>;

/**
 * 技能使用建议（可选）：拼接进 AI 提示词的 actor.skill 字段，仅影响 AI 决策。
 * 不影响 PUBLIC_SKILLS 白名单与 UI 展示（技能描述本体保持不变）。
 * 注意：技能名 + 描述 + 本条建议总长须 ≤ 240 字（后端 actor.skill 校验上限）。
 */
export const skillUsageHints: Partial<Record<WitchSkillId, string>> = {
 'soul-exchange': '使用建议：如果你是狼人，建议优先换神职（风险较高）；如果你是好人，可换狼（风险较高）或换好人互发金水；交换后旧知识失效，按新阵营行动。',
 'death-rewind': '使用建议：你拥有死亡回溯前的记忆（仅你可感知），请利用这次机会改变发言或行动策略，例如调整投票、查验或袭击目标。',
 brainwash: '使用建议：你的魔法是洗脑。使用后，你当天的洗脑发言会作为强提示词发送给其他玩家。请务必给洗脑内容前后加上【】，洗脑内容不得超过 6 个字；若违反以上两条，魔法无效。',
 'gaze-guidance': '使用建议：先选择一名被诱导者（她今天的发言必须提及你指定的对象），再选择诱导对象。你完全可以将视线引向别处，但你内心渴望被人注视，所以你的魔法总会指向自己。',
 'mind-reading': '使用建议：你的魔法是幻视。每天触碰一名目标，概率看到其夜间行动轨迹（25% 失败、50% 小成功看昨夜、25% 大成功看所有夜）；已触碰过的目标不能再选。',
 ignition: '使用建议：你的魔法是点火，整局只能使用一次，风险极高——若效果落空则整局白板。夜间使用有 90% 烧毁目标的一瓶药（可自选毒/解药，目标无药则落空）、10% 烧毁其全部魔女技；白天使用有 90% 烧毁目标当天的投票（票作废）、10% 烧毁其全部魔女技。建议在确认目标身份或价值较高时再使用，避免浪费。',
};
