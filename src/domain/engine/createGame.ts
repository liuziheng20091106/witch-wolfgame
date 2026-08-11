import { characters } from '../catalog/characters';
import { defaultSkillByCharacterId, witchSkillDefinitions } from '../catalog/witchSkills';
import type {
  CharacterId,
  GameSetup,
  GameState,
  PlayerId,
  RewindSnapshot,
  RoleId,
  RoleResources,
  WitchSkillInstance,
} from '../model';
import { addPublicEvent } from './events';
import { shuffleWithState } from './random';

const playerIds: PlayerId[] = [0, 1, 2, 3, 4, 5];
const rolePool: RoleId[] = ['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager'];

export function createRewindSnapshot(state: GameState): RewindSnapshot {
  const { morningCheckpoint: _checkpoint, causalLocks: _locks, archivedTimelines: _archives, ...snapshot } = state;
  return structuredClone(snapshot);
}

export function createGame(setup: GameSetup): GameState {
  const seed = setup.seed >>> 0;
  let rngState = seed;
  let selectedCharacters: CharacterId[];

  if (setup.mode === 'player') {
    if (!setup.humanCharacterId) {
      throw new Error('参与模式必须选择角色');
    }
    const remaining = characters.map((character) => character.id).filter((id) => id !== setup.humanCharacterId);
    const shuffled = shuffleWithState(remaining, rngState);
    rngState = shuffled.state;
    selectedCharacters = [setup.humanCharacterId, ...shuffled.items.slice(0, 5)];
  } else {
    const shuffled = shuffleWithState(characters.map((character) => character.id), rngState);
    rngState = shuffled.state;
    selectedCharacters = shuffled.items.slice(0, 6);
  }

  const shuffledRoles = shuffleWithState(rolePool, rngState);
  rngState = shuffledRoles.state;
  const shuffledSpeech = shuffleWithState(playerIds, rngState);
  rngState = shuffledSpeech.state;

  const roleAssignments = playerIds.map((playerId) => {
    const roleId = shuffledRoles.items[playerId];
    if (!roleId) {
      throw new Error(`座位 ${playerId} 缺少职业`);
    }
    const resources: RoleResources = roleId === 'witch' ? { antidote: 1, poison: 1 } : {};
    return { id: `role-${playerId}`, ownerPlayerId: playerId, roleId, resources };
  });

  const skillInstances: WitchSkillInstance[] = playerIds.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    if (!characterId) {
      throw new Error(`座位 ${playerId} 缺少角色`);
    }
    const definitionId = defaultSkillByCharacterId[characterId];
    const usage = witchSkillDefinitions[definitionId].usage;
    return {
      id: `skill-${playerId}-${definitionId}`,
      definitionId,
      ownerPlayerId: playerId,
      status: usage === 'passive' ? 'active' : 'ready',
      remainingUses: usage === 'once' ? 1 : null,
      data: {},
    };
  });

  const players = playerIds.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    if (!characterId) {
      throw new Error(`座位 ${playerId} 缺少角色`);
    }
    return {
      id: playerId,
      characterId,
      roleAssignmentId: `role-${playerId}`,
      skillInstanceId: skillInstances[playerId]?.id ?? null,
      alive: true,
    };
  });

  const state: GameState = {
    schemaVersion: 1,
    gameId: `game-${seed}-${setup.mode}-${setup.humanCharacterId ?? 'auto'}`,
    mode: setup.mode,
    automationMode: 'remote',
    humanPlayerId: setup.mode === 'player' ? 0 : null,
    seed,
    rngState,
    day: 0,
    phase: 'first-night',
    players,
    roleAssignments,
    skillInstances,
    knowledgeByPlayer: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] },
    speechOrder: shuffledSpeech.items,
    publicEvents: [],
    privateEvents: [],
    archivedTimelines: [],
    currentVotes: [],
    pendingDecision: null,
    morningCheckpoint: null,
    causalLocks: [],
    result: null,
  };
  const startEvent = addPublicEvent(state, 'system', '六名少女进入审判庭，首夜开始。');
  for (const playerId of playerIds) {
    const roleId = roleAssignments[playerId]?.roleId;
    if (!roleId) {
      throw new Error(`座位 ${playerId} 缺少初始职业事实`);
    }
    state.knowledgeByPlayer[playerId].push({
      id: `${state.gameId}-fact-${playerId}-self`,
      subjectPlayerId: playerId,
      kind: 'role',
      value: roleId,
      observedDay: 0,
      sourceEventId: startEvent.id,
    });
  }
  state.morningCheckpoint = createRewindSnapshot(state);
  return state;
}
