import { makeRoleDecision } from './decisions';
import { advanceRoleDraft } from './roleDraft';
import { getAssassinDecision, getMorticianDecision } from './specialRoles';
import { advanceWolfSuggestions, advanceWolfDecision, advanceWitch, advanceSeer, getGuardDecision, applyRoleDecision } from './roleActions';
import { advanceVoting, advanceRunoff } from './voting';
import { SPEECH_MAX_LENGTH, SPEECH_PROMPT_MAX_LENGTH } from '../../../shared/gamePromptContract.js';
import type {
  GameEvent,
  GameState,
  PlayerId,
} from '../model';
import {
  applySkillDecision,
  gazeRequiredMention,
  getAfterSpeechSkillDecision,
  getBeforeSpeechSkillDecision,
  getHealingDecision,
  getNextDayStartSkillDecision,
  getNextNightSkillDecision,
  getNightIgnitionPotionDecision,
  getVoteSkillDecision,
  isRestrainedToday,
} from '../skills/registry';
import { addPublicEvent } from './events';
import { getNextShotDecision } from './retaliation';
import { finalizeGameIfWon, refreshMorningCheckpoint, resolveDeathBatch, resolveNight } from './night';
import { getName, getPlayer, getRoleAssignment } from './selectors';
import { exhaustSkill } from '../skills/types';
import { getNextLastWordsDecision } from '../skills/lastWords';
import { getNextPostGameDecision } from '../skills/postGame';

const DAY_SPEECH_DESCRIPTION = `公开发言建议不超过 ${SPEECH_PROMPT_MAX_LENGTH} 字，实际最多 ${SPEECH_MAX_LENGTH} 字。系统规则只作为内部决策边界，不得当作默认发言素材。先检查本日已有发言；不得换一种说法重复已有共识。至少贡献一项新的观察、质疑、矛盾、回应或后续验证建议；确无新增时可简短保留判断，但不要复述规则。`;

function advanceNightSkills(state: GameState): GameState {
  // 点火烧药第二步：若点火已暂存烧药目标，先完成烧药再继续其它夜间技能
  const ignition = state.skillInstances.find(
    (entry) => entry.definitionId === 'ignition' && typeof entry.data.pendingBurnTarget === 'number',
  );
  if (ignition) {
    const potion = getNightIgnitionPotionDecision(state, ignition.data.pendingBurnTarget as PlayerId);
    if (potion) {
      state.pendingDecision = potion;
      return state;
    }
    // 目标药已无（防御）：直接耗尽，避免卡死
    delete ignition.data.pendingBurnTarget;
    delete ignition.data.pendingBurnNight;
    exhaustSkill(ignition);
  }
  const pending = getNextNightSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'wolf-suggestions';
  }
  return state;
}

function advanceProtection(state: GameState): GameState {
  const mortician = getMorticianDecision(state);
  if (mortician) {
    state.pendingDecision = mortician;
    return state;
  }
  const guardPending = getGuardDecision(state);
  if (guardPending) {
    state.pendingDecision = guardPending;
    return state;
  }
  const pending = getHealingDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'night-resolution';
  }
  return state;
}

function advanceDawn(state: GameState): GameState {
  state.day += 1;
  addPublicEvent(state, 'dawn', `第 ${state.day} 天，审判庭重新亮起。`);
  state.phase = 'day-skills';
  return state;
}

function advanceDaySkills(state: GameState): GameState {
  const pending = getNextDayStartSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.phase = 'speeches';
    refreshMorningCheckpoint(state);
  }
  return state;
}

function spokenToday(state: GameState): PlayerId[] {
  return state.publicEvents
    .filter((event) => event.day === state.day && (event.kind === 'speech' || event.kind === 'restrained'))
    .map((event) => event.targetPlayerIds[0] ?? event.actorPlayerId)
    .filter((value): value is PlayerId => value !== null);
}

