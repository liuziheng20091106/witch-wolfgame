import type {
  CharacterId,
  PendingDecisionKind,
  TimelineEventKind,
  WitchSkillId,
} from '../domain/model';

export type RoleplayRetrievalCategory = 'argument_moves' | 'pressure_reactions' | 'original_case';

export interface RoleplayRetrievalQuery {
  actorCharacterId: CharacterId;
  actorSkillId: WitchSkillId | null;
  decisionKind: PendingDecisionKind;
  isPostGame: boolean;
  focusedCharacterIds: readonly CharacterId[];
  recentCharacterIds: readonly CharacterId[];
  recentEventKinds: readonly TimelineEventKind[];
  privateKnowledgeCount: number;
  currentSpeechCount: number;
  votesAgainstActor: number;
}

export interface RoleplayRetrievalCard {
  id: string;
  category: RoleplayRetrievalCategory;
  content: string;
}

export interface OriginalCaseLoreCard {
  id: string;
  title: string;
  summary: string;
  characterIds: readonly CharacterId[];
  skillIds: readonly WitchSkillId[];
  eventKinds: readonly TimelineEventKind[];
}

export const ORIGINAL_CASE_SUMMARY_MIN_LENGTH = 40;
export const ORIGINAL_CASE_SUMMARY_MAX_LENGTH = 160;

const ARGUMENT_CARD_BY_ID = {
  proposeHypothesis: {
    id: 'argument.propose-hypothesis',
    category: 'argument_moves',
    content: '先提出可验证的假设，再区分事实、推测和不知道的部分。',
  },
  identifyContradiction: {
    id: 'argument.identify-contradiction',
    category: 'argument_moves',
    content: '优先比较已有发言的具体冲突；只引用当前可见内容，不替别人补写动机。',
  },
  demandEvidence: {
    id: 'argument.demand-evidence',
    category: 'argument_moves',
    content: '投票前指出具体依据；若依据不足，说明不确定性，不把关系当证据。',
  },
  alternativeExplanation: {
    id: 'argument.alternative-explanation',
    category: 'argument_moves',
    content: '比较候选人的公开矛盾，说明为什么当前选择比替代解释更合理。',
  },
  reconstructTimeline: {
    id: 'argument.reconstruct-timeline',
    category: 'argument_moves',
    content: '只根据已公开的信息重建顺序，不能把平票本身当成身份结论。',
  },
  wolfHypothesis: {
    id: 'argument.wolf-hypothesis',
    category: 'argument_moves',
    content: '区分队友私密情报与公开事实，不把建议写成必然结果。',
  },
  wolfRisk: {
    id: 'argument.wolf-risk',
    category: 'argument_moves',
    content: '比较目标收益、暴露风险和替代目标，但最终只提交合法目标。',
  },
  usePrivateKnowledge: {
    id: 'argument.use-private-knowledge',
    category: 'argument_moves',
    content: '私有查验可以影响判断；公开发言时自行决定是否透露，但不得虚构未获得的结果。',
  },
  answerUnderPressure: {
    id: 'pressure.answer-under-pressure',
    category: 'pressure_reactions',
    content: '当前已承受票型压力；先回应针对自己的具体依据，再按角色性格决定反驳、承认失误或保留。',
  },
} as const satisfies Record<string, RoleplayRetrievalCard>;

