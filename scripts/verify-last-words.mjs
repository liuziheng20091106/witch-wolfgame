#!/usr/bin/env node
/**
 * 回归测试：遗言（last-words）功能
 *
 * 规则（经典狼人杀 + 魔女技修正）：
 * - 夜晚死亡：仅首夜（day 0）死亡的玩家有遗言；第二夜及之后的夜晚死亡无遗言
 * - 白天死亡：所有白天公投放逐的玩家都有遗言
 * - 魔女杀手（precise-kill）带走的人无遗言
 * - 诺亚的造物（id 99）无遗言
 * - 当天被怪力禁言（speech-restrain）的玩家无遗言
 * - 遗言不受视线诱导约束（死者没有视线）
 * - 遗言可联动洗脑：夏目安安（brainwash 持有者）可在遗言中发动洗脑（死者最后的执念）
 * - 遗言为公开事件，全部玩家可见
 *
 * 验证方式：可控注入死亡意图 → resolveNight / advanceDayResolution 结算 → 检查遗言决策。
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, resolveNight, getNextLastWordsDecision;
let getRoleAssignment, getName, getNextNightSkillDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ resolveNight } = await server.ssrLoadModule('/src/domain/engine/night.ts'));
  ({ getNextLastWordsDecision } = await server.ssrLoadModule('/src/domain/skills/lastWords.ts'));
  ({ getRoleAssignment, getName } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ getNextNightSkillDecision } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
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
    let suffix = '';
    if (detail) {
      suffix = ` -- ${detail}`;
    }
    console.log(`  FAIL ${label}${suffix}`);
  }
}

function findSkillOwner(game, definitionId) {
  const skill = game.skillInstances.find((s) => s.definitionId === definitionId);
  if (skill) {
    return skill.ownerPlayerId;
  }
  return -1;
}

function findGameWithSkill(definitionId, seedStart) {
  for (let seed = seedStart; seed < seedStart + 600; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    if (findSkillOwner(game, definitionId) >= 0) {
      return game;
    }
  }
  return null;
}

function hasDeathRewind(game, playerId) {
  return game.skillInstances.some((skill) => skill.definitionId === 'death-rewind' && skill.ownerPlayerId === playerId);
}

/** 注入一条夜间死亡意图（狼刀/毒药/精准击杀），resolveNight 会据此结算。 */
function injectNightDeath(game, targetPlayerId, source, actorPlayerId) {
  let kind = 'skill';
  if (source === 'wolf') {
    kind = 'wolf-attack';
  } else if (source === 'poison') {
    kind = 'witch-action';
  }
  let actionKind = 'witch-action';
  if (source === 'wolf') {
    actionKind = 'wolf-decision';
  }
  game.privateEvents.push({
    id: `${game.gameId}-inject-${game.day}-${source}-${targetPlayerId}`,
    kind,
    day: game.day,
    phase: 'night-resolution',
    text: `注入测试意图：${source} 指向 ${targetPlayerId}`,
    actorPlayerId,
    targetPlayerIds: [targetPlayerId],
    displayAuthorPlayerId: null,
    actualAuthorPlayerId: null,
    data: {
      actionKind,
      intentSource: source,
      preventable: source !== 'precise-kill',
      targetPlayerId,
    },
    viewerPlayerIds: [actorPlayerId],
  });
}

/** 注入白天放逐事件并把阶段推进到 day-resolution（advance 会结算并询问遗言）。 */
function injectDayExile(game, targetPlayerId) {
  game.publicEvents.push({
    id: `${game.gameId}-inject-exile-${game.day}-${targetPlayerId}`,
    kind: 'exile',
    day: game.day,
    phase: 'day-resolution',
    text: `注入测试放逐：${targetPlayerId}`,
    actorPlayerId: null,
    targetPlayerIds: [targetPlayerId],
    displayAuthorPlayerId: null,
    actualAuthorPlayerId: null,
    data: { exileTargetPlayerId: targetPlayerId },
  });
  game.phase = 'day-resolution';
  return reduceGame(game, { type: 'advance' });
}

