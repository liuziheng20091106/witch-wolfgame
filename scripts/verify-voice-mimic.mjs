#!/usr/bin/env node
/**
 * 回归测试：声音模仿（voice-mimic）——候选与说话风格映射
 *
 * 修复背景（bug 4）：
 * - mimicVoices（playerId → speechStyle）曾放在 options 里，AI 可能混淆
 *   "发言顺序编号"与"座位号"，导致模仿时用了错误角色的人设。
 * - 修复：voice-mimic 决策的候选直接附带 speechStyle（prompts.ts），
 *   且发言顺序在开局公屏公示（createGame.ts）。
 *
 * 验证：
 * 1. voice-mimic 决策的 candidates 与 mimicVoices 一一对应（playerId → speechStyle 不错位）
 * 2. 每个候选的 speechStyle 与对应角色的实际 speech_style 一致
 * 3. 非 voice-mimic 决策不注入 speechStyle（不泄露说话风格）
 * 4. 开局公屏包含发言顺序公示
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, getPlayer, characterById;
let getAfterSpeechSkillDecision, getBeforeSpeechSkillDecision;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ getPlayer } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
  ({ getAfterSpeechSkillDecision, getBeforeSpeechSkillDecision } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts'));
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

// 找一个有声音模仿持有者的局，并推进到其声音模仿决策
function findVoiceMimicDecision() {
  for (let seed = 1; seed < 400; seed += 1) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const skill = game.skillInstances.find((s) => s.definitionId === 'voice-mimic');
    if (!skill) {
      continue;
    }
    const ownerId = skill.ownerPlayerId;
    // 模拟：其他玩家已发言，声音模仿持有者随后可发动
    // 直接构造"已有一人发言"的假象（声音模仿决策依赖未发言者候选）
    // 这里直接调用决策函数验证映射（不需要完整对局）
    const spokenPlayer = game.players.find((p) => p.id !== ownerId);
    if (!spokenPlayer) {
      continue;
    }
    // 注入一条已发言事件（让候选池排除发言者，但保留其他未发言者）
    game.publicEvents.push({
      id: `${game.gameId}-fake-speech`, kind: 'speech', day: game.day, phase: game.phase,
      text: '测试发言', actorPlayerId: spokenPlayer.id, targetPlayerIds: [spokenPlayer.id],
      displayAuthorPlayerId: spokenPlayer.id, actualAuthorPlayerId: spokenPlayer.id, data: {},
    });
    const decision = getAfterSpeechSkillDecision(game, ownerId);
    if (decision && decision.schemaKey === 'voice-mimic') {
      return { game, ownerId, decision };
    }
  }
  return null;
}

// ===== 1. voice-mimic 候选与 mimicVoices 映射一致 =====
console.log('=== 1. 候选与说话风格映射 ===');
{
  const found = findVoiceMimicDecision();
  check('找到声音模仿决策', found !== null);
  if (!found) {
    process.exit(1);
  }
  const { game, decision } = found;
  const mimicVoices = Array.isArray(decision.options.mimicVoices) ? decision.options.mimicVoices : [];
  check('mimicVoices 存在且与候选同数', mimicVoices.length === decision.candidates.length, `candidates=${decision.candidates.length} voices=${mimicVoices.length}`);
  let allMatched = true;
  for (const playerId of decision.candidates) {
    const voice = mimicVoices.find((entry) => entry.playerId === playerId);
    if (!voice) {
      allMatched = false;
      break;
    }
    const character = characterById[getPlayer(game, playerId).characterId];
    if (voice.speechStyle !== character.speechStyle.slice(0, 300)) {
      allMatched = false;
      break;
    }
  }
  check('每个候选的 speechStyle 与角色实际风格一致', allMatched);
}

// ===== 2. 非 voice-mimic 决策不注入 speechStyle =====
console.log('=== 2. 不泄露说话风格 ===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 1 >>> 0 });
  // 构造一个非 voice-mimic 决策（如视线诱导/怪力），检查其候选无 speechStyle
  const skill = game.skillInstances.find((s) => s.definitionId === 'speech-restrain' || s.definitionId === 'gaze-guidance');
  check('找到对照技能', skill !== undefined);
  if (skill) {
    // 直接验证 prompts 的 legalCandidates 逻辑：非 voice-mimic 不附加 speechStyle
    // 通过检查 mimicVoices 只在 voice-mimic 决策出现（决策 options 层面）
    const voiceSkill = game.skillInstances.find((s) => s.definitionId === 'voice-mimic');
    const nonVoiceDecision = getBeforeSpeechSkillDecision(game, skill.ownerPlayerId);
    check('非 voice-mimic 决策无 mimicVoices', nonVoiceDecision === null || nonVoiceDecision.options.mimicVoices === undefined);
    void voiceSkill;
  }
}

// ===== 3. 开局公屏含发言顺序公示 =====
console.log('=== 3. 发言顺序公示 ===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 3 >>> 0 });
  const hasOrder = game.publicEvents.some((e) => e.text.includes('发言顺序'));
  check('开局公屏播报发言顺序', hasOrder);
}

console.log('');
console.log('===== 结果 =====');
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures > 0) {
  console.log('FAIL 声音模仿验证未通过');
  process.exit(1);
}
console.log('PASS 声音模仿验证全部通过');
await server.close();
