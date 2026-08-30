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
import { validateGamePrompt } from '../server/gameProtocol.mjs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({
  root,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

let buildDecisionPrompt;
let createGame;
let reduceGame;
let selectObservation;
try {
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
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
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount: 6, selectedCharacterIds: [] });
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
function addLivingCreature(game, ownerPlayerId = 0) {
  const owner = game.players.find((player) => player.id === ownerPlayerId);
  if (!owner) throw new Error(`找不到造物主人 ${ownerPlayerId}`);
  const ownerAssignment = game.roleAssignments.find((assignment) => assignment.id === owner.roleAssignmentId);
  if (!ownerAssignment) throw new Error(`找不到造物主人职业 ${ownerPlayerId}`);
  const roleAssignmentId = `${game.gameId}-smoke-creature-role`;
  game.roleAssignments.push({ id: roleAssignmentId, ownerPlayerId: 99, roleId: ownerAssignment.roleId, resources: {} });
  game.creatures.push({ id: 99, ownerPlayerId, characterId: owner.characterId, roleAssignmentId, alive: true, resources: {} });
}

function revealedEvents(game, round) {
  return game.publicEvents.filter(
    (event) => event.kind === 'vote' && event.data.revealedVoteRound === round,
  );
}

function livingRealVoterCount(game) {
  return game.players.filter((player) => player.alive).length;
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
function promptVotes(game, label, pendingOverride = null) {
  const pending = pendingOverride ?? game.pendingDecision;
  if (!pending) throw new Error(`${label}缺少待处理决策`);
  const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
  const messages = buildDecisionPrompt({ observation, pendingDecision: pending, sessionId: `voting-${label}` });
  const prompt = JSON.parse(messages[1].content);
  check(`${label}提示词通过契约校验`, validateGamePrompt(messages).ok === true);
  return prompt.publicVotes;
}
function samePublicVotes(left, right) {
  return left.length === right.length && left.every((vote, index) => {
    const expected = right[index];
    return expected !== undefined
      && vote.round === expected.round
      && vote.voterPlayerId === expected.voterPlayerId
      && vote.targetPlayerId === expected.targetPlayerId;
  });
}


console.log('=== 1. 首轮投票秘密提交并统一揭晓 ===');
{
  let game = prepareVotingGame(1, false);
  addLivingCreature(game);
  const expectedVoterCount = livingRealVoterCount(game);
  game = reduceGame(game, { type: 'advance' });
  check('首轮揭票前提示无公开票型', promptVotes(game, '首轮揭票前').length === 0);
  let lastVotePending = null;
  const expectedFirstRoundVotes = [];
  for (let index = 0; index < expectedVoterCount; index += 1) {
    const pending = game.pendingDecision;
    lastVotePending = pending;
    if (!pending) {
      throw new Error(`第 ${index + 1} 位投票者缺少决策`);
    }
    let targetPlayerId = 0;
    if (index === 0) {
      targetPlayerId = null;
    } else if (pending.actorId === 0) {
      check('造物主人不能把票投给自己的造物', pending.candidates.includes(99) === false);
      targetPlayerId = 1;
    }
    expectedFirstRoundVotes.push({ voterPlayerId: pending.actorId, targetPlayerId, round: 1 });
    const publicVoteEventsBefore = game.publicEvents.filter((event) => event.kind === 'vote').length;
    game = submitPendingVote(game, targetPlayerId);
    const publicVoteEventsAfter = game.publicEvents.filter((event) => event.kind === 'vote').length;
    check(`第 ${index + 1} 票提交后没有即时唱票`, publicVoteEventsAfter === publicVoteEventsBefore);
    const playerObservation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    const spectatorObservation = selectObservation(game, { kind: 'spectator' });
    check(`第 ${index + 1} 票未向玩家观察视图泄露`, playerObservation.currentVotes.length === 0);
    check(`第 ${index + 1} 票未向观战界面提前展示`, spectatorObservation.currentVotes.length === 0);
    if (index < expectedVoterCount - 1) {
      game = reduceGame(game, { type: 'advance' });
    }
  }
  check('全部投票收齐后仍等待统一揭票', revealedEvents(game, 1).length === 0);
  game = reduceGame(game, { type: 'advance' });
  const reveal = revealedEvents(game, 1);
  const expectedRevealedFirstRoundVotes = [
    ...expectedFirstRoundVotes,
    { voterPlayerId: 99, targetPlayerId: expectedFirstRoundVotes.find((vote) => vote.voterPlayerId === 0)?.targetPlayerId ?? null, round: 1 },
  ];
  const firstRoundPromptVotes = promptVotes(game, '首轮揭票后', lastVotePending);
  check('首轮提示按独立预期携带全部票型', samePublicVotes(firstRoundPromptVotes, expectedRevealedFirstRoundVotes));
  check('首轮揭票事件按独立预期记录票型', samePublicVotes(reveal[0]?.data.voteRecords ?? [], expectedRevealedFirstRoundVotes));
  check('首轮完整票型只公布一次', reveal.length === 1, `公布次数=${reveal.length}`);
  const revealedTally = reveal[0]?.data.submittedVoteTally ?? [];
  const tallyTotal = revealedTally.reduce((total, entry) => total + entry.count, 0);
  check('首轮提交票数汇总覆盖全部投票', tallyTotal === expectedRevealedFirstRoundVotes.length, `预期=${expectedRevealedFirstRoundVotes.length}，汇总=${tallyTotal}`);
  check('首轮提交票数汇总单列弃权票', revealedTally.some((entry) => entry.targetPlayerId === null && entry.count === 1));
  check('提交票数汇总在公开文本中单独换行', reveal[0]?.text.includes('\n提交票数汇总（点火前）：') === true);
  check('公开文本显示弃权票数', reveal[0]?.text.includes('弃权：1票') === true);
  const revealedObservation = selectObservation(game, { kind: 'player', playerId: 0 });
  check('统一揭票后玩家可见完整首轮票型', revealedObservation.currentVotes.length === expectedRevealedFirstRoundVotes.length);
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
    const expectedVoterCount = livingRealVoterCount(game);
    const expectedIgnitionVotes = [
      { voterPlayerId: 0, targetPlayerId: 1, round: 1 },
      { voterPlayerId: 1, targetPlayerId: 2, round: 1 },
      { voterPlayerId: 2, targetPlayerId: 3, round: 1 },
      { voterPlayerId: 3, targetPlayerId: 4, round: 1 },
      { voterPlayerId: 4, targetPlayerId: 5, round: 1 },
      { voterPlayerId: 5, targetPlayerId: 0, round: 1 },
    ];
    game.currentVotes = expectedIgnitionVotes.map((vote) => ({ ...vote }));
    game = reduceGame(game, { type: 'advance' });
    check('进入点火决策前首轮票型已经公开', revealedEvents(game, 1).length === 1);
    check('揭票后立即调度白天点火', game.pendingDecision?.title === '点火-白天');
    check('点火提示明确携带完整提交票型', game.pendingDecision?.description.includes('完整提交票型已经公布') === true);
    check('点火提示按独立预期携带完整票型', samePublicVotes(promptVotes(game, '实际点火提示', game.pendingDecision), expectedIgnitionVotes));
    check('点火提示明确携带点火前提交票数汇总', game.pendingDecision?.description.includes('提交票数汇总（点火前）') === true);
    check('点火行动者可见全部已公开票型', selectObservation(game, { kind: 'player', playerId: game.pendingDecision.actorId }).currentVotes.length === expectedVoterCount);
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
  const expectedVoterCount = livingRealVoterCount(game);
  const expectedFirstRoundVotes = [
    { voterPlayerId: 0, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 1, targetPlayerId: 0, round: 1 },
    { voterPlayerId: 2, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 3, targetPlayerId: 0, round: 1 },
    { voterPlayerId: 4, targetPlayerId: 1, round: 1 },
    { voterPlayerId: 5, targetPlayerId: 0, round: 1 },
  ];
  game.currentVotes = expectedFirstRoundVotes.map((vote) => ({ ...vote }));
  const expectedRunoffVotes = [];
  game = reduceGame(game, { type: 'advance' });
  const firstRoundPublicVotes = selectObservation(game, { kind: 'spectator' }).currentVotes;
  check('重投开始前公开票型符合独立预期', samePublicVotes(firstRoundPublicVotes, expectedFirstRoundVotes));
  game = reduceGame(game, { type: 'advance' });
  check('重投开始前提示只含首轮票型', samePublicVotes(promptVotes(game, '重投开始前'), expectedFirstRoundVotes));
  let lastRunoffPending = null;
  for (let index = 0; index < expectedVoterCount; index += 1) {
    const pending = game.pendingDecision;
    lastRunoffPending = pending;
    if (!pending) {
      throw new Error(`重投第 ${index + 1} 位投票者缺少决策`);
    }
    let targetPlayerId = 0;
    if (pending.actorId === 0) {
      targetPlayerId = 1;
    }
    expectedRunoffVotes.push({ voterPlayerId: pending.actorId, targetPlayerId, round: 2 });
    game = submitPendingVote(game, targetPlayerId);
    const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    check(`重投第 ${index + 1} 票只暴露已公布的首轮`, observation.currentVotes.length === expectedVoterCount);
    check(`重投第 ${index + 1} 票没有即时唱票`, revealedEvents(game, 2).length === 0);
    if (index < expectedVoterCount - 1) {
      game = reduceGame(game, { type: 'advance' });
      check(`重投第 ${index + 1} 票后提示无半成品`, samePublicVotes(promptVotes(game, `重投第${index + 1}票后`), firstRoundPublicVotes));
    }
  }
  game = reduceGame(game, { type: 'advance' });
  check('第二轮完整票型只公布一次', revealedEvents(game, 2).length === 1);
  const secondReveal = revealedEvents(game, 2);
  const finalPromptVotes = promptVotes(game, '第二轮揭票后', lastRunoffPending);
  const expectedPromptVotes = [...firstRoundPublicVotes, ...expectedRunoffVotes];
  check('第二轮揭票事件按独立预期记录票型', samePublicVotes(secondReveal[0]?.data.voteRecords ?? [], expectedRunoffVotes));
  check('第二轮提示按独立预期携带两轮票型', samePublicVotes(finalPromptVotes, expectedPromptVotes));
  const finalObservation = selectObservation(game, { kind: 'player', playerId: 0 });
  check('第二轮揭票后两轮完整票型均可见', finalObservation.currentVotes.length === expectedVoterCount * 2);
}

console.log(`\n===== 结果 =====\n检查项: ${checks} | 失败: ${failures}`);
await server.close();
if (failures > 0) {
  process.exit(1);
}
console.log('✓ 封闭投票回归全部通过');
