#!/usr/bin/env node
/**
 * 回归测试：漂浮（远野汉娜）重构为隐匿技
 *
 * 新机制（每局一次，night-start 发动，覆盖当夜 + 次日白天）：
 * - 发动隐藏脚印：自己的行动不留可追溯记录，无公开播报
 * - 免疫（照常消耗对方技能）：预言家查验、幻视、千里眼看不到；
 *   女巫药、灵魂交换选中失败
 * - 不抵挡：魔女杀手（精准击杀）
 * - 跨天失效：次日白天结束后不再生效
 *
 * 验证：
 * 1. 发动：私密确认 + 无公开播报 + 技能 exhausted + isFloatingActive
 * 2. 预言家查验漂浮者：结果为空（私密"什么都没有看见"）
 * 3. 女巫毒漂浮者：毒药落空（消耗）
 * 4. 灵魂交换漂浮者：失败（消耗）
 * 5. 魔女杀手：不受漂浮影响
 * 6. 跨天失效：次日白天 isFloatingActive 为 false
 * 7. 完整对局正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getRoleAssignment, getSkillInstance;
let getLevitationDecision, applyLevitation, isFloatingActive, getNextNightSkillDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getRoleAssignment, getSkillInstance } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ getLevitationDecision, applyLevitation, isFloatingActive, getNextNightSkillDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
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

function findLevitationOwner(game) {
  const skill = game.skillInstances.find((s) => s.definitionId === 'levitation');
  if (skill) {
    return skill.ownerPlayerId;
  }
  return -1;
}

function createGameWithLevitation(seedStart) {
  for (let seed = seedStart; seed < seedStart + 300; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
    if (findLevitationOwner(game) >= 0) {
      return game;
    }
  }
  return null;
}

// 找一个"漂浮持有者非指定角色"的局（确保免疫对象与漂浮者是不同人）
function createGameWithLevitationAndRole(seedStart, roleId) {
  for (let seed = seedStart; seed < seedStart + 500; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
    const owner = findLevitationOwner(game);
    if (owner >= 0) {
      const roleOwner = game.players.find((p) => roleOf(game, p.id) === roleId);
      if (roleOwner && roleOwner.id !== owner) {
        return game;
      }
    }
  }
  return null;
}

function roleOf(game, playerId) {
  return getRoleAssignment(game, playerId).roleId;
}

// 用引擎驱动一次角色行动（设置 pendingDecision 后提交，返回新状态）
function act(game, pending, decision) {
  game.pendingDecision = pending;
  const next = reduceGame(game, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision });
  next.pendingDecision = null;
  return next;
}

// ===== 1. 发动：私密确认 + 无公开播报 + exhausted =====
console.log('=== 1. 发动漂浮 ===');
{
  const game = createGameWithLevitation(1);
  check('找到含漂浮的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const publicBefore = game.publicEvents.length;
  const decision = getLevitationDecision(game, getSkillInstance(game, ownerId));
  check('night-start 出漂浮决策（ignition use-only）', decision !== null && decision.schemaKey === 'ignition');
  applyLevitation(game, decision, { use: true });
  check('发动后技能 exhausted', getSkillInstance(game, ownerId).status === 'exhausted');
  check('生效期内 isFloatingActive 为 true', isFloatingActive(game, ownerId, game.day));
  check('发动无公开播报', game.publicEvents.length === publicBefore);
  const privateOwner = game.privateEvents.filter((e) => e.actorPlayerId === ownerId || e.targetPlayerIds.includes(ownerId));
  check('持有者收到私密确认', privateOwner.some((e) => e.text.includes('脚印')));
}

// ===== 1b. 保留漂浮：不再重复询问（回归：死循环 bug）=====
console.log('=== 1b. 保留漂浮不再询问 ===');
{
  let game = createGameWithLevitation(1);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const decision = getLevitationDecision(game, getSkillInstance(game, ownerId));
  applyLevitation(game, decision, { use: false });
  check('保留后技能未消耗', getSkillInstance(game, ownerId).status === 'ready');
  // 关键回归：保留后当天调度不应再次询问漂浮（此前因 key 不匹配死循环）
  const pending = getNextNightSkillDecision(game);
  check('保留后当天不再询问漂浮', pending === null || pending.title !== '漂浮');
  // 回归：保留只屏蔽当天（offerKey 含 day）；下一天漂浮仍可正常询问（未发动则保留可下一天用）
  game.day += 1;
  // 下一天调度可能先出更高优先级技能（如操控液体），循环推进直到出现漂浮或确认不出现
  let nextDayPending = null;
  let guard = 0;
  while (guard < 10) {
    guard += 1;
    const candidate = getNextNightSkillDecision(game);
    if (!candidate) {
      break;
    }
    if (candidate.title === '漂浮') {
      nextDayPending = candidate;
      break;
    }
    game.pendingDecision = candidate;
    const advanced = reduceGame(game, { type: 'submit-decision', pendingDecisionId: candidate.id, actorId: candidate.actorId, decision: fallbackDecision(game, candidate).decision });
    game.pendingDecision = null;
    game = advanced;
  }
  check('下一天漂浮仍可询问', nextDayPending !== null && nextDayPending.title === '漂浮');
}

// ===== 2. 预言家查验漂浮者：空结果 =====
console.log('=== 2. 预言家查验免疫 ===');
{
  const game = createGameWithLevitationAndRole(1, 'seer');
  check('找到含漂浮+预言家的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const seerId = game.players.find((p) => roleOf(game, p.id) === 'seer')?.id ?? -1;
  applyLevitation(game, getLevitationDecision(game, getSkillInstance(game, ownerId)), { use: true });
  const eventsBefore = game.privateEvents.length;
  const after = act(game, {
    id: `${game.gameId}-seer-${seerId}`, kind: 'seer-action', schemaKey: 'target', actorId: seerId,
    title: '查验', description: '', candidates: [ownerId], allowAbstain: false, skillInstanceId: null, options: {},
  }, { targetPlayerId: ownerId });
  const newEvents = after.privateEvents.slice(eventsBefore);
  const seerFeedback = newEvents.find((e) => e.actorPlayerId === seerId);
  check('预言家看到"什么都没有看见"', seerFeedback !== undefined && seerFeedback.text.includes('什么都没有看见'));
  // 回归：查验失败必须标记已行动（actionKind: seer-action），否则会无限重复查验
  const seerCheckCount = after.privateEvents.filter(
    (e) => e.actorPlayerId === seerId && e.text.includes('查验'),
  ).length;
  check('预言家仅查验一次（无死循环）', seerCheckCount === 1, `实际 ${seerCheckCount} 次`);
}

// ===== 3. 女巫毒漂浮者：落空 =====
console.log('=== 3. 女巫毒药免疫 ===');
{
  const game = createGameWithLevitationAndRole(2, 'witch');
  check('找到含漂浮+女巫的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const witchId = game.players.find((p) => roleOf(game, p.id) === 'witch')?.id ?? -1;
  applyLevitation(game, getLevitationDecision(game, getSkillInstance(game, ownerId)), { use: true });
  const eventsBefore = game.privateEvents.length;
  const after = act(game, {
    id: `${game.gameId}-witch-${witchId}`, kind: 'witch-action', schemaKey: 'witch', actorId: witchId,
    title: '女巫行动', description: '', candidates: getAliveIds(game), allowAbstain: false, skillInstanceId: null, options: {},
  }, { save: false, poisonTargetPlayerId: ownerId });
  const newEvents = after.privateEvents.slice(eventsBefore);
  const witchFeedback = newEvents.find((e) => e.actorPlayerId === witchId && e.text.includes('毒药'));
  check('女巫毒药落空', witchFeedback !== undefined && witchFeedback.text.includes('落空'));
  check('女巫毒药已消耗', getRoleAssignment(after, witchId).resources.poison === 0);
}

// ===== 4. 灵魂交换漂浮者：失败 =====
console.log('=== 4. 灵魂交换免疫 ===');
{
  let game = null;
  for (let seed = 3; seed < 503; seed += 1) {
    const g = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
    const hasLev = g.skillInstances.some((s) => s.definitionId === 'levitation');
    const hasExchange = g.skillInstances.some((s) => s.definitionId === 'soul-exchange');
    if (hasLev && hasExchange) {
      game = g;
      break;
    }
  }
  check('找到含漂浮+灵魂交换的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const exchangeOwner = game.players.find((p) => {
    const skill = game.skillInstances.find((s) => s.ownerPlayerId === p.id);
    return skill !== undefined && skill.definitionId === 'soul-exchange';
  })?.id ?? -1;
  applyLevitation(game, getLevitationDecision(game, getSkillInstance(game, ownerId)), { use: true });
  const beforeRole = roleOf(game, exchangeOwner);
  const eventsBefore = game.privateEvents.length;
  const after = act(game, {
    id: `${game.gameId}-exchange-${exchangeOwner}`, kind: 'skill', schemaKey: 'optional-target', actorId: exchangeOwner,
    title: '灵魂交换', description: '', candidates: [ownerId], allowAbstain: true,
    skillInstanceId: game.skillInstances.find((s) => s.ownerPlayerId === exchangeOwner)?.id ?? null, options: {},
  }, { use: true, targetPlayerId: ownerId });
  const newEvents = after.privateEvents.slice(eventsBefore);
  const feedback = newEvents.find((e) => e.actorPlayerId === exchangeOwner);
  check('灵魂交换失败（无职业互换）', roleOf(after, exchangeOwner) === beforeRole);
  check('灵魂交换持有者收到失败反馈', feedback !== undefined && feedback.text.includes('失败'));
}

// ===== 5. 魔女杀手不抵挡漂浮 =====
console.log('=== 5. 魔女杀手不抵挡 ===');
{
  let game = null;
  for (let seed = 5; seed < 505; seed += 1) {
    const g = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
    const hasLev = g.skillInstances.some((s) => s.definitionId === 'levitation');
    const hasKiller = g.skillInstances.some((s) => s.definitionId === 'witch-killer');
    if (hasLev && hasKiller) {
      game = g;
      break;
    }
  }
  check('找到含漂浮+魔女杀手的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  const killerOwner = game.players.find((p) => {
    const skill = game.skillInstances.find((s) => s.ownerPlayerId === p.id);
    return skill !== undefined && skill.definitionId === 'witch-killer';
  })?.id ?? -1;
  applyLevitation(game, getLevitationDecision(game, getSkillInstance(game, ownerId)), { use: true });
  const after = act(game, {
    id: `${game.gameId}-killer-${killerOwner}`, kind: 'skill', schemaKey: 'optional-target', actorId: killerOwner,
    title: '魔女杀手', description: '', candidates: [ownerId], allowAbstain: true,
    skillInstanceId: game.skillInstances.find((s) => s.ownerPlayerId === killerOwner)?.id ?? null, options: {},
  }, { use: true, targetPlayerId: ownerId });
  const preciseEvent = after.privateEvents.find(
    (e) => e.actorPlayerId === killerOwner && e.text.includes('精准击杀'),
  );
  check('魔女杀手成功标记漂浮者', preciseEvent !== undefined);
}

// ===== 6. 跨天失效 =====
console.log('=== 6. 跨天失效 ===');
{
  const game = createGameWithLevitation(4);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findLevitationOwner(game);
  applyLevitation(game, getLevitationDecision(game, getSkillInstance(game, ownerId)), { use: true });
  const startDay = game.day;
  check('发动夜生效', isFloatingActive(game, ownerId, startDay));
  check('次日白天仍生效', isFloatingActive(game, ownerId, startDay + 1));
  check('次日结束后失效', !isFloatingActive(game, ownerId, startDay + 2));
}

// ===== 7. 完整对局 =====
console.log('=== 7. 完整对局（本地策略）===');
{
  let game = createGameWithLevitation(42);
  if (!game) {
    process.exit(1);
  }
  let guard = 0;
  while (game.phase !== 'ended' && guard < 2000) {
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
  check('对局未死循环', guard < 2000);
}

console.log('');
console.log('===== 结果 =====');
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures > 0) {
  console.log('FAIL 漂浮重构验证未通过');
  process.exit(1);
}
console.log('PASS 漂浮重构验证全部通过');
await server.close();

// 辅助：存活玩家 id 列表
function getAliveIds(game) {
  return game.players.filter((p) => p.alive).map((p) => p.id);
}
