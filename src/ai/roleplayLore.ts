import { formatRoleplaySpeechStyle, getRoleplayStaticCard } from '../data/roleplay-static';
import { selectRoleplayRetrievalCards } from '../data/roleplay-retrieval';
import type {
  CharacterId,
  GameObservation,
  PendingDecision,
  PlayerId,
  TimelineEvent,
  TimelineEventKind,
} from '../domain/model';

function joinValues(values: readonly string[]): string {
  return values.join('；');
}

function formatRelationships(characterId: CharacterId): string {
  const card = getRoleplayStaticCard(characterId);
  return card.relationshipAnchors
    .map((anchor) => `${anchor.target}（${anchor.relation}：${anchor.behavioralEffect}）`)
    .join('；');
}

function addCharacterId(
  characterIds: Set<CharacterId>,
  characterIdByPlayerId: ReadonlyMap<PlayerId, CharacterId>,
  playerId: PlayerId | null,
): void {
  if (playerId === null) {
    return;
  }
  const characterId = characterIdByPlayerId.get(playerId);
  if (characterId !== undefined) {
    characterIds.add(characterId);
  }
}

function collectEventSignals(
  events: readonly TimelineEvent[],
  characterIdByPlayerId: ReadonlyMap<PlayerId, CharacterId>,
): { characterIds: readonly CharacterId[]; eventKinds: readonly TimelineEventKind[] } {
  const characterIds = new Set<CharacterId>();
  const eventKinds = new Set<TimelineEventKind>();
  for (const event of events) {
    eventKinds.add(event.kind);
    addCharacterId(characterIds, characterIdByPlayerId, event.actorPlayerId);
    addCharacterId(characterIds, characterIdByPlayerId, event.displayAuthorPlayerId);
    addCharacterId(characterIds, characterIdByPlayerId, event.actualAuthorPlayerId);
    for (const targetPlayerId of event.targetPlayerIds) {
      addCharacterId(characterIds, characterIdByPlayerId, targetPlayerId);
    }
  }
  return { characterIds: [...characterIds], eventKinds: [...eventKinds] };
}

function buildRetrievalQuery(
  characterId: CharacterId,
  observation: GameObservation,
  pendingDecision: PendingDecision,
) {
  const actor = observation.players.find((player) => player.id === pendingDecision.actorId);
  if (actor === undefined) {
    throw new Error('动态角色上下文缺少当前行动者');
  }
  const characterIdByPlayerId = new Map<PlayerId, CharacterId>(
    observation.players.map((player) => [player.id, player.characterId]),
  );
  const focusedCharacterIds: CharacterId[] = [];
  if (pendingDecision.options.potionChoice !== true && pendingDecision.candidates.length <= 2) {
    for (const playerId of pendingDecision.candidates) {
      const focusedCharacterId = characterIdByPlayerId.get(playerId);
      if (focusedCharacterId !== undefined) {
        focusedCharacterIds.push(focusedCharacterId);
      }
    }
  }
  const recentEvents = [
    ...observation.publicEvents.slice(-12),
    ...observation.privateEvents.slice(-8),
  ];
  const eventSignals = collectEventSignals(recentEvents, characterIdByPlayerId);
  const currentSpeechCount = observation.publicEvents.filter(
    (event) => event.kind === 'speech' && event.day === observation.day,
  ).length;
  const votesAgainstActor = observation.currentVotes.filter(
    (vote) => vote.targetPlayerId === pendingDecision.actorId,
  ).length;
  return {
    actorCharacterId: characterId,
    actorSkillId: actor.skillId,
    decisionKind: pendingDecision.kind,
    isPostGame: pendingDecision.options.postGame === true,
    focusedCharacterIds,
    recentCharacterIds: eventSignals.characterIds,
    recentEventKinds: eventSignals.eventKinds,
    privateKnowledgeCount: observation.knowledge.filter(
      (fact) => fact.kind === 'role' || fact.kind === 'alignment',
    ).length,
    currentSpeechCount,
    votesAgainstActor,
  };
}

/**
 * 返回当前 actor 的静态人格卡和本轮动态检索片段，不包含来源元数据或本局隐藏状态。
 * 案件片段会明确标记为旧时间线；本局身份、存活与技能仍由观察字段提供。
 */
export function buildRoleplayPersonality(
  characterId: CharacterId,
  observation: GameObservation,
  pendingDecision: PendingDecision,
): string {
  const card = getRoleplayStaticCard(characterId);
  const retrievalCards = selectRoleplayRetrievalCards(
    buildRetrievalQuery(characterId, observation, pendingDecision),
  );
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
  for (const retrievalCard of retrievalCards) {
    sections.push(`【动态上下文｜${retrievalCard.id}】${retrievalCard.content}`);
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
