import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ROLE_IDS, rolePoolError, rolePoolForPlayerCount, formatBoardDescription, isValidBoardDescription } from '../shared/gamePromptContract.js';
import { validateGamePrompt } from '../server/gameProtocol.mjs';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
try {
  const { createGame, continueGameWithNewRoles, createRewindSnapshot } = await server.ssrLoadModule('/src/domain/engine/createGame.ts');
  const { reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts');
  const { selectObservation, getRoleAssignment } = await server.ssrLoadModule('/src/domain/engine/selectors.ts');
  const { initialRoleResources } = await server.ssrLoadModule('/src/domain/catalog/roles.ts');
  const { fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts');
  const { parseDecision } = await server.ssrLoadModule('/src/ai/schemas.ts');
  const { buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts');
  const { gameStateSchema } = await server.ssrLoadModule('/src/storage/gameStateSchema.ts');
  const storage = await server.ssrLoadModule('/src/storage/browserStorage.ts');
  const { multiplayerClientMessageSchema } = await server.ssrLoadModule('/src/multiplayer/protocol.ts');
  const { createCreature } = await server.ssrLoadModule('/src/domain/skills/creature.ts');
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const customPool = ['wolf', 'assassin', 'mortician', 'seer', 'witch', 'villager'];
  const setup = { mode: 'spectator', humanCharacterId: null, playerCount: 6, selectedCharacterIds: [], seed: 12, rolePool: customPool };
  const submit = (state, decision) => reduceGame(state, { type: 'submit-decision', pendingDecisionId: state.pendingDecision.id, actorId: state.pendingDecision.actorId, decision });
  const promptCheck = (state) => {
    const observation = selectObservation(state, { kind: 'player', playerId: state.pendingDecision.actorId });
    assert.deepEqual(validateGamePrompt(buildDecisionPrompt({ observation, pendingDecision: state.pendingDecision, sessionId: 'new-roles-test' })), { ok: true });
  };
  const fixture = (seatCharacterIds = ['soul-0', 'soul-2', 'soul-3', 'soul-1', 'soul-4', 'soul-5']) => {
    const state = createGame({ ...setup, seatCharacterIds });
    for (const [index, roleId] of customPool.entries()) {
      const assignment = getRoleAssignment(state, index);
      assignment.roleId = roleId;
      assignment.resources = initialRoleResources(roleId);
    }
    for (const skill of state.skillInstances) { skill.status = 'exhausted'; skill.remainingUses = 0; }
    state.causalLocks = state.skillInstances.map((skill) => skill.id);
    state.day = 1;
    return state;
  };

  assert.equal(rolePoolError(customPool, 6), null);
  assert.equal(isValidBoardDescription(formatBoardDescription(customPool)), true);
  for (const pool of [[], ['bogus', ...customPool.slice(1)], ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'villager'], ['wolf', 'wolf', 'seer', 'seer', 'witch', 'villager']]) {
    assert.notEqual(rolePoolError(pool, 6), null);
    assert.throws(() => createGame({ ...setup, rolePool: pool }));
    assert.equal(multiplayerClientMessageSchema.safeParse({ type: 'create-room', playerName: 'test', characterId: 'soul-0', playerCount: 6, rolePool: pool }).success, false);
  }
  assert.equal(isValidBoardDescription('6人局：狼人×2、狼人×2、村民×2'), false);
  assert.equal(isValidBoardDescription('6人局：狼人×2、未知×4'), false);
  storage.saveSetup({ ...setup, randomSeed: false, assignmentMode: 'draft' });
  assert.deepEqual(storage.loadSetup().value.rolePool, customPool);

  for (const corrupt of [
    (state) => { state.roleDraft.order[1] = state.roleDraft.order[0]; },
    (state) => { state.roleDraft.remainingRoles.pop(); },
    (state) => { state.roleDraft.selectedPlayerIds.push(state.roleDraft.order[1]); },
    (state) => { state.assignmentMode = 'classic'; },
  ]) {
    const state = createGame({ ...setup, assignmentMode: 'draft' });
    corrupt(state);
    assert.equal(gameStateSchema.safeParse(state).success, false);
  }

  for (let seed = 1; seed <= 12; seed += 1) {
    let state = createGame({ ...setup, seed, assignmentMode: 'draft' });
    assert.deepEqual(state, createGame({ ...setup, seed, assignmentMode: 'draft' }));
    for (const player of state.players) assert.equal(selectObservation(state, { kind: 'player', playerId: player.id }).players.every((entry) => entry.roleId === null), true);
    let step = 0;
    while (state.phase === 'role-draft' && step++ < 30) {
      const before = structuredClone(state);
      if (!state.pendingDecision) state = reduceGame(state, { type: 'advance' });
      else {
        promptCheck(state);
        assert.throws(() => submit(state, { roleId: 'not-a-role' }));
        const choice = seed % 2 ? null : state.pendingDecision.options.roleIds[0];
        state = submit(state, parseDecision(state.pendingDecision, { roleId: choice }));
        for (const viewer of state.players) {
          const observation = selectObservation(state, { kind: 'player', playerId: viewer.id });
          assert.equal(observation.players.filter((entry) => entry.id !== viewer.id).every((entry) => entry.roleId === null), true);
          assert.equal(observation.privateEvents.every((event) => event.viewerPlayerIds.includes(viewer.id)), true);
        }
      }
      assert.equal(gameStateSchema.safeParse(state).success, true);
      storage.saveGame(state, '2.4.0');
      assert.deepEqual(storage.loadGame().value.state, state);
      assert.notEqual(state, before);
    }
    assert.equal(state.phase, 'first-night');
    assert.deepEqual(state.roleAssignments.map((entry) => entry.roleId).sort(), [...customPool].sort());
    for (const player of state.players) assert.equal(state.knowledgeByPlayer[player.id].find((fact) => fact.kind === 'role' && fact.subjectPlayerId === player.id).value, getRoleAssignment(state, player.id).roleId);
    state.result = { winner: 'good', reason: 'wolves-eliminated', finishedDay: 1 };
    state.phase = 'ended';
    const next = continueGameWithNewRoles(state);
    assert.equal(next.phase, 'role-draft');
    assert.deepEqual(next.rolePool, customPool);
  }

  let mortician = fixture();
  mortician.players[5].alive = false;
  mortician.phase = 'night-protection';
  mortician = reduceGame(mortician, { type: 'advance' });
  assert.equal(mortician.pendingDecision.kind, 'mortician-action');
  assert.deepEqual(mortician.pendingDecision.candidates, [5]);
  promptCheck(mortician);
  assert.throws(() => submit(mortician, { targetPlayerId: 0 }));
  mortician = submit(mortician, { targetPlayerId: 5 });
  assert.equal(mortician.knowledgeByPlayer[2].some((fact) => fact.subjectPlayerId === 5 && fact.value === 'villager'), true);
  assert.equal(selectObservation(mortician, { kind: 'player', playerId: 0 }).privateEvents.some((event) => event.data.actionKind === 'mortician-action'), false);
  assert.notEqual(reduceGame(mortician, { type: 'advance' }).pendingDecision?.kind, 'mortician-action');

  let corpse = fixture();
  createCreature(corpse, corpse.skillInstances.find((skill) => skill.definitionId === 'liquid-control'));
  corpse.creatures[0].alive = false;
  corpse.phase = 'night-protection';
  corpse = reduceGame(corpse, { type: 'advance' });
  assert.deepEqual(corpse.pendingDecision.candidates, [99]);
  promptCheck(corpse);
  corpse = submit(corpse, { targetPlayerId: 99 });
  assert.equal(corpse.knowledgeByPlayer[2].some((fact) => fact.subjectPlayerId === 99 && fact.value === 'mortician'), true);

  let floating = fixture();
  const floatSkill = floating.skillInstances.find((skill) => skill.definitionId === 'levitation');
  floatSkill.data.floatingStartDay = floating.day;
  floating.phase = 'vote-skills';
  floating = reduceGame(floating, { type: 'advance' });
  assert.equal(floating.pendingDecision.candidates.includes(floatSkill.ownerPlayerId), false);
  assert.throws(() => submit(floating, { targetPlayerId: floatSkill.ownerPlayerId, guessedRoleId: getRoleAssignment(floating, floatSkill.ownerPlayerId).roleId }));

  let recovered = fixture(['soul-6', 'soul-2', 'soul-3', 'soul-1', 'soul-4', 'soul-5']);
  recovered.causalLocks = [];
  const recovery = recovered.skillInstances.find((skill) => skill.definitionId === 'witch-factor-recovery');
  const donorSkill = recovered.skillInstances.find((skill) => skill.definitionId === 'levitation');
  recovery.status = donorSkill.status = 'ready';
  recovery.remainingUses = donorSkill.remainingUses = 1;
  recovered.players[donorSkill.ownerPlayerId].alive = false;
  recovered.phase = 'night-skills';
  recovered = reduceGame(recovered, { type: 'advance' });
  assert.equal(recovered.pendingDecision.skillInstanceId, recovery.id);
  recovered = submit(recovered, { use: true, targetPlayerId: donorSkill.ownerPlayerId });
  assert.equal(recovered.players[recovery.ownerPlayerId].skillInstanceId, donorSkill.id);
  storage.saveGame(recovered, '2.4.0');
  assert.deepEqual(storage.loadGame().value.state, recovered);
  const duplicateActive = structuredClone(recovered);
  duplicateActive.skillInstances.find((skill) => skill.id === recovery.id).status = 'ready';
  assert.equal(gameStateSchema.safeParse(duplicateActive).success, false);

  for (const guess of ['seer', 'villager', null]) {
    let state = fixture();
    state.phase = 'vote-skills';
    state = reduceGame(state, { type: 'advance' });
    assert.equal(state.pendingDecision.kind, 'assassin-action');
    promptCheck(state);
    const untouched = structuredClone(state);
    assert.throws(() => submit(state, { targetPlayerId: 1, guessedRoleId: 'assassin' }));
    assert.throws(() => submit(state, { targetPlayerId: 3, guessedRoleId: null }));
    assert.deepEqual(state, untouched);
    state = submit(state, { targetPlayerId: guess === null ? null : 3, guessedRoleId: guess });
    assert.equal(state.players[3].alive, guess !== 'seer');
    assert.equal(state.players[1].alive, guess !== 'villager');
    assert.equal(getRoleAssignment(state, 1).resources.assassination, guess === null ? 1 : 0);
    assert.notEqual(reduceGame(state, { type: 'advance' }).pendingDecision?.kind, 'assassin-action');
    assert.doesNotThrow(() => gameStateSchema.parse(state));
  }
  let rewind = fixture();
  const rewindSkill = rewind.skillInstances.find((skill) => skill.definitionId === 'death-rewind');
  if (!rewindSkill) throw new Error('fixture must contain rewind');
  assert.equal(rewindSkill.ownerPlayerId, 3);
  rewind.causalLocks = [];
  rewind.phase = 'speeches';
  rewind.morningCheckpoint = createRewindSnapshot(rewind);
  rewind.phase = 'vote-skills';
  rewind = reduceGame(rewind, { type: 'advance' });
  rewind = submit(rewind, { targetPlayerId: 3, guessedRoleId: 'seer' });
  assert.equal(rewind.phase, 'speeches');
  assert.equal(rewind.players[3].alive, true);
  assert.equal(rewind.archivedTimelines.length, 1);
  assert.equal(getRoleAssignment(rewind, 1).resources.assassination, 1);

  const kinds = new Set();
  for (const count of [6, 9, 14]) for (const assignmentMode of ['classic', 'draft']) for (const seed of [13, 17, 31]) {
    const pool = [...rolePoolForPlayerCount(count)];
    pool[pool.indexOf('wolf')] = 'assassin';
    pool[pool.indexOf('seer')] = 'mortician';
    let state = createGame({ ...setup, seed, playerCount: count, rolePool: pool, assignmentMode });
    let steps = 0;
    while (!state.result && steps++ < 1600) {
      if (!state.pendingDecision) state = reduceGame(state, { type: 'advance' });
      else {
        if (!kinds.has(state.pendingDecision.kind)) { promptCheck(state); kinds.add(state.pendingDecision.kind); }
        const fallback = fallbackDecision(state, state.pendingDecision);
        const decision = parseDecision(state.pendingDecision, fallback.decision);
        state = reduceGame(state, { type: 'set-rng-state', rngState: fallback.rngState });
        state = submit(state, decision);
      }
    }
    assert.ok(state.result, `${count}/${assignmentMode}/${seed} stuck at ${state.phase}`);
    assert.doesNotThrow(() => gameStateSchema.parse(state), `${count}/${assignmentMode}/${seed}`);
  }
  assert.equal(ROLE_IDS.includes('mortician') && ROLE_IDS.includes('assassin'), true);
  console.log('PASS custom rosters, private deterministic draft, storage, roles, rewind, protocol, 18 complete games');
} finally {
  delete globalThis.localStorage;
  await server.close();
}
