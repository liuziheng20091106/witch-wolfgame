import type { DeathIntent, GameState, PlayerId, RoleAssignmentState, WitchSkillInstance } from '../model';
import { addPublicEvent } from './events';
import { createRewindSnapshot } from './createGame';
import { getName, getPlayer } from './selectors';
import { checkWin } from './win';
import { getNextLastWordsDecision } from '../skills/lastWords';

function nameOf(state: GameState, playerId: PlayerId): string {
  return getName(state, playerId);
}

function sourceLabel(source: DeathIntent['source']): string {
  if (source === 'wolf') return '狼人袭击';
  if (source === 'poison') return '女巫毒药';
  return '魔女杀手';
}

function rewindForDeath(state: GameState, deadPlayerIds: PlayerId[]): GameState | null {
  const trigger = state.skillInstances
    .filter((skill) => skill.definitionId === 'death-rewind' && !state.causalLocks.includes(skill.id))
    .filter((skill) => deadPlayerIds.includes(skill.ownerPlayerId))
    .sort((left, right) => left.ownerPlayerId - right.ownerPlayerId)[0];
  if (!trigger || !state.morningCheckpoint) {
    return null;
  }
  const ownerId = trigger.ownerPlayerId;
  const checkpoint = structuredClone(state.morningCheckpoint);
  const archive = {
    id: `${state.gameId}-archive-${state.archivedTimelines.length}`,
    rewoundAtDay: state.day,
    publicEvents: structuredClone(state.publicEvents),
    privateEvents: structuredClone(state.privateEvents),
  };
  // 死亡回溯：仅使用者保留回溯前的记忆（知识 + 其可见的私有事件）。
  // 私有事件必须改为仅使用者可见（viewerPlayerIds 收敛为 [owner]），
  // 否则狼队共享事件等会把"记忆"泄漏给其他角色。
  const ownerMemoryKnowledge = structuredClone(state.knowledgeByPlayer[ownerId]);
  const ownerMemoryEvents = structuredClone(
    state.privateEvents
      .filter((event) => event.viewerPlayerIds.includes(ownerId))
      .map((event) => ({ ...event, viewerPlayerIds: [ownerId] })),
  );
  const restored: GameState = {
    ...checkpoint,
    usedFreeProvider: state.usedFreeProvider,
    aiFailureOccurred: state.aiFailureOccurred,
    pendingDecision: null,
    morningCheckpoint: structuredClone(state.morningCheckpoint),
    causalLocks: [...state.causalLocks, trigger.id],
    archivedTimelines: [...state.archivedTimelines, archive],
    knowledgeByPlayer: {
      ...checkpoint.knowledgeByPlayer,
      [ownerId]: ownerMemoryKnowledge,
    },
    privateEvents: [
      ...checkpoint.privateEvents,
      ...ownerMemoryEvents.filter((event) => !checkpoint.privateEvents.some((existing) => existing.id === event.id)),
    ],
  };
  // 若回溯前发生过灵魂交换，记忆中的自我职业可能与恢复后的职业不一致：
  // 交换已被回溯撤销，以恢复后的职业为准修正使用者记忆中的"所有"自我职业事实
  //（可能存在多条：初始事实 + 千里眼自我提及等），交换事件仍保留在记忆中
  const ownerPlayer = restored.players[ownerId];
  let restoredAssignment: RoleAssignmentState | undefined;
  if (ownerPlayer) {
    restoredAssignment = restored.roleAssignments.find((entry) => entry.id === ownerPlayer.roleAssignmentId);
  }
  if (restoredAssignment) {
    for (const fact of restored.knowledgeByPlayer[ownerId]) {
      if (fact.subjectPlayerId === ownerId && fact.kind === 'role') {
        fact.value = restoredAssignment.roleId;
        fact.observedDay = restored.day;
      }
    }
  }
  addPublicEvent(restored, 'timeline-rewound', `${nameOf(state, trigger.ownerPlayerId)} 的死亡回溯发动，审判返回此前的晨间节点。`, {
    actorPlayerId: trigger.ownerPlayerId,
  });
  return restored;
}

