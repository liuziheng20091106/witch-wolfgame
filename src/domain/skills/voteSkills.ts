import { characterById } from '../catalog/characters';
import type { GameState, LevitationDecision, PendingDecision, PlayerId, SubmittedDecision } from '../model';
import { addPrivateEvent, addPublicEvent } from '../engine/events';
import { getAlivePlayerIds, getPlayer } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, wasOffered } from './types';

function nameOf(state: GameState, playerId: PlayerId): string {
  return characterById[getPlayer(state, playerId).characterId].name;
}

export function getVoteSkillDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'before-vote');
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'levitation'
      && entry.status === 'ready'
      && getPlayer(state, entry.ownerPlayerId).alive
      && !wasOffered(entry, key),
  );
  if (!skill) {
    return null;
  }
  return makeSkillDecision(
    state,
    skill,
    '漂浮',
    '把一名角色移到投票首位/末位，或取得二次平票裁决权。',
    getAlivePlayerIds(state).filter((playerId) => playerId !== skill.ownerPlayerId),
    'levitation',
    { modes: ['move-first', 'move-last', 'tie-break'] },
  );
}

export function applyVoteSkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'levitation' || skill.status !== 'ready') {
    throw new Error('漂浮技能不可用');
  }
  markOffered(skill, offerKey(state, 'before-vote'));
  const levitation = decision as LevitationDecision;
  if (!levitation.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', '你保留了漂浮。', { actorPlayerId: skill.ownerPlayerId });
    return;
  }
  if (!levitation.mode) {
    throw new Error('必须选择漂浮模式');
  }
  if (levitation.mode !== 'tie-break') {
    if (levitation.targetPlayerId === null || !pending.candidates.includes(levitation.targetPlayerId)) {
      throw new Error('漂浮顺序目标不合法');
    }
    skill.data.voteTargetPlayerId = levitation.targetPlayerId;
  }
  skill.data.voteDay = state.day;
  skill.data.voteMode = levitation.mode;
  exhaustSkill(skill);
  const targetText = levitation.targetPlayerId === null ? '' : `，目标为 ${nameOf(state, levitation.targetPlayerId)}`;
  addPublicEvent(state, 'skill', `${nameOf(state, skill.ownerPlayerId)} 使用漂浮：${levitation.mode}${targetText}。`, {
    actorPlayerId: skill.ownerPlayerId,
    targetPlayerIds: levitation.targetPlayerId === null ? [] : [levitation.targetPlayerId],
    data: { mode: levitation.mode },
  });
}

export function getVoteOrder(state: GameState): PlayerId[] {
  const aliveOrder = state.speechOrder.filter((playerId) => getPlayer(state, playerId).alive);
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'levitation' && entry.data.voteDay === state.day,
  );
  const mode = skill?.data.voteMode;
  const target = skill?.data.voteTargetPlayerId;
  if ((mode !== 'move-first' && mode !== 'move-last') || typeof target !== 'number') {
    return aliveOrder;
  }
  const targetId = target as PlayerId;
  const remaining = aliveOrder.filter((playerId) => playerId !== targetId);
  return mode === 'move-first' ? [targetId, ...remaining] : [...remaining, targetId];
}

export function getTieBreaker(state: GameState, tiedPlayerIds: PlayerId[]): PendingDecision | null {
  const skill = state.skillInstances.find(
    (entry) => entry.definitionId === 'levitation'
      && entry.data.voteDay === state.day
      && entry.data.voteMode === 'tie-break'
      && getPlayer(state, entry.ownerPlayerId).alive,
  );
  if (!skill) {
    return null;
  }
  return {
    id: `${state.gameId}-decision-${state.day}-tie-break-${skill.ownerPlayerId}`,
    kind: 'tie-break',
    schemaKey: 'target',
    actorId: skill.ownerPlayerId,
    title: '漂浮裁决',
    description: '二次投票仍平票，请从平票角色中指定放逐者。',
    candidates: tiedPlayerIds,
    allowAbstain: false,
    skillInstanceId: skill.id,
    options: {},
  };
}
