import { characterById } from '../domain/catalog/characters';
import type { GameState, PendingDecision, PlayerId, SubmittedDecision } from '../domain/model';
import { chooseWithState } from '../domain/engine/random';
import { getPlayer } from '../domain/engine/selectors';

export interface FallbackResult {
  decision: SubmittedDecision;
  rngState: number;
}

function chooseCandidate(state: GameState, pending: PendingDecision, rngState: number): { playerId: PlayerId; rngState: number } {
  let candidates = pending.candidates;
  if (pending.kind === 'vote') {
    const focus = state.skillInstances.find(
      (skill) => skill.definitionId === 'brainwash' && skill.data.activeDay === state.day && typeof skill.data.targetPlayerId === 'number',
    )?.data.targetPlayerId;
    if (typeof focus === 'number' && candidates.includes(focus as PlayerId)) {
      candidates = [...candidates, focus as PlayerId];
    }
  }
  const selected = chooseWithState(candidates, rngState);
  return { playerId: selected.item, rngState: selected.state };
}

function guidedSpeech(state: GameState, actorId: PlayerId, source: string): string {
  const guide = state.skillInstances.find(
    (skill) => skill.definitionId === 'gaze-guidance' && getPlayer(state, skill.ownerPlayerId).alive,
  );
  if (!guide || guide.ownerPlayerId === actorId) {
    return source.slice(0, 100);
  }
  const guideName = characterById[getPlayer(state, guide.ownerPlayerId).characterId].name;
  const suffix = `${guideName}值得继续关注。`;
  if (source.includes(guideName) || source.includes(`${guide.ownerPlayerId + 1}号`)) {
    return source.slice(0, 100);
  }
  return `${source.slice(0, Math.max(0, 100 - suffix.length))}${suffix}`;
}

function fallbackSpeech(state: GameState, pending: PendingDecision, rngState: number): { speech: string; rngState: number } {
  const character = characterById[getPlayer(state, pending.actorId).characterId];
  const selected = chooseWithState(character.examplePhrases, rngState);
  return { speech: guidedSpeech(state, pending.actorId, selected.item), rngState: selected.state };
}

export function fallbackDecision(state: GameState, pending: PendingDecision): FallbackResult {
  if (pending.schemaKey === 'speech') {
    const speech = fallbackSpeech(state, pending, state.rngState);
    return { decision: { speech: speech.speech }, rngState: speech.rngState };
  }
  if (pending.schemaKey === 'witch') {
    const canSave = state.day === 0 && pending.options.canSave === true;
    return { decision: { save: canSave, poisonTargetPlayerId: null }, rngState: state.rngState };
  }
  if (pending.schemaKey === 'ignition') {
    return { decision: { use: true }, rngState: state.rngState };
  }
  if (pending.candidates.length === 0) {
    if (pending.schemaKey === 'liquid-control') return { decision: { use: false, mode: null, targetPlayerId: null, factId: null }, rngState: state.rngState };
    if (pending.schemaKey === 'levitation') return { decision: { use: false, mode: null, targetPlayerId: null }, rngState: state.rngState };
    if (pending.schemaKey === 'voice-mimic') return { decision: { use: false, targetPlayerId: null, forgedSpeech: null }, rngState: state.rngState };
    if (pending.schemaKey === 'optional-target') return { decision: { use: false, targetPlayerId: null }, rngState: state.rngState };
    return { decision: { targetPlayerId: null }, rngState: state.rngState };
  }
  const selected = chooseCandidate(state, pending, state.rngState);
  if (pending.schemaKey === 'liquid-control') {
    return { decision: { use: true, mode: 'extract', targetPlayerId: selected.playerId, factId: null }, rngState: selected.rngState };
  }
  if (pending.schemaKey === 'levitation') {
    return { decision: { use: true, mode: 'move-last', targetPlayerId: selected.playerId }, rngState: selected.rngState };
  }
  if (pending.schemaKey === 'voice-mimic') {
    const generated = fallbackSpeech(state, pending, selected.rngState);
    return {
      decision: { use: true, targetPlayerId: selected.playerId, forgedSpeech: generated.speech },
      rngState: generated.rngState,
    };
  }
  if (pending.schemaKey === 'optional-target') {
    return { decision: { use: true, targetPlayerId: selected.playerId }, rngState: selected.rngState };
  }
  return { decision: { targetPlayerId: selected.playerId }, rngState: selected.rngState };
}
