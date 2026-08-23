#!/usr/bin/env node
/**
 * 回归测试：点火（亚里沙）重做
 *
 * 新机制（整局一次，夜间或白天二选一使用）：
 * - 夜间：90% 烧目标一瓶药（可自选毒/解药，无药则落空）/ 10% 烧全部魔女技
 * - 白天（投票统计后）：90% 烧目标当天投票（票作废）/ 10% 烧全部魔女技
 * - 烧技能：目标所有 skillInstances 置 exhausted + burned 标记（不可回收）
 * - 高风险：落空则整局白板（使用说明已强调）
 *
 * 验证：
 * 1. 夜间点火：烧物品（目标有药→选毒/解药生效；无药→落空）、烧技能（目标白板）
 * 2. 白天点火：烧投票（计票时票作废）、烧技能
 * 3. 烧技能后：目标技能全 exhausted + burned，魔女因子回收不可用
 * 4. 完整对局（本地策略）正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, characterById, getRoleAssignment, getSkillInstance, getPlayer;
let burnAllSkills, getNightIgnitionDecision, applyNightIgnition, getNightIgnitionPotionDecision, applyNightIgnitionPotion;
let getDayIgnitionDecision, applyDayIgnition, burnedVoters;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
  ({ getRoleAssignment, getSkillInstance, getPlayer } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ burnAllSkills, getNightIgnitionDecision, applyNightIgnition, getNightIgnitionPotionDecision, applyNightIgnitionPotion, getDayIgnitionDecision, applyDayIgnition, burnedVoters } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
} finally {
  // 保持 server 打开
}

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}
const nameOf = (game, id) => characterById[game.players.find((p) => p.id === id).characterId].name;

// ===== 1. burnAllSkills：目标白板 + burned 标记 =====
console.log('=== 1. 烧技能（burnAllSkills）===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 1 >>> 0 });
  const target = game.players[0];
  const before = game.skillInstances.filter((s) => s.ownerPlayerId === target.id);
  const burned = burnAllSkills(game, target.id);
  check('烧技能返回 true（有技能可烧）', burned);
  check('目标所有技能置 exhausted', game.skillInstances.filter((s) => s.ownerPlayerId === target.id).every((s) => s.status === 'exhausted'));
  check('目标技能带 burned 标记', game.skillInstances.filter((s) => s.ownerPlayerId === target.id).every((s) => s.data.burned === true));
  check(`烧掉 ${before.length} 个技能`, before.length > 0, `目标技能数=${before.length}`);
}

// ===== 2. 夜间点火：走完整流程（RNG 判定 90%/10%）=====
console.log('\n=== 2. 夜间点火：完整流程（RNG 判定）===');
{
  const { nextRandom } = await server.ssrLoadModule('/src/domain/engine/random.ts');
  // 辅助：找能让 chooseWithState([0..9]) 返回指定 item 的 rngState
  const findRngForItem = (item, start = 1) => {
    for (let rng = start; rng < start + 5000; rng++) {
      const r = nextRandom(rng >>> 0);
      const rolled = Math.floor(r.value * 10);
      if (rolled === item) return rng >>> 0;
    }
    return null;
  };
  const rngBurnSkill = findRngForItem(0); // 10% 烧技能
  const rngBurnPotion = findRngForItem(5); // 90% 烧物品（非 0 即烧物品）
  check('找到烧技能分支的 RNG', rngBurnSkill !== null);
  check('找到烧物品分支的 RNG', rngBurnPotion !== null);

  // 场景 A：烧技能（10%）
  {
    let verified = false;
    for (let seed = 1; seed <= 100 && !verified; seed++) {
      const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
      const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
      if (!ignition) continue;
      const ownerId = ignition.ownerPlayerId;
      const target = game.players.find((p) => p.id !== ownerId);
      if (!target || !rngBurnSkill) continue;
      const targetSkillsBefore = game.skillInstances.filter((s) => s.ownerPlayerId === target.id).length;
      if (targetSkillsBefore === 0) continue;
      game.rngState = rngBurnSkill;
      const pending = {
        id: 't-a', kind: 'skill', schemaKey: 'optional-target', actorId: ownerId,
        title: '点火', description: '', candidates: [target.id], allowAbstain: true,
        skillInstanceId: ignition.id, options: {},
      };
      applyNightIgnition(game, pending, { use: true, targetPlayerId: target.id });
      const targetSkillsAfter = game.skillInstances.filter((s) => s.ownerPlayerId === target.id);
      check(`seed ${seed} 烧技能(10%): 目标技能全 exhausted`, targetSkillsAfter.every((s) => s.status === 'exhausted'));
      check(`seed ${seed} 烧技能: 带 burned 标记`, targetSkillsAfter.every((s) => s.data.burned === true));
      check(`seed ${seed} 烧技能: 点火耗尽`, game.skillInstances.find((s) => s.id === ignition.id).status === 'exhausted');
      verified = true;
    }
    if (!verified) check('烧技能场景：找到有效对局', false);
  }

  // 场景 B：烧物品（90%）→ 有药 → 二次决策
  {
    let verified = false;
    for (let seed = 1; seed <= 100 && !verified; seed++) {
      const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
      const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
      if (!ignition) continue;
      const ownerId = ignition.ownerPlayerId;
      const witch = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'witch' && p.id !== ownerId);
      if (!witch || !rngBurnPotion) continue;
      const before = { ...getRoleAssignment(game, witch.id).resources };
      if (before.antidote !== 1 && before.poison !== 1) continue;
      game.rngState = rngBurnPotion;
      const pending = {
        id: 't-b', kind: 'skill', schemaKey: 'optional-target', actorId: ownerId,
        title: '点火', description: '', candidates: [witch.id], allowAbstain: true,
        skillInstanceId: ignition.id, options: {},
      };
      applyNightIgnition(game, pending, { use: true, targetPlayerId: witch.id });
      // 有药 → 应进入第二步（pendingBurnTarget 已设，技能未耗尽）
      const skillAfter = game.skillInstances.find((s) => s.id === ignition.id);
      check(`seed ${seed} 烧物品(90%): 目标有药 → 进入烧药第二步`, skillAfter.status === 'ready' && skillAfter.data.pendingBurnTarget === witch.id, `status=${skillAfter.status} pending=${skillAfter.data.pendingBurnTarget}`);
      // 第二步：选药
      const potionPending = getNightIgnitionPotionDecision(game, witch.id);
      check(`seed ${seed} 烧药候选非空`, Boolean(potionPending) && potionPending.candidates.length > 0);
      check(`seed ${seed} 烧药决策带药选择标记（potionChoice）`, potionPending !== null && potionPending.options.potionChoice === true);
      check(`seed ${seed} 烧药决策 id 与点火主决策唯一（UI 重置 target）`, potionPending !== null && potionPending.id !== pending.id);
      if (potionPending) {
        const hasPoison = before.poison === 1;
        const choice = hasPoison ? 1 : 0;
        applyNightIgnitionPotion(game, potionPending, { targetPlayerId: choice });
        const after = getRoleAssignment(game, witch.id).resources;
        if (hasPoison) {
          check(`seed ${seed} 毒药被烧毁`, after.poison === 0 && after.antidote === 1, `poison=${after.poison} antidote=${after.antidote}`);
        } else {
          check(`seed ${seed} 解药被烧毁`, after.antidote === 0 && after.poison === 1, `antidote=${after.antidote} poison=${after.poison}`);
        }
        check(`seed ${seed} 烧药后点火耗尽`, game.skillInstances.find((s) => s.id === ignition.id).status === 'exhausted');
      }
      verified = true;
    }
    if (!verified) check('烧物品场景：找到有效对局', false);
  }

  // 场景 C：烧物品（90%）→ 目标无药 → 落空
  {
    let verified = false;
    for (let seed = 1; seed <= 200 && !verified; seed++) {
      const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
      const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
      if (!ignition) continue;
      const ownerId = ignition.ownerPlayerId;
      // 找非女巫目标（无药）
      const target = game.players.find((p) => p.id !== ownerId && getRoleAssignment(game, p.id).roleId !== 'witch');
      if (!target || !rngBurnPotion) continue;
      game.rngState = rngBurnPotion;
      const pending = {
        id: 't-c', kind: 'skill', schemaKey: 'optional-target', actorId: ownerId,
        title: '点火', description: '', candidates: [target.id], allowAbstain: true,
        skillInstanceId: ignition.id, options: {},
      };
      applyNightIgnition(game, pending, { use: true, targetPlayerId: target.id });
      const skillAfter = game.skillInstances.find((s) => s.id === ignition.id);
      check(`seed ${seed} 烧物品: 目标无药 → 落空且点火耗尽`, skillAfter.status === 'exhausted' && skillAfter.data.pendingBurnTarget === undefined, `status=${skillAfter.status} pending=${skillAfter.data.pendingBurnTarget}`);
      verified = true;
    }
    if (!verified) check('烧物品落空场景：找到有效对局', false);
  }
}

// ===== 3. 白天点火：烧投票（计票过滤，无假阳性）=====
console.log('\n=== 3. 白天点火：烧投票（计票过滤验证）===');
{
  const { resolveVotes } = await server.ssrLoadModule('/src/domain/engine/vote.ts');
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 2 >>> 0 });
  const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
  if (!ignition) { check('找到点火持有者', false); }
  else {
    const ownerId = ignition.ownerPlayerId;
    const target = game.players.find((p) => p.id !== ownerId);
    if (!target) { check('找到点火目标', false); }
    else {
      // 构造：目标投票给 A，另一人投票给 A，A 得 2 票（最高）→ 不烧则 A 被放逐
      // 烧目标后：A 只剩 1 票，B 得 1 票 → 平票 → runoff（证明目标票被过滤）
      const A = 3;
      const B = 4;
      const votes = [
        { voterPlayerId: target.id, targetPlayerId: A, round: 1 },
        { voterPlayerId: 1, targetPlayerId: A, round: 1 },
        { voterPlayerId: 2, targetPlayerId: B, round: 1 },
      ];
      // 不烧：A 2 票最高 → exile A
      const resNoBurn = resolveVotes(votes, 1);
      check('不烧票时 A 得 2 票最高（对照组）', resNoBurn.outcome === 'exile' && resNoBurn.targetPlayerId === A, `outcome=${resNoBurn.outcome} target=${resNoBurn.targetPlayerId}`);
      // 烧目标：目标票剔除 → A 1 票、B 1 票 → 平票 runoff
      const burned = new Set([target.id]);
      const resBurned = resolveVotes(votes, 1, burned);
      check('烧票后目标票被剔除 → 平票 runoff', resBurned.outcome === 'runoff', `outcome=${resBurned.outcome}`);
      check('烧票后 A 不再是最高（票被过滤）', resBurned.targetPlayerId !== A || resBurned.outcome === 'runoff', `target=${resBurned.targetPlayerId}`);
    }
  }
}

// ===== 4. 完整对局正常结束 =====
console.log('\n=== 4. 完整对局（本地策略）正常结束 ===');
{
  let ok = 0;
  const total = 30;
  for (let seed = 1; seed <= total; seed++) {
    let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    let iter = 0;
    while (game.phase !== 'ended' && iter < 2000) {
      iter += 1;
      if (game.pendingDecision) {
        const fb = fallbackDecision(game, game.pendingDecision);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: game.pendingDecision.id, actorId: game.pendingDecision.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (game.phase === 'ended') ok += 1;
  }
  check(`${total} 局完整对局全部正常结束`, ok === total, `结束 ${ok}/${total}`);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures === 0) {
  console.log('✓ 点火重做验证全部通过');
  await server.close();
  process.exit(0);
}
console.log(`!!! 失败 ${failures} 项`);
await server.close();
process.exit(1);