/** 编译自工作目录中对应的 A1_C1 至 A3_C2 总览；运行时不携带来源元数据与章节流程。 */
export const ORIGINAL_CASE_LORE_CARDS = [
  {
    id: 'A1-C1',
    title: '诺亚案',
    summary: '蕾雅以简易长矛从门外刺杀诺亚，并固定诺亚望向天花板的视线，又令路过者忽略尸体。她因幼时缺少母亲注视而渴望成为焦点，嫉妒知名画家“气球”诺亚夺走众人关注，遂起杀心。',
    characterIds: ['soul-3', 'soul-11'],
    skillIds: ['gaze-guidance'],
    eventKinds: ['speech', 'restrained', 'death'],
  },
  {
    id: 'A1-C2',
    title: '米莉亚案',
    summary: '安安以洗脑魔法取得惩罚室钥匙，刺杀自称与艾玛交换身体的米莉亚，再用录音与手机掉包伪造不在场证明。监牢让孤独的她首次拥有诺亚、蕾雅、米莉亚和梅露露等朋友；她不愿艾玛的越狱计划夺走这份幸福，本想杀死艾玛，却被米莉亚舍身保护艾玛的谎言误导。',
    characterIds: ['soul-0', 'soul-2', 'soul-10'],
    skillIds: ['brainwash', 'soul-exchange'],
    eventKinds: ['role-exchange', 'speech', 'death'],
  },
  {
    id: 'A1-C3',
    title: '汉娜案',
    summary: '即将魔女化的汉娜托付雪莉结束生命；雪莉将她勒死并伪装成上吊，再以怪力调换两座招待所制造密室，又袭击奈叶香、刺伤自己伪造不在场证明，最终承担罪责。',
    characterIds: ['soul-4', 'soul-5'],
    skillIds: ['levitation', 'speech-restrain'],
    eventKinds: ['restrained', 'death', 'exile'],
  },
  {
    id: 'A1-C4',
    title: '亚里沙案',
    summary: '首次审判一度认定：亚里沙服安眠药自尽未遂，艾玛误触机关，使昏睡的她随处刑台降入冷冻室，过失致其冻死。幕后黑手案则揭示，梅露露交给她的“安眠药”其实是杀死魔女的特雷德基姆，才是其真正死因。',
    characterIds: ['soul-0', 'soul-9'],
    skillIds: ['ignition'],
    eventKinds: ['witch-action', 'death', 'trial-by-fire'],
  },
  {
    id: 'A1-C5',
    title: '幕后黑手案',
    summary: '梅露露为寻找大魔女月代雪而运营监牢。为灭口已查明监牢秘密的奈叶香，她从背后开枪杀人，以斧分尸，经地下处刑台小窗移送，再用治愈魔法复原尸体制造密室；她还把特雷德基姆伪装成安眠药交给亚里沙，造成其死亡。',
    characterIds: ['soul-8', 'soul-9', 'soul-12'],
    skillIds: ['healing'],
    eventKinds: ['protection', 'witch-action', 'death'],
  },
  {
    id: 'A2-C1',
    title: '梅露露案',
    summary: '玛格因梅露露照顾自己而产生将爱等同伤害的扭曲占有欲，遂将她刺死；她以模仿魔法伪造通话和玻璃碎裂声，并把昏迷的希罗当作踏板跨越白色颜料，未留下自己的足迹。',
    characterIds: ['soul-1', 'soul-7', 'soul-8'],
    skillIds: ['voice-mimic'],
    eventKinds: ['speech', 'timeline-rewound', 'death'],
  },
  {
    id: 'A2-C2',
    title: '可可案',
    summary: '奈叶香为阻止可可使用杀死魔女的“13水”（特雷德基姆）而开枪杀死她；可可实际身处焚烧炉室，却用合成直播背景伪装成淋浴房，造成现场错觉。处刑时，已成为看守的姐姐惠叶香挺身保护奈叶香，令她在崩溃中魔女化。',
    characterIds: ['soul-12', 'soul-13'],
    skillIds: ['mind-reading', 'clairvoyance'],
    eventKinds: ['knowledge', 'skill', 'death'],
  },
  {
    id: 'A2-C3',
    title: '安安案',
    summary: '安安与艾玛策划装死恶作剧；希罗阻止两人争执时意外使安安坠楼，艾玛为保护希罗而伪造现场。安安凭预设吊床成功假死后，害怕拙劣真画曝光的诺亚用铁栅将她刺死，并以魔法降雨冲去痕迹。',
    characterIds: ['soul-0', 'soul-1', 'soul-2', 'soul-3'],
    skillIds: ['brainwash', 'liquid-control'],
    eventKinds: ['speech', 'death', 'exile'],
  },
  {
    id: 'A2-C4',
    title: '艾玛与蕾雅案',
    summary: '汉娜以大小姐幻想掩盖贫困与被母亲抛弃的创伤；蕾雅谈及她粗糙的手，又说“先走一步”，触发她对阶层差距与再次被抛弃的恐惧。汉娜以冰块击杀蕾雅，又为灭口用刺剑杀死目击的艾玛；她给艾玛穿上缝有自己头发的礼服，以漂浮魔法将尸体悬在电梯轿厢上方，希罗因此决定最后一次自杀回溯。',
    characterIds: ['soul-0', 'soul-1', 'soul-5', 'soul-11'],
    skillIds: ['levitation'],
    eventKinds: ['death', 'timeline-rewound'],
  },
  {
    id: 'A3-C1',
    title: '召唤大魔女',
    summary: '希罗带着轮回记忆主动召开审判，逐一揭开众人创伤使十三人魔女化，最终以仪礼剑召来月代雪。',
    characterIds: ['soul-0', 'soul-1', 'soul-6', 'soul-8'],
    skillIds: ['death-rewind', 'witch-factor-recovery'],
    eventKinds: ['timeline-rewound', 'factor-recovered', 'trial-by-fire'],
  },
  {
    id: 'A3-C2',
    title: '最终审判',
    summary: '少女们在最终审判中指出月代雪复仇计划的矛盾；雪收回全人类的魔女因子，与梅露露和解消逝。',
    characterIds: ['soul-0', 'soul-1', 'soul-6', 'soul-8'],
    skillIds: ['witch-killer', 'witch-factor-recovery', 'healing'],
    eventKinds: ['factor-recovered', 'protection', 'result'],
  },
] as const satisfies readonly OriginalCaseLoreCard[];

