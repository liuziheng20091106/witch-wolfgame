import { characterById } from '../catalog/characters';
import { roleAlignment, roleNames } from '../catalog/roles';
import type {
  GameState,
  IgnitionDecision,
  OptionalTargetDecision,
  PendingDecision,
  PlayerId,
  SpeechDecision,
  SubmittedDecision,
  VoiceMimicDecision,
} from '../model';
import { addKnowledge, addPrivateEvent, addPublicEvent } from '../engine/events';
import { chooseWithState } from '../engine/random';
import { getAlivePlayerIds, getPlayer, getRoleAssignment } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, wasOffered } from './types';

function nameOf(state: GameState, playerId: PlayerId): string {
  return characterById[getPlayer(state, playerId).characterId].name;
}

export function getNextDayStartSkillDecision(state: GameState): PendingDecision | null {
  const key = offerKey(state, 'day-start');
  const skills = state.skillInstances
    .filter((skill) => skill.status === 'ready' && !wasOffered(skill, key))
    .filter((skill) => getPlayer(state, skill.ownerPlayerId).alive)
    .filter((skill) => skill.definitionId === 'speech-restrain' || skill.definitionId === 'ignition')
    .sort((left, right) => left.ownerPlayerId - right.ownerPlayerId);
  for (const skill of skills) {
    const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== skill.ownerPlayerId);
    if (candidates.length === 0) {
      continue;
    }
    if (skill.definitionId === 'ignition') {
      return makeSkillDecision(state, skill, '点火', '公开随机一名其他存活者的阵营。', candidates, 'ignition');
    }
    return makeSkillDecision(state, skill, '力气大', '指定一名其他存活者，她今天无法发言。', candidates, 'optional-target');
  }
  return null;
}

export function getBeforeSpeechSkillDecision(state: GameState, actorId: PlayerId): PendingDecision | null {
  const skill = state.skillInstances.find(
    (entry) => entry.ownerPlayerId === actorId
      && entry.definitionId === 'brainwash'
      && entry.status === 'ready'
      && !wasOffered(entry, offerKey(state, `before-speech-${actorId}`)),
  );
  if (!skill) {
    return null;
  }
  const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== actorId);
  return candidates.length === 0 ? null : makeSkillDecision(state, skill, '洗脑', '指定今天更容易被怀疑的一名角色。', candidates, 'optional-target');
}

export function getAfterSpeechSkillDecision(state: GameState, actorId: PlayerId): PendingDecision | null {
  const skill = state.skillInstances.find(
    (entry) => entry.ownerPlayerId === actorId
      && entry.definitionId === 'voice-mimic'
      && entry.status === 'ready'
      && !wasOffered(entry, offerKey(state, `after-speech-${actorId}`)),
  );
  if (!skill) {
    return null;
  }
  const spoken = new Set(
    state.publicEvents
      .filter((event) => event.day === state.day && (event.kind === 'speech' || event.kind === 'restrained'))
      .flatMap((event) => event.targetPlayerIds.length > 0 ? event.targetPlayerIds : event.actorPlayerId === null ? [] : [event.actorPlayerId]),
  );
  const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== actorId && !spoken.has(playerId));
  if (candidates.length === 0) return null;
  const decision = makeSkillDecision(state, skill, '声音模仿', '选择一名尚未发言者，并伪造一段不超过 100 字的内容。', candidates, 'voice-mimic');
  const guide = state.skillInstances.find(
    (entry) => entry.definitionId === 'gaze-guidance' && getPlayer(state, entry.ownerPlayerId).alive,
  );
  if (guide && guide.ownerPlayerId !== actorId) {
    decision.options = {
      requiredMention: nameOf(state, guide.ownerPlayerId),
      requiredSeatLabel: `${guide.ownerPlayerId + 1}号`,
    };
  }
  return decision;
}

