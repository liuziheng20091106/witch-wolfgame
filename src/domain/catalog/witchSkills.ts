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
 'gaze-guidance': '认知：先选择被诱导者，再选择其必须提及的对象；对象可以是你，也可以是其他合法目标，不是固定指向你。',
 'mind-reading': '使用建议：你的魔法是幻视。每天触碰一名目标，概率看到其夜间行动轨迹（25% 失败、50% 小成功看昨夜、25% 大成功看所有夜）；已触碰过的目标不能再选。',
 ignition: '使用建议：点火整局一次，风险极高。夜间90%烧目标一瓶药（无药则落空），10%烧全部魔女技；白天完整票型公布后90%烧目标当日投票，10%烧全部魔女技；目标99号造物时必定烧投票（100%）。结合票型选择目标，避免浪费。',
 levitation: '使用建议：你的魔法是漂浮。发动后直到次日白天结束，你的行动不留痕迹——预言家查验、幻视、千里眼都看不到你，女巫药、灵魂交换对你无效。适合在被重点怀疑或预感会被查验/针对时使用；注意发动不播报，但他人可能从"查无结果"反推你开了漂浮。每局限一次。',
 'liquid-control': '使用建议：造物与你共享同一基础职业和阵营，你无需猜测它的身份；它可独立查验或用药，投票跟随当前主人。好人通常首夜召唤以尽早获得额外战力；狼人召唤会增加暴露同阵营的风险，可考虑保留。',
 clairvoyance: '使用建议：直播是单向暴露观看者身份；通常只有已经相信并基本确认你身份的玩家才愿意观看。第一天信任不足，几乎无人观看，通常应保留到身份较可信时再开启。',
 'witch-killer': '认知：精准击杀不可被解药或治愈阻止；目标必须遵守当前合法候选。',
 'speech-restrain': '认知：怪力使目标当天无法进行公开发言；不要把被禁言当成沉默或身份铁证。',
 healing: '认知：治愈私下保护目标并可能阻止死亡；目标不会因此自动知道被保护。',
 'voice-mimic': '认知：选择尚未发言的目标后，伪造片段会混入其公开发言；按系统记录判断来源。',
 'witch-factor-recovery': '认知：只能从已死亡且魔女技尚未耗尽的目标回收一项技能。',
};
