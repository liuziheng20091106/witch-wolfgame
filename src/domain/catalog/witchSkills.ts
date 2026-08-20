import type { CharacterId, WitchSkillDefinition, WitchSkillId } from '../model';

export const witchSkillDefinitions: Record<WitchSkillId, WitchSkillDefinition> = {
  'witch-killer': { id: 'witch-killer', name: '魔女杀手', description: '每局一次，夜间指定一名无法被解药或治愈保护的目标。', timings: ['night-start'], usage: 'once' },
  'death-rewind': { id: 'death-rewind', name: '死亡回溯', description: '首次死亡时回到当日发言前，旧时间线仅观战者可见。', timings: ['on-death'], usage: 'passive' },
  brainwash: { id: 'brainwash', name: '洗脑', description: '发言前指定当天的怀疑焦点。', timings: ['before-speech'], usage: 'once' },
  'liquid-control': { id: 'liquid-control', name: '操控液体', description: '抽取他人职业，或公开一条已知事实。', timings: ['night-start'], usage: 'once' },
  'speech-restrain': { id: 'speech-restrain', name: '力气大', description: '指定一人当天无法发言。', timings: ['day-start'], usage: 'once' },
  levitation: { id: 'levitation', name: '漂浮', description: '调整公开投票顺序，或取得二次平票裁决权。', timings: ['before-vote', 'after-runoff'], usage: 'once' },
  healing: { id: 'healing', name: '治愈', description: '每夜保护一名存活者，移除其所有可防止死亡意图。', timings: ['night-protection'], usage: 'nightly' },
  clairvoyance: { id: 'clairvoyance', name: '千里眼', description: '有人提及自己时，看穿真实发言者的当前职业。', timings: ['on-mention'], usage: 'passive' },
  'gaze-guidance': { id: 'gaze-guidance', name: '视线诱导', description: '存活时，其他人的正常与伪造发言必须提及自己。', timings: ['day-start'], usage: 'daily' },
  'soul-exchange': { id: 'soul-exchange', name: '灵魂交换', description: '每局一次，交换自己与另一名存活者的基础职业及职业资源。', timings: ['night-start'], usage: 'once' },
  'mind-reading': { id: 'mind-reading', name: '看到内心', description: '每局一次，私下获知一名存活者的当前阵营。', timings: ['night-start'], usage: 'once' },
  ignition: { id: 'ignition', name: '点火', description: '每局一次，公开随机一名其他存活者的阵营。', timings: ['day-start'], usage: 'once' },
  'voice-mimic': { id: 'voice-mimic', name: '声音模仿', description: '把一段伪造内容混入本日尚未发言者的公开记录。', timings: ['after-speech'], usage: 'once' },
  'witch-factor-recovery': { id: 'witch-factor-recovery', name: '魔女因子回收', description: '回收一名死亡者尚未耗尽的实际技能实例。', timings: ['night-start'], usage: 'once' },
};

export const defaultSkillByCharacterId: Record<CharacterId, WitchSkillId> = {
  'soul-0': 'witch-killer',
  'soul-1': 'death-rewind',
  'soul-2': 'brainwash',
  'soul-3': 'liquid-control',
  'soul-4': 'speech-restrain',
  'soul-5': 'levitation',
  'soul-6': 'witch-factor-recovery',
  'soul-7': 'voice-mimic',
  'soul-8': 'healing',
  'soul-9': 'ignition',
  'soul-10': 'soul-exchange',
  'soul-11': 'gaze-guidance',
  'soul-12': 'mind-reading',
  'soul-13': 'clairvoyance',
};

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
};
