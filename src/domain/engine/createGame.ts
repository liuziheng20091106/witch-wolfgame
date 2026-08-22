import { BOARD_DESCRIPTION, BOARD_ROLE_POOL, PLAYER_IDS } from '../../../shared/gamePromptContract.js';
import { characterById, characters } from '../catalog/characters';
import { defaultSkillByCharacterId, witchSkillDefinitions } from '../catalog/witchSkills';
import type {
  CharacterId,
  GameSetup,
  GameState,
  PlayerId,
  RewindSnapshot,
  RoleResources,
  WitchSkillInstance,
} from '../model';
import { addKnowledge, addPublicEvent } from './events';
import { chooseWithState, shuffleWithState } from './random';


export function createRewindSnapshot(state: GameState): RewindSnapshot {
  const { morningCheckpoint: _checkpoint, causalLocks: _locks, archivedTimelines: _archives, usedFreeProvider: _freeProvider, ...snapshot } = state;
  return structuredClone(snapshot);
}

export function createGame(setup: GameSetup): GameState {
  const seed = setup.seed >>> 0;
  let rngState = seed;
  let selectedCharacters: CharacterId[];
  let humanPlayerId: PlayerId | null = null;
  const humanCharacterId = setup.humanCharacterId;

  if (setup.mode === 'player') {
    if (!humanCharacterId) {
      throw new Error('参与模式必须选择角色');
    }
    const remaining = characters.map((character) => character.id).filter((id) => id !== humanCharacterId);
    const shuffled = shuffleWithState(remaining, rngState);
    rngState = shuffled.state;
    const humanSeat = chooseWithState(PLAYER_IDS, rngState);
    rngState = humanSeat.state;
    humanPlayerId = humanSeat.item;
    const others = shuffled.items.slice(0, 5);
    selectedCharacters = PLAYER_IDS.map((playerId) => {
      if (playerId === humanSeat.item) {
        return humanCharacterId;
      }
      const offset = playerId < humanSeat.item ? playerId : playerId - 1;
      const characterId = others[offset];
      if (!characterId) {
        throw new Error(`座位 ${playerId} 缺少角色`);
      }
      return characterId;
    });
  } else {
    const shuffled = shuffleWithState(characters.map((character) => character.id), rngState);
    rngState = shuffled.state;
    selectedCharacters = shuffled.items.slice(0, 6);
  }

  const shuffledRoles = shuffleWithState(BOARD_ROLE_POOL, rngState);
  rngState = shuffledRoles.state;
  const shuffledSpeech = shuffleWithState(PLAYER_IDS, rngState);
  rngState = shuffledSpeech.state;

  const roleAssignments = PLAYER_IDS.map((playerId) => {
    const roleId = shuffledRoles.items[playerId];
    if (!roleId) {
      throw new Error(`座位 ${playerId} 缺少职业`);
    }
    const resources: RoleResources = roleId === 'witch' ? { antidote: 1, poison: 1 } : {};
    return { id: `role-${playerId}`, ownerPlayerId: playerId, roleId, resources };
  });

  const skillInstances: WitchSkillInstance[] = PLAYER_IDS.map((playerId) => {
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

  const players = PLAYER_IDS.map((playerId) => {
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
    board: BOARD_DESCRIPTION,
    mode: setup.mode,
    automationMode: 'remote',
    usedFreeProvider: false,
    humanPlayerId,
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
  const startEvent = addPublicEvent(state, 'system', `本局版型：${BOARD_DESCRIPTION}。六名少女进入审判庭，首夜开始。`);
  const skillAnnouncement = addPublicEvent(state, 'knowledge', `魔女技公开：${PLAYER_IDS.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    const definitionId = skillInstances[playerId]?.definitionId;
    if (!characterId || !definitionId) {
      throw new Error(`座位 ${playerId} 缺少魔女技公开信息`);
    }
    return `${playerId + 1}号 ${characterById[characterId].name}（${witchSkillDefinitions[definitionId].name}）`;
  }).join('、')}。`);
  for (const playerId of PLAYER_IDS) {
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
    for (const subjectId of PLAYER_IDS) {
      const subjectSkill = skillInstances[subjectId];
      if (!subjectSkill) {
        throw new Error(`座位 ${subjectId} 缺少初始魔女技事实`);
      }
      addKnowledge(state, playerId, { subjectPlayerId: subjectId, kind: 'skill', value: subjectSkill.definitionId, observedDay: 0 }, skillAnnouncement.id);
    }
  }
  state.morningCheckpoint = createRewindSnapshot(state);
  return state;
}
