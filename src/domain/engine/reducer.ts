import { CREATURE_ID, WOLF_COUNCIL_MESSAGE_MAX_LENGTH } from '../../../shared/gamePromptContract.js';
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
  WolfCouncilDecision,
  WitchDecision,
} from '../model';
import {
  applyClairvoyanceDecision,
  applyDayIgnition,
  applyLevitation,
  applyNightIgnition,
  applyNightIgnitionPotion,
  applyNightSkillDecision,
  applySpeechSkillDecision,
  applyVisionSkillDecision,
  applyVoteSkillDecision,
  attachBrainwashSuggestion,
  burnedVoters,
  gazeRequiredMention,
  getAfterSpeechSkillDecision,
  getBeforeSpeechSkillDecision,
  getClairvoyanceDecision,
  getDayIgnitionDecision,
  getHealingDecision,
  getNextDayStartSkillDecision,
  getNextNightSkillDecision,
  getNightIgnitionDecision,
  getNightIgnitionPotionDecision,
  getTieBreaker,
  getVoteOrder,
  getVoteSkillDecision,
  isFloatingActive,
  isRestrainedToday,
  publishSpeech,
} from '../skills/registry';
import { addKnowledge, addPrivateEvent, addPublicEvent } from './events';
import { finalizeGameIfWon, refreshMorningCheckpoint, resolveDeathBatch, resolveNight } from './night';
import { getAlivePlayerIds, getName, getPlayer, getRoleAssignment, getSkillInstance } from './selectors';
import { exhaustSkill } from '../skills/types';
import { formatVoteRound, formatVoteTally, resolveVotes, tallyVoteRound } from './vote';
import { applyLastWords, getNextLastWordsDecision } from '../skills/lastWords';
import { applyPostGameSpeech, getNextPostGameDecision } from '../skills/postGame';
import { withFactionStrategyGuidance } from '../skills/decisionGuidance';

const DAY_SPEECH_DESCRIPTION = '公开发言不超过 100 字。系统规则只作为内部决策边界，不得当作默认发言素材。先检查本日已有发言；不得换一种说法重复已有共识。至少贡献一项新的观察、质疑、矛盾、回应或后续验证建议；确无新增时可简短保留判断，但不要复述规则。';

function nameOf(state: GameState, playerId: PlayerId): string {
  return getName(state, playerId);
}

function pendingId(state: GameState, kind: string, actorId: PlayerId): string {
  return `${state.gameId}-decision-${state.day}-${state.phase}-${kind}-${actorId}`;
}

function hasPrivateAction(state: GameState, kind: string, actorId: PlayerId): boolean {
  return state.privateEvents.some(
    (event) => event.day === state.day && event.actorPlayerId === actorId && event.data.actionKind === kind,
  );
}

function hasPrivateActionKind(state: GameState, kind: string): boolean {
  return state.privateEvents.some(
    (event) => event.day === state.day && event.data.actionKind === kind,
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
  const decision: PendingDecision = {
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
  attachBrainwashSuggestion(state, decision);
  return decision;
}

function livingWolves(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'wolf');
}

function speakingWolves(state: GameState): PlayerId[] {
  return livingWolves(state).filter((playerId) => playerId !== CREATURE_ID);
}

function wolfDecisionActor(state: GameState, wolves: PlayerId[]): PlayerId | undefined {
  const humanPlayerId = state.humanPlayerId;
  if (humanPlayerId !== null && humanPlayerId !== CREATURE_ID && wolves.includes(humanPlayerId)) {
    return humanPlayerId;
  }
  const realWolf = wolves.find((playerId) => playerId !== CREATURE_ID);
  if (realWolf !== undefined) {
    return realWolf;
  }
  return wolves[0];
}

function wolfTargetLabel(state: GameState, playerId: PlayerId): string {
  if (playerId === CREATURE_ID) {
    return `造物（${nameOf(state, playerId)}）`;
  }
  return `${playerId + 1}号（${nameOf(state, playerId)}）`;
}

function wolfCouncilMessages(state: GameState) {
  const messages: Array<{
    speakerPlayerId: PlayerId;
    speakerName: string;
    message: string;
    recommendedTargetPlayerId: PlayerId;
  }> = [];
  for (const event of state.privateEvents) {
    if (event.day !== state.day || event.data.actionKind !== 'wolf-suggestion') {
      continue;
    }
    const speakerPlayerId = event.actorPlayerId;
    if (speakerPlayerId === null || speakerPlayerId === CREATURE_ID) {
      continue;
    }
    let recommendedTargetPlayerId: PlayerId | null = null;
    if (typeof event.data.recommendedTargetPlayerId === 'number') {
      recommendedTargetPlayerId = event.data.recommendedTargetPlayerId as PlayerId;
    } else if (typeof event.data.targetPlayerId === 'number') {
      recommendedTargetPlayerId = event.data.targetPlayerId as PlayerId;
    }
    if (recommendedTargetPlayerId === null) {
      continue;
    }
    let message = event.text;
    if (typeof event.data.message === 'string') {
      message = event.data.message;
    }
    messages.push({
      speakerPlayerId,
      speakerName: nameOf(state, speakerPlayerId),
      message,
      recommendedTargetPlayerId,
    });
  }
  return messages;
}

function wolfTargets(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId !== 'wolf');
}

