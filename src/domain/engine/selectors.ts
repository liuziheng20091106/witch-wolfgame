import { CREATURE_ID, formatCreatureName } from '../../../shared/gamePromptContract.js';
import { characterById } from '../catalog/characters';
import { roleAlignment } from '../catalog/roles';
import type {
  CreatureState,
  GameObservation,
  GameState,
  PlayerId,
  PlayerState,
  RoleAssignmentState,
  WitchSkillInstance,
} from '../model';

export function isCreatureId(playerId: PlayerId): boolean {
  return playerId === CREATURE_ID;
}

export function getCreature(state: GameState): CreatureState | null {
  const creature = state.creatures.find((entry) => entry.id === CREATURE_ID);
  return creature ?? null;
}

/** 玩家/造物通用名：造物显示为「诺亚的造物」。 */
export function getName(state: GameState, playerId: PlayerId): string {
  if (playerId === CREATURE_ID) {
    const creature = getCreature(state);
    const ownerName = creature ? getName(state, creature.ownerPlayerId) : '诺亚';
    return formatCreatureName(ownerName);
  }
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player) {
    throw new Error(`找不到座位 ${playerId}`);
  }
  return characterById[player.characterId].name;
}

/** 把造物适配成"影子玩家"形态，使 getPlayer/getRoleAssignment 等对 99 号透明。 */
export function creatureAsPlayer(state: GameState, creature: CreatureState): PlayerState {
  return {
    id: creature.id,
    characterId: creature.characterId,
    roleAssignmentId: creature.roleAssignmentId,
    skillInstanceId: null,
    alive: creature.alive,
  };
}

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
  if (playerId === CREATURE_ID) {
    const creature = getCreature(state);
    if (!creature) {
      throw new Error('找不到造物 99');
    }
    return creatureAsPlayer(state, creature);
  }
  const player = state.players.find((entry) => entry.id === playerId);
  if (!player) {
    throw new Error(`找不到座位 ${playerId}`);
  }
  return player;
}

export function getRoleAssignment(state: GameState, playerId: PlayerId): RoleAssignmentState {
  const player = getPlayer(state, playerId);
  const assignment = state.roleAssignments.find((entry) => entry.id === player.roleAssignmentId);
  if (!assignment) {
    throw new Error(`座位 ${playerId} 缺少职业分配`);
  }
  return assignment;
}

export function getSkillInstance(state: GameState, playerId: PlayerId): WitchSkillInstance | null {
  const skillId = getPlayer(state, playerId).skillInstanceId;
  if (!skillId) {
    return null;
  }
  return state.skillInstances.find((entry) => entry.id === skillId) ?? null;
}

export function getAlivePlayerIds(state: GameState): PlayerId[] {
  const playerIds = state.players.filter((player) => player.alive).map((player) => player.id);
  if (state.creatures.some((creature) => creature.alive)) {
    playerIds.push(CREATURE_ID);
  }
  return playerIds;
}

function revealedCurrentVotes(state: GameState) {
  const revealedRounds = new Set<number>();
  for (const event of state.publicEvents) {
    if (event.day !== state.day || event.kind !== 'vote') {
      continue;
    }
    const round = event.data.revealedVoteRound;
    if (round === 1 || round === 2) {
      revealedRounds.add(round);
    }
  }
  return state.currentVotes.filter((vote) => revealedRounds.has(vote.round));
}

export function selectObservation(
  state: GameState,
  viewer: { kind: 'spectator' } | { kind: 'player'; playerId: PlayerId },
): GameObservation {
  const omniscient = viewer.kind === 'spectator' || state.phase === 'ended' || state.phase === 'post-game';
  const viewerPlayerId = viewer.kind === 'player' ? viewer.playerId : null;
  const viewerRole = viewerPlayerId === null ? null : getRoleAssignment(state, viewerPlayerId).roleId;

  const players = state.players.map((player) => {
    const assignment = getRoleAssignment(state, player.id);
    const showWolfTeammate = viewerRole === 'wolf' && assignment.roleId === 'wolf';
    const showPrivate = omniscient || player.id === viewerPlayerId || showWolfTeammate;
    const character = characterById[player.characterId];
    return {
      id: player.id,
      characterId: player.characterId,
      name: character.name,
      avatarUrl: character.avatarUrl,
      alive: player.alive,
      roleId: showPrivate ? assignment.roleId : null,
      skillId: getSkillInstance(state, player.id)?.definitionId ?? null,
      isSelf: player.id === viewerPlayerId,
    };
  });
  // 造物作为可观察单位加入（供 AI 决策视角与目标池呈现）；暂无专属立绘，沿用当前主人的立绘
  for (const creature of state.creatures) {
    if (!creature.alive) {
      continue;
    }
    const ownerName = getName(state, creature.ownerPlayerId);
    const assignment = getRoleAssignment(state, creature.id);
    const showWolfTeammate = viewerRole === 'wolf' && assignment.roleId === 'wolf';
    // 造物自己或主人查看时，能看到造物的职业（造物决策需要知道自己的身份）
    const viewerIsCreatureOrOwner = creature.id === viewerPlayerId || creature.ownerPlayerId === viewerPlayerId;
    const showPrivate = omniscient || viewerIsCreatureOrOwner || showWolfTeammate;
    const ownerCharacter = characterById[getPlayer(state, creature.ownerPlayerId).characterId];
    players.push({
      id: creature.id,
      characterId: creature.characterId,
      name: formatCreatureName(ownerName),
      avatarUrl: ownerCharacter.avatarUrl,
      alive: true,
      roleId: showPrivate ? assignment.roleId : null,
      skillId: null,
      isSelf: false,
    });
  }

  const publicEvents = omniscient
    ? state.publicEvents
    : state.publicEvents.map((event) => ({ ...event, actualAuthorPlayerId: null }));
  const privateEvents = omniscient
    ? state.privateEvents
    : state.privateEvents.filter((event) => event.viewerPlayerIds.includes(viewer.playerId));

  return {
    gameId: state.gameId,
    roundNumber: state.roundNumber,
    mode: state.mode,
    automationMode: state.automationMode,
    board: state.board,
    seed: state.seed,
    usedFreeProvider: state.usedFreeProvider,
    day: state.day,
    phase: state.phase,
    viewerPlayerId,
    omniscient,
    players,
    publicEvents,
    privateEvents,
    archivedTimelines: omniscient ? state.archivedTimelines : [],
    knowledge: viewerPlayerId === null ? [] : state.knowledgeByPlayer[viewerPlayerId],
    currentVotes: revealedCurrentVotes(state),
    pendingDecision: state.pendingDecision?.actorId === viewerPlayerId || omniscient ? state.pendingDecision : null,
    result: state.result,
  };
}

export function getPlayerAlignment(state: GameState, playerId: PlayerId) {
  return roleAlignment[getRoleAssignment(state, playerId).roleId];
}
