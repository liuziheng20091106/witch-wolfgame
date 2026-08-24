import type { PendingDecisionKind } from '../domain/model';

export interface RoleplayRetrievalCard {
  id: string;
  category: 'argument_moves';
  triggers: readonly string[];
  purpose: string;
  content: string;
  sceneSpecific: false;
  maxUse: '当前场景一次';
}

const RETRIEVAL_CARD_BY_ID = {
  proposeHypothesis: {
    id: 'argument.propose-hypothesis',
    category: 'argument_moves',
    triggers: ['speech'],
    purpose: '提出可以验证的观点，不增加本局事实',
    content: '先提出可验证的假设，再区分事实、推测和不知道的部分。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
  demandEvidence: {
    id: 'argument.demand-evidence',
    category: 'argument_moves',
    triggers: ['vote'],
    purpose: '要求对方说明依据，不增加本局事实',
    content: '投票前指出具体依据；若依据不足，说明不确定性，不把关系当证据。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
  alternativeExplanation: {
    id: 'argument.alternative-explanation',
    category: 'argument_moves',
    triggers: ['runoff'],
    purpose: '比较公开信息的替代解释，不增加本局事实',
    content: '比较候选人的公开矛盾，说明为什么当前选择比替代解释更合理。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
  reconstructTimeline: {
    id: 'argument.reconstruct-timeline',
    category: 'argument_moves',
    triggers: ['tie-break'],
    purpose: '按公开顺序整理信息，不增加本局事实',
    content: '只根据已公开的信息重建顺序，不能把平票本身当成身份结论。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
  wolfHypothesis: {
    id: 'argument.wolf-hypothesis',
    category: 'argument_moves',
    triggers: ['wolf-suggestion'],
    purpose: '在狼队讨论中区分信息权限，不增加本局事实',
    content: '区分队友私密情报与公开事实，不把建议写成必然结果。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
  wolfRisk: {
    id: 'argument.wolf-risk',
    category: 'argument_moves',
    triggers: ['wolf-decision'],
    purpose: '比较行动风险，不增加本局事实',
    content: '选择行动时说明风险和替代目标，但最终只提交合法目标。',
    sceneSpecific: false,
    maxUse: '当前场景一次',
  },
} as const satisfies Record<string, RoleplayRetrievalCard>;

const RETRIEVAL_ID_BY_DECISION_KIND: Partial<Record<PendingDecisionKind, keyof typeof RETRIEVAL_CARD_BY_ID>> = {
  speech: 'proposeHypothesis',
  vote: 'demandEvidence',
  runoff: 'alternativeExplanation',
  'tie-break': 'reconstructTimeline',
  'wolf-suggestion': 'wolfHypothesis',
  'wolf-decision': 'wolfRisk',
};

export function getRoleplayRetrievalCard(
  decisionKind: PendingDecisionKind,
  isPostGame: boolean,
): RoleplayRetrievalCard | null {
  if (isPostGame) {
    return null;
  }
  const cardId = RETRIEVAL_ID_BY_DECISION_KIND[decisionKind];
  if (cardId === undefined) {
    return null;
  }
  return RETRIEVAL_CARD_BY_ID[cardId];
}