function advanceNightSkills(state: GameState): GameState {
  // 点火烧药第二步：若点火已暂存烧药目标，先完成烧药再继续其它夜间技能
  const ignition = state.skillInstances.find(
    (entry) => entry.definitionId === 'ignition' && typeof entry.data.pendingBurnTarget === 'number',
  );
  if (ignition) {
    const potion = getNightIgnitionPotionDecision(state, ignition.data.pendingBurnTarget as PlayerId);
    if (potion) {
      state.pendingDecision = potion;
      return state;
    }
    // 目标药已无（防御）：直接耗尽，避免卡死
    delete ignition.data.pendingBurnTarget;
    delete ignition.data.pendingBurnNight;
    exhaustSkill(ignition);
  }
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
  const actorId = speakingWolves(state).find((playerId) => !hasPrivateAction(state, 'wolf-suggestion', playerId));
  if (actorId !== undefined) {
    const pending = makeRoleDecision(
      state,
      'wolf-suggestion',
      actorId,
      '狼人内部频道',
      '仅狼队可见。结合已有狼议，简要说明判断依据并推荐一名袭击目标。',
      wolfTargets(state),
      false,
      'wolf-council',
    );
    pending.options = { wolfCouncilMessages: wolfCouncilMessages(state) };
    state.pendingDecision = pending;
  } else {
    state.phase = 'wolf-decision';
  }
  return state;
}

function advanceWolfDecision(state: GameState): GameState {
  const wolves = livingWolves(state);
  const actorId = wolfDecisionActor(state, wolves);
  if (actorId === undefined) {
    state.phase = 'night-resolution';
    return state;
  }
  if (!hasPrivateActionKind(state, 'wolf-decision')) {
    const councilMessages = wolfCouncilMessages(state);
    const pending = makeRoleDecision(
      state,
      'wolf-decision',
      actorId,
      '狼人最终袭击',
      '代表狼队结合本夜内部频道，选择唯一的最终袭击目标。',
      wolfTargets(state),
      false,
    );
    pending.options = { wolfCouncilMessages: councilMessages };
    state.pendingDecision = pending;
  } else {
    state.phase = 'witch-action';
  }
  return state;
}

function advanceWitch(state: GameState): GameState {
  // 女巫主体 = 玩家女巫 + 继承女巫的造物（诺亚的造物若为女巫可独立用药）
  const witchSubjects = getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'witch');
  if (witchSubjects.length === 0) {
    state.phase = 'seer-action';
    return state;
  }
  const attack = state.privateEvents.findLast(
    (event) => event.day === state.day && event.data.actionKind === 'wolf-decision',
  );
  const attackedPlayerId = typeof attack?.data.targetPlayerId === 'number' ? attack.data.targetPlayerId as PlayerId : null;
  for (const witch of witchSubjects) {
    if (hasPrivateAction(state, 'witch-action', witch)) {
      continue;
    }
    const resources = getRoleAssignment(state, witch).resources;
    const canSave = resources.antidote === 1 && attackedPlayerId !== null;
    let candidates: PlayerId[] = [];
    if (resources.poison === 1) {
      candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== witch);
      if (witch !== 99) {
        // 玩家女巫不能对自己的造物用药（分身无意义）；造物保留毒主人的可能（失控设定）
        candidates = candidates.filter((playerId) => playerId !== 99 || !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === witch));
      }
    }
    const canPoison = candidates.length > 0;
    if (!canSave && !canPoison) {
      continue;
    }
    const title = witch === 99 ? '造物用药' : '女巫行动';
    let description = witch === 99 ? '你是诺亚的造物，继承女巫的药并独立行动。' : '';
    description += attackedPlayerId === null ? '今晚没有可见的狼刀。' : `${nameOf(state, attackedPlayerId)} 遭到狼刀。`;
    description += canSave ? `解药可用，只能救下 ${nameOf(state, attackedPlayerId as PlayerId)}。` : '解药不可用。';
    description += canPoison ? '毒药可用，目标必须从候选中选择。' : '毒药不可用。';
    if (canSave && canPoison) {
      description += '同时用药时，不能毒杀被救者。';
    }
    const witchDecision: PendingDecision = {
      ...makeRoleDecision(state, 'witch-action', witch, title, description, candidates, true, 'witch'),
      options: {
        attackedPlayerId,
        canSave,
        canPoison,
      },
    };
    state.pendingDecision = withFactionStrategyGuidance(state, witchDecision);
    return state;
  }
  state.phase = 'seer-action';
  return state;
}