/** 提交当前遗言决策并返回推进后的状态。 */
function submitPendingLastWords(game, speechText) {
  const pending = game.pendingDecision;
  if (!pending || pending.options.lastWords !== true) {
    throw new Error('当前没有待处理的遗言决策');
  }
  return reduceGame(game, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: { speech: speechText } });
}

function lastWordsEvents(game) {
  return game.publicEvents.filter((e) => e.kind === 'last-words');
}

// ===== 1. 首夜狼刀死亡 → 有遗言 =====
console.log('=== 1. 首夜（day 0）狼刀死亡 → 遗言 ===');
{
  const game = findGameWithSkill('witch-killer', 1);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  const wolfId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
  const villagerId = game.players.find((p) => p.id !== wolfId.id);
  injectNightDeath(game, villagerId.id, 'wolf', wolfId.id);
  const resolved = resolveNight(game);
  const pending = resolved.pendingDecision;
  check('夜间结算后出现遗言决策', pending !== null && pending.title === '遗言' && pending.options.lastWords === true);
  check('遗言行动者是死者', pending !== null && pending.actorId === villagerId.id);
  if (pending) {
    const after = submitPendingLastWords(resolved, '愿真相大白。');
    check('遗言发布为公开事件', lastWordsEvents(after).some((e) => e.actorPlayerId === villagerId.id && e.text.includes('愿真相大白')));
    check('遗言后无重复遗言决策', getNextLastWordsDecision(after) === null);
  }
}

// ===== 2. 首夜多死者（狼刀好人 + 毒杀狼人）→ 逐个遗言 =====
console.log('=== 2. 首夜多死者 → 逐个遗言 ===');
{
  // 找一局：狼/好各至少 2 名非死亡回溯持有者（回溯会使死者"复活"，遗言不应触发）
  let game = null;
  let goodVictim = null;
  let wolfVictim = null;
  let witchId = null;
  let seed = 50;
  while (seed < 4000 && !game) {
    const candidate = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const withoutRewind = (list) => list.filter((p) => !candidate.skillInstances.some((s) => s.definitionId === 'death-rewind' && s.ownerPlayerId === p.id));
    const safeGood = withoutRewind(candidate.players.filter((p) => getRoleAssignment(candidate, p.id).roleId !== 'wolf'));
    const safeWolves = withoutRewind(candidate.players.filter((p) => getRoleAssignment(candidate, p.id).roleId === 'wolf'));
    const witch = candidate.players.find((p) => getRoleAssignment(candidate, p.id).roleId === 'witch');
    if (safeGood.length >= 1 && safeWolves.length >= 2 && witch) {
      game = candidate;
      goodVictim = safeGood[0];
      wolfVictim = safeWolves[1];
      witchId = witch;
    }
    seed += 1;
  }
  check('找到含狼刀好人+毒杀狼人的对局', game !== null);
  if (!game || !goodVictim || !wolfVictim || !witchId) process.exit(1);
  const wolfId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
  injectNightDeath(game, goodVictim.id, 'wolf', wolfId.id);
  injectNightDeath(game, wolfVictim.id, 'poison', witchId.id);
  const resolved = resolveNight(game);
  const firstPending = resolved.pendingDecision;
  check('首夜双死产生第一个遗言', firstPending !== null && firstPending.title === '遗言' && (firstPending.actorId === goodVictim.id || firstPending.actorId === wolfVictim.id));
  if (!firstPending) process.exit(1);
  // 提交第一个遗言后必须 advance（重入 night-resolution 幂等结算），才能继续询问第二个遗言
  const afterFirstSubmit = submitPendingLastWords(resolved, '第一个遗言。');
  const afterFirst = reduceGame(afterFirstSubmit, { type: 'advance' });
  const secondPending = afterFirst.pendingDecision;
  check('第一个遗言后产生第二个遗言', secondPending !== null && secondPending.title === '遗言' && secondPending.actorId !== firstPending.actorId && (secondPending.actorId === goodVictim.id || secondPending.actorId === wolfVictim.id));
  if (!secondPending) process.exit(1);
  const afterSecond = submitPendingLastWords(afterFirst, '第二个遗言。');
  check('第二个遗言后无更多遗言', getNextLastWordsDecision(afterSecond) === null);
  check('两名死者都已发布遗言', lastWordsEvents(afterSecond).filter((e) => e.actorPlayerId === goodVictim.id || e.actorPlayerId === wolfVictim.id).length === 2);
}

