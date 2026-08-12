import { characterById } from '../catalog/characters';
import { roleNames } from '../catalog/roles';
import type {
  GameEvent,
  GameState,
  PendingDecision,
  PlayerId,
  SpeechDecision,
  SubmittedDecision,
  TargetDecision,
  VoteRecord,
  WitchDecision,
} from '../model';
import {
  applyNightSkillDecision,
  applySpeechSkillDecision,
  applyVoteSkillDecision,
  getAfterSpeechSkillDecision,
  getBeforeSpeechSkillDecision,
  getHealingDecision,
  getNextDayStartSkillDecision,
  getNextNightSkillDecision,
  getTieBreaker,
  getVoteOrder,
  getVoteSkillDecision,
  isRestrainedToday,
  publishSpeech,
} from '../skills/registry';
import { addKnowledge, addPrivateEvent, addPublicEvent } from './events';
import { refreshMorningCheckpoint, resolveDeathBatch, resolveNight } from './night';
import { getAlivePlayerIds, getPlayer, getRoleAssignment, getSkillInstance } from './selectors';
import { resolveVotes } from './vote';

function nameOf(state: GameState, playerId: PlayerId): string {
  return characterById[getPlayer(state, playerId).characterId].name;
}

function pendingId(state: GameState, kind: string, actorId: PlayerId): string {
  return `${state.gameId}-decision-${state.day}-${state.phase}-${kind}-${actorId}`;
}

function hasPrivateAction(state: GameState, kind: string, actorId: PlayerId): boolean {
  return state.privateEvents.some(
    (event) => event.day === state.day && event.actorPlayerId === actorId && event.data.actionKind === kind,
  );
}

function makeRoleDecision(
  state: GameState,
  kind: PendingDecision['kind'],
  actorId: PlayerId,
  title: string,
  description: string,
  candidates: PlayerId[],
  allowAbstain: boolean,
  schemaKey: PendingDecision['schemaKey'] = 'target',
): PendingDecision {
  return {
    id: pendingId(state, kind, actorId),
    kind,
    schemaKey,
    actorId,
    title,
    description,
    candidates,
    allowAbstain,
    skillInstanceId: null,
    options: {},
  };
}

function livingWolves(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'wolf');
}

function wolfTargets(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId !== 'wolf');
}

function advanceNightSkills(state: GameState): GameState {
  const pending = getNextNightSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'wolf-suggestions';
  }
  return state;
}

function advanceWolfSuggestions(state: GameState): GameState {
  const wolves = livingWolves(state);
  if (wolves.length <= 1) {
    state.phase = 'wolf-decision';
    return state;
  }
  const actorId = wolves.find((playerId) => !hasPrivateAction(state, 'wolf-suggestion', playerId));
  if (actorId !== undefined) {
    state.pendingDecision = makeRoleDecision(state, 'wolf-suggestion', actorId, '狼人密议', '私下建议一名非狼人目标。', wolfTargets(state), false);
  } else {
    state.phase = 'wolf-decision';
  }
  return state;
}

function advanceWolfDecision(state: GameState): GameState {
  const wolves = livingWolves(state);
  const actorId = wolves[0];
  if (actorId === undefined) {
    state.phase = 'night-resolution';
    return state;
  }
  if (!hasPrivateAction(state, 'wolf-decision', actorId)) {
    const suggestions = state.privateEvents
      .filter((event) => event.day === state.day && event.data.actionKind === 'wolf-suggestion')
      .map((event) => event.data.targetPlayerId)
      .filter((value): value is PlayerId => typeof value === 'number');
    state.pendingDecision = makeRoleDecision(
      state,
      'wolf-decision',
      actorId,
      '狼人最终袭击',
      suggestions.length > 0 ? `队友建议座位：${suggestions.map((id) => id + 1).join('、')}。确认本夜目标。` : '选择本夜袭击目标。',
      wolfTargets(state),
      false,
    );
  } else {
    state.phase = 'witch-action';
  }
  return state;
}

