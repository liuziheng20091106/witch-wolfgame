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

/** 本地策略模板：修正结构性自损行为；语义层表现由真实 AI 与真人数据校准。 */
export interface FallbackTemplate {
  /** 女巫最早可下毒的白天号，默认 2（第 3 个白天起）。 */
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

/** 该玩家当前是否狼阵营（狼队互知）。 */
function isWolfFaction(state: GameState, playerId: PlayerId): boolean {
  const roleId = actorRoleId(state, playerId);
  return roleId !== null && roleAlignment[roleId] === 'wolf';
}

/** 玩家自己已确认的狼目标（含白狼王/隐狼）。 */
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
  // 视线诱导为主动技：仅被诱导者的发言必须提及诱导对象（复用引擎侧的同一判定）
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
  // 遗言不受视线诱导约束（死者没有视线），直接截断使用例句
  if (pending.options.lastWords === true) {
    return { speech: selected.item.slice(0, SPEECH_MAX_LENGTH), rngState: selected.state };
  }
  // 赛后复盘：本地策略给出简短复盘总结（不套用视线诱导）
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
    // 毒药延后至 template.witchPoisonDay 才可用：前几日无可靠依据随机下毒会毒杀好人（结构性自损）
    if (pending.options.canPoison === true && state.day >= template.witchPoisonDay) {
      // 候选已排除自己；若本夜救人，排除被救的袭击目标
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
  // 视线诱导（主动技，两步）：第一步选被诱导者（随机非自己）；第二步选诱导对象
  if (pending.title === '视线诱导') {
    if (pending.schemaKey === 'optional-target' && pending.candidates.length > 0) {
      const selected = chooseCandidate(pending, state.rngState);
      return { decision: { use: true, targetPlayerId: selected.playerId }, rngState: selected.rngState };
    }
    return { decision: { use: false, targetPlayerId: null }, rngState: state.rngState };
  }
  if (pending.title === '视线诱导-目标' && pending.candidates.length > 0) {
    // 人设：内心渴望被人注视，本地策略倾向把诱导对象指向自己（若自己仍存活）
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
  // 狼人不投队友；好人优先投已确认的狼。
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
  // 死亡反击启发：猎人无确认狼目标时弃枪（防自损）；白狼王被放逐必带走一名非狼队友（狼队互知）
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
    // 伪造发言使用被模仿者例句，并限制在契约上限内。
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
