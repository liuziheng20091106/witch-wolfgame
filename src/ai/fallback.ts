import { SPEECH_MAX_LENGTH, VOICE_MIMIC_MAX_LENGTH } from '../../shared/gamePromptContract.js';
import { characterById } from '../domain/catalog/characters';
import { roleAlignment } from '../domain/catalog/roles';
import type { GameState, PendingDecision, PlayerId, RoleId, SubmittedDecision } from '../domain/model';
import { chooseWithState } from '../domain/engine/random';
import { getName, getPlayer } from '../domain/engine/selectors';
import { gazeRequiredMention } from '../domain/skills/speechSkills';

export interface FallbackResult {
  decision: SubmittedDecision;
  rngState: number;
}

export interface FallbackTemplate {
  witchPoisonDay: number;
}

export const DEFAULT_FALLBACK_TEMPLATE: FallbackTemplate = {
  witchPoisonDay: 2,
};

function chooseCandidate(pending: PendingDecision, rngState: number): { playerId: PlayerId; rngState: number } {
  const selected = chooseWithState(pending.candidates, rngState);
  return { playerId: selected.item, rngState: selected.state };
}

function actorRoleId(state: GameState, playerId: PlayerId): RoleId | null {
  return state.roleAssignments.find((assignment) => assignment.ownerPlayerId === playerId)?.roleId ?? null;
}

function isWolfFaction(state: GameState, playerId: PlayerId): boolean {
  const roleId = actorRoleId(state, playerId);
  return roleId !== null && roleAlignment[roleId] === 'wolf';
}

function knownWolfTargets(state: GameState, actorId: PlayerId): PlayerId[] {
  const facts = state.knowledgeByPlayer[actorId] ?? [];
  const targets: PlayerId[] = [];
  for (const fact of facts) {
    if (fact.kind !== 'role' || fact.subjectPlayerId === actorId) {
      continue;
    }
    const roleId = fact.value as RoleId;
    if (roleAlignment[roleId] === 'wolf' && !targets.includes(fact.subjectPlayerId)) {
      targets.push(fact.subjectPlayerId);
    }
  }
  return targets;
}

function guidedSpeech(state: GameState, actorId: PlayerId, source: string): string {
  const mention = gazeRequiredMention(state, actorId);
  if (!mention) {
    return source.slice(0, SPEECH_MAX_LENGTH);
  }
  const suffix = `${mention.requiredMention}值得继续关注。`;
  if (source.includes(mention.requiredMention) || source.includes(mention.requiredSeatLabel)) {
    return source.slice(0, SPEECH_MAX_LENGTH);
  }
  return `${source.slice(0, Math.max(0, SPEECH_MAX_LENGTH - suffix.length))}${suffix}`;
}

function fallbackSpeech(state: GameState, speakerId: PlayerId, pending: PendingDecision, rngState: number): { speech: string; rngState: number } {
  const character = characterById[getPlayer(state, speakerId).characterId];
  const selected = chooseWithState(character.examplePhrases, rngState);
  if (pending.options.lastWords === true) {
    return { speech: selected.item.slice(0, SPEECH_MAX_LENGTH), rngState: selected.state };
  }
  if (pending.options.postGame === true) {
    return { speech: '对局结束了，我想再重新审视一遍今天每个人的选择。', rngState: selected.state };
  }
  return { speech: guidedSpeech(state, pending.actorId, selected.item), rngState: selected.state };
}