function advanceWitch(state: GameState): GameState {
  const witch = getAlivePlayerIds(state).find((playerId) => getRoleAssignment(state, playerId).roleId === 'witch');
  if (witch === undefined || hasPrivateAction(state, 'witch-action', witch)) {
    state.phase = 'seer-action';
    return state;
  }
  const resources = getRoleAssignment(state, witch).resources;
  if (resources.antidote !== 1 && resources.poison !== 1) {
    state.phase = 'seer-action';
    return state;
  }
  const attack = state.privateEvents.findLast(
    (event) => event.day === state.day && event.data.actionKind === 'wolf-decision',
  );
  const attackedPlayerId = typeof attack?.data.targetPlayerId === 'number' ? attack.data.targetPlayerId as PlayerId : null;
  state.pendingDecision = {
    ...makeRoleDecision(state, 'witch-action', witch, '女巫行动', attackedPlayerId === null ? '今晚没有可见的狼刀。' : `${nameOf(state, attackedPlayerId)} 遭到狼刀。可使用解药，并可对另一人用毒。`, getAlivePlayerIds(state).filter((playerId) => playerId !== witch), true, 'witch'),
    options: {
      attackedPlayerId,
      canSave: resources.antidote === 1 && attackedPlayerId !== null,
      canPoison: resources.poison === 1,
    },
  };
  return state;
}

function advanceSeer(state: GameState): GameState {
  const seer = getAlivePlayerIds(state).find((playerId) => getRoleAssignment(state, playerId).roleId === 'seer');
  if (seer === undefined || hasPrivateAction(state, 'seer-action', seer)) {
    state.phase = 'night-protection';
    return state;
  }
  state.pendingDecision = makeRoleDecision(state, 'seer-action', seer, '预言家查验', '选择一名其他存活者，私下获知其当前职业。', getAlivePlayerIds(state).filter((playerId) => playerId !== seer), false);
  return state;
}

function advanceProtection(state: GameState): GameState {
  const pending = getHealingDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'night-resolution';
  }
  return state;
}

function advanceDawn(state: GameState): GameState {
  state.day += 1;
  addPublicEvent(state, 'dawn', `第 ${state.day} 天，审判庭重新亮起。`);
  state.phase = 'day-skills';
  return state;
}

function advanceDaySkills(state: GameState): GameState {
  const pending = getNextDayStartSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'speeches';
    refreshMorningCheckpoint(state);
  }
  return state;
}

function spokenToday(state: GameState): PlayerId[] {
  return state.publicEvents
    .filter((event) => event.day === state.day && (event.kind === 'speech' || event.kind === 'restrained'))
    .map((event) => event.targetPlayerIds[0] ?? event.actorPlayerId)
    .filter((value): value is PlayerId => value !== null);
}

function advanceSpeeches(state: GameState): GameState {
  const daySpeechEvents = state.publicEvents.filter((event) => event.day === state.day && event.kind === 'speech');
  const lastSpeech = daySpeechEvents.at(-1);
  if (lastSpeech?.actorPlayerId !== null && lastSpeech?.actorPlayerId !== undefined) {
    const afterDecision = getAfterSpeechSkillDecision(state, lastSpeech.actorPlayerId);
    if (afterDecision) {
      state.pendingDecision = afterDecision;
      return state;
    }
  }
  const spoken = spokenToday(state);
  const actorId = state.speechOrder.find((playerId) => getPlayer(state, playerId).alive && !spoken.includes(playerId));
  if (actorId === undefined) {
    state.phase = 'vote-skills';
    return state;
  }
  const beforeDecision = getBeforeSpeechSkillDecision(state, actorId);
  if (beforeDecision) {
    state.pendingDecision = beforeDecision;
    return state;
  }
  if (isRestrainedToday(state, actorId)) {
    addPublicEvent(state, 'restrained', `${nameOf(state, actorId)} 受到限制，无法发言。`, {
      actorPlayerId: actorId,
      targetPlayerIds: [actorId],
      displayAuthorPlayerId: actorId,
      actualAuthorPlayerId: actorId,
    });
    return state;
  }
  const speechDecision = makeRoleDecision(state, 'speech', actorId, `${nameOf(state, actorId)} 发言`, '公开发言不超过 100 字，也可以保持沉默。', [], true, 'speech');
  const guide = state.skillInstances.find(
    (skill) => skill.definitionId === 'gaze-guidance' && getPlayer(state, skill.ownerPlayerId).alive,
  );
  if (guide && guide.ownerPlayerId !== actorId) {
    speechDecision.options = {
      requiredMention: nameOf(state, guide.ownerPlayerId),
      requiredSeatLabel: `${guide.ownerPlayerId + 1}号`,
    };
  }
  state.pendingDecision = speechDecision;
  return state;
}