export function finalizeGameIfWon(state: GameState): boolean {
  if (state.result) {
    state.phase = 'ended';
    return true;
  }
  const result = checkWin(state);
  if (!result) return false;
  state.result = result;
  state.phase = 'ended';
  addPublicEvent(state, 'result', result.winner === 'wolf' ? '狼人达到人数优势，狼人阵营获胜。' : '所有狼人均已出局，好人阵营获胜。');
  return true;
}

export function resolveDeathBatch(
  state: GameState,
  deaths: Array<{ playerId: PlayerId; sources: DeathIntent['source'][] }>,
): GameState {
  const newlyDead: PlayerId[] = [];
  for (const death of deaths) {
    const player = getPlayer(state, death.playerId);
    if (!player.alive) {
      continue;
    }
    if (death.playerId === 99) {
      // 造物死亡：写入 creature.alive（影子玩家不可变）
      const creature = state.creatures.find((entry) => entry.id === 99);
      if (creature) {
        creature.alive = false;
      }
    } else {
      player.alive = false;
    }
    newlyDead.push(player.id);
    const reason = death.sources.length > 0 ? death.sources.map(sourceLabel).join('、') : '白天放逐';
    addPublicEvent(state, 'death', `${nameOf(state, player.id)} 死亡。原因：${reason}。`, {
      targetPlayerIds: [player.id],
      data: { sources: death.sources },
    });
  }
  const rewound = rewindForDeath(state, newlyDead);
  if (rewound) {
    return rewound;
  }
  return state;
}

function nightIntents(state: GameState): DeathIntent[] {
  const intents: DeathIntent[] = [];
  for (const event of state.privateEvents) {
    if (event.day !== state.day || typeof event.data.intentSource !== 'string' || typeof event.data.targetPlayerId !== 'number') {
      continue;
    }
    const source = event.data.intentSource;
    if (source !== 'wolf' && source !== 'poison' && source !== 'precise-kill') {
      continue;
    }
    intents.push({
      targetPlayerId: event.data.targetPlayerId as PlayerId,
      source,
      preventable: event.data.preventable !== false,
    });
  }
  return intents;
}

export function resolveNight(state: GameState): GameState {
  const savedTargets = new Set(
    state.privateEvents
      .filter((event) => event.day === state.day && typeof event.data.savedWolfTargetPlayerId === 'number')
      .map((event) => event.data.savedWolfTargetPlayerId as PlayerId),
  );
  const protectedTargets = new Set(
    state.privateEvents
      .filter((event) => event.day === state.day && typeof event.data.protectTargetPlayerId === 'number')
      .map((event) => event.data.protectTargetPlayerId as PlayerId),
  );
  const survivingIntents = nightIntents(state).filter((intent) => {
    if (intent.source === 'wolf' && savedTargets.has(intent.targetPlayerId)) {
      return false;
    }
    return !(intent.preventable && protectedTargets.has(intent.targetPlayerId));
  });
  const grouped = new Map<PlayerId, DeathIntent['source'][]>();
  for (const intent of survivingIntents) {
    const sources = grouped.get(intent.targetPlayerId) ?? [];
    if (!sources.includes(intent.source)) {
      sources.push(intent.source);
    }
    grouped.set(intent.targetPlayerId, sources);
  }
  const resolved = resolveDeathBatch(
    state,
    [...grouped.entries()].map(([playerId, sources]) => ({ playerId, sources })),
  );
  // 死亡回溯返回晨间快照，当前死亡批次已被撤销，不进入遗言或胜负结算。
  if (resolved !== state) return resolved;
  // 遗言：夜间死亡结算后，若有合格死者需要发布遗言，保持 night-resolution 阶段等待遗言决策。
  // 多个死者时逐个询问；只有全部遗言结束后才确认最终胜负。
  const lastWords = getNextLastWordsDecision(resolved);
  if (lastWords) {
    resolved.pendingDecision = lastWords;
    resolved.phase = 'night-resolution';
    return resolved;
  }
  if (finalizeGameIfWon(resolved)) return resolved;
  resolved.phase = 'dawn';
  return resolved;
}

export function refreshMorningCheckpoint(state: GameState): void {
  state.morningCheckpoint = createRewindSnapshot(state);
}

export function isRecoveredThisNight(skill: WitchSkillInstance, day: number): boolean {
  return skill.data.recoveredNight === day;
}