export function fallbackDecision(state: GameState, pending: PendingDecision, template: FallbackTemplate = DEFAULT_FALLBACK_TEMPLATE): FallbackResult {
  if (pending.schemaKey === 'speech') {
    const speech = fallbackSpeech(state, pending.actorId, pending, state.rngState);
    return { decision: { speech: speech.speech }, rngState: speech.rngState };
  }
  if (pending.schemaKey === 'wolf-council') {
    const selected = chooseCandidate(pending, state.rngState);
    const targetName = getName(state, selected.playerId);
    return {
      decision: {
        message: `我建议袭击${targetName}。她仍在场，优先削弱好人的发言与投票空间更稳妥。`,
        recommendedTargetPlayerId: selected.playerId,
      },
      rngState: selected.rngState,
    };
  }
  if (pending.schemaKey === 'witch') {
    const canSave = state.day === 0 && pending.options.canSave === true;
    let rng = state.rngState;
    let poisonTargetPlayerId: PlayerId | null = null;
    if (pending.options.canPoison === true && state.day >= template.witchPoisonDay) {
      let pool = pending.candidates;
      const attacked = typeof pending.options.attackedPlayerId === 'number' ? pending.options.attackedPlayerId as PlayerId : null;
      if (canSave && attacked !== null) {
        pool = pool.filter((playerId) => playerId !== attacked);
      }
      if (pool.length > 0) {
        const chosen = chooseWithState(pool, rng);
        rng = chosen.state;
        poisonTargetPlayerId = chosen.item;
      }
    }
    return { decision: { save: canSave, poisonTargetPlayerId }, rngState: rng };
  }
  if (pending.schemaKey === 'ignition') {
    return { decision: { use: true }, rngState: state.rngState };
  }
  if (pending.title === '视线诱导') {
    if (pending.schemaKey === 'optional-target' && pending.candidates.length > 0) {
      const selected = chooseCandidate(pending, state.rngState);
      return { decision: { use: true, targetPlayerId: selected.playerId }, rngState: selected.rngState };
    }
    return { decision: { use: false, targetPlayerId: null }, rngState: state.rngState };
  }
  if (pending.title === '视线诱导-目标' && pending.candidates.length > 0) {
    if (pending.candidates.includes(pending.actorId)) {
      return { decision: { targetPlayerId: pending.actorId }, rngState: state.rngState };
    }
    const selected = chooseCandidate(pending, state.rngState);
    return { decision: { targetPlayerId: selected.playerId }, rngState: selected.rngState };
  }
  if (pending.candidates.length === 0) {
    if (pending.schemaKey === 'liquid-control') return { decision: { use: false, mode: null, targetPlayerId: null, factId: null }, rngState: state.rngState };
    if (pending.schemaKey === 'levitation') return { decision: { use: false, mode: null, targetPlayerId: null }, rngState: state.rngState };
    if (pending.schemaKey === 'voice-mimic') return { decision: { use: false, targetPlayerId: null, forgedSpeech: null }, rngState: state.rngState };
    if (pending.schemaKey === 'optional-target') return { decision: { use: false, targetPlayerId: null }, rngState: state.rngState };
    return { decision: { targetPlayerId: null }, rngState: state.rngState };
  }
  if (pending.schemaKey === 'target' && (pending.kind === 'vote' || pending.kind === 'runoff')) {
    if (isWolfFaction(state, pending.actorId)) {
      const pool = pending.candidates.filter((playerId) => !isWolfFaction(state, playerId));
      let picked: { playerId: PlayerId; rngState: number };
      if (pool.length > 0) {
        picked = chooseCandidate({ ...pending, candidates: pool }, state.rngState);
      } else {
        picked = chooseCandidate(pending, state.rngState);
      }
      return { decision: { targetPlayerId: picked.playerId }, rngState: picked.rngState };
    }
    const confirmed = knownWolfTargets(state, pending.actorId).filter((playerId) => pending.candidates.includes(playerId));
    const confirmedTarget = confirmed[0];
    if (confirmedTarget !== undefined) {
      return { decision: { targetPlayerId: confirmedTarget }, rngState: state.rngState };
    }
    const picked = chooseCandidate(pending, state.rngState);
    return { decision: { targetPlayerId: picked.playerId }, rngState: picked.rngState };
  }
  if (pending.schemaKey === 'target' && (pending.kind === 'hunter-shot' || pending.kind === 'wolf-king-shot')) {
    if (pending.kind === 'hunter-shot') {
      const confirmed = knownWolfTargets(state, pending.actorId).filter((playerId) => pending.candidates.includes(playerId));
      const confirmedTarget = confirmed[0];
      if (confirmedTarget !== undefined) {
        return { decision: { targetPlayerId: confirmedTarget }, rngState: state.rngState };
      }
      return { decision: { targetPlayerId: null }, rngState: state.rngState };
    }
    const pool = pending.candidates.filter((playerId) => !isWolfFaction(state, playerId));
    let picked: { playerId: PlayerId; rngState: number };
    if (pool.length > 0) {
      picked = chooseCandidate({ ...pending, candidates: pool }, state.rngState);
    } else {
      picked = chooseCandidate(pending, state.rngState);
    }
    return { decision: { targetPlayerId: picked.playerId }, rngState: picked.rngState };
  }
  const selected = chooseCandidate(pending, state.rngState);
  if (pending.schemaKey === 'liquid-control') {
    return { decision: { use: true, mode: 'extract', targetPlayerId: selected.playerId, factId: null }, rngState: selected.rngState };
  }
  if (pending.schemaKey === 'levitation') {
    return { decision: { use: true, mode: 'move-last', targetPlayerId: selected.playerId }, rngState: selected.rngState };
  }
  if (pending.schemaKey === 'voice-mimic') {
    const generated = fallbackSpeech(state, selected.playerId, pending, selected.rngState);
    const forgedSpeech = generated.speech.slice(0, VOICE_MIMIC_MAX_LENGTH);
    return {
      decision: { use: true, targetPlayerId: selected.playerId, forgedSpeech },
      rngState: generated.rngState,
    };
  }
  if (pending.schemaKey === 'optional-target') {
    return { decision: { use: true, targetPlayerId: selected.playerId }, rngState: selected.rngState };
  }
  return { decision: { targetPlayerId: selected.playerId }, rngState: selected.rngState };
}