export function applySpeechSkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.status === 'exhausted') {
    throw new Error('技能实例不可用');
  }
  const timing = skill.definitionId === 'brainwash'
    ? `before-speech-${skill.ownerPlayerId}`
    : skill.definitionId === 'voice-mimic'
      ? `after-speech-${skill.ownerPlayerId}`
      : 'day-start';
  markOffered(skill, offerKey(state, timing));
  const use = (decision as OptionalTargetDecision | IgnitionDecision).use;
  if (!use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你保留了${pending.title}。`, { actorPlayerId: skill.ownerPlayerId });
    return;
  }

  if (skill.definitionId === 'ignition') {
    const choice = chooseWithState(pending.candidates, state.rngState);
    state.rngState = choice.state;
    const alignment = roleAlignment[getRoleAssignment(state, choice.item).roleId];
    addPublicEvent(state, 'trial-by-fire', `火焰审判指向 ${nameOf(state, choice.item)}：她属于${alignment === 'wolf' ? '狼人' : '好人'}阵营。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [choice.item],
      data: { alignment },
    });
    exhaustSkill(skill);
    return;
  }

  const targetPlayerId = (decision as OptionalTargetDecision).targetPlayerId;
  if (targetPlayerId === null || !pending.candidates.includes(targetPlayerId)) {
    throw new Error('目标不在当前合法候选中');
  }
  if (skill.definitionId === 'speech-restrain') {
    skill.data.activeDay = state.day;
    skill.data.targetPlayerId = targetPlayerId;
    addPublicEvent(state, 'skill', `${nameOf(state, targetPlayerId)} 被限制了今天的发言。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'brainwash') {
    skill.data.activeDay = state.day;
    skill.data.targetPlayerId = targetPlayerId;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你把 ${nameOf(state, targetPlayerId)} 设为今天的怀疑焦点。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
    });
    exhaustSkill(skill);
    return;
  }
  if (skill.definitionId === 'voice-mimic') {
    const forgedSpeech = (decision as VoiceMimicDecision).forgedSpeech?.trim() ?? '';
    if (forgedSpeech.length === 0 || forgedSpeech.length > 100) {
      throw new Error('伪造发言必须为 1–100 字');
    }
    validateGuidedSpeech(state, skill.ownerPlayerId, forgedSpeech);
    skill.data.forgedDay = state.day;
    skill.data.targetPlayerId = targetPlayerId;
    skill.data.forgedSpeech = forgedSpeech;
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `你准备以 ${nameOf(state, targetPlayerId)} 的声音混入一段发言。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [targetPlayerId],
      data: { forgedSpeech },
    });
    exhaustSkill(skill);
  }
}

export function isRestrainedToday(state: GameState, playerId: PlayerId): boolean {
  return state.skillInstances.some(
    (skill) => skill.definitionId === 'speech-restrain'
      && skill.data.activeDay === state.day
      && skill.data.targetPlayerId === playerId,
  );
}

export function validateGuidedSpeech(state: GameState, actorId: PlayerId, speech: string): void {
  const guide = state.skillInstances.find(
    (skill) => skill.definitionId === 'gaze-guidance' && getPlayer(state, skill.ownerPlayerId).alive,
  );
  if (!guide || guide.ownerPlayerId === actorId) {
    return;
  }
  const guideName = nameOf(state, guide.ownerPlayerId);
  const seatLabel = `${guide.ownerPlayerId + 1}号`;
  if (!speech.includes(guideName) && !speech.includes(seatLabel)) {
    throw new Error(`发言必须提及 ${guideName} 或 ${seatLabel}`);
  }
}

export function publishSpeech(state: GameState, actorId: PlayerId, decision: SpeechDecision): void {
  const speech = decision.speech.trim();
  if (speech.length > 100) {
    throw new Error('发言不能超过 100 字');
  }
  if (speech.length > 0) {
    validateGuidedSpeech(state, actorId, speech);
  }
  const mimic = state.skillInstances.find(
    (skill) => skill.definitionId === 'voice-mimic'
      && skill.data.forgedDay === state.day
      && skill.data.targetPlayerId === actorId,
  );
  const forgedSpeech = typeof mimic?.data.forgedSpeech === 'string' ? mimic.data.forgedSpeech : '';
  const merged = [speech || '（保持沉默）', forgedSpeech].filter(Boolean).join(' ');
  const event = addPublicEvent(state, 'speech', merged, {
    actorPlayerId: actorId,
    targetPlayerIds: [actorId],
    displayAuthorPlayerId: actorId,
    actualAuthorPlayerId: forgedSpeech ? mimic?.ownerPlayerId ?? actorId : actorId,
    data: forgedSpeech ? { hasForgedFragment: true, forgedSpeech } : {},
  });
  processClairvoyanceMentions(state, event.actualAuthorPlayerId ?? actorId, merged);
}

function processClairvoyanceMentions(state: GameState, actualAuthorId: PlayerId, speech: string): void {
  for (const skill of state.skillInstances) {
    if (skill.definitionId !== 'clairvoyance' || !getPlayer(state, skill.ownerPlayerId).alive) {
      continue;
    }
    const name = nameOf(state, skill.ownerPlayerId);
    const seatLabel = `${skill.ownerPlayerId + 1}号`;
    if (!speech.includes(name) && !speech.includes(seatLabel)) {
      continue;
    }
    const roleId = getRoleAssignment(state, actualAuthorId).roleId;
    const event = addPrivateEvent(state, [skill.ownerPlayerId], 'knowledge', `千里眼识破真实发言者 ${nameOf(state, actualAuthorId)} 的职业：${roleNames[roleId]}。`, {
      actorPlayerId: skill.ownerPlayerId,
      targetPlayerIds: [actualAuthorId],
    });
    addKnowledge(state, skill.ownerPlayerId, { subjectPlayerId: actualAuthorId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
  }
}
