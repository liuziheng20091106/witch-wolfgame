import { formatRoleplaySpeechStyle, getRoleplayStaticCard } from '../data/roleplay-static';
import { getRoleplayRetrievalCard } from '../data/roleplay-retrieval';
import type { CharacterId, PendingDecisionKind } from '../domain/model';

function joinValues(values: readonly string[]): string {
  return values.join('；');
}

function formatRelationships(characterId: CharacterId): string {
  const card = getRoleplayStaticCard(characterId);
  return card.relationshipAnchors
    .map((anchor) => `${anchor.target}（${anchor.relation}：${anchor.behavioralEffect}）`)
    .join('；');
}

/**
 * 只返回当前 actor 需要的静态人格卡，不包含来源、案件、旧时间线或本局状态。
 * 本局身份、阵营、存活与技能由 actor.role、actor.skill 和观察字段提供。
 */
export function buildRoleplayPersonality(
  characterId: CharacterId,
  decisionKind: PendingDecisionKind,
  isPostGame: boolean,
): string {
  const card = getRoleplayStaticCard(characterId);
  const retrieval = getRoleplayRetrievalCard(decisionKind, isPostGame);
  const sections = [
    `【角色静态卡｜版本：${card.canonicalVersion}】`,
    `身份核心：${joinValues(card.identityCore)}`,
    `稳定动机：${joinValues(card.stableMotivation)}`,
    `压力触发：${joinValues(card.fearOrPressurePoint)}`,
    `行为底线：${joinValues(card.moralBoundaries)}`,
    `行为规则：${joinValues(card.behaviorRules)}`,
    `关系锚点：${formatRelationships(characterId)}`,
    `演绎限制：${joinValues(card.roleplayConstraints)}`,
  ];
  if (retrieval !== null) {
    sections.push(`【按需论证卡｜${retrieval.id}】${retrieval.content}`);
  }
  return sections.join('\n');
}

/** 将静态卡中的声音指纹放入已有 speechStyle 字段，避免重复发送完整角色原始设定。 */
export function buildRoleplaySpeechStyle(characterId: CharacterId): string {
  return formatRoleplaySpeechStyle(characterId);
}

export function validateRoleplayStaticCards(): void {
  const characterIds: CharacterId[] = [
    'soul-0', 'soul-1', 'soul-2', 'soul-3', 'soul-4', 'soul-5', 'soul-6',
    'soul-7', 'soul-8', 'soul-9', 'soul-10', 'soul-11', 'soul-12', 'soul-13',
  ];
  for (const characterId of characterIds) {
    const card = getRoleplayStaticCard(characterId);
    if (card.relationshipAnchors.length > 2) {
      throw new Error(`角色关系锚点超过上限：${characterId}`);
    }
    if (card.canonicalVersion !== '后日谈') {
      throw new Error(`角色静态卡版本不明确：${characterId}`);
    }
  }
}

validateRoleplayStaticCards();
