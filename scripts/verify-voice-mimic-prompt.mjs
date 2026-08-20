#!/usr/bin/env node
/**
 * 回归测试：声音模仿 × 发言来源标注
 *
 * 覆盖 GPT review 建议的两点：
 * 1. displayAuthorPlayerId 优先于 actorPlayerId（伪造发言显示为被模仿者）
 * 2. 普通玩家视角不泄露 actualAuthorPlayerId（模仿者身份不出现在提示词中）
 *
 * 场景构造（真实引擎）：
 *   A 持有声音模仿 → 伪造 B 的发言「我是被伪造的发言」
 *   B 正常发言「B的真实发言」→ 公开记录 merged = 「B的真实发言 我是被伪造的发言」
 *   displayAuthor = B（被模仿者），actualAuthor = A（模仿者真身）
 *   验证第三人 C 的玩家视角提示词：
 *     - 发言来源显示为 B，不显示为 A
 *     - 玩家视角 publicEvents 中 actualAuthorPlayerId 为 null
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, publishSpeech, selectObservation, buildDecisionPrompt, characterById;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ publishSpeech } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
} finally {
  // server 保持打开
}

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

// 固定种子找一局：循环种子直到出现 voice-mimic 持有者
let game = null;
let mimicSkill = null;
for (let seed = 1; seed <= 50; seed++) {
  const candidate = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
  const skill = candidate.skillInstances.find((entry) => entry.definitionId === 'voice-mimic');
  if (skill && getAliveOther(candidate, skill.ownerPlayerId) !== null) {
    game = candidate;
    mimicSkill = skill;
    break;
  }
}
if (!game || !mimicSkill) {
  console.log('!! 未找到含 voice-mimic 的对局，测试中止');
  await server.close();
  process.exit(1);
}

function getAliveOther(state, playerId) {
  return state.players.find((p) => p.alive && p.id !== playerId)?.id ?? null;
}

const mimicId = mimicSkill.ownerPlayerId; // A：模仿者
const targetId = getAliveOther(game, mimicId); // B：被模仿者
const viewerId = getAliveOther(game, Math.max(mimicId, targetId));
const nameOf = (state, id) => characterById[state.players.find((p) => p.id === id).characterId].name;
const mimicName = nameOf(game, mimicId);
const targetName = nameOf(game, targetId);

// 模拟声音模仿已生效（applySpeechSkillDecision 的效果）
mimicSkill.data.forgedDay = game.day;
mimicSkill.data.targetPlayerId = targetId;
mimicSkill.data.forgedSpeech = '我是被伪造的发言';

// B 公开发言（含视线诱导检查：若存在视线诱导需提及对方，这里用座位号规避不确定性，出现异常则回退纯文本）
let speechText = 'B的真实发言';
try {
  publishSpeech(game, targetId, { speech: speechText });
} catch (error) {
  // 视线诱导等校验失败：改用提及目标角色的占位内容重试
  speechText = `${targetName} 3号 B的真实发言`;
  try {
    publishSpeech(game, targetId, { speech: speechText });
  } catch (error2) {
    console.log(`!! publishSpeech 失败: ${error2.message}`);
    await server.close();
    process.exit(1);
  }
}

console.log(`\n场景：${mimicName}(模仿者A) 伪造 ${targetName}(被模仿者B) 的发言，第三人视角验证\n`);

// ===== 1. 玩家视角（C 看公开记录）=====
const playerObs = selectObservation(game, { kind: 'player', playerId: viewerId });
const speechEvent = playerObs.publicEvents.find((e) => e.kind === 'speech' && e.actorPlayerId === targetId);
check('玩家视角 speech 事件存在', Boolean(speechEvent));
check(
  '玩家视角 actualAuthorPlayerId 已置空（不泄露模仿者）',
  speechEvent?.actualAuthorPlayerId === null,
  `实际值: ${speechEvent?.actualAuthorPlayerId}`,
);
check(
  '玩家视角 displayAuthorPlayerId = 被模仿者',
  speechEvent?.displayAuthorPlayerId === targetId,
  `实际值: ${speechEvent?.displayAuthorPlayerId}`,
);

const pending = {
  id: 'test-pending',
  kind: 'speech',
  schemaKey: 'speech',
  actorId: viewerId,
  title: '发言',
  description: '公开发言不超过 100 字。',
  candidates: [],
  allowAbstain: true,
  skillInstanceId: null,
  options: {},
};
const prompt = buildDecisionPrompt({ observation: playerObs, pendingDecision: pending });
const userContent = prompt[1].content;
const parsed = JSON.parse(userContent);

const speechEntry = parsed.currentDaySpeeches.find((entry) => entry.includes('我是被伪造的发言'));
check(
  '伪造发言显示为「发言来源：被模仿者」',
  Boolean(speechEntry) && speechEntry.startsWith(`发言来源：${targetName}`),
  speechEntry ? `实际: ${speechEntry}` : '未找到伪造发言条目',
);
check(
  '提示词中不存在「发言来源：模仿者」',
  !parsed.currentDaySpeeches.some((entry) => entry.startsWith(`发言来源：${mimicName}`)),
  `出现: ${parsed.currentDaySpeeches.filter((entry) => entry.startsWith(`发言来源：${mimicName}`)).join(' | ')}`,
);
check(
  '提示词全文不包含 actualAuthorPlayerId 字段',
  !userContent.includes('actualAuthorPlayerId'),
  '出现 actualAuthorPlayerId 字样',
);
check(
  'speech 事件 merged 含真实+伪造两段',
  Boolean(speechEntry) && speechEntry.includes('B的真实发言') && speechEntry.includes('我是被伪造的发言'),
  speechEntry ? `实际: ${speechEntry}` : '',
);

// ===== 2. 全量校验 =====
// currentDaySpeeches / historicalSpeeches 全部是发言，必须每条带前缀
const speechOnlyEntries = [...parsed.currentDaySpeeches, ...parsed.historicalSpeeches];
let noPrefix = 0;
for (const entry of speechOnlyEntries) {
  if (!/^发言来源：[^。]+。发言内容：/.test(entry)) noPrefix += 1;
}
check(
  `currentDay/historical 发言全部带「发言来源」前缀（共 ${speechOnlyEntries.length} 条）`,
  noPrefix === 0,
  `缺前缀 ${noPrefix} 条`,
);
// recentPublic 是混排事件流（含非 speech 事件），只验证其中 speech 事件带前缀
const forgedInRecent = parsed.recentPublic.find((entry) => entry.includes('我是被伪造的发言'));
check(
  'recentPublic 中的伪造发言条目也带「发言来源」前缀',
  Boolean(forgedInRecent) && forgedInRecent.startsWith(`发言来源：${targetName}`),
  forgedInRecent ? `实际: ${forgedInRecent}` : '未找到',
);

// ===== 3. 观战视角（全知）对照：提示词仍按公开作者显示 =====
const specObs = selectObservation(game, { kind: 'spectator' });
const specPending = { ...pending, actorId: 0 };
const specPrompt = buildDecisionPrompt({ observation: specObs, pendingDecision: specPending });
const specContent = specPrompt[1].content;
const specParsed = JSON.parse(specContent);
const specEntry = specParsed.currentDaySpeeches.find((entry) => entry.includes('我是被伪造的发言'));
check(
  '观战视角也按 displayAuthor（被模仿者）显示，不暴露真实作者',
  Boolean(specEntry) && specEntry.startsWith(`发言来源：${targetName}`),
  specEntry ? `实际: ${specEntry}` : '未找到',
);

console.log(`\n===== ${failures === 0 ? '全部通过 ✓' : `失败 ${failures} 项 ✗`} =====`);
await server.close();
process.exit(failures === 0 ? 0 : 1);
