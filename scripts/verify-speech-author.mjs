#!/usr/bin/env node
/**
 * 验证：AI 提示词中的发言必须带「作者：」前缀
 *
 * 跑一局完整对局（本地策略），每次进入 speeches 阶段有 pendingDecision 时，
 * 调用 buildDecisionPrompt 生成提示词，检查 currentDaySpeeches / historicalSpeeches / recentPublic
 * 中的每条发言都带「名字：」或「N号：」前缀。
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, buildDecisionPrompt, selectObservation, characterById;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
} finally {
  // 保持 server 打开直到对局结束
}

const playerName = (state, id) => {
  const player = state.players.find((p) => p.id === id);
  if (!player) return `?${id}?`;
  return characterById[player.characterId]?.name ?? `?${id}?`;
};

let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 20260820 >>> 0 });
let iterations = 0;
let checked = 0;
let failed = 0;
let samples = [];

while (game.phase !== 'ended') {
  if (++iterations > 3000) { console.log('!! 超过迭代上限，提前结束'); break; }
  if (game.pendingDecision) {
    const pending = game.pendingDecision;
    const viewerId = pending.actorId;
    const observation = selectObservation(game, { kind: 'player', playerId: viewerId });
    const request = { observation, pendingDecision: pending };
    let prompt;
    try {
      prompt = buildDecisionPrompt(request);
    } catch (e) {
      console.log('buildDecisionPrompt 异常:', e.message);
      break;
    }
    const userContent = prompt[1].content;
    const parsed = JSON.parse(userContent);
    const actorName = playerName(game, pending.actorId);

    if (pending.kind === 'speech') {
      checked += 1;
      const allSpeechEntries = [...parsed.currentDaySpeeches, ...parsed.historicalSpeeches];
      for (const entry of allSpeechEntries) {
        // 每条发言必须带「发言来源：名字。发言内容：…」前缀
        const hasAuthor = /^发言来源：[^。]+。发言内容：/.test(entry);
        if (!hasAuthor) {
          failed += 1;
          console.log(`  ✗ [${actorName}] 无作者前缀的发言: ${entry}`);
        } else if (samples.length < 8) {
          samples.push(`  [${actorName}] ${entry.slice(0, 60)}`);
        }
      }
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
  // 无 pending：推进
  game = reduceGame(game, { type: 'advance' });
}

console.log(`\n===== 验证结果 =====`);
console.log(`对局结束于第 ${game.day} 天，${game.phase}，胜者: ${game.result?.winner ?? '无'}`);
console.log(`检查发言决策次数: ${checked}`);
console.log(`无作者前缀的发言数: ${failed}`);
if (samples.length) {
  console.log(`\n抽样（行动者视角看到的发言，已带作者）：`);
  for (const s of samples) console.log(s);
}
if (failed > 0) {
  console.log(`\n!!! 验证失败：存在 ${failed} 条无作者前缀的发言 !!!`);
  process.exit(1);
} else {
  console.log(`\n✓ 所有发言均带「作者：」前缀`);
}

await server.close();
