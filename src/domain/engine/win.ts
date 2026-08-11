import type { GameResult, GameState } from '../model';
import { getRoleAssignment } from './selectors';

export function checkWin(state: GameState): GameResult | null {
  const alive = state.players.filter((player) => player.alive);
  const aliveWolves = alive.filter((player) => getRoleAssignment(state, player.id).roleId === 'wolf').length;
  const aliveGood = alive.length - aliveWolves;
  if (aliveWolves === 0) {
    return { winner: 'good', reason: 'wolves-eliminated', finishedDay: state.day };
  }
  if (aliveWolves >= aliveGood) {
    return { winner: 'wolf', reason: 'parity', finishedDay: state.day };
  }
  return null;
}
