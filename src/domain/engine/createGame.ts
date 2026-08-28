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
import { chooseWithState, nextRandom, shuffleWithState } from './random';

export function createRewindSnapshot(state: GameState): RewindSnapshot {
  const { morningCheckpoint: _checkpoint, causalLocks: _locks, archivedTimelines: _archives, usedFreeProvider: _freeProvider, aiFailureOccurred: _aiFailure, ...snapshot } = state;
  return structuredClone(snapshot);
}

interface RoundInput {
  mode: GameSetup['mode'];
  humanCharacterId: CharacterId | null;
  humanPlayerId: PlayerId | null;
  selectedCharacters: CharacterId[];
  playerCount: number;
  seed: number;
  initialRngState: number;
  seriesId: string;
  roundNumber: number;
  automationMode: GameState['automationMode'];
}

<<<<<<< HEAD
function createRound(input: RoundInput): GameState {
  const activePlayerIds = PLAYER_IDS.slice(0, input.playerCount);
  const rolePool = rolePoolForPlayerCount(input.playerCount);
  const board = formatBoardDescription(rolePool);
  let rngState = input.initialRngState;
  const shuffledRoles = shuffleWithState(rolePool, rngState);
=======
  if (setup.seatCharacterIds !== undefined) {
    if (setup.seatCharacterIds.length !== PLAYER_IDS.length || new Set(setup.seatCharacterIds).size !== PLAYER_IDS.length) {
      throw new Error('指定席位角色必须是六名不重复角色');
    }
    selectedCharacters = [...setup.seatCharacterIds];
    const seatHumanPlayerId = humanCharacterId === null ? -1 : selectedCharacters.indexOf(humanCharacterId);
    if (setup.mode === 'player' && seatHumanPlayerId < 0) throw new Error('参与角色不在指定席位中');
    humanPlayerId = seatHumanPlayerId < 0 ? null : seatHumanPlayerId as PlayerId;
  } else if (setup.mode === 'player') {
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
>>>>>>> 8c2eb76 (实现权威多人房间与混合席位驱动)
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
    const characterId = input.selectedCharacters[playerId];
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
    const characterId = input.selectedCharacters[playerId];
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
  const gameId = input.roundNumber === 1 ? input.seriesId : `${input.seriesId}-round-${input.roundNumber}`;
  const state: GameState = {
    schemaVersion: 1,
    gameId,
    seriesId: input.seriesId,
    roundNumber: input.roundNumber,
    board,
    mode: input.mode,
    automationMode: input.automationMode,
    usedFreeProvider: false,
<<<<<<< HEAD
    humanPlayerId: input.humanPlayerId,
    seed: input.seed,
=======
    aiFailureOccurred: false,
    humanPlayerId,
    seed,
>>>>>>> 156adb9 (改善 AI 决策失败恢复逻辑)
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
  const roundLabel = input.roundNumber > 1 ? `连续审判第 ${input.roundNumber} 轮。` : '';
  const startEvent = addPublicEvent(state, 'system', `${roundLabel}本局版型：${board}。${input.playerCount} 名少女进入审判庭，身份已重新分配，首夜开始。`);
  const speechOrderText = shuffledSpeech.items.map((playerId, index) => {
    const characterId = input.selectedCharacters[playerId];
    if (!characterId) throw new Error(`座位 ${playerId} 缺少发言顺序角色信息`);
    return `${index + 1}. ${playerId + 1}号 ${characterById[characterId].name}`;
  }).join('、');
  addPublicEvent(state, 'knowledge', `今日发言顺序：${speechOrderText}。`);
  const skillAnnouncement = addPublicEvent(state, 'knowledge', `魔女技公开：${activePlayerIds.map((playerId) => {
    const characterId = input.selectedCharacters[playerId];
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

export function createGame(setup: GameSetup): GameState {
  const playerCount = setup.playerCount ?? MIN_PLAYERS;
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new Error(`玩家人数必须在 ${MIN_PLAYERS} 到 ${MAX_PLAYERS} 之间`);
  }
  const activePlayerIds = PLAYER_IDS.slice(0, playerCount);
  const requestedCharacters = setup.selectedCharacterIds ?? [];
  if (new Set(requestedCharacters).size !== requestedCharacters.length) throw new Error('出庭角色不能重复');
  if (requestedCharacters.length !== 0 && requestedCharacters.length !== playerCount) {
    throw new Error(`必须选择 ${playerCount} 名出庭角色，或留空使用随机阵容`);
  }
  const seed = setup.seed >>> 0;
  let rngState = seed;
  const humanCharacterId = setup.humanCharacterId;
  let humanPlayerId: PlayerId | null = null;
  let selectedCharacters: CharacterId[];
  if (setup.seatCharacterIds !== undefined) {
    if (setup.seatCharacterIds.length !== playerCount || new Set(setup.seatCharacterIds).size !== playerCount) {
      throw new Error(`指定席位角色必须是 ${playerCount} 名不重复角色`);
    }
    selectedCharacters = [...setup.seatCharacterIds];
    const seatHumanPlayerId = humanCharacterId === null ? -1 : selectedCharacters.indexOf(humanCharacterId);
    if (setup.mode === 'player' && seatHumanPlayerId < 0) throw new Error('参与角色不在指定席位中');
    humanPlayerId = seatHumanPlayerId < 0 ? null : seatHumanPlayerId as PlayerId;
  } else if (setup.mode === 'player') {
    if (!humanCharacterId) throw new Error('参与模式必须选择角色');
    if (requestedCharacters.length > 0 && !requestedCharacters.includes(humanCharacterId)) {
      throw new Error('你的角色必须包含在出庭阵容中');
    }
    const remaining = (requestedCharacters.length > 0 ? requestedCharacters : characters.map((character) => character.id))
      .filter((id) => id !== humanCharacterId);
    const shuffled = shuffleWithState(remaining, rngState);
    rngState = shuffled.state;
    const humanSeat = chooseWithState(activePlayerIds, rngState);
    rngState = humanSeat.state;
    humanPlayerId = humanSeat.item;
    const others = shuffled.items.slice(0, playerCount - 1);
    selectedCharacters = activePlayerIds.map((playerId) => {
      if (playerId === humanSeat.item) return humanCharacterId;
      const offset = playerId < humanSeat.item ? playerId : playerId - 1;
      const characterId = others[offset];
      if (!characterId) throw new Error(`座位 ${playerId} 缺少角色`);
      return characterId;
    });
  } else {
    const characterPool = requestedCharacters.length > 0 ? requestedCharacters : characters.map((character) => character.id);
    const shuffled = shuffleWithState(characterPool, rngState);
    rngState = shuffled.state;
    selectedCharacters = shuffled.items.slice(0, playerCount);
  }
  if (selectedCharacters.length !== playerCount) throw new Error('可用角色不足');
  const rosterSignature = [...selectedCharacters].sort().join(',');
  const seriesId = `game-${seed}-${setup.mode}-${playerCount}-${humanCharacterId ?? 'auto'}-${rosterSignature}`;
  return createRound({
    mode: setup.mode,
    humanCharacterId,
    humanPlayerId,
    selectedCharacters,
    playerCount,
    seed,
    initialRngState: rngState,
    seriesId,
    roundNumber: 1,
    automationMode: 'remote',
  });
}

export function continueGameWithNewRoles(previous: GameState): GameState {
  if (previous.result === null || (previous.phase !== 'ended' && previous.phase !== 'post-game')) {
    throw new Error('只有已结束的对局可以重新分配身份继续');
  }
  const playerCount = previous.players.length;
  const nextSeed = nextRandom(previous.rngState).state;
  const selectedCharacters = previous.players
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((player) => player.characterId);
  const humanCharacterId = previous.humanPlayerId === null
    ? null
    : previous.players.find((player) => player.id === previous.humanPlayerId)?.characterId ?? null;
  return createRound({
    mode: previous.mode,
    humanCharacterId,
    humanPlayerId: previous.humanPlayerId,
    selectedCharacters,
    playerCount,
    seed: nextSeed,
    initialRngState: nextSeed,
    seriesId: previous.seriesId,
    roundNumber: previous.roundNumber + 1,
    automationMode: previous.automationMode,
  });
}
