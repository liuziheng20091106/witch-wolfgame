#!/usr/bin/env node
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined) return fallback;
  return process.argv[index + 1];
}
const GAMES = Math.max(10, Number(arg('games', 50)) || 50);
const MIN = Math.max(6, Number(arg('min', 6)) || 6);
const MAX = Math.min(14, Number(arg('max', 14)) || 14);

const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, reduceGame, fallbackDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
} finally {
  await server.close();
}

function playOne(playerCount, seed, poisonDay) {
  let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount, selectedCharacterIds: [] });
  let iterations = 0;
  while (game.phase !== 'ended') {
    if (++iterations > 6000) return { timedOut: true, winner: null };
    if (game.pendingDecision) {
      const fallback = fallbackDecision(game, game.pendingDecision, { witchPoisonDay: poisonDay });
      game = reduceGame(game, { type: 'set-rng-state', rngState: fallback.rngState });
      game = reduceGame(game, {
        type: 'submit-decision',
        pendingDecisionId: game.pendingDecision.id,
        actorId: game.pendingDecision.actorId,
        decision: fallback.decision,
      });
    } else {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  return { timedOut: false, winner: game.result?.winner ?? null, day: game.day };
}

function runTemplate(playerCount, poisonDay) {
  const counts = { good: 0, wolf: 0, neutral: 0, timedOut: 0 };
  let days = 0;
  let finished = 0;
  for (let i = 0; i < GAMES; i += 1) {
    const result = playOne(playerCount, 7000 + playerCount * 100 + i, poisonDay);
    if (result.timedOut) {
      counts.timedOut += 1;
      continue;
    }
    counts[result.winner] += 1;
    days += result.day;
    finished += 1;
  }
  let wolfPct = null;
  let goodPct = null;
  let neutralPct = null;
  let avgDays = null;
  if (finished > 0) {
    wolfPct = Number(((counts.wolf / finished) * 100).toFixed(1));
    goodPct = Number(((counts.good / finished) * 100).toFixed(1));
    neutralPct = Number(((counts.neutral / finished) * 100).toFixed(1));
    avgDays = Number((days / finished).toFixed(1));
  }
  return {
    good: counts.good,
    wolf: counts.wolf,
    neutral: counts.neutral,
    timedOut: counts.timedOut,
    wolfPct,
    goodPct,
    neutralPct,
    avgDays,
  };
}

console.log('档位 | 模板 | 局数 | 好人% | 狼% | 中立% | 平均天数 | 超时');
console.log('---- | ---- | ---- | ---- | ---- | ---- | ---- | ----');
const rows = [];
for (let p = MIN; p <= MAX; p += 1) {
  for (const poisonDay of [2, 0]) {
    const stats = runTemplate(p, poisonDay);
    rows.push({ players: p, poisonDay, ...stats });
    console.log(
      `${p}人 | 毒日${poisonDay} | ${GAMES} | ${stats.goodPct ?? '-'}% | ${stats.wolfPct ?? '-'}% | ${stats.neutralPct ?? '-'}% | ${stats.avgDays ?? '-'} | ${stats.timedOut}`,
    );
  }
}
console.log('');
console.log('说明: 本地策略无语义层（不跳神/不演狼/不分析发言），守卫守中率与猎人/预言家信息价值被低估；');
console.log('胜率仅作结构与策略敏感性的相对信号，真实平衡以 AI 对弈与真人数据为准。');
