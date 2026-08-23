#!/usr/bin/env node
/**
 * 回归测试：千里眼（可可）重做为主动技——白天开播，观看者职业被获知
 *
 * 新机制（每局一次，白天，发言前）：
 * - 开播决策（use-only）：公屏播报"可可开启了直播"；保留则当天不再询问
 * - 观看决策（逐观众，候选=自己）：观看→可可获知观看者职业（私密列表）；不观看→无事
 * - 观看名单仅可可可见，不公开播报
 * - 观看者私密反馈 + 策略提示（确认同阵营可获铁证；狼人通常不观看）
 *
 * 验证：
 * 1. 开播：公屏事件 + 可可私密确认 + 技能 exhausted
 * 2. 观看：可可收到"X 观看了直播，职业是 Y"知识事实；观众收到私密反馈
 * 3. 不观看：无知识产生，观众收到保留私密事件
 * 4. 观看名单仅可可可见（公屏事件不含观众名）
 * 5. 保留开播后：当天不再重复询问（wasOffered）
 * 6. 完整对局（本地策略）正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, getRoleAssignment, getSkillInstance, getPlayer, fallbackDecision, characterById;
let getClairvoyanceDecision, applyClairvoyanceDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
  ({ getRoleAssignment, getSkillInstance, getPlayer } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ getClairvoyanceDecision, applyClairvoyanceDecision } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts'));
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

function privateEventsFor(game, playerId) {
  return game.privateEvents.filter(
    (e) => e.actorPlayerId === playerId || e.targetPlayerIds.includes(playerId),
  );
}

// 找到持有千里眼的座位（soul-13 泽渡可可）
function findClairvoyanceOwner(game) {
  const skill = game.skillInstances.find((s) => s.definitionId === 'clairvoyance');
  if (skill) {
    return skill.ownerPlayerId;
  }
  return -1;
}

// 遍历 seed 生成一个含千里眼持有者的对局（spectator 模式 6 人从 14 角色随机抽取）
function createGameWithClairvoyance(seedStart) {
  for (let seed = seedStart; seed < seedStart + 200; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    if (findClairvoyanceOwner(game) >= 0) {
      return game;
    }
  }
  return null;
}

// 找到一个不是开播者的存活观众
function findViewer(game, ownerId) {
  const player = game.players.find((p) => p.id !== ownerId && p.alive);
  if (player) {
    return player.id;
  }
  return -1;
}

// ===== 1. 开播：公屏播报 + 可可私密确认 + exhausted =====
console.log('=== 1. 开播决策 ===');
{
  const game = createGameWithClairvoyance(11);
  check('找到含千里眼的对局', game !== null);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  check('存在千里眼持有者', ownerId >= 0);
  const skill = getSkillInstance(game, ownerId);
  check('千里眼技能初始 ready', skill.definitionId === 'clairvoyance' && skill.status === 'ready');

  const decision = getClairvoyanceDecision(game);
  check('day-start 出开播决策', decision !== null && decision.title === '千里眼');
  check('开播决策 schema 为 ignition（use-only）', decision !== null && decision.schemaKey === 'ignition');

  const eventsBefore = game.publicEvents.length;
  applyClairvoyanceDecision(game, decision, { use: true });
  const liveEvents = game.publicEvents.slice(eventsBefore);
  check('公屏播报开播', liveEvents.some((e) => e.text.includes('开启了直播')));
  check('技能已 exhausted', getSkillInstance(game, ownerId).status === 'exhausted');
  const privateForOwner = privateEventsFor(game, ownerId);
  check('可可收到私密确认', privateForOwner.some((e) => e.text.includes('开启')));

  // 开播后进入观看阶段
  const viewerDecision = getClairvoyanceDecision(game);
  check('开播后出观看决策', viewerDecision !== null && viewerDecision.title === '观看直播');
  check('观看决策 actor 是观众（非开播者）', viewerDecision !== null && viewerDecision.actorId !== ownerId);
  check('观看决策 schema 为 ignition（use-only）', viewerDecision !== null && viewerDecision.schemaKey === 'ignition');
  check('观看决策无目标候选（目标固定为观众自己）', viewerDecision !== null && viewerDecision.candidates.length === 0);
}

// ===== 2. 观看：可可获知职业 + 观众私密反馈 =====
console.log('=== 2. 观看直播 ===');
{
  const game = createGameWithClairvoyance(11);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  const viewerId = findViewer(game, ownerId);
  const stream = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, stream, { use: true });

  const viewerDecision = getClairvoyanceDecision(game);
  const viewerRoleBefore = getRoleAssignment(game, viewerId).roleId;
  applyClairvoyanceDecision(game, viewerDecision, { use: true });

  const ownerKnowledge = game.knowledgeByPlayer[ownerId];
  const roleFact = ownerKnowledge.find(
    (fact) => fact.subjectPlayerId === viewerId && fact.kind === 'role',
  );
  check('可可获得观众职业知识', roleFact !== undefined && roleFact.value === viewerRoleBefore);

  const privateForViewer = privateEventsFor(game, viewerId);
  check('观众收到私密反馈（身份已传送）', privateForViewer.some((e) => e.text.includes('因此知晓了')));
  const privateForOwner = privateEventsFor(game, ownerId);
  check('可可收到观看名单私密事件', privateForOwner.some((e) => e.text.includes('观看了') && e.text.includes('直播，职业是')));
}

// ===== 3. 不观看：无知识 + 观众保留事件 =====
console.log('=== 3. 不观看直播 ===');
{
  const game = createGameWithClairvoyance(11);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  const viewerId = findViewer(game, ownerId);
  const stream = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, stream, { use: true });

  const viewerDecision = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, viewerDecision, { use: false });

  const ownerKnowledge = game.knowledgeByPlayer[ownerId];
  check('不观看：可可无该观众职业知识', !ownerKnowledge.some((fact) => fact.subjectPlayerId === viewerId && fact.kind === 'role'));
  const privateForViewer = privateEventsFor(game, viewerId);
  check('不观看：观众收到带名字的保留事件', privateForViewer.some((e) => e.text.includes('决定不观看')));

  // 该观众已被询问，下一个观看决策应是其他观众
  const nextDecision = getClairvoyanceDecision(game);
  check('下一位观众被询问', nextDecision !== null && nextDecision.actorId !== viewerId);
}

// ===== 4. 观看名单不公开 =====
console.log('=== 4. 观看名单不公开 ===');
{
  const game = createGameWithClairvoyance(11);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  const viewerId = findViewer(game, ownerId);
  const publicCountBefore = game.publicEvents.length;
  const stream = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, stream, { use: true });
  const viewerDecision = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, viewerDecision, { use: true });

  // 只检查开播后新增的公屏事件（初始"魔女技公开"播报含所有玩家名，不计入）
  const addedPublicTexts = game.publicEvents.slice(publicCountBefore).map((e) => e.text).join(' ');
  const viewerPlayer = game.players.find((p) => p.id === viewerId);
  const viewerName = viewerPlayer ? characterById[viewerPlayer.characterId].name : '';
  check('开播后新增公屏不含观众名（观看名单保密）', viewerName.length > 0 && !addedPublicTexts.includes(viewerName));
}

// ===== 5. 保留开播后不再询问 =====
console.log('=== 5. 保留开播决策 ===');
{
  const game = createGameWithClairvoyance(11);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  const stream = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, stream, { use: false });
  check('保留后当天不再询问', getClairvoyanceDecision(game) === null);
  check('保留后技能未消耗', getSkillInstance(game, ownerId).status === 'ready');
}

// ===== 6. 防御校验：重复观看/开播者自己观看被拒 =====
console.log('=== 6. 观看者有效性校验 ===');
{
  const game = createGameWithClairvoyance(11);
  if (!game) {
    process.exit(1);
  }
  const ownerId = findClairvoyanceOwner(game);
  const viewerId = findViewer(game, ownerId);
  const stream = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, stream, { use: true });

  const viewerDecision = getClairvoyanceDecision(game);
  applyClairvoyanceDecision(game, viewerDecision, { use: true });

  // 重复观看同一观众：应抛错
  let repeatedError = null;
  try {
    applyClairvoyanceDecision(game, viewerDecision, { use: true });
  } catch (error) {
    repeatedError = error;
  }
  check('重复观看被拒绝', repeatedError !== null && repeatedError.message.includes('观看者无效'));

  // 开播者自己观看：应抛错
  let selfError = null;
  const selfDecision = { ...viewerDecision, actorId: ownerId };
  try {
    applyClairvoyanceDecision(game, selfDecision, { use: true });
  } catch (error) {
    selfError = error;
  }
  check('开播者自己观看被拒绝', selfError !== null && selfError.message.includes('观看者无效'));
}

// ===== 7. 完整对局 =====
console.log('=== 7. 完整对局（本地策略）===');
{
  let game = createGameWithClairvoyance(42);
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
  console.log('FAIL 千里眼重构验证未通过');
  process.exit(1);
}
console.log('PASS 千里眼重构验证全部通过');
await server.close();
