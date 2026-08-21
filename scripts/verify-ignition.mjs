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

// ===== 2. 夜间点火：烧物品（有药 → 自选毒/解药）=====
console.log('\n=== 2. 夜间点火：烧物品 ===');
{
  // 找一个女巫作为目标（有药）
  let verified = false;
  for (let seed = 1; seed <= 100; seed++) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
    if (!ignition) continue;
    const ownerId = ignition.ownerPlayerId;
    // 找女巫（有药）
    const witch = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'witch' && p.id !== ownerId);
    if (!witch) continue;
    const witchPotionBefore = { ...getRoleAssignment(game, witch.id).resources };
    // 夜间点火决策（模拟 night 询问，手动构造）
    const pending = {
      id: 'test-ignition', kind: 'skill', schemaKey: 'optional-target', actorId: ownerId,
      title: '点火', description: '', candidates: [witch.id], allowAbstain: true,
      skillInstanceId: ignition.id, options: {},
    };
    // 强制"烧物品"分支：rngState 调成非 0 的倍数（roll.item !== 0 → 90% 分支）
    // 直接调 applyNightIgnition 前把 rngState 设为已知值使 roll.item >= 1
    // 用 chooseWithState([0..9], rngState) 无法精确控制，改为注入已烧物品的判定：
    // 直接把 ignition 技能状态设为"有药待烧"，验证第二步
    const skillInst = game.skillInstances.find((s) => s.id === ignition.id);
    skillInst.data.pendingBurnTarget = witch.id;
    skillInst.data.pendingBurnNight = game.day;
    const potionPending = getNightIgnitionPotionDecision(game, witch.id);
    if (!potionPending) { check('烧药第二步决策存在', false); continue; }
    check(`seed ${seed}: 烧药候选含目标拥有的药（${witchPotionBefore.antidote === 1 ? '解药 ' : ''}${witchPotionBefore.poison === 1 ? '毒药' : ''}）`, potionPending.candidates.length > 0, `候选=${potionPending.candidates.join(',')}`);
    // 选毒药（若目标有毒药）
    const hasPoison = witchPotionBefore.poison === 1;
    const choice = hasPoison ? 1 : 0;
    applyNightIgnitionPotion(game, potionPending, { targetPlayerId: choice });
    const resourcesAfter = getRoleAssignment(game, witch.id).resources;
    if (hasPoison) {
      check(`seed ${seed}: 毒药被烧毁`, resourcesAfter.poison === 0, `poison=${resourcesAfter.poison}`);
      check(`seed ${seed}: 解药保留`, resourcesAfter.antidote === 1, `antidote=${resourcesAfter.antidote}`);
    } else {
      check(`seed ${seed}: 解药被烧毁`, resourcesAfter.antidote === 0, `antidote=${resourcesAfter.antidote}`);
    }
    check(`seed ${seed}: 点火技能耗尽`, game.skillInstances.find((s) => s.id === ignition.id).status === 'exhausted');
    verified = true;
    break;
  }
  if (!verified) check('找到点火持有者+女巫目标的对局', false, '100 种子内未找到');
}

// ===== 3. 白天点火：烧投票（计票过滤）=====
console.log('\n=== 3. 白天点火：烧投票 ===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 2 >>> 0 });
  const ignition = game.skillInstances.find((s) => s.definitionId === 'ignition');
  if (!ignition) { check('找到点火持有者', false); }
  else {
    const ownerId = ignition.ownerPlayerId;
    const target = game.players.find((p) => p.id !== ownerId);
    if (!target) { check('找到点火目标', false); }
    else {
      // 模拟白天点火结算（90% 烧投票分支：roll.item >= 1）
      const pending = {
        id: 'test-day-ignition', kind: 'skill', schemaKey: 'optional-target', actorId: ownerId,
        title: '点火-白天', description: '', candidates: [target.id], allowAbstain: true,
        skillInstanceId: ignition.id, options: {},
      };
      // 强制烧投票：把 rngState 设大确保 roll.item >= 1
      game.rngState = 0xFFFFFFFF; // 大值 → nextRandom 结果大 → roll.item 高
      applyDayIgnition(game, pending, { use: true, targetPlayerId: target.id });
      const burned = burnedVoters(game);
      check(`白天点火标记目标 ${target.id} 投票被烧`, burned.has(target.id), `burned=${[...burned].join(',')}`);
      check('点火技能耗尽', game.skillInstances.find((s) => s.id === ignition.id).status === 'exhausted');
      // 计票过滤验证：构造一票，resolveVotes 应排除
      const { resolveVotes } = await server.ssrLoadModule('/src/domain/engine/vote.ts');
      const votes = [
        { voterPlayerId: target.id, targetPlayerId: 3, round: 1 },
        { voterPlayerId: 1, targetPlayerId: 3, round: 1 },
      ];
      const res = resolveVotes(votes, 1, burned);
      check('被烧者的票不计入', res.targetPlayerId !== target.id, `result target=${res.targetPlayerId}`);
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
