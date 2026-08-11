import { describe, expect, it } from 'vitest';
import { characterById } from './catalog/characters';
import { roleAlignment } from './catalog/roles';
import { witchSkillDefinitions } from './catalog/witchSkills';
import { createGame } from './engine/createGame';
import { addPrivateEvent } from './engine/events';
import { resolveDeathBatch, resolveNight } from './engine/night';
import { reduceGame } from './engine/reducer';
import { getPlayer, getRoleAssignment, getSkillInstance, selectObservation } from './engine/selectors';
import { checkWin } from './engine/win';
import { resolveVotes } from './engine/vote';
import type {
  CharacterId,
  GameState,
  PendingDecision,
  PlayerId,
  SubmittedDecision,
  WitchSkillId,
} from './model';
import {
  applyNightSkillDecision,
  applySpeechSkillDecision,
  applyVoteSkillDecision,
  getTieBreaker,
  getVoteOrder,
  isRestrainedToday,
  publishSpeech,
  validateGuidedSpeech,
} from './skills/registry';

function gameFor(characterId: CharacterId, seed = 1): GameState {
  return createGame({ mode: 'player', humanCharacterId: characterId, seed });
}

function pendingFor(
  state: GameState,
  skillId: WitchSkillId,
  candidates: PlayerId[],
  schemaKey: PendingDecision['schemaKey'] = 'optional-target',
): PendingDecision {
  const skill = state.skillInstances.find((entry) => entry.definitionId === skillId);
  if (!skill) throw new Error(`测试阵容缺少技能 ${skillId}`);
  return {
    id: `test-${skillId}`,
    kind: skillId === 'healing' ? 'healing' : 'skill',
    schemaKey,
    actorId: skill.ownerPlayerId,
    title: witchSkillDefinitions[skillId].name,
    description: 'test',
    candidates,
    allowAbstain: schemaKey !== 'target',
    skillInstanceId: skill.id,
    options: {},
  };
}

function decisionFor(state: GameState, pending: PendingDecision): SubmittedDecision {
  const first = pending.candidates[0] ?? null;
  if (pending.schemaKey === 'speech') {
    const guide = state.skillInstances.find((skill) => skill.definitionId === 'gaze-guidance' && getPlayer(state, skill.ownerPlayerId).alive);
    const prefix = guide ? `${characterById[getPlayer(state, guide.ownerPlayerId).characterId].name}值得继续关注。` : '';
    return { speech: `${prefix}我会依据公开记录继续判断。` };
  }
  if (pending.schemaKey === 'witch') return { save: false, poisonTargetPlayerId: null };
  if (pending.schemaKey === 'ignition') return { use: true };
  if (pending.schemaKey === 'liquid-control') return { use: false, mode: null, targetPlayerId: null, factId: null };
  if (pending.schemaKey === 'levitation') return { use: false, mode: null, targetPlayerId: null };
  if (pending.schemaKey === 'voice-mimic') return { use: false, targetPlayerId: null, forgedSpeech: null };
  if (pending.schemaKey === 'optional-target') return { use: false, targetPlayerId: null };
  return { targetPlayerId: first };
}

describe('开局、基础规则与可恢复状态', () => {
  it('固定种子生成无重复角色、标准职业与独立技能实例', () => {
    const state = gameFor('soul-0', 1);
    expect(state.players.map((player) => player.characterId)).toEqual(['soul-0', 'soul-11', 'soul-12', 'soul-2', 'soul-4', 'soul-8']);
    expect(new Set(state.players.map((player) => player.characterId))).toHaveLength(6);
    const roles = state.roleAssignments.map((assignment) => assignment.roleId).sort();
    expect(roles).toEqual(['seer', 'villager', 'villager', 'witch', 'wolf', 'wolf']);
    expect(new Set(state.skillInstances.map((skill) => skill.id))).toHaveLength(6);
    expect(state.humanPlayerId).toBe(0);
    expect(state.knowledgeByPlayer[0][0]?.subjectPlayerId).toBe(0);
  });

  it('参与者看不到他人身份和伪造来源，观战者可见完整状态', () => {
    const state = gameFor('soul-7');
    const actor = 1 as PlayerId;
    state.publicEvents.push({
      id: 'forged', kind: 'speech', day: 1, phase: 'speeches', text: '伪造片段', actorPlayerId: actor,
      targetPlayerIds: [actor], displayAuthorPlayerId: actor, actualAuthorPlayerId: 0, data: { hasForgedFragment: true },
    });
    const playerView = selectObservation(state, { kind: 'player', playerId: 0 });
    const spectatorView = selectObservation(state, { kind: 'spectator' });
    expect(playerView.players[1]?.roleId).toBeNull();
    expect(playerView.publicEvents.at(-1)?.actualAuthorPlayerId).toBeNull();
    expect(spectatorView.players.every((player) => player.roleId !== null)).toBe(true);
    expect(spectatorView.publicEvents.at(-1)?.actualAuthorPlayerId).toBe(0);
  });

  it('使用标准人数胜负与弃权、平票规则', () => {
    const state = gameFor('soul-0');
    const wolfIds = state.players.filter((player) => getRoleAssignment(state, player.id).roleId === 'wolf').map((player) => player.id);
    for (const player of state.players) player.alive = wolfIds.includes(player.id) || player.id === state.players.find((entry) => !wolfIds.includes(entry.id))?.id;
    expect(checkWin(state)?.winner).toBe('wolf');
    expect(resolveVotes([
      { voterPlayerId: 0, targetPlayerId: null, round: 1 },
      { voterPlayerId: 1, targetPlayerId: null, round: 1 },
      { voterPlayerId: 2, targetPlayerId: 3, round: 1 },
    ], 1).outcome).toBe('none');
    expect(resolveVotes([
      { voterPlayerId: 0, targetPlayerId: 2, round: 2 },
      { voterPlayerId: 1, targetPlayerId: 3, round: 2 },
    ], 2).outcome).toBe('runoff');
  });

  it('命令驱动引擎可以从首夜完整运行到胜负', () => {
    let state = createGame({ mode: 'spectator', humanCharacterId: null, seed: 7 });
    for (let step = 0; step < 2_000 && state.phase !== 'ended'; step += 1) {
      state = state.pendingDecision
        ? reduceGame(state, { type: 'submit-decision', pendingDecisionId: state.pendingDecision.id, actorId: state.pendingDecision.actorId, decision: decisionFor(state, state.pendingDecision) })
        : reduceGame(state, { type: 'advance' });
    }
    expect(state.phase).toBe('ended');
    expect(state.result).not.toBeNull();
    expect(state.publicEvents.some((event) => event.kind === 'speech')).toBe(true);
    expect(state.publicEvents.some((event) => event.kind === 'vote')).toBe(true);
  });
});

