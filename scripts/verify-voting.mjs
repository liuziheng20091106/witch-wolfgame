#!/usr/bin/env node
/**
 * 回归测试：封闭投票、统一揭票与揭票后点火。
 *
 * 验证：
 * 1. 投票提交期间不产生公开事件，观察视图不暴露未揭晓票型。
 * 2. 全员投票完成后只统一揭票一次，完整票型随后可见。
 * 3. 亚里沙的白天点火在揭票后触发，并明确获得本轮完整票型。
 * 4. 平票重投继续封闭，第一轮公开票型不会泄露第二轮半成品。
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({
  root,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

let createGame;
let reduceGame;
let selectObservation;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  // 测试结束前保持 Vite SSR 服务可用。
}

let checks = 0;
let failures = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  let suffix = '';
  if (detail.length > 0) {
    suffix = ` —— ${detail}`;
  }
  console.log(`  ✗ ${label}${suffix}`);
}

function prepareVotingGame(seed, keepIgnitionReady) {
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
  game.phase = 'voting';
  game.pendingDecision = null;
  game.currentVotes = [];
  for (const skill of game.skillInstances) {
    if (skill.definitionId === 'ignition' && !keepIgnitionReady) {
      skill.status = 'exhausted';
    }
  }
  return game;
}

function revealedEvents(game, round) {
  return game.publicEvents.filter(
    (event) => event.kind === 'vote' && event.data.revealedVoteRound === round,
  );
}

function submitPendingVote(game, targetPlayerId) {
  const pending = game.pendingDecision;
  if (!pending) {
    throw new Error('缺少待提交的投票决策');
  }
  return reduceGame(game, {
    type: 'submit-decision',
    pendingDecisionId: pending.id,
    actorId: pending.actorId,
    decision: { targetPlayerId },
  });
}

console.log('=== 1. 首轮投票秘密提交并统一揭晓 ===');
{
  let game = prepareVotingGame(1, false);
  game = reduceGame(game, { type: 'advance' });
  for (let index = 0; index < 6; index += 1) {
    const pending = game.pendingDecision;
    if (!pending) {
      throw new Error(`第 ${index + 1} 位投票者缺少决策`);
    }
    let targetPlayerId = 0;
    if (index === 0) {
      targetPlayerId = null;
    } else if (pending.actorId === 0) {
      targetPlayerId = 1;
    }
    const publicVoteEventsBefore = game.publicEvents.filter((event) => event.kind === 'vote').length;
    game = submitPendingVote(game, targetPlayerId);
    const publicVoteEventsAfter = game.publicEvents.filter((event) => event.kind === 'vote').length;
    check(`第 ${index + 1} 票提交后没有即时唱票`, publicVoteEventsAfter === publicVoteEventsBefore);
    const playerObservation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    const spectatorObservation = selectObservation(game, { kind: 'spectator' });
    check(`第 ${index + 1} 票未向玩家观察视图泄露`, playerObservation.currentVotes.length === 0);
    check(`第 ${index + 1} 票未向观战界面提前展示`, spectatorObservation.currentVotes.length === 0);
    if (index < 5) {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  check('六票收齐后仍等待统一揭票', revealedEvents(game, 1).length === 0);
  game = reduceGame(game, { type: 'advance' });
  const reveal = revealedEvents(game, 1);
  check('首轮完整票型只公布一次', reveal.length === 1, `公布次数=${reveal.length}`);
  check('首轮揭票事件包含六条结构化票型', Array.isArray(reveal[0]?.data.voteRecords) && reveal[0].data.voteRecords.length === 6);
  check('首轮揭票事件包含结构化票数汇总', Array.isArray(reveal[0]?.data.voteTally));
  const revealedTally = reveal[0]?.data.voteTally ?? [];
  const tallyTotal = revealedTally.reduce((total, entry) => total + entry.count, 0);
  check('首轮票数汇总覆盖全部六票', tallyTotal === 6, `汇总票数=${tallyTotal}`);
  check('首轮票数汇总单列弃权票', revealedTally.some((entry) => entry.targetPlayerId === null && entry.count === 1));
  check('票数汇总在公开文本中单独换行', reveal[0]?.text.includes('\n票数汇总：') === true);
  check('公开文本显示弃权票数', reveal[0]?.text.includes('弃权：1票') === true);
  const revealedObservation = selectObservation(game, { kind: 'player', playerId: 0 });
  check('统一揭票后玩家可见完整首轮票型', revealedObservation.currentVotes.length === 6);
}

console.log('\n=== 2. 白天点火在完整票型公布后触发 ===');
{
  let game = null;
  for (let seed = 1; seed <= 500; seed += 1) {
    const candidate = prepareVotingGame(seed, true);
    if (candidate.skillInstances.some((skill) => skill.definitionId === 'ignition')) {
      game = candidate;
      break;
    }
  }
  check('找到包含点火持有者的对局', game !== null);
  if (game) {
    game.currentVotes = game.players.map((player) => {
      let targetPlayerId = player.id + 1;
      if (targetPlayerId >= 6) {
        targetPlayerId = 0;
      }
      return { voterPlayerId: player.id, targetPlayerId, round: 1 };
    });
    game = reduceGame(game, { type: 'advance' });
    check('进入点火决策前首轮票型已经公开', revealedEvents(game, 1).length === 1);
    check('揭票后立即调度白天点火', game.pendingDecision?.title === '点火-白天');
    check('点火提示明确携带完整票型', game.pendingDecision?.description.includes('完整票型已经公布') === true);
    check('点火提示明确携带票数汇总', game.pendingDecision?.description.includes('票数汇总') === true);
    check('点火行动者可见六条已公开票型', selectObservation(game, { kind: 'player', playerId: game.pendingDecision.actorId }).currentVotes.length === 6);
    const ignitionPending = game.pendingDecision;
    game = reduceGame(game, {
      type: 'submit-decision',
      pendingDecisionId: ignitionPending.id,
      actorId: ignitionPending.actorId,
      decision: { use: false, targetPlayerId: null },
    });
    game = reduceGame(game, { type: 'advance' });
    check('点火处理后不会重复公布首轮票型', revealedEvents(game, 1).length === 1);
  }
}

console.log('\n=== 3. 平票重投继续封闭并统一揭晓 ===');
{
  let game = prepareVotingGame(2, false);
  game.currentVotes = [
    { voterPlayerId: 0, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 1, targetPlayerId: 0, round: 1 },
    { voterPlayerId: 2, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 3, targetPlayerId: 0, round: 1 },
    { voterPlayerId: 4, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 5, targetPlayerId: 0, round: 1 },
  ];
  game = reduceGame(game, { type: 'advance' });
  check('首轮平票后进入重投阶段', game.phase === 'runoff');
  check('重投开始前首轮票型已经公开', revealedEvents(game, 1).length === 1);
  game = reduceGame(game, { type: 'advance' });
  for (let index = 0; index < 6; index += 1) {
    const pending = game.pendingDecision;
    if (!pending) {
      throw new Error(`重投第 ${index + 1} 位投票者缺少决策`);
    }
    let targetPlayerId = 0;
    if (pending.actorId === 0) {
      targetPlayerId = 1;
    }
    game = submitPendingVote(game, targetPlayerId);
    const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    check(`重投第 ${index + 1} 票只暴露已公布的首轮`, observation.currentVotes.length === 6);
    check(`重投第 ${index + 1} 票没有即时唱票`, revealedEvents(game, 2).length === 0);
    if (index < 5) {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  game = reduceGame(game, { type: 'advance' });
  check('第二轮完整票型只公布一次', revealedEvents(game, 2).length === 1);
  const finalObservation = selectObservation(game, { kind: 'player', playerId: 0 });
  check('第二轮揭票后两轮完整票型均可见', finalObservation.currentVotes.length === 12);
}

console.log(`\n===== 结果 =====\n检查项: ${checks} | 失败: ${failures}`);
await server.close();
if (failures > 0) {
  process.exit(1);
}
console.log('✓ 封闭投票回归全部通过');