function advanceVoteSkills(state: GameState): GameState {
  const pending = getVoteSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.currentVotes = [];
    state.phase = 'voting';
  }
  return state;
}

function addExileIntent(state: GameState, playerId: PlayerId): void {
  addPublicEvent(state, 'exile', `${nameOf(state, playerId)} 被审判庭选为放逐对象。`, {
    targetPlayerIds: [playerId],
    data: { exileTargetPlayerId: playerId },
  });
}

function votingPending(state: GameState, round: 1 | 2, candidates: PlayerId[] | null): PendingDecision | null {
  const order = getVoteOrder(state);
  const voter = order.find((playerId) => !state.currentVotes.some((vote) => vote.round === round && vote.voterPlayerId === playerId));
  if (voter === undefined) {
    return null;
  }
  const targets = (candidates ?? getAlivePlayerIds(state)).filter((playerId) => playerId !== voter);
  if (targets.length === 0) {
    state.currentVotes.push({ voterPlayerId: voter, targetPlayerId: null, round });
    return votingPending(state, round, candidates);
  }
  return makeRoleDecision(state, round === 1 ? 'vote' : 'runoff', voter, round === 1 ? '公开投票' : '平票重投', '选择一名候选，当前票会立即公开。', targets, round === 1);
}

function advanceVoting(state: GameState): GameState {
  const pending = votingPending(state, 1, null);
  if (pending) {
    state.pendingDecision = pending;
    return state;
  }
  const resolution = resolveVotes(state.currentVotes, 1);
  if (resolution.outcome === 'runoff') {
    addPublicEvent(state, 'vote', `最高票并列：${resolution.tiedPlayerIds.map((id) => nameOf(state, id)).join('、')}，进行一次重投。`, {
      targetPlayerIds: resolution.tiedPlayerIds,
      data: { tiedPlayerIds: resolution.tiedPlayerIds },
    });
    state.phase = 'runoff';
  } else {
    if (resolution.outcome === 'exile' && resolution.targetPlayerId !== null) {
      addExileIntent(state, resolution.targetPlayerId);
    } else {
      addPublicEvent(state, 'vote', '本轮弃权占优或无人得票，没有人被放逐。');
    }
    state.phase = 'day-resolution';
  }
  return state;
}

function latestRunoffCandidates(state: GameState): PlayerId[] {
  const event = state.publicEvents.findLast(
    (entry) => entry.day === state.day && Array.isArray(entry.data.tiedPlayerIds),
  );
  return Array.isArray(event?.data.tiedPlayerIds)
    ? event.data.tiedPlayerIds.filter((value): value is PlayerId => typeof value === 'number')
    : [];
}

function advanceRunoff(state: GameState): GameState {
  const candidates = latestRunoffCandidates(state);
  const pending = votingPending(state, 2, candidates);
  if (pending) {
    state.pendingDecision = pending;
    return state;
  }
  const resolution = resolveVotes(state.currentVotes, 2);
  if (resolution.outcome === 'exile' && resolution.targetPlayerId !== null) {
    addExileIntent(state, resolution.targetPlayerId);
    state.phase = 'day-resolution';
    return state;
  }
  const tieBreaker = getTieBreaker(state, resolution.tiedPlayerIds);
  if (tieBreaker) {
    state.pendingDecision = tieBreaker;
  } else {
    addPublicEvent(state, 'vote', '重投后仍然平票，本日无人出局。');
    state.phase = 'day-resolution';
  }
  return state;
}

