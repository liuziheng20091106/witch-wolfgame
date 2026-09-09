import { CREATURE_ID, WOLF_COUNCIL_MESSAGE_MAX_LENGTH } from '../../../shared/gamePromptContract.js';
import { roleAlignment, roleNames } from '../catalog/roles';
import type { GameState, PendingDecision, PlayerId, SpeechDecision, SubmittedDecision, TargetDecision, VoteRecord, WolfCouncilDecision, WitchDecision } from '../model';
import { addKnowledge, addPrivateEvent, addPublicEvent } from './events';
import { getAlivePlayerIds, getName, getPlayer, getRoleAssignment } from './selectors';
import { makeRoleDecision } from './decisions';
import { isFloatingActive } from '../skills/levitation';
import { publishSpeech } from '../skills/speechSkills';
import { applyLastWords } from '../skills/lastWords';
import { applyPostGameSpeech } from '../skills/postGame';
import { withFactionStrategyGuidance } from '../skills/decisionGuidance';
import { addExileIntent } from './voting';
import { resolveDeathBatch } from './night';
import { applyDraftDecision } from './roleDraft';
import { applyAssassinDecision, applyMorticianDecision } from './specialRoles';
import type { AssassinDecision, DraftDecision } from '../model';

function hasPrivateAction(state: GameState, kind: string, actorId: PlayerId): boolean {
  return state.privateEvents.some(
    (event) => event.day === state.day && event.actorPlayerId === actorId && event.data.actionKind === kind,
  );
}

function hasPrivateActionKind(state: GameState, kind: string): boolean {
  return state.privateEvents.some(
    (event) => event.day === state.day && event.data.actionKind === kind,
  );
}

function livingWolves(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => roleAlignment[getRoleAssignment(state, playerId).roleId] === 'wolf');
}

function speakingWolves(state: GameState): PlayerId[] {
  return livingWolves(state).filter((playerId) => playerId !== CREATURE_ID);
}

function wolfDecisionActor(state: GameState, wolves: PlayerId[]): PlayerId | undefined {
  const humanPlayerId = state.humanPlayerId;
  if (humanPlayerId !== null && humanPlayerId !== CREATURE_ID && wolves.includes(humanPlayerId)) {
    return humanPlayerId;
  }
  const realWolf = wolves.find((playerId) => playerId !== CREATURE_ID);
  if (realWolf !== undefined) {
    return realWolf;
  }
  return wolves[0];
}

function wolfTargetLabel(state: GameState, playerId: PlayerId): string {
  if (playerId === CREATURE_ID) {
    return `造物（${getName(state, playerId)}）`;
  }
  return `${playerId + 1}号（${getName(state, playerId)}）`;
}

function wolfCouncilMessages(state: GameState) {
  const messages: Array<{
    speakerPlayerId: PlayerId;
    speakerName: string;
    message: string;
    recommendedTargetPlayerId: PlayerId;
  }> = [];
  for (const event of state.privateEvents) {
    if (event.day !== state.day || event.data.actionKind !== 'wolf-suggestion') {
      continue;
    }
    const speakerPlayerId = event.actorPlayerId;
    if (speakerPlayerId === null || speakerPlayerId === CREATURE_ID) {
      continue;
    }
    let recommendedTargetPlayerId: PlayerId | null = null;
    if (typeof event.data.recommendedTargetPlayerId === 'number') {
      recommendedTargetPlayerId = event.data.recommendedTargetPlayerId as PlayerId;
    } else if (typeof event.data.targetPlayerId === 'number') {
      recommendedTargetPlayerId = event.data.targetPlayerId as PlayerId;
    }
    if (recommendedTargetPlayerId === null) {
      continue;
    }
    let message = event.text;
    if (typeof event.data.message === 'string') {
      message = event.data.message;
    }
    messages.push({
      speakerPlayerId,
      speakerName: getName(state, speakerPlayerId),
      message,
      recommendedTargetPlayerId,
    });
  }
  return messages;
}

function wolfTargets(state: GameState): PlayerId[] {
  return getAlivePlayerIds(state).filter((playerId) => roleAlignment[getRoleAssignment(state, playerId).roleId] !== 'wolf');
}