describe('十四项可迁移魔女技', () => {
  it('目录完整且治愈不能阻止魔女杀手', () => {
    expect(Object.keys(witchSkillDefinitions)).toHaveLength(14);
    const state = gameFor('soul-0', 1);
    const killer = state.skillInstances.find((skill) => skill.definitionId === 'witch-killer');
    const healer = state.skillInstances.find((skill) => skill.definitionId === 'healing');
    if (!killer || !healer) throw new Error('seed 1 应包含魔女杀手与治愈');
    const target = state.players.find((player) => player.id !== killer.ownerPlayerId && player.id !== healer.ownerPlayerId)?.id;
    if (target === undefined) throw new Error('缺少测试目标');
    applyNightSkillDecision(state, pendingFor(state, 'witch-killer', [target]), { use: true, targetPlayerId: target });
    addPrivateEvent(state, [killer.ownerPlayerId], 'witch-action', '测试毒药', { data: { intentSource: 'poison', preventable: true, targetPlayerId: target } });
    applyNightSkillDecision(state, pendingFor(state, 'healing', state.players.map((player) => player.id), 'target'), { targetPlayerId: target });
    const resolved = resolveNight(state);
    expect(getPlayer(resolved, target).alive).toBe(false);
    expect(resolved.publicEvents.find((event) => event.kind === 'death')?.data.sources).toEqual(['precise-kill']);
  });

  it('死亡回溯恢复快照并使用因果锁防止重复触发', () => {
    const state = gameFor('soul-1');
    const skill = getSkillInstance(state, 0);
    expect(skill?.definitionId).toBe('death-rewind');
    expect(state.morningCheckpoint?.players[0]?.alive).toBe(true);
    expect(state.causalLocks).toEqual([]);
    const resolved = resolveDeathBatch(state, [{ playerId: 0, sources: ['wolf'] }]);
    expect(getPlayer(resolved, 0).alive).toBe(true);
    expect(resolved.causalLocks).toContain(skill?.id);
    expect(resolved.archivedTimelines).toHaveLength(1);
    const second = resolveDeathBatch(resolved, [{ playerId: 0, sources: ['wolf'] }]);
    expect(getPlayer(second, 0).alive).toBe(false);
  });

  it('操控液体只复制真实职业事实，看到内心只复制阵营', () => {
    const liquidState = gameFor('soul-3');
    applyNightSkillDecision(liquidState, pendingFor(liquidState, 'liquid-control', [1], 'liquid-control'), { use: true, mode: 'extract', targetPlayerId: 1, factId: null });
    expect(liquidState.knowledgeByPlayer[0].some((fact) => fact.subjectPlayerId === 1 && fact.kind === 'role')).toBe(true);

    const mindState = gameFor('soul-12');
    applyNightSkillDecision(mindState, pendingFor(mindState, 'mind-reading', [1]), { use: true, targetPlayerId: 1 });
    const learned = mindState.knowledgeByPlayer[0].find((fact) => fact.subjectPlayerId === 1);
    expect(learned?.kind).toBe('alignment');
    expect(learned?.value).toBe(roleAlignment[getRoleAssignment(mindState, 1).roleId]);
  });

  it('灵魂交换移动职业资源但保留个人知识', () => {
    const state = gameFor('soul-10');
    const target = state.players.find((player) => getRoleAssignment(state, player.id).roleId === 'witch' && player.id !== 0)?.id
      ?? state.players.find((player) => player.id !== 0)?.id;
    if (target === undefined) throw new Error('缺少交换目标');
    const ownerRoleBefore = getRoleAssignment(state, 0).roleId;
    const targetRoleBefore = getRoleAssignment(state, target).roleId;
    const ownerKnowledge = structuredClone(state.knowledgeByPlayer[0]);
    applyNightSkillDecision(state, pendingFor(state, 'soul-exchange', [target]), { use: true, targetPlayerId: target });
    expect(getRoleAssignment(state, 0).roleId).toBe(targetRoleBefore);
    expect(getRoleAssignment(state, target).roleId).toBe(ownerRoleBefore);
    expect(state.knowledgeByPlayer[0]).toEqual(ownerKnowledge);
    if (targetRoleBefore === 'witch') expect(getRoleAssignment(state, 0).resources.antidote).toBe(1);
  });

  it('魔女因子回收移动死亡者的实际未耗尽实例', () => {
    const state = gameFor('soul-6');
    const recoveredId = getPlayer(state, 1).skillInstanceId;
    getPlayer(state, 1).alive = false;
    applyNightSkillDecision(state, pendingFor(state, 'witch-factor-recovery', [1]), { use: true, targetPlayerId: 1 });
    expect(getPlayer(state, 0).skillInstanceId).toBe(recoveredId);
    expect(getPlayer(state, 1).skillInstanceId).toBeNull();
    expect(state.skillInstances.find((skill) => skill.id === recoveredId)?.data.recoveredNight).toBe(0);
  });

  it('洗脑、限制发言与点火写入当日真实状态', () => {
    const brainwash = gameFor('soul-2');
    applySpeechSkillDecision(brainwash, pendingFor(brainwash, 'brainwash', [1]), { use: true, targetPlayerId: 1 });
    expect(getSkillInstance(brainwash, 0)?.data.targetPlayerId).toBe(1);

    const restrain = gameFor('soul-4');
    applySpeechSkillDecision(restrain, pendingFor(restrain, 'speech-restrain', [1]), { use: true, targetPlayerId: 1 });
    expect(isRestrainedToday(restrain, 1)).toBe(true);

    const ignition = gameFor('soul-9');
    applySpeechSkillDecision(ignition, pendingFor(ignition, 'ignition', [1, 2], 'ignition'), { use: true });
    expect(ignition.publicEvents.at(-1)?.kind).toBe('trial-by-fire');
    expect(['wolf', 'good']).toContain(ignition.publicEvents.at(-1)?.data.alignment);
  });

  it('视线诱导约束发言，持有者死亡后立即放行', () => {
    const state = gameFor('soul-11');
    expect(() => validateGuidedSpeech(state, 1, '我暂时没有结论。')).toThrow('必须提及');
    expect(() => validateGuidedSpeech(state, 1, '莲见蕾雅值得继续关注。')).not.toThrow();
    getPlayer(state, 0).alive = false;
    expect(() => validateGuidedSpeech(state, 1, '现在可以自由发言。')).not.toThrow();
  });

  it('声音模仿隐藏真实来源，千里眼按真实作者结算', () => {
    const mimic = gameFor('soul-7');
    applySpeechSkillDecision(mimic, pendingFor(mimic, 'voice-mimic', [1], 'voice-mimic'), { use: true, targetPlayerId: 1, forgedSpeech: '莲见蕾雅值得继续关注，这是一段伪造判断。' });
    publishSpeech(mimic, 1, { speech: '这是本人的判断。' });
    expect(selectObservation(mimic, { kind: 'player', playerId: 2 }).publicEvents.at(-1)?.actualAuthorPlayerId).toBeNull();
    expect(selectObservation(mimic, { kind: 'spectator' }).publicEvents.at(-1)?.actualAuthorPlayerId).toBe(0);

    const clairvoyance = gameFor('soul-13');
    publishSpeech(clairvoyance, 1, { speech: '莲见蕾雅在场，泽渡可可值得继续关注。' });
    expect(clairvoyance.knowledgeByPlayer[0].some((fact) => fact.subjectPlayerId === 1 && fact.kind === 'role')).toBe(true);
  });

  it('漂浮重排公开投票并在二次平票后提供裁决', () => {
    const state = gameFor('soul-5');
    applyVoteSkillDecision(state, pendingFor(state, 'levitation', [1, 2], 'levitation'), { use: true, mode: 'move-last', targetPlayerId: 1 });
    expect(getVoteOrder(state).at(-1)).toBe(1);
    expect(getTieBreaker(state, [2, 3])).toBeNull();

    const tieState = gameFor('soul-5');
    applyVoteSkillDecision(tieState, pendingFor(tieState, 'levitation', [1, 2], 'levitation'), { use: true, mode: 'tie-break', targetPlayerId: null });
    expect(getTieBreaker(tieState, [2, 3])?.candidates).toEqual([2, 3]);
  });
});
