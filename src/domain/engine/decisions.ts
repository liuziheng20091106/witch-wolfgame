import type { GameState, PendingDecision, PlayerId } from '../model';
import { attachBrainwashSuggestion } from '../skills/speechSkills';

function pendingId(state: GameState, kind: string, actorId: PlayerId): string {
  return `${state.gameId}-decision-${state.day}-${state.phase}-${kind}-${actorId}`;
}

export function makeRoleDecision(
  state: GameState,
  kind: PendingDecision['kind'],
  actorId: PlayerId,
  title: string,
  description: string,
  candidates: PlayerId[],
  allowAbstain: boolean,
  schemaKey: PendingDecision['schemaKey'] = 'target',
): PendingDecision {
  const decision: PendingDecision = {
    id: pendingId(state, kind, actorId),
    kind,
    schemaKey,
    actorId,
    title,
    description,
    candidates,
    allowAbstain,
    skillInstanceId: null,
    options: {},
  };
  attachBrainwashSuggestion(state, decision);
  return decision;
}
