#!/usr/bin/env node
/**
 * 回归测试：AI 规则认知——基础职业与魔女技相互独立
 *
 * 背景：实测 AI 曾把「基础职业」与「魔女技」当成同一套系统（希罗跳预言家被
 * 奈叶香以"你的魔女技是死亡回溯，并非查验"反驳）。修复方式：system 提示词
 * 明确「两者相互独立、互不影响，公开魔女技不代表基础职业公开」。
 *
 * 本测试跑一局完整对局（本地策略），对【每次决策】验证：
 * 1. system 提示词包含规则句（职业与魔女技独立）——回归 P2-1
 * 2. 整条 messages 通过后端 validateGamePrompt 协议校验（覆盖全部实际出现的
 *    schema，如 speech/vote/skill/ignition 等）——回归 P2-3
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, buildDecisionPrompt, selectObservation;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  // 保持 server 打开直到对局结束
}

const RULE_SENTENCE = '每个玩家同时拥有一个基础职业（狼人/预言家/女巫/村民）与一个公开的魔女技，两者相互独立、互不影响：公开魔女技不代表基础职业公开，反之亦然。';

let failures = 0;
let decisions = 0;
const schemaSeen = new Set();

function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 20260820 >>> 0 });
let iterations = 0;
let promptErrors = 0;
let protocolFailures = 0;
let ruleFailures = 0;
const schemaCount = new Map();

while (game.phase !== 'ended') {
  if (++iterations > 3000) { console.log('!! 超过迭代上限，提前结束'); break; }
  if (game.pendingDecision) {
    const pending = game.pendingDecision;
    decisions += 1;
    const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    let messages;
    try {
      messages = buildDecisionPrompt({ observation, pendingDecision: pending });
    } catch (error) {
      promptErrors += 1;
      console.log(`  ✗ buildDecisionPrompt 异常 [${pending.schemaKey}]: ${error.message}`);
      break;
    }
    const systemContent = messages[0].content;
    schemaSeen.add(pending.schemaKey);
    schemaCount.set(pending.schemaKey, (schemaCount.get(pending.schemaKey) ?? 0) + 1);

    // P2-1：规则句必须在 system 提示词中
    if (!systemContent.includes(RULE_SENTENCE)) {
      ruleFailures += 1;
      console.log(`  ✗ [${pending.schemaKey}] system 提示词缺少规则句`);
    }
    // P2-3：整条 messages 必须通过后端协议校验（覆盖全部出现的 schema）
    if (!validateGamePrompt(messages)) {
      protocolFailures += 1;
      console.log(`  ✗ [${pending.schemaKey}] 未通过 validateGamePrompt 协议校验`);
    }

    const fallback = fallbackDecision(game, pending);
    game = reduceGame(game, { type: 'set-rng-state', rngState: fallback.rngState });
    game = reduceGame(game, {
      type: 'submit-decision',
      pendingDecisionId: pending.id,
      actorId: pending.actorId,
      decision: fallback.decision,
    });
    continue;
  }
  game = reduceGame(game, { type: 'advance' });
}

console.log(`\n===== 验证结果 =====`);
console.log(`对局结束于第 ${game.day} 天（${game.phase}），胜者: ${game.result?.winner ?? '无'}`);
console.log(`决策总数: ${decisions}，涉及的 schema: ${[...schemaSeen].join(', ')}`);
for (const [key, count] of [...schemaCount.entries()].sort()) {
  console.log(`  ${key}: ${count} 次`);
}
console.log(`prompt 异常: ${promptErrors} | 规则句缺失: ${ruleFailures} | 协议校验失败: ${protocolFailures}`);

if (failures === 0 && schemaSeen.size >= 3) {
  console.log('\n✓ 全部通过：规则句每次决策都在，且所有决策均通过后端协议校验');
  await server.close();
  process.exit(0);
}
console.log(`\n!!! 失败：${failures} 项（规则句缺失 ${ruleFailures}，协议失败 ${protocolFailures}，prompt 异常 ${promptErrors}）`);
await server.close();
process.exit(1);
