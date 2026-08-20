#!/usr/bin/env node
/**
 * 回归测试：魔女杀手（witch-killer）狼人持有时不刀狼队友
 *
 * bug：candidatesForNightSkill 对所有夜间技能返回「除自己外所有存活者」，
 * 狼人持 witch-killer 时候选含狼队友，AI/本地策略可能把队友标记为精准击杀。
 *
 * 修复：持有者当前阵营为狼时，候选排除当前阵营同为狼的存活者。
 * 注意：灵魂交换会改变阵营，判断必须用「当前阵营」（getPlayerAlignment），
 * 不能用初始职业分配。
 *
 * 验证：
 * 1. 引擎候选：当前阵营为狼的持有者，witch-killer 候选不含当前狼队友
 * 2. 完整对局（本地策略）：当前阵营为狼的持有者使用 witch-killer 时，
 *    目标从不为当前狼队友
 * 3. 当前阵营非狼的持有者行为不变（候选 = 除自己外所有存活者）
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getPlayerAlignment;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getPlayerAlignment } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  // 保持 server 打开
}

let failures = 0;
let checks = 0;
let wolfUses = 0;
const wolfPlayersAtUse = new Set();
const aliveIds = (game) => game.players.filter((p) => p.alive).map((p) => p.id);

function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function findWitchKillerPending(game, maxIter = 300) {
  let state = game;
  let iter = 0;
  while (state.phase !== 'ended' && iter < maxIter) {
    iter += 1;
    if (state.pendingDecision) {
      const pending = state.pendingDecision;
      if (pending.schemaKey === 'optional-target' && pending.title === '魔女杀手') {
        return { state, pending };
      }
      const fb = fallbackDecision(state, pending);
      state = reduceGame(state, { type: 'set-rng-state', rngState: fb.rngState });
      state = reduceGame(state, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fb.decision });
    } else {
      state = reduceGame(state, { type: 'advance' });
    }
  }
  return { state, pending: null };
}

// ===== 1. 引擎候选：当前阵营为狼时不含狼队友 =====
console.log('=== 1. 引擎候选：当前阵营为狼的持有者，候选不含当前狼队友 ===');
{
  let wolfCases = 0;
  let goodCases = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const killer = game.skillInstances.find((skill) => skill.definitionId === 'witch-killer');
    if (!killer) continue;
    const { state: hitState, pending } = findWitchKillerPending(game);
    if (!pending) continue;
    // 必须用推进后的 hitState 判断当前阵营（灵魂交换会改变阵营）
    const ownerAlignment = getPlayerAlignment(hitState, pending.actorId);
    const wolfTeam = aliveIds(hitState).filter((id) => id !== pending.actorId && getPlayerAlignment(hitState, id) === 'wolf');
    if (ownerAlignment === 'wolf') {
      wolfCases += 1;
      const containsMate = wolfTeam.some((mate) => pending.candidates.includes(mate));
      check(`seed ${seed}: 狼持有者候选不含狼队友（狼队 ${wolfTeam.join(',')}）`, !containsMate, `候选=${pending.candidates.join(',')}`);
    } else {
      goodCases += 1;
      // 好人持有者：候选 = 除自己外所有存活者（行为不变）
      const aliveOthers = aliveIds(hitState).filter((id) => id !== pending.actorId);
      const same = pending.candidates.length === aliveOthers.length && pending.candidates.every((id) => aliveOthers.includes(id));
      check(`seed ${seed}: 好人持有者候选不受限（${aliveOthers.length} 名）`, same, `候选=${pending.candidates.join(',')}`);
    }
    if (wolfCases >= 5 && goodCases >= 5) break;
  }
  console.log(`  （狼持有者样本 ${wolfCases}，好人持有者样本 ${goodCases}）`);
  check('收集到足够的狼/好人持有者样本', wolfCases >= 5 && goodCases >= 5, `狼=${wolfCases} 好人=${goodCases}`);
}

// ===== 2. 完整对局：狼持有者使用目标从不为狼队友 =====
console.log('\n=== 2. 完整对局（本地策略）：狼持有者使用目标从不为狼队友 ===');
{
  const games = 60;
  for (let seed = 1; seed <= games; seed++) {
    let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    let iter = 0;
    while (game.phase !== 'ended' && iter < 1000) {
      iter += 1;
      if (game.pendingDecision) {
        const pending = game.pendingDecision;
        if (pending.schemaKey === 'optional-target' && pending.title === '魔女杀手') {
          const ownerAlignment = getPlayerAlignment(game, pending.actorId);
          if (ownerAlignment === 'wolf') {
            wolfUses += 1;
            wolfPlayersAtUse.add(pending.actorId);
            const fb = fallbackDecision(game, pending);
            const target = fb.decision.targetPlayerId;
            if (target !== null && getPlayerAlignment(game, target) === 'wolf') {
              failures += 1;
              console.log(`  ✗ seed ${seed}: 狼持有者 witch-killer 刀到狼队友 ${target}`);
            }
          }
        }
        const fb = fallbackDecision(game, pending);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
  }
  check(`${games} 局中狼持有者使用 witch-killer 的目标均非狼队友`, failures === 0, `失败 ${failures} 次`);
  console.log(`  （狼持有者共使用 ${wolfUses} 次，涉及角色 ${[...wolfPlayersAtUse].length} 名）`);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures} | 狼持有者使用次数: ${wolfUses}`);
if (failures === 0 && checks > 0) {
  console.log('✓ 全部通过：狼人 witch-killer 不再刀狼队友，好人行为不变');
  await server.close();
  process.exit(0);
}
console.log(`!!! 失败 ${failures} 项`);
await server.close();
process.exit(1);