export function advanceWolfSuggestions(state: GameState): GameState {
  const wolves = livingWolves(state);
  if (wolves.length <= 1) {
    state.phase = 'wolf-decision';
    return state;
  }
  const actorId = speakingWolves(state).find((playerId) => !hasPrivateAction(state, 'wolf-suggestion', playerId));
  if (actorId !== undefined) {
    const pending = makeRoleDecision(
      state,
      'wolf-suggestion',
      actorId,
      '狼人内部频道',
      '仅狼队可见。结合已有狼议，简要说明判断依据并推荐一名袭击目标。',
      wolfTargets(state),
      false,
      'wolf-council',
    );
    pending.options = { wolfCouncilMessages: wolfCouncilMessages(state) };
    state.pendingDecision = pending;
  } else {
    state.phase = 'wolf-decision';
  }
  return state;
}

export function advanceWolfDecision(state: GameState): GameState {
  const wolves = livingWolves(state);
  const actorId = wolfDecisionActor(state, wolves);
  if (actorId === undefined) {
    state.phase = 'night-resolution';
    return state;
  }
  if (!hasPrivateActionKind(state, 'wolf-decision')) {
    const councilMessages = wolfCouncilMessages(state);
    const pending = makeRoleDecision(
      state,
      'wolf-decision',
      actorId,
      '狼人最终袭击',
      '代表狼队结合本夜内部频道，选择唯一的最终袭击目标。',
      wolfTargets(state),
      false,
    );
    pending.options = { wolfCouncilMessages: councilMessages };
    state.pendingDecision = pending;
  } else {
    state.phase = 'witch-action';
  }
  return state;
}

export function advanceWitch(state: GameState): GameState {
  // 女巫主体 = 玩家女巫 + 继承女巫的造物（诺亚的造物若为女巫可独立用药）
  const witchSubjects = getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'witch');
  if (witchSubjects.length === 0) {
    state.phase = 'seer-action';
    return state;
  }
  const attack = state.privateEvents.findLast(
    (event) => event.day === state.day && event.data.actionKind === 'wolf-decision',
  );
  const attackedPlayerId = typeof attack?.data.targetPlayerId === 'number' ? attack.data.targetPlayerId as PlayerId : null;
  for (const witch of witchSubjects) {
    if (hasPrivateAction(state, 'witch-action', witch)) {
      continue;
    }
    const resources = getRoleAssignment(state, witch).resources;
    const canSave = resources.antidote === 1 && attackedPlayerId !== null;
    let candidates: PlayerId[] = [];
    if (resources.poison === 1) {
      candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== witch);
      if (witch !== 99) {
        // 玩家女巫不能对自己的造物用药（分身无意义）；造物保留毒主人的可能（失控设定）
        candidates = candidates.filter((playerId) => playerId !== 99 || !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === witch));
      }
    }
    const canPoison = candidates.length > 0;
    if (!canSave && !canPoison) {
      continue;
    }
    const title = witch === 99 ? '造物用药' : '女巫行动';
    let description = witch === 99 ? '你是诺亚的造物，继承女巫的药并独立行动。' : '';
    description += attackedPlayerId === null ? '今晚没有可见的狼刀。' : `${getName(state, attackedPlayerId)} 遭到狼刀。`;
    description += canSave ? `解药可用，只能救下 ${getName(state, attackedPlayerId as PlayerId)}。` : '解药不可用。';
    description += canPoison ? '毒药可用，目标必须从候选中选择。' : '毒药不可用。';
    if (canSave && canPoison) {
      description += '同时用药时，不能毒杀被救者。';
    }
    const witchDecision: PendingDecision = {
      ...makeRoleDecision(state, 'witch-action', witch, title, description, candidates, true, 'witch'),
      options: {
        attackedPlayerId,
        canSave,
        canPoison,
      },
    };
    state.pendingDecision = withFactionStrategyGuidance(state, witchDecision);
    return state;
  }
  state.phase = 'seer-action';
  return state;
}