// ===== 2b. 首夜双死触发狼人优势 → 两人遗言后才终局 =====
console.log('=== 2b. 首夜双死触发胜负 → 遗言后终局 ===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 912 >>> 0 });
  const wolf = game.players.find((player) => getRoleAssignment(game, player.id).roleId === 'wolf');
  const victims = game.players
    .filter((player) => getRoleAssignment(game, player.id).roleId !== 'wolf' && !hasDeathRewind(game, player.id))
    .slice(0, 2);
  check('找到两名不会回溯的首夜好人死者', wolf !== undefined && victims.length === 2);
  if (!wolf || victims.length !== 2) process.exit(1);
  injectNightDeath(game, victims[0].id, 'wolf', wolf.id);
  injectNightDeath(game, victims[1].id, 'poison', wolf.id);
  let current = resolveNight(game);
  check('触发人数优势后仍先询问首个遗言', current.result === null && current.pendingDecision?.options.lastWords === true);
  const firstActor = current.pendingDecision?.actorId;
  current = submitPendingLastWords(current, '第一位死者遗言。');
  current = reduceGame(current, { type: 'advance' });
  check('首个遗言后继续询问第二个死者', current.result === null && current.pendingDecision?.options.lastWords === true && current.pendingDecision.actorId !== firstActor);
  current = submitPendingLastWords(current, '第二位死者遗言。');
  check('全部遗言提交前不写入胜负', current.result === null);
  current = reduceGame(current, { type: 'advance' });
  check('全部遗言完成后狼人才获胜', current.phase === 'ended' && current.result?.winner === 'wolf');
  const eventKinds = current.publicEvents.map((event) => event.kind);
  check('结果事件位于两条遗言之后', eventKinds.lastIndexOf('result') > eventKinds.lastIndexOf('last-words') && lastWordsEvents(current).length === 2);
}

// ===== 3. 第二夜狼刀死亡 → 无遗言 =====
console.log('=== 3. 第二夜（day 1）夜晚死亡 → 无遗言 ===');
{
  const game = findGameWithSkill('witch-killer', 100);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  game.day = 1;
  const wolfId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
  const villagerId = game.players.find((p) => p.id !== wolfId.id);
  injectNightDeath(game, villagerId.id, 'wolf', wolfId.id);
  const resolved = resolveNight(game);
  check('第二夜死亡不产生遗言决策', resolved.pendingDecision === null || resolved.pendingDecision.options.lastWords !== true, JSON.stringify(resolved.pendingDecision?.title ?? '无'));
  check('第二夜死亡后直接进入黎明', resolved.phase === 'dawn');
}

// ===== 4. 白天公投放逐 → 有遗言 =====
console.log('=== 4. 白天放逐 → 遗言 ===');
{
  const game = findGameWithSkill('witch-killer', 200);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  game.day = 1;
  const villagerId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'villager');
  const after = injectDayExile(game, villagerId.id);
  const pending = after.pendingDecision;
  check('放逐结算后出现遗言决策', pending !== null && pending.title === '遗言' && pending.options.lastWords === true);
  check('遗言行动者是放逐者', pending !== null && pending.actorId === villagerId.id);
  if (pending) {
    const submitted = submitPendingLastWords(after, '我是村民，狼是3号！');
    check('放逐遗言发布为公开事件', lastWordsEvents(submitted).some((e) => e.actorPlayerId === villagerId.id));
  }
}

