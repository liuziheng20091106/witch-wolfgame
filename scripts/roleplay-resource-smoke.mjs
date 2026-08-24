#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import {
  BOARD_DESCRIPTION,
  CHARACTER_CATALOG,
  CHAT_COMPLETIONS_MAX_BODY_BYTES,
  PROMPT_LIMITS,
  buildFreeClientPayload,
  buildGameSystemPrompt,
} from '../shared/gamePromptContract.js';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
let ROLEPLAY_STATIC_BY_CHARACTER_ID;
let buildRoleplayPersonality;
let buildRoleplaySpeechStyle;
let buildDecisionPrompt;
try {
  ({ ROLEPLAY_STATIC_BY_CHARACTER_ID } = await server.ssrLoadModule('/src/data/roleplay-static.ts'));
  ({ buildRoleplayPersonality, buildRoleplaySpeechStyle } = await server.ssrLoadModule('/src/ai/roleplayLore.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
} finally {
  await server.close();
}

const cards = Object.values(ROLEPLAY_STATIC_BY_CHARACTER_ID);
assert.equal(cards.length, CHARACTER_CATALOG.length, '静态卡数量必须覆盖全部角色');
assert.equal(new Set(cards.map((card) => card.characterId)).size, cards.length, '静态卡 ID 必须唯一');

const forbiddenStaticContent = [
  'A1-C1',
  'A2-C1',
  '魔女审判',
  '处刑',
  '魔女化',
  '大魔女',
  '焚化炉',
  '学校舞台',
];
let maxPersonalityLength = 0;
let maxSpeechStyleLength = 0;

for (const character of CHARACTER_CATALOG) {
  const card = ROLEPLAY_STATIC_BY_CHARACTER_ID[character.id];
  assert.ok(card, `缺少 ${character.name} 的静态卡`);
  assert.equal(card.canonicalVersion, '后日谈', `${character.name} 版本必须唯一`);
  assert.ok(card.relationshipAnchors.length <= 2, `${character.name} 关系锚点超过上限`);
  const personality = buildRoleplayPersonality(character.id, 'speech', false);
  const speechStyle = buildRoleplaySpeechStyle(character.id);
  maxPersonalityLength = Math.max(maxPersonalityLength, personality.length);
  maxSpeechStyleLength = Math.max(maxSpeechStyleLength, speechStyle.length);
  assert.ok(personality.length <= PROMPT_LIMITS.actorPersonalityMaxLength, `${character.name} personality 超限`);
  assert.ok(speechStyle.length <= PROMPT_LIMITS.actorSpeechStyleMaxLength, `${character.name} speechStyle 超限`);
  for (const forbidden of forbiddenStaticContent) {
    assert.equal(personality.includes(forbidden), false, `${character.name} 静态卡泄漏 ${forbidden}`);
    assert.equal(speechStyle.includes(forbidden), false, `${character.name} 声音卡泄漏 ${forbidden}`);
  }
}

let maxFreeBodyBytes = 0;

const speechPersonality = buildRoleplayPersonality('soul-0', 'speech', false);
const votePersonality = buildRoleplayPersonality('soul-0', 'vote', false);
assert.match(speechPersonality, /按需论证卡/);
assert.match(votePersonality, /按需论证卡/);
assert.equal(buildRoleplayPersonality('soul-0', 'speech', true).includes('按需论证卡'), false, '赛后不应注入论证卡');
const systemPrompt = buildGameSystemPrompt('speech');
assert.match(systemPrompt, /actor\.speechStyle 是同一静态卡的声音指纹/);
assert.match(systemPrompt, /finalRoles 是最终身份唯一来源/);
assert.equal(systemPrompt.includes('A1-C1'), false, '系统提示不得常驻原作案件');
assert.equal(systemPrompt.includes('魔女审判'), false, '系统提示不得常驻原作审判机制');

const players = CHARACTER_CATALOG.slice(0, 6).map((character, playerId) => ({
  id: playerId,
  characterId: character.id,
  name: character.name,
  avatarUrl: `/avatar-${playerId}.png`,
  alive: true,
  roleId: 'villager',
  skillId: null,
  isSelf: playerId === 0,
}));
const baseObservation = {
  gameId: 'roleplay-smoke',
  mode: 'spectator',
  automationMode: 'remote',
  board: BOARD_DESCRIPTION,
  seed: 12,
  usedFreeProvider: false,
  day: 1,
  phase: 'speeches',
  viewerPlayerId: null,
  omniscient: true,
  players,
  publicEvents: [],
  privateEvents: [],
  archivedTimelines: [],
  knowledge: [],
  currentVotes: [],
  pendingDecision: null,
  result: null,
};
for (let playerId = 0; playerId < players.length; playerId += 1) {
  const pendingDecision = {
    id: `roleplay-${playerId}`,
    kind: 'speech',
    schemaKey: 'speech',
    actorId: playerId,
    title: '公开发言',
    description: '根据当前信息发言',
    candidates: [],
    allowAbstain: false,
    skillInstanceId: null,
    options: {},
  };
  const prompt = buildDecisionPrompt({
    observation: { ...baseObservation, pendingDecision },
    pendingDecision,
    sessionId: `roleplay-session-${playerId}`,
  }, 'free');
  const payload = JSON.parse(prompt[1].content);
  assert.equal(validateGamePrompt(prompt).ok, true, `角色 ${playerId} 提示词契约校验失败`);
  assert.ok(payload.actor.personality.length <= PROMPT_LIMITS.actorPersonalityMaxLength, `角色 ${playerId} actor personality 超限`);
  const body = JSON.stringify(buildFreeClientPayload('2.3.2', prompt));
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  maxFreeBodyBytes = Math.max(maxFreeBodyBytes, bodyBytes);
  assert.ok(bodyBytes <= CHAT_COMPLETIONS_MAX_BODY_BYTES, `角色 ${playerId} 免费请求体超限`);
}

console.log(`Roleplay resource smoke passed (${cards.length} cards; max personality ${maxPersonalityLength}; max speechStyle ${maxSpeechStyleLength}; max free body ${maxFreeBodyBytes} bytes)`);
