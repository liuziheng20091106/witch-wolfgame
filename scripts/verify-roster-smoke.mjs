#!/usr/bin/env node
/**
 * 版型扩展回归 smoke（Issue #95）
 * - 断言 6-14 人版型表与文档 v2 一致（人数/狼数/守卫档位/隐狼档位/呆头鹅试点档）
 * - 各档跑少量本地策略对局，断言全部正常结束且胜者合法（狼/好/中立），无死循环
 * 用法: node scripts/verify-roster-smoke.mjs [--games N]
 */
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const GAMES = Number(process.argv[process.argv.indexOf('--games') + 1] ?? 8) || 8;

const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let rolePoolForPlayerCount, createGame, reduceGame, fallbackDecision, roleNames;
try {
  ({ rolePoolForPlayerCount } = await server.ssrLoadModule('/shared/gamePromptContract.js'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ roleNames } = await server.ssrLoadModule('/src/domain/catalog/roles.ts'));
} finally {
  await server.close();
}

// 期望版型（与 docs/issue-95-roster-design.md v2 表一致）：roleId 计数
const expectedCounts = {
  6: { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 1 },
  7: { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 2 },
  8: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 2 },
  9: { wolf: 3, seer: 1, witch: 1, guard: 1, villager: 2, dodo: 1 },
  10: { wolf: 3, 'wolf-king': 1, seer: 1, witch: 1, hunter: 1, villager: 3 },
  11: { wolf: 4, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 3 },
  12: { wolf: 3, 'wolf-king': 1, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 3, dodo: 1 },
  13: { wolf: 2, 'wolf-king': 1, 'hidden-wolf': 1, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 5 },
  14: { wolf: 3, 'wolf-king': 1, 'hidden-wolf': 1, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 5 },
};

console.log('== 版型表断言 ==');
for (let players = 6; players <= 14; players += 1) {
  const pool = rolePoolForPlayerCount(players);
  assert.equal(pool.length, players, `${players} 人版型职业数`);
  const counts = {};
  for (const roleId of pool) counts[roleId] = (counts[roleId] ?? 0) + 1;
  assert.deepEqual(counts, expectedCounts[players], `${players} 人版型构成`);
}
console.log('6-14 全部版型与 v2 规格一致 ✓');

function playOne(playerCount, seed) {
  let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount, selectedCharacterIds: [] });
  let iterations = 0;
  while (game.phase !== 'ended') {
    if (++iterations > 6000) return { timedOut: true, winner: null };
    if (game.pendingDecision) {
      const fallback = fallbackDecision(game, game.pendingDecision);
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
  return { timedOut: false, winner: game.result?.winner ?? null, phase: game.phase };
}

console.log(`== 全档本地策略对局冒烟（每档 ${GAMES} 局）==`);
const results = {};
for (let players = 6; players <= 14; players += 1) {
  const outcomes = { good: 0, wolf: 0, neutral: 0, timedOut: 0 };
  for (let i = 0; i < GAMES; i += 1) {
    const result = playOne(players, 1000 + players * 100 + i);
    if (result.timedOut) {
      outcomes.timedOut += 1;
      continue;
    }
    assert.ok(result.winner === 'good' || result.winner === 'wolf' || result.winner === 'neutral', `${players} 人局胜者非法: ${result.winner}`);
    outcomes[result.winner] += 1;
  }
  results[players] = outcomes;
  assert.equal(outcomes.timedOut, 0, `${players} 人局出现死循环`);
  console.log(`${players} 人: 好 ${outcomes.good} / 狼 ${outcomes.wolf} / 中 ${outcomes.neutral} ✓`);
}
console.log('全档冒烟通过：无死循环、胜者全部合法 ✓');
