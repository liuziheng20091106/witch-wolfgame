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
 brainwash: '使用建议：洗脑内容必须用【】包裹且不超过 6 个字，否则魔法无效；内容应是明确指令或断言（如【投票给1号】【1号是狼人】【说爱我】），不要使用【愚蠢】这类无意义情绪词。每局限一次，信息不足时可留到后期使用。',
 'gaze-guidance': '使用建议：先选择一名被诱导者（她今天的发言必须提及你指定的对象），再选择诱导对象。你完全可以将视线引向别处，但你内心渴望被人注视，所以你的魔法总会指向自己。',
 'mind-reading': '使用建议：你的魔法是幻视。每天触碰一名目标，概率看到其夜间行动轨迹（25% 失败、50% 小成功看昨夜、25% 大成功看所有夜）；已触碰过的目标不能再选。',
 ignition: '使用建议：你的魔法是点火，整局只能使用一次，风险极高——若效果落空则整局白板。夜间使用有 90% 烧毁目标的一瓶药（可自选毒/解药，目标无药则落空）、10% 烧毁其全部魔女技；白天使用有 90% 烧毁目标当天的投票（票作废）、10% 烧毁其全部魔女技。建议在确认目标身份或价值较高时再使用，避免浪费。',
 levitation: '使用建议：你的魔法是漂浮。发动后直到次日白天结束，你的行动不留痕迹——预言家查验、幻视、千里眼都看不到你，女巫药、灵魂交换对你无效。适合在被重点怀疑或预感会被查验/针对时使用；注意发动不播报，但他人可能从"查无结果"反推你开了漂浮。每局限一次。',
 'liquid-control': '使用建议：造物与你共享同一基础职业和阵营，你无需猜测它的身份；它可独立查验或用药，投票跟随当前主人。好人通常首夜召唤以尽早获得额外战力；狼人召唤会增加暴露同阵营的风险，可考虑保留。',
 clairvoyance: '使用建议：直播是单向暴露观看者身份；通常只有已经相信并基本确认你身份的玩家才愿意观看。第一天信任不足，几乎无人观看，通常应保留到身份较可信时再开启。',
};