export function advanceSeer(state: GameState): GameState {
  // 预言家主体 = 玩家预言家 + 继承预言家的造物
  // 造物查验结果由主人接收：主人死亡后造物不再查验（查验失去意义）
  const seerSubjects = getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'seer');
  for (const seer of seerSubjects) {
    if (seer === 99) {
      const ownerAlive = state.creatures.some(
        (creature) => creature.id === 99 && getPlayer(state, creature.ownerPlayerId).alive,
      );
      if (!ownerAlive) {
        continue;
      }
    }
    if (hasPrivateAction(state, 'seer-action', seer)) {
      continue;
    }
    let candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== seer);
    // 预言家与自己的造物互查无意义：玩家不能查自己的造物，造物也不能查主人（同身份分身）
    candidates = candidates.filter((playerId) => {
      if (seer === 99) {
        return playerId !== 99 && !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === playerId);
      }
      return playerId !== 99 || !state.creatures.some((creature) => creature.id === 99 && creature.ownerPlayerId === seer);
    });
    if (seer === 99) {
      state.pendingDecision = makeRoleDecision(state, 'seer-action', seer, '造物查验', '你是诺亚的造物，继承预言家的查验能力。选择一名其他存活者，私下获知其当前职业。', candidates, false);
    } else {
      state.pendingDecision = makeRoleDecision(state, 'seer-action', seer, '预言家查验', '选择一名其他存活者，私下获知其当前职业。', candidates, false);
    }
    return state;
  }
  state.phase = 'night-protection';
  return state;
}

export function getGuardDecision(state: GameState): PendingDecision | null {
  const guardSubjects = getAlivePlayerIds(state).filter((playerId) => getRoleAssignment(state, playerId).roleId === 'guard');
  for (const guardId of guardSubjects) {
    const assignment = getRoleAssignment(state, guardId);
    if (assignment.resources.lastGuardNight === state.day) {
      continue;
    }
    let candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== guardId);
    const lastNight = assignment.resources.lastGuardNight;
    const lastTarget = assignment.resources.lastGuardTargetPlayerId;
    if (lastNight !== undefined && lastTarget !== undefined && state.day - lastNight === 1) {
      candidates = candidates.filter((playerId) => playerId !== lastTarget);
    }
    if (candidates.length === 0) {
      continue;
    }
    return makeRoleDecision(state, 'guard-action', guardId, '守卫守护', '选择一名其他存活者守护：她本夜免疫狼人袭击。不能连续两夜守护同一人。', candidates, false);
  }
  return null;
}

function validateTarget(state: GameState, decision: SubmittedDecision, pending: PendingDecision): PlayerId | null {
  const targetPlayerId = (decision as TargetDecision).targetPlayerId;
  if (targetPlayerId === null) {
    if (!pending.allowAbstain) {
      throw new Error('当前行动不允许弃权');
    }
    return null;
  }
  if (!pending.candidates.includes(targetPlayerId) || !getPlayer(state, targetPlayerId).alive) {
    throw new Error('目标不在当前合法候选中');
  }
  return targetPlayerId;
}

function validateWolfCouncilDecision(
  state: GameState,
  decision: SubmittedDecision,
  pending: PendingDecision,
): WolfCouncilDecision {
  if (pending.schemaKey === 'target') {
    const targetPlayerId = validateTarget(state, decision, pending);
    if (targetPlayerId === null) {
      throw new Error('狼议必须推荐袭击目标');
    }
    return {
      message: `我建议袭击${getName(state, targetPlayerId)}。`,
      recommendedTargetPlayerId: targetPlayerId,
    };
  }
  const councilDecision = decision as WolfCouncilDecision;
  const message = councilDecision.message.trim();
  if (message.length === 0 || message.length > WOLF_COUNCIL_MESSAGE_MAX_LENGTH) {
    throw new Error(`狼议发言必须为 1～${WOLF_COUNCIL_MESSAGE_MAX_LENGTH} 字`);
  }
  const recommendedTargetPlayerId = councilDecision.recommendedTargetPlayerId;
  if (!pending.candidates.includes(recommendedTargetPlayerId) || !getPlayer(state, recommendedTargetPlayerId).alive) {
    throw new Error('狼议推荐目标不在当前合法候选中');
  }
  return { message, recommendedTargetPlayerId };
}


