import type { GameResult, GameState } from '../model';
import { roleAlignment } from '../catalog/roles';
import { getAlivePlayerIds, getRoleAssignment } from './selectors';

export function checkWin(state: GameState): GameResult | null {
  const alive = getAlivePlayerIds(state);
  const aliveWolves = alive.filter((playerId) => roleAlignment[getRoleAssignment(state, playerId).roleId] === 'wolf').length;
  const aliveNeutral = alive.filter((playerId) => roleAlignment[getRoleAssignment(state, playerId).roleId] === 'neutral').length;
  const aliveGood = alive.length - aliveWolves - aliveNeutral;
  if (aliveWolves === 0) {
    return { winner: 'good', reason: 'wolves-eliminated', finishedDay: state.day };
  }
  if (aliveWolves >= aliveGood) {
    return { winner: 'wolf', reason: 'parity', finishedDay: state.day };
  }
  return null;
}
