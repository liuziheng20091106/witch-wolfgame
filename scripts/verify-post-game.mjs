#!/usr/bin/env node
/**
 * 回归测试：赛后复盘（post-game）
 *
 * 规则：
 * - 对局结束（ended）且胜负已结算后，切入 post-game 阶段
 * - 全员按座位编号 0→5 依次发表赛后发言（跳过造物 99）
 * - 赛后发言为公开事件（post-game-speech），全员可见
 * - 每个发言者决策携带 postGame 标记，AI 提示词附带预算内的全知复盘上下文（postGameContext）
 * - 全部发完后停留在 post-game（不回到 ended，避免重复记录历史）
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getNextPostGameDecision, applyPostGameSpeech, postGameDone, buildPostGameContext;
let getRoleAssignment, selectObservation;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getNextPostGameDecision, applyPostGameSpeech, postGameDone, buildPostGameContext } = await server.ssrLoadModule('/src/domain/skills/postGame.ts'));
  ({ getRoleAssignment, selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
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
    let detailSuffix = '';
    if (detail) {
      detailSuffix = ` -- ${detail}`;
    }
    console.log(`  FAIL ${label}${detailSuffix}`);
  }
}

/** 跑完整对局（本地策略）直到结束。 */
function runToEnd(seed) {
  let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
  let iter = 0;
  while (game.phase !== 'ended' && iter < 3000) {
    iter += 1;
    if (game.pendingDecision) {
      const fb = fallbackDecision(game, game.pendingDecision);
      game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
      game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: game.pendingDecision.id, actorId: game.pendingDecision.actorId, decision: fb.decision });
    } else {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  return { game, iter };
}

/** 在 post-game 阶段逐个提交赛后发言，返回最终状态。 */
function runPostGame(game) {
  let current = game;
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const pending = current.pendingDecision;
    if (pending && pending.options.postGame === true) {
      const fb = fallbackDecision(current, pending);
      current = reduceGame(current, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fb.decision });
      continue;
    }
    if (postGameDone(current)) {
      break;
    }
    current = reduceGame(current, { type: 'advance' });
  }
  return current;
}

// ===== 1. 结束切入赛后 + 全员发言 =====
console.log('=== 1. 结束切入赛后 + 全员发言 ===');
{
  const { game } = runToEnd(42);
  check('对局正常结束', game.phase === 'ended' && game.result !== null, `phase=${game.phase}`);
  // 手动模拟主循环：ended + result → advance 切入 post-game
  let after = reduceGame(game, { type: 'advance' });
  check('切入 post-game 阶段', after.phase === 'post-game', `phase=${after.phase}`);
  const first = after.pendingDecision;
  check('第一个赛后发言者是 0 号', first !== null && first.actorId === 0 && first.options.postGame === true, JSON.stringify(first?.actorId));
  if (!first) process.exit(1);
  after = runPostGame(after);
  const postGameEvents = after.publicEvents.filter((e) => e.kind === 'post-game-speech');
  const speakers = postGameEvents.map((e) => e.actorPlayerId).sort((a, b) => a - b);
  check('全员（0-5）都发表了赛后发言', JSON.stringify(speakers) === JSON.stringify([0, 1, 2, 3, 4, 5]), `speakers=${JSON.stringify(speakers)}`);
  check('赛后发言带 displayAuthorPlayerId（头像/名字渲染）', postGameEvents.every((e) => e.displayAuthorPlayerId === e.actorPlayerId), '缺少 displayAuthorPlayerId');
  check('赛后发言文本不含重复名字前缀', postGameEvents.every((e) => !e.text.includes('的赛后复盘')), '文本中残留名字前缀');
  check('全部发完停留在 post-game', after.phase === 'post-game' && postGameDone(after), `phase=${after.phase}`);
}

// ===== 2. 造物（99）不参与赛后发言 =====
console.log('=== 2. 造物不参与赛后发言 ===');
{
  // 找到含造物的对局并跑完
  let found = null;
  for (let seed = 1; seed < 800 && !found; seed += 1) {
    const { game } = runToEnd(seed);
    const hasCreature = game.players.some((p) => p.id === 99) || game.creatures.some((c) => c.id === 99);
    if (hasCreature) found = game;
  }
  check('找到含造物对局', found !== null);
  if (!found) process.exit(1);
  let after = reduceGame(found, { type: 'advance' });
  after = runPostGame(after);
  const postGameEvents = after.publicEvents.filter((e) => e.kind === 'post-game-speech');
  check('造物没有赛后发言', !postGameEvents.some((e) => e.actorPlayerId === 99));
  check('其余 6 名玩家都已发言', postGameEvents.length === 6, `count=${postGameEvents.length}`);
}