export function applyRoleDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): GameState {
  if (pending.kind === 'role-draft') return applyDraftDecision(state, pending, decision as DraftDecision);
  if (pending.kind === 'mortician-action') return applyMorticianDecision(state, pending, decision as TargetDecision);
  if (pending.kind === 'assassin-action') return applyAssassinDecision(state, pending, decision as AssassinDecision);
  if (pending.kind === 'speech') {
    if (pending.options.postGame === true) {
      // 赛后复盘：全员可见的赛后发言，不参与局内发言校验
      applyPostGameSpeech(state, pending, decision);
      return state;
    }
    if (pending.options.lastWords === true) {
      // 遗言：死者发布的最后发言（公开事件），不受视线诱导约束
      applyLastWords(state, pending, decision);
      return state;
    }
    publishSpeech(state, pending.actorId, decision as SpeechDecision);
    return state;
  }
  if (pending.kind === 'witch-action') {
    const witchDecision = decision as WitchDecision;
    const assignment = getRoleAssignment(state, pending.actorId);
    const attacked = typeof pending.options.attackedPlayerId === 'number' ? pending.options.attackedPlayerId as PlayerId : null;
    if (witchDecision.save) {
      if (assignment.resources.antidote !== 1 || attacked === null) {
        throw new Error('当前无法使用解药');
      }
      assignment.resources.antidote = 0;
      addPrivateEvent(state, [pending.actorId], 'witch-action', `${getName(state, pending.actorId)} 使用解药救下 ${getName(state, attacked)}。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [attacked],
        data: { actionKind: 'witch-save', savedWolfTargetPlayerId: attacked },
      });
    }
    if (witchDecision.poisonTargetPlayerId !== null) {
      const poisonTarget = witchDecision.poisonTargetPlayerId;
      if (assignment.resources.poison !== 1 || !pending.candidates.includes(poisonTarget) || poisonTarget === pending.actorId || (witchDecision.save && poisonTarget === attacked)) {
        throw new Error('毒药目标不合法');
      }
      assignment.resources.poison = 0;
      if (isFloatingActive(state, poisonTarget, state.day)) {
        // 漂浮隐匿：毒药无法锁定目标，使用失败（毒药已消耗）
        addPrivateEvent(state, [pending.actorId], 'witch-action', `${getName(state, pending.actorId)} 对 ${getName(state, poisonTarget)} 使用毒药，但她的身影若隐若现，毒药落空了。`, {
          actorPlayerId: pending.actorId,
          targetPlayerIds: [poisonTarget],
          data: { actionKind: 'witch-action', intentSource: 'poison-failed', preventable: false, targetPlayerId: poisonTarget },
        });
      } else {
        addPrivateEvent(state, [pending.actorId], 'witch-action', `${getName(state, pending.actorId)} 对 ${getName(state, poisonTarget)} 使用毒药。`, {
          actorPlayerId: pending.actorId,
          targetPlayerIds: [poisonTarget],
          data: { intentSource: 'poison', preventable: true, targetPlayerId: poisonTarget },
        });
      }
    }
    addPrivateEvent(state, [pending.actorId], 'witch-action', `${getName(state, pending.actorId)} 已完成女巫行动。`, {
      actorPlayerId: pending.actorId,
      data: { actionKind: 'witch-action' },
    });
    return state;
  }
  if (pending.kind === 'wolf-suggestion') {
    const councilDecision = validateWolfCouncilDecision(state, decision, pending);
    const targetPlayerId = councilDecision.recommendedTargetPlayerId;
    addPrivateEvent(
      state,
      livingWolves(state),
      'wolf-suggestion',
      `${getName(state, pending.actorId)}：${councilDecision.message}（建议袭击 ${wolfTargetLabel(state, targetPlayerId)}）`,
      {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [targetPlayerId],
        data: {
          actionKind: 'wolf-suggestion',
          message: councilDecision.message,
          recommendedTargetPlayerId: targetPlayerId,
        },
      },
    );
    return state;
  }
  const targetPlayerId = validateTarget(state, decision, pending);
  if (pending.kind === 'guard-action') {
    const guardId = pending.actorId;
    const assignment = getRoleAssignment(state, guardId);
    if (assignment.roleId !== 'guard') {
      throw new Error('守卫身份异常');
    }
    const guardTargetId = targetPlayerId as PlayerId;
    assignment.resources.lastGuardNight = state.day;
    assignment.resources.lastGuardTargetPlayerId = guardTargetId;
    addPrivateEvent(state, [guardId], 'protection', `${getName(state, guardId)} 守护了 ${getName(state, guardTargetId)}，她本夜免疫狼人袭击。`, {
      actorPlayerId: guardId,
      targetPlayerIds: [guardTargetId],
      data: { guardTargetPlayerId: guardTargetId },
    });
    return state;
  }
  if (pending.kind === 'hunter-shot' || pending.kind === 'wolf-king-shot') {
    const shotAssignment = getRoleAssignment(state, pending.actorId);
    if (pending.kind === 'hunter-shot') {
      shotAssignment.resources.hunterShot = 0;
    } else {
      shotAssignment.resources.wolfKingShot = 0;
    }
    if (targetPlayerId !== null) {
      const shotTargetId = targetPlayerId;
      let gunName = '猎人之枪';
      let shotSource: 'hunter-gun' | 'wolf-king-gun' = 'hunter-gun';
      if (pending.kind === 'wolf-king-shot') {
        gunName = '白狼王的獠牙';
        shotSource = 'wolf-king-gun';
      }
      addPublicEvent(state, 'death', `${getName(state, pending.actorId)} 发动${gunName}，带走了 ${getName(state, shotTargetId)}。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [shotTargetId],
        data: { actionKind: pending.kind },
      });
      const resolved = resolveDeathBatch(state, [{ playerId: shotTargetId, sources: [shotSource] }]);
      return resolved;
    }
    return state;
  }
  if (pending.kind === 'wolf-decision') {
    addPrivateEvent(state, livingWolves(state), 'wolf-attack', `狼队决定袭击 ${wolfTargetLabel(state, targetPlayerId as PlayerId)}。`, {
      actorPlayerId: null,
      targetPlayerIds: [targetPlayerId as PlayerId],
      data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: targetPlayerId as PlayerId },
    });
  } else if (pending.kind === 'seer-action') {
    const targetId = targetPlayerId as PlayerId;
    if (isFloatingActive(state, targetId, state.day)) {
      // 漂浮隐匿：查验不到任何痕迹，结果为空（照常消耗本夜查验，标记已行动避免死循环）
      addPrivateEvent(state, [pending.actorId], 'seer-check', `${getName(state, pending.actorId)} 查验了 ${getName(state, targetId)}，但在现场什么都没有看见。`, {
        actorPlayerId: pending.actorId,
        targetPlayerIds: [targetId],
        data: { actionKind: 'seer-action' },
      });
      return state;
    }
    let roleId = getRoleAssignment(state, targetId).roleId;
    if (roleId === 'hidden-wolf') {
      roleId = 'villager';
    }
    // 造物查验：结果同时传给诺亚（造物的主人）——她设计为"查验结果由诺亚统一接收"
    const creatureOwners = state.creatures.filter((creature) => creature.id === 99).map((creature) => creature.ownerPlayerId);
    const receiverIds: PlayerId[] = [pending.actorId];
    if (pending.actorId === 99) {
      receiverIds.push(...creatureOwners);
    }
    const event = addPrivateEvent(state, receiverIds, 'seer-check', `${getName(state, targetId)} 的当前职业是${roleNames[roleId]}。`, {
      actorPlayerId: pending.actorId,
      targetPlayerIds: [targetId],
      data: { actionKind: 'seer-action' },
    });
    addKnowledge(state, pending.actorId, { subjectPlayerId: targetId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
    // 造物查验的知识也同步给诺亚（她可据此发言/决策）
    if (pending.actorId === 99) {
      const ownerIds = state.creatures.filter((creature) => creature.id === 99).map((creature) => creature.ownerPlayerId);
      for (const ownerId of ownerIds) {
        addKnowledge(state, ownerId, { subjectPlayerId: targetId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
      }
    }
  } else if (pending.kind === 'vote' || pending.kind === 'runoff') {
    let round: VoteRecord['round'] = 1;
    if (pending.kind === 'runoff') {
      round = 2;
    }
    state.currentVotes.push({ voterPlayerId: pending.actorId, targetPlayerId, round });
  } else if (pending.kind === 'tie-break') {
    addExileIntent(state, targetPlayerId as PlayerId);
    state.phase = 'day-resolution';
  }
  return state;
}
