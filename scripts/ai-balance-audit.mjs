#!/usr/bin/env node
/**
 * AI 对弈抽检（Issue #95 行动 2）：真实 LLM 驱动整局对弈，汇总胜率/职业表现/发言样本。
 * 完全复用游戏 AI 决策管线（buildDecisionPrompt + requestDecision + parseDecision），
 * 每个 AI 决策的视野与其在游戏中的观察完全一致（selectObservation 隐私投影）。
 *
 * 用法:
 *   node scripts/ai-balance-audit.mjs --players 6 --games 1
 *   node scripts/ai-balance-audit.mjs --players 9 --games 2 --model qwen3:8b --reasoning low
 *   node scripts/ai-balance-audit.mjs --min 6 --max 14 --games 1 --keep-speeches .runtime/ai-audit
 * 参数:
 *   --endpoint    OpenAI 兼容端点（默认 http://127.0.0.1:11434/v1/chat/completions）
 *   --model       模型名（默认 qwen2.5:7b）
 *   --reasoning   none|low|high（默认 none；仅支持思考的模型有效）
 *   --players N / --min N --max N
 *   --games N     每档对局数（默认 1）
 *   --seed        起始种子（默认 9000）
 *   --timeout-ms  整局超时上限毫秒（默认 600000，超时中止该局）
 *   --decision-timeout-ms 单决策超时毫秒（默认 300000，写入 custom 配置）
 *   --keep-speeches DIR 保存每局发言/狼议样本到 jsonl（用于人工检查奇怪发言）
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || process.argv[index + 1] === undefined) return fallback;
  return process.argv[index + 1];
}
const ENDPOINT = arg('endpoint', 'http://127.0.0.1:11434/v1/chat/completions');
const MODEL = arg('model', 'qwen2.5:7b');
const REASONING = arg('reasoning', 'none');
const PLAYERS = Number(arg('players', 0)) || 0;
const MIN_P = Math.max(6, Number(arg('min', 6)) || 6);
const MAX_P = Math.min(14, Number(arg('max', 14)) || 14);
const GAMES = Math.max(1, Number(arg('games', 1)) || 1);
const SEED = (Number(arg('seed', 9000)) || 9000) >>> 0;
const TIMEOUT_MS = Number(arg('timeout-ms', 600000)) || 600000;
const DECISION_TIMEOUT_MS = Math.max(30_000, Number(arg('decision-timeout-ms', 300000)) || 300000);
const SPEECH_DIR = arg('keep-speeches', '');

const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let createGame, reduceGame, fallbackDecision, selectObservation, requestDecision, roleNames;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ requestDecision } = await server.ssrLoadModule('/src/ai/client.ts'));
  ({ roleNames } = await server.ssrLoadModule('/src/domain/catalog/roles.ts'));
} finally {
  await server.close();
}

const aiConfig = {
  provider: 'custom',
  endpoint: ENDPOINT,
  apiKey: 'ollama',
  profiles: {
    default: { model: MODEL, reasoningEffort: REASONING },
    fast: { model: '', reasoningEffort: 'none' },
    deep: { model: '', reasoningEffort: REASONING },
  },
  retryCount: 0,
  jsonOutputMode: 'auto',
  timeoutMs: DECISION_TIMEOUT_MS,
};

function preValidate(pending, decision) {
  const target = decision?.targetPlayerId;
  if (typeof target === 'number') {
    if (!pending.candidates.includes(target)) return false;
  } else if (target !== null && target !== undefined) {
    return false;
  }
  if (target === null && !pending.allowAbstain) return false;
  if (pending.schemaKey === 'wolf-council' && typeof decision?.recommendedTargetPlayerId === 'number') {
    if (!pending.candidates.includes(decision.recommendedTargetPlayerId)) return false;
  }
  return true;
}

async function aiPlayOne(playerCount, seed) {
  let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0, playerCount, selectedCharacterIds: [] });
  const sessionId = `audit-${seed}`;
  const stats = { decisions: 0, aiFailures: 0, fallbackUsed: 0, speeches: [], council: [], lastFailureReason: null };
  let iterations = 0;
  const signalController = new AbortController();
  const timeout = setTimeout(() => signalController.abort(), TIMEOUT_MS);
  let aborted = false;
  try {
    while (game.phase !== 'ended') {
      if (++iterations > 6000) {
        return { timedOut: true, winner: null, day: game.day, stats };
      }
      if (game.pendingDecision) {
        const pending = game.pendingDecision;
        stats.decisions += 1;
        let decision = null;
        try {
          const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
          decision = await requestDecision(
            { observation, pendingDecision: pending, sessionId },
            aiConfig,
            signalController.signal,
          );
        } catch (error) {
          stats.aiFailures += 1;
          let reason = 'ai-error';
          if (error instanceof Error && error.message) {
            reason = error.message.slice(0, 100);
          }
          stats.lastFailureReason = reason;
          if (signalController.signal.aborted) {
            aborted = true;
            break;
          }
        }
        if (pending.schemaKey === 'speech' && pending.options?.postGame !== true) {
          const text = decision?.speech ?? '';
          let speechReason = null;
          if (decision === null) {
            speechReason = stats.lastFailureReason;
          }
          stats.speeches.push({ day: game.day, actorId: pending.actorId, text, failed: decision === null, reason: speechReason });
        }
        if (pending.schemaKey === 'wolf-council') {
          let councilReason = null;
          if (decision === null) {
            councilReason = stats.lastFailureReason;
          }
          stats.council.push({ day: game.day, actorId: pending.actorId, message: decision?.message ?? '', target: decision?.recommendedTargetPlayerId ?? null, failed: decision === null, reason: councilReason });
        }
        let resolved = false;
        if (decision !== null && preValidate(pending, decision)) {
          try {
            game = reduceGame(game, {
              type: 'submit-decision',
              pendingDecisionId: pending.id,
              actorId: pending.actorId,
              decision,
            });
            resolved = true;
          } catch {
            stats.aiFailures += 1;
            stats.lastFailureReason = 'engine-invalid';
          }
        }
        if (!resolved) {
          stats.fallbackUsed += 1;
          const fb = fallbackDecision(game, pending);
          game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
          game = reduceGame(game, {
            type: 'submit-decision',
            pendingDecisionId: pending.id,
            actorId: pending.actorId,
            decision: fb.decision,
          });
        }
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
  } finally {
    clearTimeout(timeout);
  }
  if (aborted) {
    return { timedOut: true, winner: null, day: game.day, stats };
  }
  return {
    timedOut: false,
    winner: game.result?.winner ?? null,
    day: game.day,
    stats,
    finalRoles: game.roleAssignments.map((a) => ({ owner: a.ownerPlayerId, roleId: a.roleId })),
  };
}

function writeSamples(playerCount, seed, result) {
  if (!SPEECH_DIR) return;
  mkdirSync(SPEECH_DIR, { recursive: true });
  const file = `${SPEECH_DIR}/game-${playerCount}p-${seed}.jsonl`;
  const rows = [];
  for (const item of result.stats.council) {
    rows.push({ kind: 'wolf-council', day: item.day, actorId: item.actorId, message: item.message, target: item.target, failed: item.failed, reason: item.reason ?? null });
  }
  for (const item of result.stats.speeches) {
    rows.push({ kind: 'speech', day: item.day, actorId: item.actorId, text: item.text, failed: item.failed, reason: item.reason ?? null });
  }
  appendFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  console.log(`  样本已存: ${file}（${rows.length} 条）`);
}

console.log(`AI 对弈抽检  endpoint=${ENDPOINT} model=${MODEL} reasoning=${REASONING} 每档 ${GAMES} 局`);
console.log('档位 | 局 | 胜者 | 天数 | 决策数 | AI失败 | 兜底 | 狼议数');
const totals = {};
let startP = MIN_P;
let endP = MAX_P;
if (PLAYERS > 0) {
  startP = PLAYERS;
  endP = PLAYERS;
}
for (let p = startP; p <= endP; p += 1) {
  for (let i = 0; i < GAMES; i += 1) {
    const seed = SEED + p * 100 + i;
    const started = Date.now();
    const result = await aiPlayOne(p, seed);
    const elapsed = Math.round((Date.now() - started) / 1000);
    let winnerLabel = '超时';
    if (result.winner === 'wolf') winnerLabel = '狼';
    else if (result.winner === 'neutral') winnerLabel = '呆头鹅';
    else if (result.winner === 'good') winnerLabel = '好';
    console.log(`${p}人 | ${i + 1} | ${winnerLabel} | ${result.day}天 | ${result.stats.decisions} | ${result.stats.aiFailures} | ${result.stats.fallbackUsed} | ${result.stats.council.length} | ${elapsed}s`);
    writeSamples(p, seed, result);
    const key = String(p);
    totals[key] = totals[key] ?? { good: 0, wolf: 0, neutral: 0, timedOut: 0, aiFailures: 0, decisions: 0, days: 0 };
    if (result.timedOut) totals[key].timedOut += 1;
    else totals[key][result.winner] += 1;
    totals[key].aiFailures += result.stats.aiFailures;
    totals[key].decisions += result.stats.decisions;
    totals[key].days += result.day;
  }
}
console.log('');
console.log('== 汇总（每档全部局）==');
for (const [p, row] of Object.entries(totals)) {
  const finished = row.good + row.wolf + row.neutral;
  let wolfPct = '-';
  let avgDays = '-';
  if (finished > 0) {
    wolfPct = ((row.wolf / finished) * 100).toFixed(0);
    avgDays = (row.days / finished).toFixed(1);
  }
  console.log(`${p}人: 好${row.good} 狼${row.wolf} 中${row.neutral} 超时${row.timedOut} | AI失败${row.aiFailures} 决策${row.decisions} 均天${avgDays} 狼胜${wolfPct}%`);
}
console.log('');
console.log('说明: 真实 LLM 决策（含语义层），样本量小仅作方向参考；AI 失败=模型返回非法/超时后由本地策略兜底。');