// ===== 4b. 白天放逐触发人数优势 → 放逐者遗言后才终局 =====
console.log('=== 4b. 白天放逐触发胜负 → 遗言后终局 ===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 913 >>> 0 });
  game.day = 1;
  const safeGood = game.players.filter(
    (player) => getRoleAssignment(game, player.id).roleId !== 'wolf' && !hasDeathRewind(game, player.id),
  );
  check('找到两名不会回溯的白天好人', safeGood.length >= 2);
  if (safeGood.length < 2) process.exit(1);
  safeGood[0].alive = false;
  let current = injectDayExile(game, safeGood[1].id);
  check('放逐触发人数优势后仍出现遗言', current.result === null && current.pendingDecision?.actorId === safeGood[1].id && current.pendingDecision.options.lastWords === true);
  current = submitPendingLastWords(current, '放逐者最后陈述。');
  check('遗言提交后等待结算推进', current.result === null && current.phase === 'day-resolution');
  current = reduceGame(current, { type: 'advance' });
  check('放逐遗言后狼人才获胜', current.phase === 'ended' && current.result?.winner === 'wolf');
  check('放逐遗言早于结果事件', current.publicEvents.findIndex((event) => event.kind === 'last-words') < current.publicEvents.findIndex((event) => event.kind === 'result'));
}

// ===== 5. 魔女杀手（precise-kill）→ 无遗言 =====
console.log('=== 5. 首夜魔女杀手死亡 → 无遗言 ===');
{
  const game = findGameWithSkill('witch-killer', 300);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  const killerId = findSkillOwner(game, 'witch-killer');
  const victimId = game.players.find((p) => p.id !== killerId);
  injectNightDeath(game, victimId.id, 'precise-kill', killerId);
  const resolved = resolveNight(game);
  check('魔女杀手死亡不产生遗言决策', resolved.pendingDecision === null || resolved.pendingDecision.options.lastWords !== true, JSON.stringify(resolved.pendingDecision?.title ?? '无'));
  check('魔女杀手死亡后直接进入黎明', resolved.phase === 'dawn');
}

// ===== 6. 诺亚的造物死亡 → 无遗言 =====
console.log('=== 6. 造物死亡 → 无遗言 ===');
{
  const game = findGameWithSkill('liquid-control', 400);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  // 推进夜间技能直到操控液体，创建造物
  let current = game;
  let created = false;
  for (let guard = 0; guard < 30; guard += 1) {
    const pending = getNextNightSkillDecision(current);
    if (!pending) break;
    if (pending.title === '操控液体') {
      current.pendingDecision = pending;
      current = reduceGame(current, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: { use: true } });
      created = current.creatures.length === 1;
      break;
    }
    const result = fallbackDecision(current, pending);
    current.pendingDecision = pending;
    current = reduceGame(current, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: result.decision });
  }
  check('造物已创建', created);
  if (!created) process.exit(1);
  const wolfId = current.players.find((p) => getRoleAssignment(current, p.id).roleId === 'wolf');
  injectNightDeath(current, 99, 'wolf', wolfId.id);
  const resolved = resolveNight(current);
  check('造物死亡不产生遗言决策', resolved.pendingDecision === null || resolved.pendingDecision.options.lastWords !== true, JSON.stringify(resolved.pendingDecision?.title ?? '无'));
  check('造物死亡后进入黎明', resolved.phase === 'dawn');
}

// ===== 7. 当天被怪力禁言的玩家被放逐 → 无遗言 =====
console.log('=== 7. 禁言者放逐 → 无遗言 ===');
{
  const game = findGameWithSkill('speech-restrain', 500);
  check('找到可用对局', game !== null);
  if (!game) process.exit(1);
  game.day = 1;
  const restrainSkill = game.skillInstances.find((s) => s.definitionId === 'speech-restrain');
  const targetId = game.players.find((p) => p.id !== restrainSkill.ownerPlayerId);
  // 模拟当天已使用怪力禁言 target
  restrainSkill.data.activeDay = 1;
  restrainSkill.data.targetPlayerId = targetId.id;
  const after = injectDayExile(game, targetId.id);
  check('禁言者被放逐不产生遗言决策', after.pendingDecision === null || after.pendingDecision.options.lastWords !== true, JSON.stringify(after.pendingDecision?.title ?? '无'));
  check('禁言者放逐后正常入夜', after.phase === 'night-skills');
}

