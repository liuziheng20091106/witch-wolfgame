import type { PlayerId, VoteRecord } from '../model';

export interface VoteResolution {
  outcome: 'exile' | 'runoff' | 'none';
  targetPlayerId: PlayerId | null;
  tiedPlayerIds: PlayerId[];
}

export function resolveVotes(votes: VoteRecord[], round: 1 | 2): VoteResolution {
  const roundVotes = votes.filter((vote) => vote.round === round);
  const abstentions = roundVotes.filter((vote) => vote.targetPlayerId === null).length;
  const counts: Partial<Record<PlayerId, number>> = {};
  for (const vote of roundVotes) {
    if (vote.targetPlayerId !== null) {
      counts[vote.targetPlayerId] = (counts[vote.targetPlayerId] ?? 0) + 1;
    }
  }
  const entries = Object.entries(counts).map(([playerId, count]) => ({
    playerId: Number(playerId) as PlayerId,
    count,
  }));
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
