import type {
  GamePhase,
  GameState,
  JsonValue,
  KnowledgeFact,
  PlayerId,
  PrivateTimelineEvent,
  TimelineEvent,
  TimelineEventKind,
} from '../model';

interface EventOptions {
  actorPlayerId?: PlayerId | null;
  targetPlayerIds?: PlayerId[];
  displayAuthorPlayerId?: PlayerId | null;
  actualAuthorPlayerId?: PlayerId | null;
  data?: Record<string, JsonValue>;
  phase?: GamePhase;
}

function buildEvent(state: GameState, kind: TimelineEventKind, text: string, options: EventOptions): TimelineEvent {
  const serial = state.publicEvents.length + state.privateEvents.length + state.archivedTimelines.length * 1000;
  return {
    id: `${state.gameId}-event-${state.day}-${serial}`,
    kind,
    day: state.day,
    phase: options.phase ?? state.phase,
    text,
    actorPlayerId: options.actorPlayerId ?? null,
    targetPlayerIds: options.targetPlayerIds ?? [],
    displayAuthorPlayerId: options.displayAuthorPlayerId ?? null,
    actualAuthorPlayerId: options.actualAuthorPlayerId ?? null,
    data: options.data ?? {},
  };
}

export function addPublicEvent(state: GameState, kind: TimelineEventKind, text: string, options: EventOptions = {}): TimelineEvent {
  const event = buildEvent(state, kind, text, options);
  state.publicEvents.push(event);
  return event;
}

export function addPrivateEvent(
  state: GameState,
  viewerPlayerIds: PlayerId[],
  kind: TimelineEventKind,
  text: string,
  options: EventOptions = {},
): PrivateTimelineEvent {
  const event = { ...buildEvent(state, kind, text, options), viewerPlayerIds };
  state.privateEvents.push(event);
  return event;
}

function nextKnowledgeFactId(state: GameState, ownerPlayerId: PlayerId): string {
  const facts = state.knowledgeByPlayer[ownerPlayerId];
  const usedIds = new Set(facts.map((fact) => fact.id));
  let serial = facts.length;
  let id = `${state.gameId}-fact-${ownerPlayerId}-${serial}`;
  while (usedIds.has(id)) {
    serial += 1;
    id = `${state.gameId}-fact-${ownerPlayerId}-${serial}`;
  }
  return id;
}

export function addKnowledge(
  state: GameState,
  ownerPlayerId: PlayerId,
  fact: Omit<KnowledgeFact, 'id' | 'sourceEventId'>,
  sourceEventId: string,
): KnowledgeFact {
  const existing = state.knowledgeByPlayer[ownerPlayerId].find(
    (entry) => entry.subjectPlayerId === fact.subjectPlayerId && entry.kind === fact.kind && entry.value === fact.value,
  );
  if (existing) {
    return existing;
  }
  const knowledge: KnowledgeFact = {
    ...fact,
    id: nextKnowledgeFactId(state, ownerPlayerId),
    sourceEventId,
  };
  state.knowledgeByPlayer[ownerPlayerId].push(knowledge);
  return knowledge;
}