// ===== 8. 遗言洗脑联动：安安在遗言中发动洗脑 =====
console.log('=== 8. 遗言洗脑（夏目安安）===');
{
  let game = null;
  let ananId = -1;
  let secondVictim = null;
  for (let seed = 600; seed < 1600 && !game; seed += 1) {
    const candidate = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const ownerId = findSkillOwner(candidate, 'brainwash');
    const other = candidate.players.find(
      (player) => player.id !== ownerId
        && getRoleAssignment(candidate, player.id).roleId !== 'wolf'
        && !hasDeathRewind(candidate, player.id),
    );
    if (ownerId >= 0 && other) {
      game = candidate;
      ananId = ownerId;
      secondVictim = other;
    }
  }
  check('找到含洗脑和第二名首夜死者的对局', game !== null && secondVictim !== null);
  if (!game || !secondVictim) process.exit(1);
  const wolfId = game.players.find((player) => getRoleAssignment(game, player.id).roleId === 'wolf');
  const witchId = game.players.find((player) => getRoleAssignment(game, player.id).roleId === 'witch');
  if (!wolfId || !witchId) process.exit(1);
  injectNightDeath(game, ananId, 'poison', witchId.id);
  injectNightDeath(game, secondVictim.id, 'wolf', wolfId.id);
  let current = resolveNight(game);
  check('安安是首个遗言行动者', current.pendingDecision?.actorId === ananId && current.pendingDecision.options.lastWords === true);
  current = submitPendingLastWords(current, '【投票给1号】我认狼了。');
  const brainwash = current.skillInstances.find((skill) => skill.definitionId === 'brainwash');
  check('遗言锁定洗脑内容', brainwash?.data.brainwashContent === '投票给1号');
  check('遗言洗脑标记生效（不受存活限制）', brainwash?.data.lastWordsBrainwash === true);
  check('遗言洗脑技能已耗尽', brainwash?.status === 'exhausted');
  current = reduceGame(current, { type: 'advance' });
  check('第二名死者继续获得遗言决策', current.pendingDecision?.actorId === secondVictim.id && current.pendingDecision.options.lastWords === true);
  check('后续遗言收到洗脑提示', typeof current.pendingDecision?.options.brainwashHint === 'string' && current.pendingDecision.options.brainwashHint.includes('投票给1号'));
}

// ===== 9. 遗言不受视线诱导（本地策略不补提及）=====
console.log('=== 9. 遗言不受视线诱导 ===');
{
  const game = findGameWithSkill('gaze-guidance', 700);
  check('找到含视线诱导的对局', game !== null);
  if (!game) process.exit(1);
  const gazeSkill = game.skillInstances.find((s) => s.definitionId === 'gaze-guidance');
  const victimId = game.players.find((p) => p.id !== gazeSkill.ownerPlayerId);
  const wolfId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
  injectNightDeath(game, victimId.id, 'wolf', wolfId.id);
  const resolved = resolveNight(game);
  const pending = resolved.pendingDecision;
  check('首夜死亡有遗言决策', pending !== null && pending.actorId === victimId.id);
  // 遗言决策不携带视线诱导的 requiredMention（死者没有视线）
  check('遗言决策无 requiredMention', pending !== null && pending.options.requiredMention === undefined, JSON.stringify(pending?.options ?? {}));
  // 本地策略：遗言生成不补视线诱导提及（例句原样使用，无"值得继续关注"后缀）
  const fallback = fallbackDecision(resolved, pending);
  check('本地策略遗言不强制提及诱导对象', typeof fallback.decision.speech === 'string' && !fallback.decision.speech.includes('值得继续关注'), JSON.stringify(fallback.decision));
}

