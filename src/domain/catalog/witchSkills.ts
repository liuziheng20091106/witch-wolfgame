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
 * 技能规则认知：拼接进 AI 提示词的 actor.skill 字段，仅影响 AI 决策。
 * 不影响 PUBLIC_SKILLS 白名单与 UI 展示（技能描述本体保持不变）。
 * 注意：技能名 + 描述 + 本条建议总长须 ≤ 240 字（后端 actor.skill 校验上限）。
 */
export const skillUsageHints: Partial<Record<WitchSkillId, string>> = {
 'witch-killer': '认知：夜间可使用或保留；目标必须是另一名存活者。命中后本夜死亡，解药、治愈、漂浮都不能阻止，且没有遗言；你会私下知道标记目标。狼人持有时不能选择狼队友。',
 'death-rewind': '认知：被动且只触发一次；首个白天前没有晨间节点时不会发动。触发后回到当日两轮发言前，其他人失去旧时间线记忆，只有你保留当时所知的知识和私密事件；恢复后的当前职业优先。',
 brainwash: '认知：每局一次，在自己发言前选择发动；当天后续发言必须恰好含一个【1~6字】内容才会生效。它只强提示其他玩家后续发言、投票与平票决策，不保证服从；遗言中的合法内容也可发动。',
 'liquid-control': '认知：夜间可创造或保留。造物继承你当时的基础职业与阵营，不继承魔女技、不发言，投票严格跟随你；狼人密议、预言家查验、女巫用药可独立决策。你是女巫时可把现有的一瓶药转交给它。',
 'speech-restrain': '认知：每局一次，白天选择另一名存活玩家或保留。目标跳过当天第一轮和自由发言轮；当天死亡也没有遗言。平票候选人的追加发言不属于这两轮，仍可进行。技能效果会公开。',
 levitation: '认知：夜间发动且不公开，持续当夜至次日白天结束。预言家、幻视、千里眼看不清你；毒药和灵魂交换选你会失败并照常消耗。狼人袭击、解药、治愈、魔女杀手仍正常生效。',
 healing: '认知：每夜必须选择一名存活者，可选自己。治愈私下记录给你，目标不会因此自动知情；它挡下本夜狼人袭击和毒药等可防止意图，但挡不住魔女杀手。',
 clairvoyance: '认知：白天可公开开播或保留，每局只成功开播一次。其他存活者各自选择观看；观看者知道自己的选择。你私下知道谁观看及其当前职业；漂浮者观看时你只知道其观看但看不清职业。',
 'gaze-guidance': '认知：每天可使用或保留；先选另一名存活者为被诱导者，再从存活者中选诱导对象（可以是你，但不是必须）。被诱导者当天所有公开发言都必须提及该对象，技能选择仅你知晓。',
 'soul-exchange': '认知：夜间可使用或保留；交换你与另一名存活者的当前基础职业及职业资源，双方私下得知交换后的职业。关于双方旧职业的信息可能过期，应按新阵营行动；目标漂浮时交换失败但仍消耗。',
 'mind-reading': '认知：每天必须触碰一名未触碰过的其他存活者；无论结果如何都不能再选此人。25%失败、50%看昨夜、25%看全部夜晚，只显示脱敏的部分轨迹；未显示某类行动不等于目标没做过或不是该职业，漂浮目标看不到痕迹。',
 ignition: '认知：每局一次，可在夜间或全员投票后使用。夜间90%尝试烧药：目标无药则落空且仅你知晓，有药时由你选解药或毒药；10%烧光其魔女技。白天90%使目标本日票作废，10%烧光其魔女技；成功结果你和目标私下知晓。',
 'voice-mimic': '认知：每局一次，只能在你发言后选择本日尚未发言者，并按其说话风格伪造1~50字。片段会在目标随后发言时混入并公开显示为目标所说；局内其他人看不出真正作者，赛后才揭晓。',
 'witch-factor-recovery': '认知：夜间可回收或保留；目标只能是死亡玩家，且其实际技能实例仍未耗尽、未被烧毁。回收后原技能归你，回收技能自身耗尽；回收当夜不会再次触发已错过的夜间起始时机。',
};
