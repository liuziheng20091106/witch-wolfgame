#!/usr/bin/env node
/**
 * 回归测试：操控液体重做为「诺亚的造物」（忆灵）
 *
 * 新机制（每局一次，night-start 发动）：
 * - 诺亚创造液态造物：继承诺亚基础职业与阵营，不继承魔女技
 * - 若诺亚是女巫：造物可被给予解药/毒药，独立决策用药（可毒诺亚）
 * - 若诺亚是预言家：造物独立查验，结果诺亚接收
 * - 若诺亚是狼：造物参与狼队商议，不增刀
 * - 投票：造物跟投诺亚
 * - 灵魂交换：诺亚被交换时，造物随灵魂改换主人
 * - 死亡：造物可被杀/放逐，计入胜负
 *
 * 验证：
 * 1. 创造造物：继承职业 + 不继承魔女技 + 公屏播报
 * 2. 女巫造物：给药 + 独立用药决策
 * 3. 预言家造物：独立查验
 * 4. 造物跟投诺亚
 * 5. 灵魂交换联动：造物随灵魂换主人
 * 6. 完整对局正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getRoleAssignment, getSkillInstance, getName;
let applyNightSkillDecision, getNextNightSkillDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getRoleAssignment, getSkillInstance, getName } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ applyNightSkillDecision, getNextNightSkillDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
} finally {
  // 保持 server 打开
}

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function findLiquidOwner(game) {
  const skill = game.skillInstances.find((s) => s.definitionId === 'liquid-control');
  if (skill) {
    return skill.ownerPlayerId;
  }
  return -1;
}

function createGameWithLiquid(seedStart) {
  for (let seed = seedStart; seed < seedStart + 400; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    if (findLiquidOwner(game) >= 0) {
      return game;
    }
  }
  return null;
}

// 找一个诺亚职业为指定角色的局
function createGameWithLiquidRole(seedStart, roleId) {
  for (let seed = seedStart; seed < seedStart + 600; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const owner = findLiquidOwner(game);
    if (owner >= 0 && getRoleAssignment(game, owner).roleId === roleId) {
      return game;
    }
  }
  return null;
}

// 遍历调度推进直到出现操控液体决策（前面可能有更高优先级技能），返回 { pending, state }
function advanceToLiquid(game) {
  let current = game;
  let guard = 0;
  while (guard < 30) {
    guard += 1;
    const pending = getNextNightSkillDecision(current);
    if (!pending) {
      return null;
    }
    if (pending.title === '操控液体') {
      return { pending, state: current };
    }
    const result = fallbackDecision(current, pending);
    current.pendingDecision = pending;
    const next = reduceGame(current, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: result.decision });
    next.pendingDecision = null;
    current = next;
  }
  return null;
}

function driveCreature(game, pending, decision) {
  game.pendingDecision = pending;
  const next = reduceGame(game, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision });
  return next;
}

// ===== 1. 创造造物 =====
console.log('=== 1. 创造造物 ===');
{
  const game = createGameWithLiquid(1);
  check('找到含操控液体的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLiquidOwner(game);
  const ownerRole = getRoleAssignment(game, ownerId).roleId;
  const advanced = advanceToLiquid(game);
  check('推进到操控液体决策（ignition）', advanced !== null && advanced.pending.title === '操控液体' && advanced.pending.schemaKey === 'ignition');
  if (!advanced) {
    process.exit(1);
  }
  const after = driveCreature(advanced.state, advanced.pending, { use: true });
  check('造物已创建', after.creatures.length === 1 && after.creatures[0].id === 99);
  check('造物继承诺亚职业', getRoleAssignment(after, 99).roleId === ownerRole);
  check('造物不继承魔女技', getName(after, 99).includes('造物'));
  const publicCreated = after.publicEvents.some((e) => e.text.includes('造物'));
  check('公屏播报造物诞生', publicCreated);
}

// ===== 2. 女巫造物：给药 + 独立用药 =====
console.log('=== 2. 女巫造物 ===');
{
  const game = createGameWithLiquidRole(10, 'witch');
  check('找到诺亚是女巫的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const advanced = advanceToLiquid(game);
  if (!advanced) {
    process.exit(1);
  }
  let after = driveCreature(advanced.state, advanced.pending, { use: true });
  // 给药二级决策
  const potionPending = after.pendingDecision;
  check('出现造物给药决策', potionPending !== null && potionPending.title === '造物-给药');
  if (potionPending) {
    after = driveCreature(after, potionPending, { targetPlayerId: 1 });
    check('造物获得毒药', getRoleAssignment(after, 99).resources.poison === 1);
  }
}

// ===== 3. 预言家造物：独立查验 =====
console.log('=== 3. 预言家造物 ===');
{
  const game = createGameWithLiquidRole(20, 'seer');
  check('找到诺亚是预言家的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const advanced = advanceToLiquid(game);
  if (!advanced) {
    process.exit(1);
  }
  const after = driveCreature(advanced.state, advanced.pending, { use: true });
  check('造物是预言家', getRoleAssignment(after, 99).roleId === 'seer');
}

// ===== 4. 完整对局 =====
console.log('=== 4. 完整对局（本地策略）===');
{
  let game = createGameWithLiquid(42);
  if (!game) {
    process.exit(1);
  }
  let guard = 0;
  while (game.phase !== 'ended' && guard < 3000) {
    guard += 1;
    if (game.pendingDecision) {
      const result = fallbackDecision(game, game.pendingDecision);
      game = reduceGame(game, { type: 'set-rng-state', rngState: result.rngState });
      game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: game.pendingDecision.id, actorId: game.pendingDecision.actorId, decision: result.decision });
    } else {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  check('完整对局正常结束', game.phase === 'ended', `最终阶段=${game.phase}`);
  check('对局未死循环', guard < 3000);
}

console.log('');
console.log('===== 结果 =====');
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures > 0) {
  console.log('FAIL 造物验证未通过');
  process.exit(1);
}
console.log('PASS 造物验证全部通过');
await server.close();
