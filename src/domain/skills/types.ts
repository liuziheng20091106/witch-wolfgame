import type { GameState, PendingDecision, PlayerId, SubmittedDecision, TargetDecision, WitchSkillInstance } from '../model';

export function makeSkillDecision(
  state: GameState,
  skill: WitchSkillInstance,
  title: string,
  description: string,
  candidates: PlayerId[],
  schemaKey: PendingDecision['schemaKey'],
  options: PendingDecision['options'] = {},
): PendingDecision {
  return {
    id: `${state.gameId}-decision-${state.day}-${state.phase}-${skill.id}`,
    kind: skill.definitionId === 'healing' ? 'healing' : 'skill',
    schemaKey,
    actorId: skill.ownerPlayerId,
    title,
    description,
    candidates,
    allowAbstain: schemaKey !== 'target',
    skillInstanceId: skill.id,
    options,
  };
}

export function offerKey(state: GameState, timing: string): string {
  return `${state.day}:${timing}`;
}

export function wasOffered(skill: WitchSkillInstance, key: string): boolean {
  return skill.data.lastOfferedKey === key;
}

export function markOffered(skill: WitchSkillInstance, key: string): void {
  skill.data.lastOfferedKey = key;
}

export function exhaustSkill(skill: WitchSkillInstance): void {
  skill.status = 'exhausted';
  skill.remainingUses = 0;
}

export function requireTarget(decision: SubmittedDecision, candidates: PlayerId[]): PlayerId {
  const targetPlayerId = (decision as TargetDecision).targetPlayerId;
  if (targetPlayerId === null || !candidates.includes(targetPlayerId)) {
    throw new Error('目标不在当前合法候选中');
  }
  return targetPlayerId;
}