const RETRIEVAL_CONTEXT_MAX_LENGTH = 320;
const ORIGINAL_CASE_MIN_SCORE = 65;

function includesCharacter(characterIds: readonly CharacterId[], characterId: CharacterId): boolean {
  return characterIds.includes(characterId);
}

function countCharacterMatches(left: readonly CharacterId[], right: readonly CharacterId[]): number {
  return left.filter((characterId) => right.includes(characterId)).length;
}

function countEventMatches(left: readonly TimelineEventKind[], right: readonly TimelineEventKind[]): number {
  return left.filter((eventKind) => right.includes(eventKind)).length;
}

function selectArgumentCard(query: RoleplayRetrievalQuery): RoleplayRetrievalCard | null {
  if (query.isPostGame) {
    return null;
  }
  const isSocialDecision = query.decisionKind === 'speech'
    || query.decisionKind === 'vote'
    || query.decisionKind === 'runoff'
    || query.decisionKind === 'tie-break';
  if (isSocialDecision && query.votesAgainstActor > 0) {
    return ARGUMENT_CARD_BY_ID.answerUnderPressure;
  }
  if (query.decisionKind === 'speech') {
    if (query.privateKnowledgeCount > 0) {
      return ARGUMENT_CARD_BY_ID.usePrivateKnowledge;
    }
    if (query.currentSpeechCount >= 2) {
      return ARGUMENT_CARD_BY_ID.identifyContradiction;
    }
    return ARGUMENT_CARD_BY_ID.proposeHypothesis;
  }
  if (query.decisionKind === 'vote') {
    return ARGUMENT_CARD_BY_ID.demandEvidence;
  }
  if (query.decisionKind === 'runoff') {
    return ARGUMENT_CARD_BY_ID.alternativeExplanation;
  }
  if (query.decisionKind === 'tie-break') {
    return ARGUMENT_CARD_BY_ID.reconstructTimeline;
  }
  if (query.decisionKind === 'wolf-suggestion') {
    return ARGUMENT_CARD_BY_ID.wolfHypothesis;
  }
  if (query.decisionKind === 'wolf-decision') {
    return ARGUMENT_CARD_BY_ID.wolfRisk;
  }
  return null;
}

function scoreOriginalCase(card: OriginalCaseLoreCard, query: RoleplayRetrievalQuery): number {
  let score = 0;
  if (includesCharacter(card.characterIds, query.actorCharacterId)) {
    score += 40;
  }
  if (query.actorSkillId !== null && card.skillIds.includes(query.actorSkillId)) {
    score += 35;
  }
  score += countCharacterMatches(card.characterIds, query.recentCharacterIds) * 18;
  score += countCharacterMatches(card.characterIds, query.focusedCharacterIds) * 12;
  score += countEventMatches(card.eventKinds, query.recentEventKinds) * 4;
  if (query.isPostGame) {
    score += 8;
  }
  return score;
}

function selectOriginalCase(query: RoleplayRetrievalQuery): OriginalCaseLoreCard | null {
  let selected: OriginalCaseLoreCard | null = null;
  let selectedScore = ORIGINAL_CASE_MIN_SCORE - 1;
  for (const card of ORIGINAL_CASE_LORE_CARDS) {
    const score = scoreOriginalCase(card, query);
    if (score > selectedScore) {
      selected = card;
      selectedScore = score;
    }
  }
  return selected;
}

function formatOriginalCase(card: OriginalCaseLoreCard): RoleplayRetrievalCard {
  return {
    id: `original-case.${card.id}`,
    category: 'original_case',
    content: `${card.title}：${card.summary} 这是已结束的原作旧时间线，只能帮助理解表达与技能主题，不得作为本局身份、投票或行动依据。`,
  };
}

/**
 * 按当前可见运行态选择最多一张行为卡和一张案件卡；顺序与评分固定，不调用随机数。
 */
export function selectRoleplayRetrievalCards(query: RoleplayRetrievalQuery): readonly RoleplayRetrievalCard[] {
  const selected: RoleplayRetrievalCard[] = [];
  const argumentCard = selectArgumentCard(query);
  if (argumentCard !== null) {
    selected.push(argumentCard);
  }
  const originalCase = selectOriginalCase(query);
  if (originalCase !== null) {
    selected.push(formatOriginalCase(originalCase));
  }

  const fitted: RoleplayRetrievalCard[] = [];
  let usedLength = 0;
  for (const card of selected) {
    const nextLength = usedLength + card.id.length + card.content.length;
    if (nextLength <= RETRIEVAL_CONTEXT_MAX_LENGTH) {
      fitted.push(card);
      usedLength = nextLength;
    }
  }
  return fitted;
}