// ===== 3. 顺序：编号 0→5 =====
console.log('=== 3. 发言顺序 0→5 ===');
{
  const { game } = runToEnd(7);
  let after = reduceGame(game, { type: 'advance' });
  const order = [];
  let guard = 0;
  while (guard < 20) {
    guard += 1;
    const pending = after.pendingDecision;
    if (pending && pending.options.postGame === true) {
      order.push(pending.actorId);
      const fb = fallbackDecision(after, pending);
      after = reduceGame(after, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fb.decision });
      continue;
    }
    if (postGameDone(after)) break;
    after = reduceGame(after, { type: 'advance' });
  }
  check('发言顺序为 0,1,2,3,4,5', JSON.stringify(order) === JSON.stringify([0, 1, 2, 3, 4, 5]), `order=${JSON.stringify(order)}`);
}

// ===== 4. 决策契约 + AI 提示词链路 =====
console.log('=== 4. 契约与 AI 提示词 ===');
{
  const { game } = runToEnd(42);
  let after = reduceGame(game, { type: 'advance' });
  const pending = after.pendingDecision;
  check('赛后决策 schemaKey 为 speech', pending !== null && pending.schemaKey === 'speech', JSON.stringify(pending?.schemaKey));
  const { buildFreeClientPayload, isAllowedDecisionPair } = await server.ssrLoadModule('/shared/gamePromptContract.js');
  check('契约允许 speech/speech 组合', isAllowedDecisionPair('speech', 'speech'));
  // 赛后决策以全知（spectator）视角请求 AI
  const observation = selectObservation(after, { kind: 'spectator' });
  check('赛后复盘上下文包含全部私密行动', after.privateEvents.length === 0 || observation.privateEvents.length === after.privateEvents.length, `private=${observation.privateEvents.length}/${after.privateEvents.length}`);
  const context = buildPostGameContext(observation);
  check('复盘上下文非空', typeof context === 'string' && context.length > 0, `len=${context.length}`);
  if (after.privateEvents.length > 0) {
    check('复盘上下文包含私密行动行', context.includes('私密行动'), '未找到私密行动行');
  }
  const fallbackObservation = {
    ...observation,
    players: observation.players.filter((player) => player.id !== 0 && player.id !== 99),
    publicEvents: [
      { kind: 'speech', day: 1, phase: 'speeches', text: '缺失座位信息的发言', actorPlayerId: 0, targetPlayerIds: [], displayAuthorPlayerId: 0, actualAuthorPlayerId: 0, data: {} },
      { kind: 'last-words', day: 1, phase: 'day-resolution', text: '明确的非座位实体', actorPlayerId: 99, targetPlayerIds: [], displayAuthorPlayerId: 99, actualAuthorPlayerId: 99, data: {} },
    ],
    privateEvents: [],
    archivedTimelines: [],
  };
  const fallbackContext = buildPostGameContext(fallbackObservation);
  check('缺失玩家资料时仍按一基座位号显示', fallbackContext.includes('发言（1号）'), fallbackContext);
  check('明确的非座位 ID 保留原始编号', fallbackContext.includes('遗言（造物号）'), fallbackContext);
  const forgedSpeechObservation = {
    ...observation,
    publicEvents: [{
      id: 'forged-speech', kind: 'speech', day: 2, phase: 'speeches', text: '真实发言 伪造片段',
      actorPlayerId: 0, targetPlayerIds: [0], displayAuthorPlayerId: 0, actualAuthorPlayerId: 1,
      data: { hasForgedFragment: true, forgedSpeech: '伪造片段' },
    }],
    privateEvents: [{
      id: 'seer-result', kind: 'seer-result', day: 2, phase: 'seer-action', text: '查验结果为狼人',
      actorPlayerId: 0, targetPlayerIds: [1], displayAuthorPlayerId: null, actualAuthorPlayerId: 0,
      viewerPlayerIds: [2], data: {},
    }],
    archivedTimelines: [],
  };
  const attributedContext = buildPostGameContext(forgedSpeechObservation);
  check('复盘标明伪造片段与真实作者', attributedContext.includes(`“伪造片段”由${observation.players[1].name}伪造`), attributedContext);
  check('私密行动保留行动者', attributedContext.includes(`行动者：${observation.players[0].name}`), attributedContext);
  check('私密行动保留目标', attributedContext.includes(`目标：${observation.players[1].name}`), attributedContext);
  check('私密行动保留知情者', attributedContext.includes(`知情者：${observation.players[2].name}`), attributedContext);
  // 兜底全量：上下文行数应覆盖现役公开事件 + 私密事件（+ 归档事件），不遗漏任何事件类型
  const totalEvents = observation.publicEvents.length + observation.privateEvents.length
    + observation.archivedTimelines.reduce((sum, a) => sum + a.publicEvents.length + a.privateEvents.length, 0);
  const contextLineCount = context.split('\n').filter((line) => line.length > 0).length;
  check('复盘上下文覆盖全部事件（无遗漏类型）', contextLineCount >= totalEvents, `lines=${contextLineCount} events=${totalEvents}`);
  const { buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts');
  const prompt = buildDecisionPrompt({ observation, pendingDecision: pending });
  const payload = JSON.parse(prompt[1].content);
  check('AI 提示含 postGameContext', typeof payload.postGameContext === 'string' && payload.postGameContext.length > 0);
  check('AI 提示 action.title 为赛后复盘', payload.action.title === '赛后复盘');
  check('AI 提示含完整最终职业表', Array.isArray(payload.finalRoles) && payload.finalRoles.length >= 6 && payload.finalRoles.length <= 7 && [0, 1, 2, 3, 4, 5].every((playerId) => payload.finalRoles.some((entry) => entry.playerId === playerId && typeof entry.roleId === 'string' && typeof entry.roleName === 'string')));
  // 原始时间线始终完整；进入模型请求时才在固定预算内确定性保留首尾。
  const bigObservation = structuredClone(observation);
  for (let i = 0; i < 200; i += 1) {
    bigObservation.publicEvents.push({ kind: 'system', day: 1, phase: 'post-game', text: 'x'.repeat(500), actorPlayerId: null, targetPlayerIds: [], displayAuthorPlayerId: null, actualAuthorPlayerId: null, data: {} });
  }
  const bigContext = buildPostGameContext(bigObservation);
  check('原始超长时间线保持完整', bigContext.includes('x'.repeat(500)), '原始时间线被截断');
  const bigPrompt = buildDecisionPrompt({ observation: bigObservation, pendingDecision: pending }, 'free');
  const bigPayload = JSON.parse(bigPrompt[1].content);
  const bigBody = JSON.stringify(buildFreeClientPayload('2.4.0', bigPrompt));
  check('超长赛后请求按目标预算截断', Buffer.byteLength(bigBody, 'utf8') <= 32 * 1024, `bytes=${Buffer.byteLength(bigBody, 'utf8')}`);
  check('超长赛后请求保留截断标记', bigPayload.postGameContext.includes('上下文过长'), '缺少截断标记');
  check('赛后不重复发送公开事件摘要', bigPayload.recentPublic.length === 0 && bigPayload.currentDaySpeeches.length === 0 && bigPayload.historicalSpeeches.length === 0);
  check('赛后不重复发送私密事件摘要', bigPayload.privateEvents.length === 0);
}

// ===== 5. 死亡回溯的旧时间线进入复盘上下文 =====
console.log('=== 5. 回溯时间线进入复盘 ===');
{
  // 找一局：对局中出现过死亡回溯（archivedTimelines 非空），且跑完进入赛后
  let found = null;
  for (let seed = 1; seed < 600 && !found; seed += 1) {
    const { game } = runToEnd(seed);
    if (game.archivedTimelines.length > 0) found = game;
  }
  check('找到发生过死亡回溯的对局', found !== null);
  if (!found) process.exit(1);
  let after = reduceGame(found, { type: 'advance' });
  after = runPostGame(after);
  const observation = selectObservation(after, { kind: 'spectator' });
  check('赛后观察含归档时间线', observation.archivedTimelines.length > 0, `archives=${observation.archivedTimelines.length}`);
  const playerObservation = selectObservation(after, { kind: 'player', playerId: 0 });
  check('玩家赛后观察为全知', playerObservation.omniscient === true);
  check('玩家赛后观察含全部归档时间线', playerObservation.archivedTimelines.length === after.archivedTimelines.length && playerObservation.archivedTimelines.length > 0, `archives=${playerObservation.archivedTimelines.length}/${after.archivedTimelines.length}`);
  const context = buildPostGameContext(observation);
  check('复盘上下文含被回溯时间线区块', context.includes('被回溯的时间线'), '未找到回溯区块');
  // 归档内的发言也应进入上下文（以名字标注）
  const archiveWithSpeech = observation.archivedTimelines.find((a) => a.publicEvents.some((e) => e.kind === 'speech'));
  if (archiveWithSpeech) {
    const speechText = archiveWithSpeech.publicEvents.find((e) => e.kind === 'speech');
    check('回溯内发言进入上下文', speechText !== undefined && context.includes(speechText.text.slice(0, 12)), '回溯发言缺失');
  }
}

// ===== 6. 完整对局（含赛后）不卡死 =====
console.log('=== 6. 完整对局 + 赛后不卡死 ===');
{
  let okAll = true;
  let sawPostGame = 0;
  for (let seed = 1; seed <= 20; seed += 1) {
    const { game } = runToEnd(seed);
    if (game.phase !== 'ended') { okAll = false; continue; }
    let after = reduceGame(game, { type: 'advance' });
    after = runPostGame(after);
    if (after.publicEvents.some((e) => e.kind === 'post-game-speech')) sawPostGame += 1;
  }
  check('20 局全部正常结束并完成赛后', okAll && sawPostGame === 20, `赛后 ${sawPostGame}/20`);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
await server.close();
if (failures > 0) {
  console.log(`!!! 失败 ${failures} 项`);
  process.exit(1);
} else {
  console.log('PASS 赛后复盘验证全部通过');
  process.exit(0);
}