function advanceDayResolution(state: GameState): GameState {
  const exile = state.publicEvents.findLast(
    (event) => event.day === state.day && typeof event.data.exileTargetPlayerId === 'number',
  );
  if (typeof exile?.data.exileTargetPlayerId === 'number') {
    const targetPlayerId = exile.data.exileTargetPlayerId as PlayerId;
    if (getPlayer(state, targetPlayerId).alive) {
      const resolved = resolveDeathBatch(state, [{ playerId: targetPlayerId, sources: [] }]);
      if (resolved !== state || resolved.phase === 'ended') {
        return resolved;
      }
    }
  }
  for (const skill of state.skillInstances) {
    if (skill.definitionId === 'brainwash' && skill.data.activeDay === state.day) {
      delete skill.data.activeDay;
      delete skill.data.targetPlayerId;
    }
  }
  state.currentVotes = [];
  state.phase = 'night-skills';
  addPublicEvent(state, 'system', `第 ${state.day} 天结束，夜幕降临。`);
  return state;
}

function advance(state: GameState): GameState {
  if (state.pendingDecision || state.phase === 'ended') {
    return state;
  }
  switch (state.phase) {
    case 'first-night': state.phase = 'night-skills'; return state;
    case 'night-skills': return advanceNightSkills(state);
    case 'wolf-suggestions': return advanceWolfSuggestions(state);
    case 'wolf-decision': return advanceWolfDecision(state);
    case 'witch-action': return advanceWitch(state);
    case 'seer-action': return advanceSeer(state);
    case 'night-protection': return advanceProtection(state);
    case 'night-resolution': return resolveNight(state);
    case 'dawn': return advanceDawn(state);
    case 'day-skills': return advanceDaySkills(state);
    case 'speeches': return advanceSpeeches(state);
    case 'vote-skills': return advanceVoteSkills(state);
    case 'voting': return advanceVoting(state);
    case 'runoff': return advanceRunoff(state);
    case 'day-resolution': return advanceDayResolution(state);
  }
}

function validateTarget(state: GameState, decision: SubmittedDecision, pending: PendingDecision): PlayerId | null {
  const targetPlayerId = (decision as TargetDecision).targetPlayerId;
  if (targetPlayerId === null) {
    if (!pending.allowAbstain) {
      throw new Error('当前行动不允许弃权');
    }
    return null;
  }
  if (!pending.candidates.includes(targetPlayerId) || !getPlayer(state, targetPlayerId).alive) {
    throw new Error('目标不在当前合法候选中');
  }
  return targetPlayerId;
}


function applyRoleDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): GameState {
  if (pending.kind === 'speech') {
    publishSpeech(state, pending.actorId, decision as SpeechDecision);
    return state;
  }
  if (pending.kind === 'witch-action') {
    const witchDecision = decision as WitchDecision;
    const assignment = getRoleAssignment(state, pending.actorId);
    const attacked = typeof pending.options.attackedPlayerId === 'number' ? pending.options.attackedPlayerId as PlayerId : null;
    if (witchDecision.save) {
      if (assignment.resources.antidote !== 1 || attacked === null) {
        throw new Error('当前无法使用解药');
      }
      assignment.resources.antidote = 0;
      addPrivateEvent(state, [pending.actorId], 'witch-action', `你使用解药救下 ${nameOf(state, attacked)}。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [attacked],
        data: { actionKind: 'witch-save', savedWolfTargetPlayerId: attacked },
      });
    }
    if (witchDecision.poisonTargetPlayerId !== null) {
      const poisonTarget = witchDecision.poisonTargetPlayerId;
      if (assignment.resources.poison !== 1 || !pending.candidates.includes(poisonTarget) || poisonTarget === pending.actorId || (witchDecision.save && poisonTarget === attacked)) {
        throw new Error('毒药目标不合法');
      }
      assignment.resources.poison = 0;
      addPrivateEvent(state, [pending.actorId], 'witch-action', `你对 ${nameOf(state, poisonTarget)} 使用毒药。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [poisonTarget],
        data: { intentSource: 'poison', preventable: true, targetPlayerId: poisonTarget },
      });
    }
    addPrivateEvent(state, [pending.actorId], 'witch-action', '女巫行动已提交。', {
      actorPlayerId: pending.actorId,
      data: { actionKind: 'witch-action' },
    });
    return state;
  }
  const targetPlayerId = validateTarget(state, decision, pending);
  if (pending.kind === 'wolf-suggestion') {
    addPrivateEvent(state, livingWolves(state), 'wolf-suggestion', `${nameOf(state, pending.actorId)} 建议袭击 ${nameOf(state, targetPlayerId as PlayerId)}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: [targetPlayerId as PlayerId],
      data: { actionKind: 'wolf-suggestion', targetPlayerId: targetPlayerId as PlayerId },
    });
  } else if (pending.kind === 'wolf-decision') {
    addPrivateEvent(state, livingWolves(state), 'wolf-attack', `狼队决定袭击 ${nameOf(state, targetPlayerId as PlayerId)}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: [targetPlayerId as PlayerId],
      data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: targetPlayerId as PlayerId },
    });
  } else if (pending.kind === 'seer-action') {
    const roleId = getRoleAssignment(state, targetPlayerId as PlayerId).roleId;
    const event = addPrivateEvent(state, [pending.actorId], 'seer-check', `${nameOf(state, targetPlayerId as PlayerId)} 的当前职业是${roleNames[roleId]}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: [targetPlayerId as PlayerId],
      data: { actionKind: 'seer-action' },
    });
    addKnowledge(state, pending.actorId, { subjectPlayerId: targetPlayerId as PlayerId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
  } else if (pending.kind === 'vote' || pending.kind === 'runoff') {
    const round: VoteRecord['round'] = pending.kind === 'vote' ? 1 : 2;
    state.currentVotes.push({ voterPlayerId: pending.actorId, targetPlayerId, round });
    addPublicEvent(state, 'vote', `${nameOf(state, pending.actorId)} ${targetPlayerId === null ? '选择弃权' : `投给 ${nameOf(state, targetPlayerId)}`}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: targetPlayerId === null ? [] : [targetPlayerId],
      data: { round, targetPlayerId },
    });
  } else if (pending.kind === 'tie-break') {
    addExileIntent(state, targetPlayerId as PlayerId);
    state.phase = 'day-resolution';
  }
  return state;
}

function applyDecision(state: GameState, event: Extract<GameEvent, { type: 'submit-decision' }>): GameState {
  const pending = state.pendingDecision;
  if (!pending || pending.id !== event.pendingDecisionId || pending.actorId !== event.actorId) {
    throw new Error('待处理决策已过期');
  }
  state.pendingDecision = null;
  if (pending.skillInstanceId) {
    if (pending.kind === 'tie-break') {
      return applyRoleDecision(state, pending, event.decision);
    }
    const skill = getSkillInstance(state, pending.actorId);
    if (!skill || skill.id !== pending.skillInstanceId) {
      throw new Error('待处理技能已移动或失效');
    }
    if (skill.definitionId === 'levitation') {
      applyVoteSkillDecision(state, pending, event.decision);
    } else if (skill.definitionId === 'speech-restrain' || skill.definitionId === 'ignition' || skill.definitionId === 'brainwash' || skill.definitionId === 'voice-mimic') {
      applySpeechSkillDecision(state, pending, event.decision);
    } else {
      applyNightSkillDecision(state, pending, event.decision);
    }
    return state;
  }
  return applyRoleDecision(state, pending, event.decision);
}

export function reduceGame(state: GameState, event: GameEvent): GameState {
  const next = structuredClone(state);
  if (event.type === 'advance') {
    return advance(next);
  }
  if (event.type === 'submit-decision') {
    return applyDecision(next, event);
  }
  if (event.type === 'set-automation') {
    next.automationMode = event.automationMode;
    return next;
  }
  if (event.type === 'set-rng-state') {
    next.rngState = event.rngState >>> 0;
    return next;
  }
  if (event.type === 'mark-free-provider-used') {
    next.usedFreeProvider = true;
    return next;
  }
  addPublicEvent(next, 'ai-error', `AI 决策暂停：${event.message}`);
  return next;
}