function advanceSpeeches(state: GameState): GameState {
  const daySpeechEvents = state.publicEvents.filter((event) => event.day === state.day && event.kind === 'speech');
  const lastSpeech = daySpeechEvents.at(-1);
  if (lastSpeech?.actorPlayerId !== null && lastSpeech?.actorPlayerId !== undefined) {
    const afterDecision = getAfterSpeechSkillDecision(state, lastSpeech.actorPlayerId);
    if (afterDecision) {
      state.pendingDecision = afterDecision;
      return state;
    }
  }
  const spoken = spokenToday(state);
  const actorId = state.speechOrder.find((playerId) => getPlayer(state, playerId).alive && !spoken.includes(playerId));
  if (actorId === undefined) {
    state.phase = 'vote-skills';
    return state;
  }
  // 禁言检查先于发言前技能：被"怪力"禁言者今天无法发言，不应被询问洗脑等发言前技能
  if (isRestrainedToday(state, actorId)) {
    addPublicEvent(state, 'restrained', `${getName(state, actorId)} 受到限制，无法发言。`, {
      actorPlayerId: actorId,
      targetPlayerIds: [actorId],
      displayAuthorPlayerId: actorId,
      actualAuthorPlayerId: actorId,
    });
    return state;
  }
  const beforeDecision = getBeforeSpeechSkillDecision(state, actorId);
  if (beforeDecision) {
    state.pendingDecision = beforeDecision;
    return state;
  }
  const speechDecision = makeRoleDecision(
    state,
    'speech',
    actorId,
    `${getName(state, actorId)} 发言`,
    DAY_SPEECH_DESCRIPTION,
    [],
    true,
    'speech',
  );
  const gazeMention = gazeRequiredMention(state, actorId);
  if (gazeMention) {
    speechDecision.options = {
      ...speechDecision.options,
      requiredMention: gazeMention.requiredMention,
      requiredSeatLabel: gazeMention.requiredSeatLabel,
    };
  }
  state.pendingDecision = speechDecision;
  return state;
}

function advanceVoteSkills(state: GameState): GameState {
  if (state.publicEvents.some((event) => event.day === state.day && event.kind === 'death' && Array.isArray(event.data.sources) && event.data.sources.includes('assassination')) && finalizeGameIfWon(state)) return state;
  const assassin = getAssassinDecision(state);
  if (assassin) {
    state.pendingDecision = assassin;
    return state;
  }
  const pending = getVoteSkillDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  } else {
    state.currentVotes = [];
    state.phase = 'voting';
  }
  return state;
}

function advanceDayResolution(state: GameState): GameState {
  const exile = state.publicEvents.findLast(
    (event) => event.day === state.day && typeof event.data.exileTargetPlayerId === 'number',
  );
  if (typeof exile?.data.exileTargetPlayerId === 'number') {
    const targetPlayerId = exile.data.exileTargetPlayerId as PlayerId;
    if (getPlayer(state, targetPlayerId).alive) {
      if (getRoleAssignment(state, targetPlayerId).roleId === 'dodo') {
        state.result = { winner: 'neutral', reason: 'dodo-exiled', finishedDay: state.day };
        state.phase = 'ended';
        addPublicEvent(state, 'result', `${getName(state, targetPlayerId)}（呆头鹅）被放逐，呆头鹅独自获胜，狼人与好人阵营均告失败。`);
        return state;
      }
      const resolved = resolveDeathBatch(state, [{ playerId: targetPlayerId, sources: [] }]);
      // 死亡回溯返回新状态（死者被救回），当前放逐与遗言均被撤销。
      if (resolved !== state) return resolved;
    }
  }
  const retaliation = getNextShotDecision(state);
  if (retaliation) {
    state.pendingDecision = retaliation;
    return state;
  }
  // 遗言：白天放逐死亡结算后，若有合格死者需要发布遗言，保持 day-resolution 阶段等待遗言决策。
  // 提交遗言后 advance 会再次进入本阶段，此时 exile 目标已死跳过结算，再检查是否还有遗言。
  // （resolveDeathBatch 原地修改并返回同一引用，正常路径会继续执行到本检查，不会提前返回。）
  const lastWords = getNextLastWordsDecision(state);
  if (lastWords) {
    state.pendingDecision = lastWords;
    return state;
  }
  if (finalizeGameIfWon(state)) return state;
  for (const skill of state.skillInstances) {
    if (skill.definitionId === 'brainwash' && skill.data.activeDay === state.day) {
      delete skill.data.activeDay;
      delete skill.data.targetPlayerId;
    }
  }
  state.currentVotes = [];
  state.phase = 'night-skills';
  addPublicEvent(state, 'system', `第 ${state.day} 天结束，夜幕降临。`);
  return state;
}

