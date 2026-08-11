import type { GameCommand, GameState } from '../model';

export function nextCommand(state: GameState): GameCommand | null {
  return state.pendingDecision ? { type: 'decision', decision: state.pendingDecision } : null;
}