// ===== 10. 回收洗脑后遗言洗脑（月代雪）=====
console.log('=== 10. 回收洗脑后遗言洗脑（月代雪）===');
{
  // 找同时含洗脑（夏目安安）与魔女因子回收（月代雪）的对局
  let game = null;
  let seed = 1;
  while (seed < 4000 && !game) {
    const candidate = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const hasBrainwash = candidate.skillInstances.some((s) => s.definitionId === 'brainwash');
    const hasRecovery = candidate.skillInstances.some((s) => s.definitionId === 'witch-factor-recovery');
    if (hasBrainwash && hasRecovery) {
      game = candidate;
    }
    seed += 1;
  }
  check('找到含洗脑+回收的对局', game !== null);
  if (!game) process.exit(1);
  const ananId = findSkillOwner(game, 'brainwash');
  const mayukiId = findSkillOwner(game, 'witch-factor-recovery');
  const wolfId = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
  check('洗脑与回收分属两人', ananId !== mayukiId && wolfId !== undefined);
  if (ananId === mayukiId || !wolfId) process.exit(1);

  // 首夜：狼刀杀安安 → 安安遗言（提交普通内容）
  injectNightDeath(game, ananId, 'wolf', wolfId.id);
  let current = resolveNight(game);
  const ananLastWords = current.pendingDecision;
  check('安安首夜死亡有遗言', ananLastWords !== null && ananLastWords.actorId === ananId && ananLastWords.options.lastWords === true);
  if (ananLastWords) {
    current = submitPendingLastWords(current, '我先走一步，大家保重。');
  }

  // 手动推进第二夜（day 1）夜间技能直到魔女因子回收：只处理技能决策，不触碰狼刀/女巫等（避免结算杀好人）
  current.day = 1;
  current.phase = 'night-skills';
  current.pendingDecision = null;
  let recovered = false;
  let guard = 0;
  while (!recovered && guard < 30) {
    guard += 1;
    const nightSkill = getNextNightSkillDecision(current);
    if (!nightSkill) {
      break;
    }
    if (nightSkill.title === '魔女因子回收' && nightSkill.actorId === mayukiId) {
      current.pendingDecision = nightSkill;
      current = reduceGame(current, {
        type: 'submit-decision',
        pendingDecisionId: nightSkill.id,
        actorId: nightSkill.actorId,
        decision: { use: true, targetPlayerId: ananId },
      });
      recovered = true;
      break;
    }
    // 其它夜间技能：fallback 处理（保留或使用），继续找回收
    const fb = fallbackDecision(current, nightSkill);
    current.pendingDecision = nightSkill;
    current = reduceGame(current, { type: 'submit-decision', pendingDecisionId: nightSkill.id, actorId: nightSkill.actorId, decision: fb.decision });
  }
  check('月代雪成功回收洗脑', recovered && current.skillInstances.find((s) => s.definitionId === 'brainwash')?.ownerPlayerId === mayukiId);
  if (!recovered) process.exit(1);
  const recoveredBrainwash = current.skillInstances.find((s) => s.definitionId === 'brainwash');
  check('回收后洗脑仍 ready（可用）', recoveredBrainwash?.status === 'ready');

  // 白天放逐月代雪 → 遗言带【】洗脑内容。
  current.day = 2;
  const exiled = injectDayExile(current, mayukiId);
  const mayukiLastWords = exiled.pendingDecision;
  check('月代雪放逐后有遗言', mayukiLastWords !== null && mayukiLastWords.actorId === mayukiId && mayukiLastWords.options.lastWords === true);
  if (!mayukiLastWords) process.exit(1);
  const after = submitPendingLastWords(exiled, '【投票给1号】我被栽赃了，真相在1号。');
  const brainwash = after.skillInstances.find((s) => s.definitionId === 'brainwash');
  check('回收者遗言锁定洗脑内容', brainwash?.data.brainwashContent === '投票给1号');
  check('回收者遗言洗脑标记生效', brainwash?.data.lastWordsBrainwash === true);
  check('回收者遗言洗脑技能已耗尽', brainwash?.status === 'exhausted');
}

// ===== 11. 完整对局（本地策略）正常结束 + 出现遗言 =====
console.log('=== 11. 完整对局（本地策略）===');
{
  let ended = 0;
  let sawLastWords = 0;
  const total = 40;
  for (let seed = 1; seed <= total; seed += 1) {
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
    if (game.phase === 'ended') ended += 1;
    if (game.publicEvents.some((e) => e.kind === 'last-words')) sawLastWords += 1;
  }
  check(`${total} 局完整对局全部正常结束`, ended === total, `结束 ${ended}/${total}`);
  check('至少出现遗言事件', sawLastWords > 0, `出现遗言 ${sawLastWords}/${total}`);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
await server.close();
if (failures > 0) {
  console.log(`!!! 失败 ${failures} 项`);
  process.exit(1);
} else {
  console.log('PASS 遗言验证全部通过');
  process.exit(0);
}
