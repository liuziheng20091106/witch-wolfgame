import type { GameState, PendingDecision, PlayerId } from '../model';
import { getAlivePlayerIds, getRoleAssignment } from './selectors';

function deathSources(state: GameState, playerId: PlayerId): string[] {
  for (const event of state.publicEvents) {
    if (event.kind === 'death' && event.day === state.day && event.targetPlayerIds.includes(playerId)) {
      const sources = event.data.sources;
      if (Array.isArray(sources)) {
        return sources.filter((value): value is string => typeof value === 'string');
      }
      return [];
    }
  }
  return [];
}

interface ShotEligibility {
  kind: 'hunter-shot' | 'wolf-king-shot';
}

function canHunterShoot(sources: string[]): boolean {
  if (sources.length === 0) {
    return true;
  }
  if (sources.includes('poison') || sources.includes('precise-kill')) {
    return false;
  }
  return sources.length === 1 && sources[0] === 'wolf';
}

function shotEligibility(state: GameState, playerId: PlayerId): ShotEligibility | null {
  const assignment = getRoleAssignment(state, playerId);
  const sources = deathSources(state, playerId);
  if (assignment.roleId === 'hunter' && assignment.resources.hunterShot === 1) {
    if (canHunterShoot(sources)) {
      return { kind: 'hunter-shot' };
    }
  }
  if (assignment.roleId === 'wolf-king' && assignment.resources.wolfKingShot === 1) {
    if (sources.length === 0) {
      return { kind: 'wolf-king-shot' };
    }
  }
  return null;
}

export function getNextShotDecision(state: GameState): PendingDecision | null {
  const deaths = state.publicEvents.filter((event) => event.kind === 'death' && event.day === state.day);
  for (const death of deaths) {
    for (const deadId of death.targetPlayerIds) {
      const eligibility = shotEligibility(state, deadId);
      if (!eligibility) {
        continue;
      }
      const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== deadId);
      if (candidates.length === 0) {
        return null;
      }
      let title = '白狼王的獠牙';
      let description = '你已被放逐。发动白狼王的獠牙，带走一名其他存活者吗？（可选择弃权）';
      if (eligibility.kind === 'hunter-shot') {
        title = '猎人之枪';
        description = '你已死亡。发动猎人之枪，带走一名其他存活者吗？（可选择弃枪）';
      }
      return {
        id: `${state.gameId}-decision-${state.day}-${eligibility.kind}-${deadId}`,
        kind: eligibility.kind,
        schemaKey: 'target',
        actorId: deadId,
        title,
        description,
        candidates,
        allowAbstain: true,
        skillInstanceId: null,
        options: {},
      };
    }
  }
  return null;
}
