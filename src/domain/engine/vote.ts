import type { PlayerId, VoteRecord } from '../model';

export interface VoteResolution {
  outcome: 'exile' | 'runoff' | 'none';
  targetPlayerId: PlayerId | null;
  tiedPlayerIds: PlayerId[];
}

export interface VoteTallyEntry {
  targetPlayerId: PlayerId | null;
  count: number;
}

/** 汇总指定轮次的有效票数；得票者按座位排序，弃权固定放在最后。 */
export function tallyVoteRound(
  votes: VoteRecord[],
  round: 1 | 2,
  burnedVoterIds: ReadonlySet<PlayerId> = new Set(),
): VoteTallyEntry[] {
  const counts = new Map<PlayerId, number>();
  let abstentions = 0;
  for (const vote of votes) {
    if (vote.round !== round || burnedVoterIds.has(vote.voterPlayerId)) {
      continue;
    }
    if (vote.targetPlayerId === null) {
      abstentions += 1;
      continue;
    }
    const current = counts.get(vote.targetPlayerId) ?? 0;
    counts.set(vote.targetPlayerId, current + 1);
  }
  const tally: VoteTallyEntry[] = [...counts.entries()]
    .sort(([leftPlayerId], [rightPlayerId]) => leftPlayerId - rightPlayerId)
    .map(([targetPlayerId, count]) => ({ targetPlayerId, count }));
  if (abstentions > 0) {
    tally.push({ targetPlayerId: null, count: abstentions });
  }
  return tally;
}

/** 将结构化票数汇总格式化为公开文本。 */
export function formatVoteTally(
  tally: VoteTallyEntry[],
  playerName: (playerId: PlayerId) => string,
): string {
  if (tally.length === 0) {
    return '无人得票';
  }
  return tally.map((entry) => {
    let targetName = '弃权';
    if (entry.targetPlayerId !== null) {
      targetName = playerName(entry.targetPlayerId);
    }
    return `${targetName}：${entry.count}票`;
  }).join('；');
}

/** 将指定轮次的完整票型格式化为统一公开文本。 */
export function formatVoteRound(
  votes: VoteRecord[],
  round: 1 | 2,
  playerName: (playerId: PlayerId) => string,
): string {
  const records = votes.filter((vote) => vote.round === round);
  if (records.length === 0) {
    return '无人投票';
  }
  return records.map((vote) => {
    let targetName = '弃权';
    if (vote.targetPlayerId !== null) {
      targetName = playerName(vote.targetPlayerId);
    }
    return `${playerName(vote.voterPlayerId)} -> ${targetName}`;
  }).join('；');
}

export function resolveVotes(votes: VoteRecord[], round: 1 | 2, burnedVoterIds: ReadonlySet<PlayerId> = new Set()): VoteResolution {
  const tally = tallyVoteRound(votes, round, burnedVoterIds);
  let abstentions = 0;
  const entries: Array<{ playerId: PlayerId; count: number }> = [];
  for (const entry of tally) {
    if (entry.targetPlayerId === null) {
      abstentions = entry.count;
    } else {
      entries.push({ playerId: entry.targetPlayerId, count: entry.count });
    }
  }
  const highest = entries.reduce((value, entry) => Math.max(value, entry.count), 0);
  if (highest === 0 || (round === 1 && abstentions >= highest)) {
    return { outcome: 'none', targetPlayerId: null, tiedPlayerIds: [] };
  }
  const tiedPlayerIds = entries.filter((entry) => entry.count === highest).map((entry) => entry.playerId);
  if (tiedPlayerIds.length > 1) {
    return { outcome: 'runoff', targetPlayerId: null, tiedPlayerIds };
  }
  return { outcome: 'exile', targetPlayerId: tiedPlayerIds[0] ?? null, tiedPlayerIds: [] };
}