function advanceSeer(state: GameState): GameState {
  // 预言家主体 = 玩家预言家 + 继承预言家的造物
  // 造物查验结果由主人接收：主人死亡后造物不再查验（查验失去意义）
  const seerSubjects = getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'seer');
  for (const seer of seerSubjects) {
    if (seer === 99) {
      const ownerAlive = state.creatures.some(
        (creature) => creature.id === 99 && getPlayer(state, creature.ownerPlayerId).alive,
      );
      if (!ownerAlive) {
        continue;
      }
    }
    if (hasPrivateAction(state, 'seer-action', seer)) {
      continue;
    }
    let candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== seer);
    // 预言家与自己的造物互查无意义：玩家不能查自己的造物，造物也不能查主人（同身份分身）
    candidates = candidates.filter((playerId) => {
      if (seer === 99) {
        return playerId !== 99 && !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === playerId);
      }
      return playerId !== 99 || !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === seer);
    });
    if (seer === 99) {
      state.pendingDecision = makeRoleDecision(state, 'seer-action', seer, '造物查验', '你是诺亚的造物，继承预言家的查验能力。选择一名其他存活者，私下获知其当前职业。', candidates, false);
    } else {
      state.pendingDecision = makeRoleDecision(state, 'seer-action', seer, '预言家查验', '选择一名其他存活者，私下获知其当前职业。', candidates, false);
    }
    return state;
  }
  state.phase = 'night-protection';
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
  // 禁言检查先于发言前技能：被"怪力"禁言者今天无法发言，不应被询问洗脑等发言前技能
  if (isRestrainedToday(state, actorId)) {
    addPublicEvent(state, 'restrained', `${nameOf(state, actorId)} 受到限制，无法发言。`, {
      actorPlayerId: actorId,
      targetPlayerIds: [actorId],
      displayAuthorPlayerId: actorId,
      actualAuthorPlayerId: actorId,
    });
    return state;
  }
  const beforeDecision = getBeforeSpeechSkillDecision(state, actorId);
  if (beforeDecision) {
    state.pendingDecision = beforeDecision;
    return state;
  }
  const speechDecision = makeRoleDecision(
    state,
    'speech',
    actorId,
    `${nameOf(state, actorId)} 发言`,
    DAY_SPEECH_DESCRIPTION,
    [],
    true,
    'speech',
  );
  const gazeMention = gazeRequiredMention(state, actorId);
  if (gazeMention) {
    speechDecision.options = {
      ...speechDecision.options,
      requiredMention: gazeMention.requiredMention,
      requiredSeatLabel: gazeMention.requiredSeatLabel,
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

/** 造物跟投：造物直接继承诺亚的投票（不独立投票）。 */
function attachCreatureVotes(state: GameState, round: 1 | 2): void {
  for (const creature of state.creatures) {
    if (!creature.alive) {
      continue;
    }
    const ownerVote = state.currentVotes.find(
      (vote) => vote.round === round && vote.voterPlayerId === creature.ownerPlayerId,
    );
    if (!ownerVote) {
      continue;
    }
    if (!state.currentVotes.some((vote) => vote.round === round && vote.voterPlayerId === creature.id)) {
      state.currentVotes.push({
        voterPlayerId: creature.id,
        targetPlayerId: ownerVote.targetPlayerId,
        round,
      });
    }
  }
}

function voteRoundIsRevealed(state: GameState, round: 1 | 2): boolean {
  return state.publicEvents.some(
    (event) => event.day === state.day && event.kind === 'vote' && event.data.revealedVoteRound === round,
  );
}

/** 所有投票收齐后一次性公开完整票型，提交期间不产生公开事件。 */
function revealVoteRound(state: GameState, round: 1 | 2): void {
  if (voteRoundIsRevealed(state, round)) {
    return;
  }
  const votes = state.currentVotes.filter((vote) => vote.round === round);
  const voteTally = tallyVoteRound(votes, round);
  const targetPlayerIds: PlayerId[] = [];
  for (const vote of votes) {
    if (vote.targetPlayerId !== null && !targetPlayerIds.includes(vote.targetPlayerId)) {
      targetPlayerIds.push(vote.targetPlayerId);
    }
  }
  const playerName = (playerId: PlayerId) => nameOf(state, playerId);
  addPublicEvent(state, 'vote', `第 ${round} 轮完整提交票型（点火前）：${formatVoteRound(votes, round, playerName)}。\n提交票数汇总（点火前）：${formatVoteTally(voteTally, playerName)}。`, {
    targetPlayerIds,
    data: {
      revealedVoteRound: round,
      voteRecords: votes.map((vote) => ({ ...vote })),
      submittedVoteTally: voteTally.map((entry) => ({ ...entry })),
    },
  });
}

function votingPending(state: GameState, round: 1 | 2, candidates: PlayerId[] | null): PendingDecision | null {
  const order = getVoteOrder(state);
  const voter = order.find((playerId) => !state.currentVotes.some((vote) => vote.round === round && vote.voterPlayerId === playerId));
  if (voter === undefined) {
    return null;
  }
  const ownedCreatureId = state.creatures.some((creature) => creature.id === CREATURE_ID && creature.alive && creature.ownerPlayerId === voter)
    ? CREATURE_ID
    : null;
  const targets = (candidates ?? getAlivePlayerIds(state)).filter((playerId) => playerId !== voter && playerId !== ownedCreatureId);
  if (targets.length === 0) {
    state.currentVotes.push({ voterPlayerId: voter, targetPlayerId: null, round });
    return votingPending(state, round, candidates);
  }
  let kind: PendingDecision['kind'] = 'vote';
  let title = '秘密投票';
  let allowAbstain = true;
  if (round === 2) {
    kind = 'runoff';
    title = '平票秘密重投';
    allowAbstain = false;
  }
  return makeRoleDecision(
    state,
    kind,
    voter,
    title,
    '秘密选择一名候选；所有人完成本轮投票后统一公布完整票型，提交期间无法查看其他人的选择。',
    targets,
    allowAbstain,
  );
}

function advanceVoting(state: GameState): GameState {
  const pending = votingPending(state, 1, null);
  if (pending) {
    state.pendingDecision = pending;
    return state;
  }
  // 投票全部完成：先补齐造物跟票并统一揭票，再询问点火，最后计票。
  attachCreatureVotes(state, 1);
  revealVoteRound(state, 1);
  const ignition = getDayIgnitionDecision(state);
  if (ignition) {
    state.pendingDecision = ignition;
    return state;
  }
  const resolution = resolveVotes(state.currentVotes, 1, burnedVoters(state));
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
  attachCreatureVotes(state, 2);
  revealVoteRound(state, 2);
  const ignition = getDayIgnitionDecision(state);
  if (ignition) {
    state.pendingDecision = ignition;
    return state;
  }
  const resolution = resolveVotes(state.currentVotes, 2, burnedVoters(state));
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
      // 死亡回溯返回新状态（死者被救回），当前放逐与遗言均被撤销。
      if (resolved !== state) return resolved;
    }
  }
  // 遗言：白天放逐死亡结算后，若有合格死者需要发布遗言，保持 day-resolution 阶段等待遗言决策。
  // 提交遗言后 advance 会再次进入本阶段，此时 exile 目标已死跳过结算，再检查是否还有遗言。
  // （resolveDeathBatch 原地修改并返回同一引用，正常路径会继续执行到本检查，不会提前返回。）
  const lastWords = getNextLastWordsDecision(state);
  if (lastWords) {
    state.pendingDecision = lastWords;
    return state;
  }
  if (finalizeGameIfWon(state)) return state;
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
  if (state.pendingDecision) {
    return state;
  }
  if (state.phase === 'ended') {
    // 对局结束：若胜负已结算，切入赛后复盘阶段（全员依次发表赛后发言）
    if (state.result) {
      state.phase = 'post-game';
      return advancePostGame(state);
    }
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
    case 'post-game': return advancePostGame(state);
  }
}

