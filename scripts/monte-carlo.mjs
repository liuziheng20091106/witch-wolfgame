#!/usr/bin/env node
/**
 * 本地蒙特卡洛胜率统计（独立工具，不修改任何游戏源码）
 *
 * 用「本地确定性策略」（src/ai/fallback.ts，即游戏里的 LOCAL STRATEGY）
 * 自动跑 N 局观战模式对局，统计好人/狼人胜率、对局长度与技能使用情况。
 *
 * 注意：本地策略与真实 AI 决策差距较大（女巫首夜必救、毒药可用时随机下毒、狼人随机刀、投票随机等），
 * 统计结果只适合作为「改技能/改规则后的相对回归信号」，不宜当作真实平衡数值。
 *
 * 用法：
 *   node scripts/monte-carlo.mjs                 # 默认 200 局，起始种子 1
 *   node scripts/monte-carlo.mjs --games 1000 --seed 42
 *   node scripts/monte-carlo.mjs --json          # 输出 JSON，便于脚本分析
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

function getArg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`用法: node scripts/monte-carlo.mjs [--games N] [--seed N] [--max-iter N] [--json]

  --games N      对局数（默认 200）
  --seed N       起始随机种子（默认 1），每局种子 = seed + 局号
  --players N    玩家人数 6-14（默认 6，对应固定版型表）
  --max-iter N   单局最大状态推进次数，防止死循环（默认 5000）
  --json         输出 JSON 而非人类可读表格`);
  process.exit(0);
}

const GAMES = Math.max(1, Number(getArg('games', 200)) || 200);
const SEED = Number(getArg('seed', 1)) >>> 0;
const PLAYER_COUNT = Math.min(14, Math.max(6, Number(getArg('players', 6)) || 6));
const MAX_ITER = Math.max(100, Number(getArg('max-iter', 5000)) || 5000);
const AS_JSON = process.argv.includes('--json');

// 通过 Vite 的 SSR 模块加载器直接加载引擎（无需打包器，兼容 .json/.png 等资源导入）
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, reduceGame, fallbackDecision, witchSkillDefinitions, roleNames;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ witchSkillDefinitions } = await server.ssrLoadModule('/src/domain/catalog/witchSkills.ts'));
  ({ roleNames } = await server.ssrLoadModule('/src/domain/catalog/roles.ts'));
} finally {
  await server.close();
}

function playOne(seed) {
  let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: PLAYER_COUNT, selectedCharacterIds: [] });
  let iterations = 0;
  while (game.phase !== 'ended') {
    if (++iterations > MAX_ITER) return { timedOut: true, winner: null, day: game.day, exhausted: new Set(), deadByRole: {} };
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
  const used = new Set(
    game.skillInstances
      .filter(
        (skill) => skill.status === 'exhausted' || skill.data.lastUsedNight !== undefined || game.causalLocks.includes(skill.id),
      )
      .map((skill) => skill.definitionId),
  );
  const deadByRole = {};
  for (const player of game.players) {
    if (player.alive) continue;
    const roleId = game.roleAssignments.find((assignment) => assignment.id === player.roleAssignmentId)?.roleId;
    if (roleId) deadByRole[roleId] = (deadByRole[roleId] ?? 0) + 1;
  }
  return { timedOut: false, winner: game.result?.winner ?? null, day: game.day, exhausted: used, deadByRole };
}

const stats = {
  games: GAMES,
  good: 0,
  wolf: 0,
  neutral: 0,
  timedOut: 0,
  days: [],
  skillUsage: {},
  deadByRole: {},
};
for (let index = 0; index < GAMES; index += 1) {
  const result = playOne((SEED + index) >>> 0);
  if (result.timedOut) {
    stats.timedOut += 1;
    continue;
  }
  if (result.winner === 'wolf') stats.wolf += 1;
  else if (result.winner === 'good') stats.good += 1;
  else if (result.winner === 'neutral') stats.neutral += 1;
  stats.days.push(result.day);
  for (const skillId of result.exhausted) stats.skillUsage[skillId] = (stats.skillUsage[skillId] ?? 0) + 1;
  for (const [roleId, count] of Object.entries(result.deadByRole)) {
    stats.deadByRole[roleId] = (stats.deadByRole[roleId] ?? 0) + count;
  }
}

const finished = stats.good + stats.wolf + stats.neutral;
const wolfRate = finished > 0 ? ((stats.wolf / finished) * 100).toFixed(1) : 'N/A';
const neutralRate = finished > 0 ? ((stats.neutral / finished) * 100).toFixed(1) : 'N/A';
const avgDays = stats.days.length > 0 ? (stats.days.reduce((sum, day) => sum + day, 0) / stats.days.length).toFixed(2) : 'N/A';
const minDays = stats.days.length > 0 ? Math.min(...stats.days) : '-';
const maxDays = stats.days.length > 0 ? Math.max(...stats.days) : '-';

if (AS_JSON) {
  const summary = {
    ...stats,
    wolfRatePercent: Number(wolfRate),
    avgDays: Number(avgDays),
    minDays,
    maxDays,
    skillUsage: Object.fromEntries(Object.entries(stats.skillUsage).sort((a, b) => b[1] - a[1])),
    skillNames: Object.fromEntries(Object.entries(witchSkillDefinitions).map(([id, def]) => [id, def.name])),
  };
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('================ 本地蒙特卡洛结果 ================');
  console.log(`人数: ${PLAYER_COUNT}人局  对局数: ${GAMES}  起始种子: ${SEED}  完成: ${finished}  超时: ${stats.timedOut}`);
  console.log(`好人胜: ${stats.good} (${finished > 0 ? ((stats.good / finished) * 100).toFixed(1) : 'N/A'}%)  狼人胜: ${stats.wolf} (${wolfRate}%)  呆头鹅胜: ${stats.neutral} (${neutralRate}%)`);
  console.log(`对局长度(天): 平均 ${avgDays}  最短 ${minDays}  最长 ${maxDays}`);
  console.log('');
  console.log('技能使用率（按使用局数排序）:');
  const usage = Object.entries(stats.skillUsage).sort((a, b) => b[1] - a[1]);
  for (const [skillId, count] of usage) {
    const name = witchSkillDefinitions[skillId]?.name ?? skillId;
    console.log(`  ${name.padEnd(6)} ${String(count).padStart(4)} / ${GAMES} 局 (${((count / GAMES) * 100).toFixed(1)}%)`);
  }
  console.log('');
  console.log('职业死亡总数（全部对局合计）:');
  for (const [roleId, count] of Object.entries(stats.deadByRole).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(roleNames[roleId] ?? roleId).padEnd(4)} ${String(count).padStart(4)} 次`);
  }
  console.log('=================================================');
  console.log('提示: 本地策略与真实 AI 差距较大，结果仅作相对回归参考；');
  console.log('建议改技能后与改动前对比胜率/使用率，并辅以少量真实 AI 对局校准。');
}
