import { characterById } from '../catalog/characters';
import type { DeathIntent, GameState, PlayerId, WitchSkillInstance } from '../model';
import { addPublicEvent } from './events';
import { createRewindSnapshot } from './createGame';
import { getPlayer } from './selectors';
import { checkWin } from './win';

function nameOf(state: GameState, playerId: PlayerId): string {
  return characterById[getPlayer(state, playerId).characterId].name;
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
  const checkpoint = structuredClone(state.morningCheckpoint);
  const archive = {
    id: `${state.gameId}-archive-${state.archivedTimelines.length}`,
    rewoundAtDay: state.day,
    publicEvents: structuredClone(state.publicEvents),
    privateEvents: structuredClone(state.privateEvents),
  };
  const restored: GameState = {
    ...checkpoint,
    usedFreeProvider: state.usedFreeProvider,
    pendingDecision: null,
    morningCheckpoint: structuredClone(state.morningCheckpoint),
    causalLocks: [...state.causalLocks, trigger.id],
    archivedTimelines: [...state.archivedTimelines, archive],
  };
  addPublicEvent(restored, 'timeline-rewound', `${nameOf(state, trigger.ownerPlayerId)} 的死亡回溯发动，审判返回此前的晨间节点。`, {
    actorPlayerId: trigger.ownerPlayerId,
  });
  return restored;
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
    player.alive = false;
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
  const result = checkWin(state);
  if (result) {
    state.result = result;
    state.phase = 'ended';
    addPublicEvent(state, 'result', result.winner === 'wolf' ? '狼人达到人数优势，狼人阵营获胜。' : '所有狼人均已出局，好人阵营获胜。');
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
  const grouped = new Map<PlayerId, DeathIntent['source'][] >();
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
  if (resolved.phase !== 'ended' && resolved === state) {
    resolved.phase = 'dawn';
  }
  return resolved;
}

export function refreshMorningCheckpoint(state: GameState): void {
  state.morningCheckpoint = createRewindSnapshot(state);
}

export function isRecoveredThisNight(skill: WitchSkillInstance, day: number): boolean {
  return skill.data.recoveredNight === day;
}
