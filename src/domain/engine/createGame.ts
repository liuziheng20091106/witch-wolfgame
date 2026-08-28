import { CREATURE_ID, MAX_PLAYERS, MIN_PLAYERS, PLAYER_IDS, formatBoardDescription, rolePoolForPlayerCount } from '../../../shared/gamePromptContract.js';
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
  if (!Number.isInteger(setup.playerCount) || setup.playerCount < MIN_PLAYERS || setup.playerCount > MAX_PLAYERS) {
    throw new Error(`玩家人数必须在 ${MIN_PLAYERS} 到 ${MAX_PLAYERS} 之间`);
  }
  const activePlayerIds = PLAYER_IDS.slice(0, setup.playerCount);
  const requestedCharacters = setup.selectedCharacterIds;
  if (new Set(requestedCharacters).size !== requestedCharacters.length) {
    throw new Error('出庭角色不能重复');
  }
  if (requestedCharacters.length !== 0 && requestedCharacters.length !== setup.playerCount) {
    throw new Error(`必须选择 ${setup.playerCount} 名出庭角色，或留空使用随机阵容`);
  }

  const seed = setup.seed >>> 0;
  let rngState = seed;
  let characterPool = requestedCharacters.length > 0
    ? [...requestedCharacters]
    : characters.map((character) => character.id);
  const humanCharacterId = setup.humanCharacterId;
  if (setup.mode === 'player') {
    if (!humanCharacterId) throw new Error('参与模式必须选择角色');
    if (requestedCharacters.length > 0 && !requestedCharacters.includes(humanCharacterId)) {
      throw new Error('你的角色必须包含在出庭阵容中');
    }
    characterPool = characterPool.filter((characterId) => characterId !== humanCharacterId);
  }
  const shuffledCharacters = shuffleWithState(characterPool, rngState);
  rngState = shuffledCharacters.state;

  let humanPlayerId: PlayerId | null = null;
  let selectedCharacters: CharacterId[];
  if (setup.mode === 'player' && humanCharacterId) {
    const humanSeat = chooseWithState(activePlayerIds, rngState);
    rngState = humanSeat.state;
    humanPlayerId = humanSeat.item;
    const others = shuffledCharacters.items.slice(0, setup.playerCount - 1);
    selectedCharacters = activePlayerIds.map((playerId) => {
      if (playerId === humanSeat.item) return humanCharacterId;
      const offset = playerId < humanSeat.item ? playerId : playerId - 1;
      const characterId = others[offset];
      if (!characterId) throw new Error(`座位 ${playerId} 缺少角色`);
      return characterId;
    });
  } else {
    selectedCharacters = shuffledCharacters.items.slice(0, setup.playerCount);
  }
  if (selectedCharacters.length !== setup.playerCount) throw new Error('可用角色不足');

  const rolePool = rolePoolForPlayerCount(setup.playerCount);
  const board = formatBoardDescription(rolePool);
  const shuffledRoles = shuffleWithState(rolePool, rngState);
  rngState = shuffledRoles.state;
  const shuffledSpeech = shuffleWithState(activePlayerIds, rngState);
  rngState = shuffledSpeech.state;

  const roleAssignments = activePlayerIds.map((playerId) => {
    const roleId = shuffledRoles.items[playerId];
    if (!roleId) throw new Error(`座位 ${playerId} 缺少职业`);
    const resources: RoleResources = roleId === 'witch' ? { antidote: 1, poison: 1 } : {};
    return { id: `role-${playerId}`, ownerPlayerId: playerId, roleId, resources };
  });
  const skillInstances: WitchSkillInstance[] = activePlayerIds.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    if (!characterId) throw new Error(`座位 ${playerId} 缺少角色`);
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
  const players = activePlayerIds.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    if (!characterId) throw new Error(`座位 ${playerId} 缺少角色`);
    return {
      id: playerId,
      characterId,
      roleAssignmentId: `role-${playerId}`,
      skillInstanceId: skillInstances[playerId]?.id ?? null,
      alive: true,
    };
  });
  const knowledgeByPlayer = Object.fromEntries(
    [...activePlayerIds, CREATURE_ID].map((playerId) => [playerId, []]),
  ) as unknown as GameState['knowledgeByPlayer'];
  const rosterSignature = [...selectedCharacters].sort().join(',');
  const state: GameState = {
    schemaVersion: 1,
    gameId: `game-${seed}-${setup.mode}-${setup.playerCount}-${setup.humanCharacterId ?? 'auto'}-${rosterSignature}`,
    board,
    mode: setup.mode,
    automationMode: 'remote',
    usedFreeProvider: false,
    humanPlayerId,
    seed,
    rngState,
    day: 0,
    phase: 'first-night',
    players,
    creatures: [],
    roleAssignments,
    skillInstances,
    knowledgeByPlayer,
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
  const startEvent = addPublicEvent(state, 'system', `本局版型：${board}。${setup.playerCount} 名少女进入审判庭，首夜开始。`);
  const speechOrderText = shuffledSpeech.items.map((playerId, index) => {
    const characterId = selectedCharacters[playerId];
    if (!characterId) throw new Error(`座位 ${playerId} 缺少发言顺序角色信息`);
    return `${index + 1}. ${playerId + 1}号 ${characterById[characterId].name}`;
  }).join('、');
  addPublicEvent(state, 'knowledge', `今日发言顺序：${speechOrderText}。`);
  const skillAnnouncement = addPublicEvent(state, 'knowledge', `魔女技公开：${activePlayerIds.map((playerId) => {
    const characterId = selectedCharacters[playerId];
    const definitionId = skillInstances[playerId]?.definitionId;
    if (!characterId || !definitionId) throw new Error(`座位 ${playerId} 缺少魔女技公开信息`);
    return `${playerId + 1}号 ${characterById[characterId].name}（${witchSkillDefinitions[definitionId].name}）`;
  }).join('、')}。`);
  for (const playerId of activePlayerIds) {
    const roleId = roleAssignments[playerId]?.roleId;
    if (!roleId) throw new Error(`座位 ${playerId} 缺少初始职业事实`);
    state.knowledgeByPlayer[playerId].push({
      id: `${state.gameId}-fact-${playerId}-self`,
      subjectPlayerId: playerId,
      kind: 'role',
      value: roleId,
      observedDay: 0,
      sourceEventId: startEvent.id,
    });
    for (const subjectId of activePlayerIds) {
      const subjectSkill = skillInstances[subjectId];
      if (!subjectSkill) throw new Error(`座位 ${subjectId} 缺少初始魔女技事实`);
      addKnowledge(state, playerId, { subjectPlayerId: subjectId, kind: 'skill', value: subjectSkill.definitionId, observedDay: 0 }, skillAnnouncement.id);
    }
  }
  state.morningCheckpoint = createRewindSnapshot(state);
  return state;
}