function advance(state: GameState): GameState {
  if (state.pendingDecision) {
    return state;
  }
  if (state.phase === 'ended') {
    // 对局结束：若胜负已结算，切入赛后复盘阶段（全员依次发表赛后发言）
    if (state.result) {
      state.phase = 'post-game';
      return advancePostGame(state);
    }
    return state;
  }
  switch (state.phase) {
    case 'role-draft': return advanceRoleDraft(state);
    case 'first-night': state.phase = 'night-skills'; return state;
    case 'night-skills': return advanceNightSkills(state);
    case 'wolf-suggestions': return advanceWolfSuggestions(state);
    case 'wolf-decision': return advanceWolfDecision(state);
    case 'witch-action': return advanceWitch(state);
    case 'seer-action': return advanceSeer(state);
    case 'night-protection': return advanceProtection(state);
    case 'night-resolution': return resolveNight(state);
    case 'dawn': return advanceDawn(state);
    case 'day-skills': return advanceDaySkills(state);
    case 'speeches': return advanceSpeeches(state);
    case 'vote-skills': return advanceVoteSkills(state);
    case 'voting': return advanceVoting(state);
    case 'runoff': return advanceRunoff(state);
    case 'day-resolution': return advanceDayResolution(state);
    case 'post-game': return advancePostGame(state);
  }
}

/** 赛后复盘：按座位顺序为普通玩家产生发言决策；全部发完后保持 post-game 终态。 */
function advancePostGame(state: GameState): GameState {
  const pending = getNextPostGameDecision(state);
  if (pending) {
    state.pendingDecision = pending;
  }
  // 全部发完：停留在 post-game（终态），避免 phase 回到 ended 重复触发历史记录
  return state;
}

function applyDecision(state: GameState, event: Extract<GameEvent, { type: 'submit-decision' }>): GameState {
  const pending = state.pendingDecision;
  if (!pending || pending.id !== event.pendingDecisionId || pending.actorId !== event.actorId) {
    throw new Error('待处理决策已过期');
  }
  state.pendingDecision = null;
  if (pending.skillInstanceId) {
    if (pending.kind === 'tie-break') {
      return applyRoleDecision(state, pending, event.decision);
    }
    applySkillDecision(state, pending, event.decision);
    return state;
  }
  return applyRoleDecision(state, pending, event.decision);
}

export function reduceGame(state: GameState, event: GameEvent): GameState {
  const next = structuredClone(state);
  if (event.type === 'advance') {
    return advance(next);
  }
  if (event.type === 'submit-decision') {
    return applyDecision(next, event);
  }
  if (event.type === 'set-automation') {
    next.automationMode = event.automationMode;
    return next;
  }
  if (event.type === 'set-rng-state') {
    next.rngState = event.rngState >>> 0;
    return next;
  }
  if (event.type === 'mark-free-provider-used') {
    next.usedFreeProvider = true;
    return next;
  }
  next.aiFailureOccurred = true;
  if (event.failure) next.lastAiFailure = { ...event.failure, day: next.day, phase: next.phase };
  return next;
}
