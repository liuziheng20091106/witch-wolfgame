import { CREATURE_ID } from '../../../shared/gamePromptContract.js';
import type { GameState, PendingDecision, PlayerId } from '../model';
import { addPublicEvent } from './events';
import { getAlivePlayerIds, getName } from './selectors';
import { makeRoleDecision } from './decisions';
import { burnedVoters, getDayIgnitionDecision } from '../skills/ignition';
import { getTieBreaker, getVoteOrder } from '../skills/voteSkills';
import { formatVoteRound, formatVoteTally, resolveVotes, tallyVoteRound } from './vote';

export function addExileIntent(state: GameState, playerId: PlayerId): void {
  addPublicEvent(state, 'exile', `${getName(state, playerId)} 被审判庭选为放逐对象。`, {
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
  const playerName = (playerId: PlayerId) => getName(state, playerId);
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

export function advanceVoting(state: GameState): GameState {
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
    addPublicEvent(state, 'vote', `最高票并列：${resolution.tiedPlayerIds.map((id) => getName(state, id)).join('、')}，进行一次重投。`, {
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

export function advanceRunoff(state: GameState): GameState {
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
