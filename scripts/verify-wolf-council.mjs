#!/usr/bin/env node
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { validateGamePrompt } from '../server/gameProtocol.mjs';
import { PROMPT_LIMITS, WOLF_COUNCIL_MESSAGE_MAX_LENGTH } from '../shared/gamePromptContract.js';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let buildDecisionPrompt;
let createGame;
let fallbackDecision;
let getAlivePlayerIds;
let getRoleAssignment;
let parseDecision;
let reduceGame;
let selectObservation;
try {
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getAlivePlayerIds, getRoleAssignment, selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
  ({ parseDecision } = await server.ssrLoadModule('/src/ai/schemas.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));

  function livingWolves(state) {
    return getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'wolf');
  }

  function prepareCouncil(state) {
    const prepared = structuredClone(state);
    prepared.phase = 'wolf-suggestions';
    prepared.pendingDecision = null;
    prepared.privateEvents = prepared.privateEvents.filter((event) => event.data.actionKind !== 'wolf-suggestion' && event.data.actionKind !== 'wolf-decision');
    return prepared;
  }

  function advance(state) {
    return reduceGame(state, { type: 'advance' });
  }

  function submit(state, decision) {
    const pending = state.pendingDecision;
    assert.notEqual(pending, null, '提交前必须存在待处理决策');
    return reduceGame(state, {
      type: 'submit-decision',
      pendingDecisionId: pending.id,
      actorId: pending.actorId,
      decision,
    });
  }

  function councilEvents(state) {
    return state.privateEvents.filter((event) => event.day === state.day && event.data.actionKind === 'wolf-suggestion');
  }

  function promptForActor(state) {
    const pending = state.pendingDecision;
    assert.notEqual(pending, null, '组装提示词前必须存在待处理决策');
    const observation = selectObservation(state, { kind: 'player', playerId: pending.actorId });
    return buildDecisionPrompt({ observation, pendingDecision: pending });
  }

  function runAllCouncilSpeeches(state, prefix) {
    let current = state;
    const actors = [];
    let guard = 0;
    while (current.phase === 'wolf-suggestions' && guard < 20) {
      guard += 1;
      if (current.pendingDecision === null) {
        current = advance(current);
        continue;
      }
      const pending = current.pendingDecision;
      assert.equal(pending.kind, 'wolf-suggestion');
      assert.equal(pending.schemaKey, 'wolf-council');
      assert.notEqual(pending.actorId, 99, '造物不得成为狼议发言者');
      assert.deepEqual(validateGamePrompt(promptForActor(current)), { ok: true });
      const fallbackA = fallbackDecision(current, pending);
      const fallbackB = fallbackDecision(current, pending);
      assert.deepEqual(fallbackA, fallbackB, '本地狼议兜底必须保持确定性');
      actors.push(pending.actorId);
      const targetPlayerId = pending.candidates[0];
      assert.notEqual(targetPlayerId, undefined);
      const decision = parseDecision(pending, {
        message: `${prefix}${actors.length}：比较公开发言后，我认为这个目标最可能威胁狼队。`,
        recommendedTargetPlayerId: targetPlayerId,
      });
      current = submit(current, decision);
    }
    assert.ok(guard < 20, '狼议不得死循环');
    return { state: current, actors };
  }

  console.log('=== 狼人内部频道回归 ===');

  let spectator = prepareCouncil(createGame({ mode: 'spectator', humanCharacterId: null, seed: 72, playerCount: 6, selectedCharacterIds: [] }));
  const spectatorRealWolves = livingWolves(spectator).filter((playerId) => playerId !== 99);
  assert.equal(spectatorRealWolves.length, 2);
  const firstPendingState = advance(spectator);
  const firstPending = firstPendingState.pendingDecision;
  assert.notEqual(firstPending, null);
  assert.equal(firstPending.schemaKey, 'wolf-council');
  assert.deepEqual(firstPending.options.wolfCouncilMessages, []);
  assert.throws(
    () => parseDecision(firstPending, {
      message: '长'.repeat(161),
      recommendedTargetPlayerId: firstPending.candidates[0],
    }),
    /wolf-council 契约/,
  );
  assert.throws(
    () => parseDecision(firstPending, { message: '推荐一个非法目标。', recommendedTargetPlayerId: 99 }),
    /非法目标/,
  );
  assert.throws(
    () => submit(firstPendingState, { message: '   ', recommendedTargetPlayerId: firstPending.candidates[0] }),
    /狼议发言必须为/,
  );

  const spectatorCouncil = runAllCouncilSpeeches(spectator, '狼议');
  spectator = spectatorCouncil.state;
  assert.deepEqual(new Set(spectatorCouncil.actors), new Set(spectatorRealWolves), '两名真实狼人都必须发言');
  assert.equal(councilEvents(spectator).length, 2);
  spectator = advance(spectator);
  assert.equal(spectator.phase, 'wolf-decision');
  spectator = advance(spectator);
  const finalPending = spectator.pendingDecision;
  assert.notEqual(finalPending, null);
  assert.equal(finalPending.kind, 'wolf-decision');
  assert.equal(finalPending.options.wolfCouncilMessages.length, 2);
  assert.ok(finalPending.options.wolfCouncilMessages.some((message) => message.speakerPlayerId === finalPending.actorId));
  const finalPrompt = promptForActor(spectator);
  assert.deepEqual(validateGamePrompt(finalPrompt), { ok: true }, '最终狼刀提示必须通过后端契约');
  const finalPayload = JSON.parse(finalPrompt[1].content);
  assert.equal(finalPayload.options.wolfCouncilMessages.length, 2);
  assert.equal(finalPayload.privateEvents.some((text) => text.includes('建议袭击')), false, '专用狼议不得在 privateEvents 中重复');

  const forgedPrompt = structuredClone(finalPrompt);
  const forgedPayload = JSON.parse(forgedPrompt[1].content);
  forgedPayload.options.wolfCouncilMessages[0].speakerPlayerId = 99;
  forgedPrompt[1].content = JSON.stringify(forgedPayload);
  assert.deepEqual(
    validateGamePrompt(forgedPrompt),
    { ok: false, reason: 'wolf_council_options', path: 'options.wolfCouncilMessages' },
  );

  const forgedGoodSpeakerPrompt = structuredClone(finalPrompt);
  const forgedGoodSpeakerPayload = JSON.parse(forgedGoodSpeakerPrompt[1].content);
  const forgedGoodSpeaker = forgedGoodSpeakerPayload.legalCandidates.find((candidate) => candidate.playerId !== 99);
  assert.notEqual(forgedGoodSpeaker, undefined);
  forgedGoodSpeakerPayload.options.wolfCouncilMessages[0].speakerPlayerId = forgedGoodSpeaker.playerId;
  forgedGoodSpeakerPayload.options.wolfCouncilMessages[0].speakerName = forgedGoodSpeaker.name;
  forgedGoodSpeakerPrompt[1].content = JSON.stringify(forgedGoodSpeakerPayload);
  assert.deepEqual(
    validateGamePrompt(forgedGoodSpeakerPrompt),
    { ok: false, reason: 'wolf_council_options', path: 'options.wolfCouncilMessages' },
    '存活好人不得伪造狼队发言',
  );

  const incompleteCouncilPrompt = structuredClone(finalPrompt);
  const incompleteCouncilPayload = JSON.parse(incompleteCouncilPrompt[1].content);
  incompleteCouncilPayload.options.wolfCouncilMessages.pop();
  incompleteCouncilPrompt[1].content = JSON.stringify(incompleteCouncilPayload);
  assert.deepEqual(
    validateGamePrompt(incompleteCouncilPrompt),
    { ok: false, reason: 'wolf_council_options', path: 'options.wolfCouncilMessages' },
    '最终狼刀必须携带完整的真实狼人发言记录',
  );

  const legacySuggestionPrompt = structuredClone(finalPrompt);
  const legacySuggestionPayload = JSON.parse(legacySuggestionPrompt[1].content);
  legacySuggestionPayload.action.kind = 'wolf-suggestion';
  delete legacySuggestionPayload.options.wolfCouncilMessages;
  legacySuggestionPrompt[1].content = JSON.stringify(legacySuggestionPayload);
  assert.deepEqual(validateGamePrompt(legacySuggestionPrompt), { ok: true }, '升级前 target 狼建议存档必须保持可恢复');

  const missingCouncilPrompt = structuredClone(finalPrompt);
  const missingCouncilPayload = JSON.parse(missingCouncilPrompt[1].content);
  delete missingCouncilPayload.options.wolfCouncilMessages;
  missingCouncilPrompt[1].content = JSON.stringify(missingCouncilPayload);
  assert.deepEqual(
    validateGamePrompt(missingCouncilPrompt),
    { ok: false, reason: 'wolf_council_options', path: 'options.wolfCouncilMessages' },
    '最终狼刀不得通过省略狼议字段绕过校验',
  );

  const malformedCouncilPrompt = structuredClone(finalPrompt);
  const malformedCouncilPayload = JSON.parse(malformedCouncilPrompt[1].content);
  malformedCouncilPayload.options.wolfCouncilMessages = 'invalid';
  malformedCouncilPrompt[1].content = JSON.stringify(malformedCouncilPayload);
  assert.deepEqual(
    validateGamePrompt(malformedCouncilPrompt),
    { ok: false, reason: 'wolf_council_options', path: 'options.wolfCouncilMessages' },
    '新 target 狼刀提供狼议字段时仍须完整校验',
  );

  const wolfViewerId = spectatorRealWolves[0];
  const goodViewerId = getAlivePlayerIds(spectator).find((playerId) => getRoleAssignment(spectator, playerId).roleId !== 'wolf');
  assert.notEqual(goodViewerId, undefined);
  const wolfView = selectObservation(spectator, { kind: 'player', playerId: wolfViewerId });
  const goodView = selectObservation(spectator, { kind: 'player', playerId: goodViewerId });
  assert.equal(wolfView.privateEvents.filter((event) => event.data.actionKind === 'wolf-suggestion').length, 2);
  assert.equal(goodView.privateEvents.some((event) => event.data.actionKind === 'wolf-suggestion'), false);

  const finalTarget = finalPending.candidates[0];
  assert.notEqual(finalTarget, undefined);
  spectator = submit(spectator, { targetPlayerId: finalTarget });
  const finalChannelPrompt = buildDecisionPrompt({
    observation: selectObservation(spectator, { kind: 'player', playerId: finalPending.actorId }),
    pendingDecision: finalPending,
  });
  const finalChannelPayload = JSON.parse(finalChannelPrompt[1].content);
  assert.deepEqual(validateGamePrompt(finalChannelPrompt), { ok: true }, '最终狼队频道事件提示必须通过契约');
  assert.equal(
    finalChannelPayload.privateEvents.some((text) => text.startsWith('【狼队共享记录；受众：') && text.includes('狼队决定袭击')),
    true,
    '最终狼队频道事件必须标记为狼队共享记录',
  );
  for (const wolfId of spectatorRealWolves) {
    const wolfPrompt = buildDecisionPrompt({
      observation: selectObservation(spectator, { kind: 'player', playerId: wolfId }),
      pendingDecision: finalPending,
    });
    const wolfPayload = JSON.parse(wolfPrompt[1].content);
    assert.equal(wolfPayload.privateEvents.some((text) => text.includes('狼队决定袭击')), true, `狼人 ${wolfId} 应看到最终狼刀记录`);
  }
  const nonWolfAfterAttack = getAlivePlayerIds(spectator).find((playerId) => !spectatorRealWolves.includes(playerId));
  if (nonWolfAfterAttack !== undefined) {
    const nonWolfPrompt = buildDecisionPrompt({
      observation: selectObservation(spectator, { kind: 'player', playerId: nonWolfAfterAttack }),
      pendingDecision: finalPending,
    });
    const nonWolfPayload = JSON.parse(nonWolfPrompt[1].content);
    assert.equal(nonWolfPayload.privateEvents.some((text) => text.includes('狼队决定袭击')), false, '非狼人不得看到最终狼刀记录');
  }
  const attackEvent = spectator.privateEvents.findLast((event) => event.data.actionKind === 'wolf-decision');
  assert.notEqual(attackEvent, undefined);
  assert.equal(attackEvent.actorPlayerId, null, '最终狼刀事件不得暴露决策狼');
  assert.match(attackEvent.text, /^狼队决定袭击 /);
  assert.equal(attackEvent.text.includes('建议袭击'), false);

  console.log('=== 灵魂交换后的实时阵营 ===');
  let exchangedGame = null;
  let exchangedOwnerId = null;
  let exchangedTargetId = null;
  for (let seed = 1; seed < 800; seed += 1) {
    const candidate = createGame({ mode: 'spectator', humanCharacterId: null, seed, playerCount: 6, selectedCharacterIds: [] });
    const exchangeSkill = candidate.skillInstances.find((skill) => skill.definitionId === 'soul-exchange');
    if (exchangeSkill === undefined || getRoleAssignment(candidate, exchangeSkill.ownerPlayerId).roleId === 'wolf') {
      continue;
    }
    const wolfTargetId = livingWolves(candidate)[0];
    if (wolfTargetId === undefined) {
      continue;
    }
    candidate.phase = 'night-skills';
    candidate.pendingDecision = {
      id: `${candidate.gameId}-soul-exchange-wolf-council-test`,
      kind: 'skill',
      schemaKey: 'optional-target',
      actorId: exchangeSkill.ownerPlayerId,
      title: '灵魂交换',
      description: '交换双方当前职业。',
      candidates: [wolfTargetId],
      allowAbstain: true,
      skillInstanceId: exchangeSkill.id,
      options: {},
    };
    exchangedOwnerId = exchangeSkill.ownerPlayerId;
    exchangedTargetId = wolfTargetId;
    exchangedGame = submit(candidate, { use: true, targetPlayerId: wolfTargetId });
    break;
  }
  assert.notEqual(exchangedGame, null, '应找到可与狼人进行灵魂交换的确定性种子');
  assert.notEqual(exchangedOwnerId, null);
  assert.notEqual(exchangedTargetId, null);
  assert.equal(getRoleAssignment(exchangedGame, exchangedOwnerId).roleId, 'wolf');
  assert.notEqual(getRoleAssignment(exchangedGame, exchangedTargetId).roleId, 'wolf');
  exchangedGame = prepareCouncil(exchangedGame);
  const exchangedCouncil = runAllCouncilSpeeches(exchangedGame, '交换后狼议');
  assert.ok(exchangedCouncil.actors.includes(exchangedOwnerId), '交换后的新狼人必须进入频道');
  assert.equal(exchangedCouncil.actors.includes(exchangedTargetId), false, '交换后的旧狼人不得继续参与频道');

  console.log('=== 人类狼人固定拍板 ===');
  let humanGame = null;
  for (let seed = 1; seed < 500; seed += 1) {
    const candidate = createGame({ mode: 'player', humanCharacterId: 'soul-0', seed, playerCount: 6, selectedCharacterIds: [] });
    if (candidate.humanPlayerId !== null && getRoleAssignment(candidate, candidate.humanPlayerId).roleId === 'wolf') {
      humanGame = candidate;
      break;
    }
  }
  assert.notEqual(humanGame, null, '应找到人类玩家为狼人的确定性种子');
  humanGame = prepareCouncil(humanGame);
  const humanCouncil = runAllCouncilSpeeches(humanGame, '玩家局狼议');
  humanGame = advance(humanCouncil.state);
  humanGame = advance(humanGame);
  assert.notEqual(humanGame.pendingDecision, null);
  assert.equal(humanGame.pendingDecision.actorId, humanGame.humanPlayerId);
  assert.ok(humanCouncil.actors.includes(humanGame.humanPlayerId), '人类决策狼也必须先完成狼议发言');

  console.log('=== 单狼与造物边界 ===');
  let singleWolf = prepareCouncil(createGame({ mode: 'spectator', humanCharacterId: null, seed: 91, playerCount: 6, selectedCharacterIds: [] }));
  const singleWolfIds = livingWolves(singleWolf);
  assert.equal(singleWolfIds.length, 2);
  const removedWolf = singleWolf.players.find((player) => player.id === singleWolfIds[1]);
  assert.notEqual(removedWolf, undefined);
  removedWolf.alive = false;
  singleWolf = advance(singleWolf);
  assert.equal(singleWolf.phase, 'wolf-decision');
  assert.equal(singleWolf.pendingDecision, null);
  singleWolf = advance(singleWolf);
  assert.notEqual(singleWolf.pendingDecision, null);
  assert.deepEqual(singleWolf.pendingDecision.options.wolfCouncilMessages, []);
  assert.deepEqual(validateGamePrompt(promptForActor(singleWolf)), { ok: true }, '单狼显式空记录必须通过后端契约');

  let creatureGame = prepareCouncil(createGame({ mode: 'spectator', humanCharacterId: null, seed: 113, playerCount: 6, selectedCharacterIds: [] }));
  const creatureOwnerId = livingWolves(creatureGame)[0];
  const creatureOwner = creatureGame.players.find((player) => player.id === creatureOwnerId);
  assert.notEqual(creatureOwner, undefined);
  creatureGame.creatures.push({
    id: 99,
    ownerPlayerId: creatureOwnerId,
    characterId: creatureOwner.characterId,
    roleAssignmentId: creatureOwner.roleAssignmentId,
    alive: true,
    resources: {},
  });
  const creatureCouncil = runAllCouncilSpeeches(creatureGame, '造物局狼议');
  assert.equal(creatureCouncil.actors.includes(99), false);
  assert.equal(creatureCouncil.actors.length, 2);

  let soleCreature = structuredClone(creatureGame);
  for (const player of soleCreature.players) {
    if (getRoleAssignment(soleCreature, player.id).roleId === 'wolf') {
      player.alive = false;
    }
  }
  soleCreature = prepareCouncil(soleCreature);
  soleCreature = advance(soleCreature);
  assert.equal(soleCreature.phase, 'wolf-decision');
  soleCreature = advance(soleCreature);
  assert.notEqual(soleCreature.pendingDecision, null);
  assert.equal(soleCreature.pendingDecision.actorId, 99);
  assert.deepEqual(soleCreature.pendingDecision.options.wolfCouncilMessages, []);

  console.log('PASS 狼人内部频道验证全部通过');
} finally {
  await server.close();
}
