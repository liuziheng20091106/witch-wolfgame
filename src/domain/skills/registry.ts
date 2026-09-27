import type { GameState, PendingDecision, SubmittedDecision } from '../model';
import { getSkillInstance } from '../engine/selectors';
import { applyLevitation } from './levitation';
import { applyVisionSkillDecision } from './vision';
import { applyDayIgnition, applyNightIgnition, applyNightIgnitionPotion } from './ignition';
import { applyClairvoyanceDecision } from './clairvoyance';
import { applySpeechSkillDecision } from './speechSkills';
import { applyNightSkillDecision } from './nightSkills';

export {
  getHealingDecision,
  getNextNightSkillDecision,
  applyNightSkillDecision,
} from './nightSkills';
export { applyLevitation, getLevitationDecision, isFloatingActive } from './levitation';
export {
  getVisionSkillDecision,
  applyVisionSkillDecision,
} from './vision';
export {
  getNightIgnitionDecision,
  getNightIgnitionPotionDecision,
  applyNightIgnition,
  applyNightIgnitionPotion,
  getDayIgnitionDecision,
  applyDayIgnition,
  burnedVoters,
} from './ignition';
export { applyClairvoyanceDecision, getClairvoyanceDecision } from './clairvoyance';
export {
  applySpeechSkillDecision,
  attachBrainwashSuggestion,
  gazeRequiredMention,
  getAfterSpeechSkillDecision,
  getBeforeSpeechSkillDecision,
  getNextDayStartSkillDecision,
  isRestrainedToday,
  publishSpeech,
  validateGuidedSpeech,
} from './speechSkills';
export { applyVoteSkillDecision, getTieBreaker, getVoteOrder, getVoteSkillDecision } from './voteSkills';

export function applySkillDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  // 千里眼观看决策：actor 是观众，技能实例属于开播者（可可），必须按 skillInstanceId 定位技能
  if (pending.options.clairvoyanceViewer === true) {
    const clairvoyanceSkill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
    if (!clairvoyanceSkill || clairvoyanceSkill.definitionId !== 'clairvoyance') {
      throw new Error('千里眼技能不可用');
    }
    applyClairvoyanceDecision(state, pending, decision);
    return;
  }
  const skill = getSkillInstance(state, pending.actorId);
  if (!skill || skill.id !== pending.skillInstanceId) {
    throw new Error('待处理技能已移动或失效');
  }
  if (skill.definitionId === 'levitation') {
    applyLevitation(state, pending, decision);
  } else if (skill.definitionId === 'mind-reading') {
    applyVisionSkillDecision(state, pending, decision);
  } else if (skill.definitionId === 'ignition') {
    if (pending.title === '点火-烧药') {
      applyNightIgnitionPotion(state, pending, decision);
    } else if (pending.title === '点火-白天') {
      applyDayIgnition(state, pending, decision);
    } else {
      applyNightIgnition(state, pending, decision);
    }
  } else if (skill.definitionId === 'clairvoyance') {
    applyClairvoyanceDecision(state, pending, decision);
  } else if (skill.definitionId === 'speech-restrain' || skill.definitionId === 'brainwash' || skill.definitionId === 'voice-mimic' || skill.definitionId === 'gaze-guidance') {
    applySpeechSkillDecision(state, pending, decision);
  } else {
    applyNightSkillDecision(state, pending, decision);
  }
}
