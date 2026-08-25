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
let ORIGINAL_CASE_LORE_CARDS;
let ORIGINAL_CASE_SUMMARY_MIN_LENGTH;
let ORIGINAL_CASE_SUMMARY_MAX_LENGTH;
let selectRoleplayRetrievalCards;
let buildRoleplayPersonality;
let buildRoleplaySpeechStyle;
let buildDecisionPrompt;
try {
  ({ ROLEPLAY_STATIC_BY_CHARACTER_ID } = await server.ssrLoadModule('/src/data/roleplay-static.ts'));
  ({
    ORIGINAL_CASE_LORE_CARDS,
    ORIGINAL_CASE_SUMMARY_MIN_LENGTH,
    ORIGINAL_CASE_SUMMARY_MAX_LENGTH,
    selectRoleplayRetrievalCards,
  } = await server.ssrLoadModule('/src/data/roleplay-retrieval.ts'));
  ({ buildRoleplayPersonality, buildRoleplaySpeechStyle } = await server.ssrLoadModule('/src/ai/roleplayLore.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
} finally {
  await server.close();
}

const cards = Object.values(ROLEPLAY_STATIC_BY_CHARACTER_ID);
assert.equal(cards.length, CHARACTER_CATALOG.length, '静态卡数量必须覆盖全部角色');
assert.equal(new Set(cards.map((card) => card.characterId)).size, cards.length, '静态卡 ID 必须唯一');

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
const baseSpeechDecision = {
  id: 'roleplay-static-speech',
  kind: 'speech',
  schemaKey: 'speech',
  actorId: 0,
  title: '公开发言',
  description: '根据当前信息发言',
  candidates: [],
  allowAbstain: false,
  skillInstanceId: null,
  options: {},
};

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
  const personality = buildRoleplayPersonality(
    character.id,
    { ...baseObservation, pendingDecision: baseSpeechDecision },
    baseSpeechDecision,
  );
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

const voteDecision = { ...baseSpeechDecision, id: 'roleplay-static-vote', kind: 'vote', schemaKey: 'target' };
const postGameDecision = { ...baseSpeechDecision, id: 'roleplay-static-post-game', options: { postGame: true } };
const speechPersonality = buildRoleplayPersonality(
  'soul-0',
  { ...baseObservation, pendingDecision: baseSpeechDecision },
  baseSpeechDecision,
);
const votePersonality = buildRoleplayPersonality(
  'soul-0',
  { ...baseObservation, pendingDecision: voteDecision },
  voteDecision,
);
const postGamePersonality = buildRoleplayPersonality(
  'soul-0',
  { ...baseObservation, phase: 'post-game', pendingDecision: postGameDecision },
  postGameDecision,
);
assert.match(speechPersonality, /动态上下文.*propose-hypothesis/);
assert.match(votePersonality, /动态上下文.*demand-evidence/);
assert.equal(postGamePersonality.includes('argument.'), false, '赛后不应注入论证动作卡');
const systemPrompt = buildGameSystemPrompt('speech');
assert.match(systemPrompt, /actor\.speechStyle 是同一静态卡的声音指纹/);
assert.match(systemPrompt, /finalRoles 是最终身份唯一来源/);
assert.equal(systemPrompt.includes('A1-C1'), false, '系统提示不得常驻原作案件');
assert.equal(systemPrompt.includes('魔女审判'), false, '系统提示不得常驻原作审判机制');

assert.equal(ORIGINAL_CASE_LORE_CARDS.length, 11, '案件短卡必须覆盖十一场审判记录');
assert.equal(new Set(ORIGINAL_CASE_LORE_CARDS.map((card) => card.id)).size, 11, '案件短卡 ID 必须唯一');
for (const caseCard of ORIGINAL_CASE_LORE_CARDS) {
  assert.ok(caseCard.summary.length >= ORIGINAL_CASE_SUMMARY_MIN_LENGTH, `${caseCard.id} 案件摘要过短`);
  assert.ok(caseCard.summary.length <= ORIGINAL_CASE_SUMMARY_MAX_LENGTH, `${caseCard.id} 案件摘要过长`);
}

const retrievalDefaults = {
  actorCharacterId: 'soul-13',
  actorSkillId: null,
  decisionKind: 'speech',
  isPostGame: false,
  focusedCharacterIds: [],
  recentCharacterIds: [],
  recentEventKinds: [],
  privateKnowledgeCount: 0,
  currentSpeechCount: 0,
  votesAgainstActor: 0,
};
const noCaseCards = selectRoleplayRetrievalCards(retrievalDefaults);
assert.equal(noCaseCards.some((card) => card.category === 'original_case'), false, '只有角色信号时不得常驻案件');
const knowledgeMatchedCards = selectRoleplayRetrievalCards({ ...retrievalDefaults, privateKnowledgeCount: 1, currentSpeechCount: 3 });
assert.equal(knowledgeMatchedCards.some((card) => card.id === 'argument.use-private-knowledge'), true, '私有查验应优先选择知识使用卡');
const pressureMatchedCards = selectRoleplayRetrievalCards({ ...retrievalDefaults, votesAgainstActor: 1 });
assert.equal(pressureMatchedCards.some((card) => card.id === 'pressure.answer-under-pressure'), true, '当前票型应触发受压回应卡');
const skillMatchedCards = selectRoleplayRetrievalCards({ ...retrievalDefaults, actorSkillId: 'clairvoyance' });
assert.equal(skillMatchedCards.some((card) => card.id === 'original-case.A2-C2'), true, '角色与技能应命中可可案');
const relationMatchedCards = selectRoleplayRetrievalCards({
  ...retrievalDefaults,
  focusedCharacterIds: ['soul-12'],
  recentCharacterIds: ['soul-12'],
});
assert.equal(relationMatchedCards.some((card) => card.id === 'original-case.A2-C2'), true, '当前对象与近期参与者应参与案件检索');
assert.equal(skillMatchedCards.filter((card) => card.category === 'original_case').length, 1, '单次最多注入一条案件');
for (const caseCard of ORIGINAL_CASE_LORE_CARDS) {
  let actorSkillId = null;
  if (caseCard.skillIds.length > 0) {
    actorSkillId = caseCard.skillIds[caseCard.skillIds.length - 1];
  }
  let relatedCharacterId = caseCard.characterIds[0];
  if (caseCard.characterIds.length > 1) {
    relatedCharacterId = caseCard.characterIds[1];
  }
  const matchedCards = selectRoleplayRetrievalCards({
    ...retrievalDefaults,
    actorCharacterId: caseCard.characterIds[0],
    actorSkillId,
    focusedCharacterIds: [relatedCharacterId],
    recentCharacterIds: [relatedCharacterId],
    recentEventKinds: [caseCard.eventKinds[0]],
  });
  assert.equal(matchedCards.some((card) => card.id === `original-case.${caseCard.id}`), true, `${caseCard.id} 必须可由结构化信号命中`);
}

const coco = CHARACTER_CATALOG.find((character) => character.id === 'soul-13');
assert.ok(coco, '共享契约缺少泽渡可可');
const dynamicPlayers = players.map((player) => ({ ...player }));
dynamicPlayers[0] = {
  ...dynamicPlayers[0],
  characterId: coco.id,
  name: coco.name,
  skillId: coco.defaultSkillId,
};
const dynamicObservation = {
  ...baseObservation,
  players: dynamicPlayers,
  pendingDecision: baseSpeechDecision,
};
const dynamicPrompt = buildDecisionPrompt({
  observation: dynamicObservation,
  pendingDecision: baseSpeechDecision,
  sessionId: 'roleplay-dynamic-case',
}, 'free');
const dynamicPayload = JSON.parse(dynamicPrompt[1].content);
assert.match(dynamicPayload.actor.personality, /original-case\.A2-C2/, '实际提示词应注入动态命中的可可案');
assert.match(dynamicPayload.actor.personality, /不得作为本局身份、投票或行动依据/, '案件卡必须携带本局隔离边界');
assert.equal(validateGamePrompt(dynamicPrompt).ok, true, '动态案件提示词必须通过后端契约');
const dynamicBodyBytes = Buffer.byteLength(JSON.stringify(buildFreeClientPayload('2.3.2', dynamicPrompt)), 'utf8');
maxPersonalityLength = Math.max(maxPersonalityLength, dynamicPayload.actor.personality.length);
maxFreeBodyBytes = Math.max(maxFreeBodyBytes, dynamicBodyBytes);
assert.ok(dynamicBodyBytes <= 32 * 1024, '动态案件提示词超过目标预算');

const contextEvents = [];
for (let index = 0; index < 8; index += 1) {
  contextEvents.push({
    id: `history-${index}`,
    kind: 'speech',
    day: 1,
    phase: 'speeches',
    text: `历史发言 ${index}`,
    actorPlayerId: index % 6,
    targetPlayerIds: [],
    displayAuthorPlayerId: index % 6,
    actualAuthorPlayerId: index % 6,
    data: {},
  });
}
for (let index = 0; index < 2; index += 1) {
  contextEvents.push({
    id: `current-${index}`,
    kind: 'speech',
    day: 2,
    phase: 'speeches',
    text: `当前发言 ${index}`,
    actorPlayerId: index,
    targetPlayerIds: [],
    displayAuthorPlayerId: index,
    actualAuthorPlayerId: index,
    data: {},
  });
}
contextEvents.push({
  id: 'current-skill',
  kind: 'skill',
  day: 2,
  phase: 'day-skills',
  text: '当前公开技能事件',
  actorPlayerId: 0,
  targetPlayerIds: [1],
  displayAuthorPlayerId: null,
  actualAuthorPlayerId: null,
  data: {},
});
const contextDecision = {
  ...baseSpeechDecision,
  id: 'roleplay-context-vote',
  kind: 'vote',
  schemaKey: 'target',
  candidates: [1, 2, 3, 4, 5],
};
const contextObservation = {
  ...baseObservation,
  day: 2,
  phase: 'voting',
  publicEvents: contextEvents,
  pendingDecision: contextDecision,
};
const contextPrompt = buildDecisionPrompt({
  observation: contextObservation,
  pendingDecision: contextDecision,
  sessionId: 'roleplay-context-selection',
}, 'free');
const contextPayload = JSON.parse(contextPrompt[1].content);
assert.equal(contextPayload.currentDaySpeeches.length, 2, '当前日发言必须完整保留');
assert.equal(contextPayload.historicalSpeeches.length, 6, '历史发言只保留最近六条');
assert.equal(contextPayload.recentPublic.includes('当前公开技能事件'), true, '近期非发言事件必须保留');
assert.equal(contextPayload.recentPublic.some((entry) => entry.includes('历史发言')), false, 'recentPublic 不得重复携带发言');

const oversizedRequiredEvents = [];
for (let index = 0; index < 6; index += 1) {
  oversizedRequiredEvents.push({
    id: `oversized-current-${index}`,
    kind: 'speech',
    day: 2,
    phase: 'speeches',
    text: '\u4e2d'.repeat(1900),
    actorPlayerId: index,
    targetPlayerIds: [],
    displayAuthorPlayerId: index,
    actualAuthorPlayerId: index,
    data: {},
  });
}
const oversizedRequiredObservation = {
  ...baseObservation,
  day: 2,
  phase: 'voting',
  publicEvents: oversizedRequiredEvents,
  pendingDecision: contextDecision,
};
const oversizedRequiredRequest = {
  observation: oversizedRequiredObservation,
  pendingDecision: contextDecision,
  sessionId: 'roleplay-oversized-required-context',
};
assert.throws(
  () => buildDecisionPrompt(oversizedRequiredRequest, 'custom'),
  /必要上下文超过 32 KiB 目标预算/,
  'custom provider must reject required context above the target budget',
);
assert.throws(
  () => buildDecisionPrompt(oversizedRequiredRequest, 'free'),
  /必要上下文超过 32 KiB 目标预算/,
  'free provider must reject required context above the target budget',
);

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
  assert.ok(bodyBytes <= 32 * 1024, `角色 ${playerId} 免费请求体超过目标预算`);
}

console.log(`Roleplay resource smoke passed (${cards.length} cards; max personality ${maxPersonalityLength}; max speechStyle ${maxSpeechStyleLength}; max free body ${maxFreeBodyBytes} bytes)`);
