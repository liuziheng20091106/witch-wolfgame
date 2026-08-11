import { characterById } from '../catalog/characters';
import { roleAlignment } from '../catalog/roles';
import type {
  GameObservation,
  GameState,
  PlayerId,
  PlayerState,
  RoleAssignmentState,
  WitchSkillInstance,
} from '../model';

export function getPlayer(state: GameState, playerId: PlayerId): PlayerState {
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
  return state.players.filter((player) => player.alive).map((player) => player.id);
}

export function selectObservation(
  state: GameState,
  viewer: { kind: 'spectator' } | { kind: 'player'; playerId: PlayerId },
): GameObservation {
  const omniscient = viewer.kind === 'spectator' || state.phase === 'ended';
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
      skillId: omniscient || player.id === viewerPlayerId ? getSkillInstance(state, player.id)?.definitionId ?? null : null,
      isSelf: player.id === viewerPlayerId,
    };
  });

  const publicEvents = omniscient
    ? state.publicEvents
    : state.publicEvents.map((event) => ({ ...event, actualAuthorPlayerId: null }));
  const privateEvents = viewer.kind === 'spectator'
    ? state.privateEvents
    : state.privateEvents.filter((event) => event.viewerPlayerIds.includes(viewer.playerId));

  return {
    gameId: state.gameId,
    mode: state.mode,
    automationMode: state.automationMode,
    day: state.day,
    phase: state.phase,
    viewerPlayerId,
    omniscient,
    players,
    publicEvents,
    privateEvents,
    archivedTimelines: viewer.kind === 'spectator' ? state.archivedTimelines : [],
    knowledge: viewerPlayerId === null ? [] : state.knowledgeByPlayer[viewerPlayerId],
    currentVotes: state.currentVotes,
    pendingDecision: state.pendingDecision?.actorId === viewerPlayerId || omniscient ? state.pendingDecision : null,
    result: state.result,
  };
}

export function getPlayerAlignment(state: GameState, playerId: PlayerId) {
  return roleAlignment[getRoleAssignment(state, playerId).roleId];
}
