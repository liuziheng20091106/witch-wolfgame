import type { GamePhase } from '../domain/model';
import type { ThemePreference } from '../storage/browserStorage';

export type ResolvedTheme = 'light' | 'dark';

const nightPhases = new Set<GamePhase>([
  'first-night',
  'night-skills',
  'wolf-suggestions',
  'wolf-decision',
  'witch-action',
  'seer-action',
  'night-protection',
  'night-resolution',
]);

export function isNightPhase(phase: GamePhase | null | undefined): boolean {
  return phase !== undefined && phase !== null && nightPhases.has(phase);
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
  judgmentMode: boolean,
  phase: GamePhase | null | undefined,
): ResolvedTheme {
  if (judgmentMode && phase !== null && phase !== undefined) {
    return isNightPhase(phase) ? 'dark' : 'light';
  }
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}
