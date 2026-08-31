#!/usr/bin/env node
/**
 * 验证遗言决策在 AI 提示词链路的兼容性：
 * 1. isAllowedDecisionPair('speech', 'speech') 通过
 * 2. buildDecisionPrompt 能为死者 actor 组装提示词（无异常）
 * 3. 真实消息通过后端 validateGamePrompt
 * 4. parseDecision 能解析 AI 返回的 {speech}
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, resolveNight, buildDecisionPrompt, parseDecision, isAllowedDecisionPair, getRoleAssignment;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ resolveNight } = await server.ssrLoadModule('/src/domain/engine/night.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ parseDecision } = await server.ssrLoadModule('/src/ai/schemas.ts'));
  ({ isAllowedDecisionPair } = await server.ssrLoadModule('/shared/gamePromptContract.js'));
  ({ getRoleAssignment } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
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

// 找一个对局并构造首夜狼刀死亡 → 遗言决策
const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 42 >>> 0, playerCount: 6, selectedCharacterIds: [] });
const realWolf = game.players.find((p) => getRoleAssignment(game, p.id).roleId === 'wolf');
const victim = game.players.find((p) => p.id !== realWolf?.id);
if (!realWolf || !victim) {
  console.log('FAIL 对局缺少狼人');
  await server.close();
  process.exit(1);
}
console.log(`  狼人座位: ${realWolf.id}，死者座位: ${victim.id}`);
game.privateEvents.push({
  id: `${game.gameId}-inject-wolf`,
  kind: 'wolf-attack',
  day: game.day,
  phase: 'night-resolution',
  text: '注入狼刀',
  actorPlayerId: realWolf.id,
  targetPlayerIds: [victim.id],
  displayAuthorPlayerId: null,
  actualAuthorPlayerId: null,
  data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: victim.id },
  viewerPlayerIds: [realWolf.id],
});
const resolved = resolveNight(game);
const pending = resolved.pendingDecision;
check('出现遗言决策', pending !== null && pending.title === '遗言');
if (!pending) {
  await server.close();
  process.exit(1);
}

check('契约允许 speech/speech 组合', isAllowedDecisionPair('speech', 'speech'));

// 以死者视角组装 AI 提示词（模拟 useGameController 的请求路径）
const { selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts');
const observation = selectObservation(resolved, { kind: 'player', playerId: pending.actorId });
let prompt;
try {
  prompt = buildDecisionPrompt({ observation, pendingDecision: pending });
  check('buildDecisionPrompt 组装成功', prompt.length === 2 && prompt[0].role === 'system' && prompt[1].role === 'user');
} catch (error) {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  check('buildDecisionPrompt 组装成功', false, message);
}
if (prompt) {
  const payload = JSON.parse(prompt[1].content);
  check('action.title 为遗言', payload.action.title === '遗言');
  check('actor 是死者', payload.actor.playerId === pending.actorId);
  check('alivePlayers 不含死者', !payload.alivePlayers.some((p) => p.playerId === pending.actorId));
  const validation = validateGamePrompt(prompt);
  check('真实遗言提示词通过后端验证', validation.ok, JSON.stringify(validation));
}

// parseDecision 解析 AI 返回
let parsed;
try {
  parsed = parseDecision(pending, { speech: '这是测试遗言，大家保重。' });
  check('parseDecision 接受合法遗言', parsed.speech === '这是测试遗言，大家保重。');
} catch (error) {
  let message = String(error);
  if (error instanceof Error) {
    message = error.message;
  }
  check('parseDecision 接受合法遗言', false, message);
}
try {
  parseDecision(pending, { speech: 'x'.repeat(161) });
  check('parseDecision 拒绝超长遗言', false, '161 字应被拒绝');
} catch {
  check('parseDecision 拒绝超长遗言', true);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
await server.close();
if (failures > 0) {
  process.exit(1);
} else {
  console.log('PASS 遗言 AI 链路验证通过');
  process.exit(0);
}