/** 赛后复盘：逐个玩家（编号 0→5，跳过造物 99）产生赛后发言决策；全部发完后保持 post-game 终态。 */
function advancePostGame(state: GameState): GameState {
  const pending = getNextPostGameDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  }
  // 全部发完：停留在 post-game（终态），避免 phase 回到 ended 重复触发历史记录
  return state;
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

function validateWolfCouncilDecision(
  state: GameState,
  decision: SubmittedDecision,
  pending: PendingDecision,
): WolfCouncilDecision {
  if (pending.schemaKey === 'target') {
    const targetPlayerId = validateTarget(state, decision, pending);
    if (targetPlayerId === null) {
      throw new Error('狼议必须推荐袭击目标');
    }
    return {
      message: `我建议袭击${nameOf(state, targetPlayerId)}。`,
      recommendedTargetPlayerId: targetPlayerId,
    };
  }
  const councilDecision = decision as WolfCouncilDecision;
  const message = councilDecision.message.trim();
  if (message.length === 0 || message.length > WOLF_COUNCIL_MESSAGE_MAX_LENGTH) {
    throw new Error(`狼议发言必须为 1～${WOLF_COUNCIL_MESSAGE_MAX_LENGTH} 字`);
  }
  const recommendedTargetPlayerId = councilDecision.recommendedTargetPlayerId;
  if (!pending.candidates.includes(recommendedTargetPlayerId) || !getPlayer(state, recommendedTargetPlayerId).alive) {
    throw new Error('狼议推荐目标不在当前合法候选中');
  }
  return { message, recommendedTargetPlayerId };
}


function applyRoleDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): GameState {
  if (pending.kind === 'speech') {
    if (pending.options.postGame === true) {
      // 赛后复盘：全员可见的赛后发言，不参与局内发言校验
      applyPostGameSpeech(state, pending, decision);
      return state;
    }
    if (pending.options.lastWords === true) {
      // 遗言：死者发布的最后发言（公开事件），不受视线诱导约束
      applyLastWords(state, pending, decision);
      return state;
    }
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
      addPrivateEvent(state, [pending.actorId], 'witch-action', `${nameOf(state, pending.actorId)} 使用解药救下 ${nameOf(state, attacked)}。`, {
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
      if (isFloatingActive(state, poisonTarget, state.day)) {
        // 漂浮隐匿：毒药无法锁定目标，使用失败（毒药已消耗）
        addPrivateEvent(state, [pending.actorId], 'witch-action', `${nameOf(state, pending.actorId)} 对 ${nameOf(state, poisonTarget)} 使用毒药，但她的身影若隐若现，毒药落空了。`, {
          actorPlayerId: pending.actorId,
          targetPlayerIds: [poisonTarget],
          data: { actionKind: 'witch-action', intentSource: 'poison-failed', preventable: false, targetPlayerId: poisonTarget },
        });
      } else {
        addPrivateEvent(state, [pending.actorId], 'witch-action', `${nameOf(state, pending.actorId)} 对 ${nameOf(state, poisonTarget)} 使用毒药。`, {
          actorPlayerId: pending.actorId,
          targetPlayerIds: [poisonTarget],
          data: { intentSource: 'poison', preventable: true, targetPlayerId: poisonTarget },
        });
      }
    }
    addPrivateEvent(state, [pending.actorId], 'witch-action', `${nameOf(state, pending.actorId)} 已完成女巫行动。`, {
      actorPlayerId: pending.actorId,
      data: { actionKind: 'witch-action' },
    });
    return state;
  }
  if (pending.kind === 'wolf-suggestion') {
    const councilDecision = validateWolfCouncilDecision(state, decision, pending);
    const targetPlayerId = councilDecision.recommendedTargetPlayerId;
    addPrivateEvent(
      state,
      livingWolves(state),
      'wolf-suggestion',
      `${nameOf(state, pending.actorId)}：${councilDecision.message}（建议袭击 ${wolfTargetLabel(state, targetPlayerId)}）`,
      {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [targetPlayerId],
        data: {
          actionKind: 'wolf-suggestion',
          message: councilDecision.message,
          recommendedTargetPlayerId: targetPlayerId,
        },
      },
    );
    return state;
  }
  const targetPlayerId = validateTarget(state, decision, pending);
  if (pending.kind === 'wolf-decision') {
    addPrivateEvent(state, livingWolves(state), 'wolf-attack', `狼队决定袭击 ${wolfTargetLabel(state, targetPlayerId as PlayerId)}。`, {
      actorPlayerId: null,
      targetPlayerIds: [targetPlayerId as PlayerId],
      data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: targetPlayerId as PlayerId },
    });
  } else if (pending.kind === 'seer-action') {
    const targetId = targetPlayerId as PlayerId;
    if (isFloatingActive(state, targetId, state.day)) {
      // 漂浮隐匿：查验不到任何痕迹，结果为空（照常消耗本夜查验，标记已行动避免死循环）
      addPrivateEvent(state, [pending.actorId], 'seer-check', `${nameOf(state, pending.actorId)} 查验了 ${nameOf(state, targetId)}，但在现场什么都没有看见。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [targetId],
        data: { actionKind: 'seer-action' },
      });
      return state;
    }
    const roleId = getRoleAssignment(state, targetId).roleId;
    // 造物查验：结果同时传给诺亚（造物的主人）——她设计为"查验结果由诺亚统一接收"
    const creatureOwners = state.creatures.filter((creature) => creature.id === 99).map((creature) => creature.ownerPlayerId);
    const receiverIds: PlayerId[] = [pending.actorId];
    if (pending.actorId === 99) {
      receiverIds.push(...creatureOwners);
    }
    const event = addPrivateEvent(state, receiverIds, 'seer-check', `${nameOf(state, targetId)} 的当前职业是${roleNames[roleId]}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: [targetId],
      data: { actionKind: 'seer-action' },
    });
    addKnowledge(state, pending.actorId, { subjectPlayerId: targetId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
    // 造物查验的知识也同步给诺亚（她可据此发言/决策）
    if (pending.actorId === 99) {
      const ownerIds = state.creatures.filter((creature) => creature.id === 99).map((creature) => creature.ownerPlayerId);
      for (const ownerId of ownerIds) {
        addKnowledge(state, ownerId, { subjectPlayerId: targetId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
      }
    }
  } else if (pending.kind === 'vote' || pending.kind === 'runoff') {
    let round: VoteRecord['round'] = 1;
    if (pending.kind === 'runoff') {
      round = 2;
    }
    state.currentVotes.push({ voterPlayerId: pending.actorId, targetPlayerId, round });
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
    // 千里眼观看决策：actor 是观众，技能实例属于开播者（可可），必须按 skillInstanceId 定位技能
    if (pending.options.clairvoyanceViewer === true) {
      const clairvoyanceSkill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
      if (!clairvoyanceSkill || clairvoyanceSkill.definitionId !== 'clairvoyance') {
        throw new Error('千里眼技能不可用');
      }
      applyClairvoyanceDecision(state, pending, event.decision);
      return state;
    }
    const skill = getSkillInstance(state, pending.actorId);
    if (!skill || skill.id !== pending.skillInstanceId) {
      throw new Error('待处理技能已移动或失效');
    }
    if (skill.definitionId === 'levitation') {
      applyLevitation(state, pending, event.decision);
    } else if (skill.definitionId === 'mind-reading') {
      applyVisionSkillDecision(state, pending, event.decision);
    } else if (skill.definitionId === 'ignition') {
      if (pending.title === '点火-烧药') {
        applyNightIgnitionPotion(state, pending, event.decision);
      } else if (pending.title === '点火-白天') {
        applyDayIgnition(state, pending, event.decision);
      } else {
        applyNightIgnition(state, pending, event.decision);
      }
    } else if (skill.definitionId === 'clairvoyance') {
      applyClairvoyanceDecision(state, pending, event.decision);
    } else if (skill.definitionId === 'speech-restrain' || skill.definitionId === 'brainwash' || skill.definitionId === 'voice-mimic' || skill.definitionId === 'gaze-guidance') {
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
  next.aiFailureOccurred = true;
  if (event.failure) next.lastAiFailure = { ...event.failure, day: next.day, phase: next.phase };
  return next;
}
