import type { GameState, IgnitionDecision, PendingDecision, PlayerId, SubmittedDecision, WitchSkillInstance } from '../model';
import { addKnowledge, addPrivateEvent, addPublicEvent } from '../engine/events';
import { getAlivePlayerIds, getName, getPlayer, getRoleAssignment } from '../engine/selectors';
import { exhaustSkill, makeSkillDecision, markOffered, offerKey, wasOffered } from './types';
import { roleNames } from '../catalog/roles';
import { isFloatingActive } from './levitation';

/**
 * 千里眼（可可，主动技，每局一次）：白天开启直播，观看者职业被获知。
 * 流程分两段：①开播决策（use-only）；②逐个观众观看决策（候选=观众自己，观看即选中自己）。
 * 观看名单仅可可可见（私密事件），不公开播报。
 */
function clairvoyanceSkill(state: GameState): WitchSkillInstance | null {
  return state.skillInstances.find(
    (skill) => skill.definitionId === 'clairvoyance'
      && getPlayer(state, skill.ownerPlayerId).alive,
  ) ?? null;
}

function clairvoyanceViewerCandidates(state: GameState, skill: WitchSkillInstance): PlayerId[] {
  const ownerId = skill.ownerPlayerId;
  const asked = Array.isArray(skill.data.viewerIds)
    ? skill.data.viewerIds.filter((value): value is number => typeof value === 'number')
    : [];
  const askedSet = new Set<number>(asked);
  return getAlivePlayerIds(state).filter((playerId) => playerId !== ownerId && !askedSet.has(playerId));
}

export function getClairvoyanceDecision(state: GameState): PendingDecision | null {
  const skill = clairvoyanceSkill(state);
  if (!skill) {
    return null;
  }
  if (skill.data.liveDay === state.day) {
    // 已开播：逐个询问尚未决定的观看者（use-only，目标固定为观众自己，无需选择）
    const candidates = clairvoyanceViewerCandidates(state, skill);
    if (candidates.length > 0) {
      const viewerId = candidates[0] as PlayerId;
      const ownerName = getName(state, skill.ownerPlayerId);
      const decision = makeSkillDecision(
        state,
        skill,
        '观看直播',
        `观看 ${ownerName} 的直播吗？【选择：是/否】\n观看后你的身份信息将被单向传送给她；如果你确认她与你同阵营，可通过她的直播获得一位能为你作铁证的人。狼人通常不观看以免暴露自己。`,
        [],
        'ignition',
      );
      // 观看决策的 actor 是观众（不是开播者），reducer 按 options.clairvoyanceViewer 定位技能实例
      decision.actorId = viewerId;
      decision.options.clairvoyanceViewer = true;
      return decision;
    }
    return null;
  }
  if (skill.status === 'ready') {
    // 未开播：开播决策（每局一次，保留后当天不再询问）
    const offeredKey = offerKey(state, `clairvoyance-${state.day}`);
    if (wasOffered(skill, offeredKey)) {
      return null;
    }
    const ownerName = getName(state, skill.ownerPlayerId);
    return makeSkillDecision(
      state,
      skill,
      '千里眼',
      `开启直播吗？【选择：是/否】\n开启后，${ownerName} 的直播将公开通知其他玩家，他们可逐个选择是否观看。\n每个观看者的身份信息将单向传送给你（观看名单仅你可见）。通常只有已经相信并基本确认你身份的人才愿意观看；第一天信任不足，几乎无人观看，通常应保留到身份较可信时再开启。本技能每局仅能开启一次。`,
      [],
      'ignition',
    );
  }
  return null;
}

export function applyClairvoyanceDecision(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const skill = state.skillInstances.find((entry) => entry.id === pending.skillInstanceId);
  if (!skill || skill.definitionId !== 'clairvoyance') {
    throw new Error('千里眼技能不可用');
  }
  if (pending.title === '观看直播') {
    applyClairvoyanceView(state, skill, pending, decision);
    return;
  }
  const ignition = decision as IgnitionDecision;
  if (!ignition.use) {
    addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${getName(state, skill.ownerPlayerId)} 保留了${pending.title}。`, { actorPlayerId: skill.ownerPlayerId });
    markOffered(skill, offerKey(state, `clairvoyance-${state.day}`));
    return;
  }
  skill.data.liveDay = state.day;
  skill.data.viewerIds = [];
  const ownerName = getName(state, skill.ownerPlayerId);
  addPublicEvent(state, 'skill', `${ownerName} 开启了直播，你可以选择是否观看。`, {
    actorPlayerId: skill.ownerPlayerId,
    targetPlayerIds: [skill.ownerPlayerId],
  });
  addPrivateEvent(state, [skill.ownerPlayerId], 'skill', `${ownerName} 开启了直播：任何选择观看的玩家，其职业将被${ownerName}获知（观看名单仅${ownerName}可见）。`, {
    actorPlayerId: skill.ownerPlayerId,
    targetPlayerIds: [skill.ownerPlayerId],
  });
  exhaustSkill(skill);
}

function applyClairvoyanceView(state: GameState, skill: WitchSkillInstance, pending: PendingDecision, decision: SubmittedDecision): void {
  const viewerId = pending.actorId;
  const ownerId = skill.ownerPlayerId;
  // 防御性校验：观看者必须存活、非开播者本人、且未被记录过（防陈旧/畸形提交重复暴露身份）
  const asked = Array.isArray(skill.data.viewerIds) ? skill.data.viewerIds : [];
  if (viewerId === ownerId || !getPlayer(state, viewerId).alive || asked.includes(viewerId)) {
    throw new Error('千里眼观看者无效');
  }
  const viewerName = getName(state, viewerId);
  const ownerName = getName(state, ownerId);
  const ignition = decision as IgnitionDecision;
  if (!ignition.use) {
    addPrivateEvent(state, [viewerId], 'skill', `${viewerName} 决定不观看 ${ownerName} 的直播。`, { actorPlayerId: viewerId });
  } else if (isFloatingActive(state, viewerId, state.day)) {
    // 漂浮隐匿：直播中看不到漂浮者的身份（观看已消耗，可可获知有人观看但看不清职业）
    addPrivateEvent(state, [ownerId], 'knowledge', `${viewerName} 观看了 ${ownerName} 的直播，但她的身影若隐若现，${ownerName} 看不清她的职业。`, {
      actorPlayerId: ownerId,
      targetPlayerIds: [viewerId],
    });
    addPrivateEvent(state, [viewerId], 'skill', `${viewerName} 观看了 ${ownerName} 的直播，但${ownerName}没能看清${viewerName}的身份。`, {
      actorPlayerId: viewerId,
      targetPlayerIds: [viewerId],
    });
  } else {
    let roleId = getRoleAssignment(state, viewerId).roleId;
    if (roleId === 'hidden-wolf') {
      roleId = 'villager';
    }
    const roleName = roleNames[roleId];
    const event = addPrivateEvent(state, [ownerId], 'knowledge', `${viewerName} 观看了 ${ownerName} 的直播，职业是${roleName}。`, {
      actorPlayerId: ownerId,
      targetPlayerIds: [viewerId],
    });
    addKnowledge(state, ownerId, { subjectPlayerId: viewerId, kind: 'role', value: roleId, observedDay: state.day }, event.id);
    addPrivateEvent(state, [viewerId], 'skill', `${viewerName} 观看了 ${ownerName} 的直播。${ownerName}看到了${viewerName}是${roleName}，因此知晓了${viewerName}的身份。`, {
      actorPlayerId: viewerId,
      targetPlayerIds: [viewerId],
    });
  }
  asked.push(viewerId);
  skill.data.viewerIds = asked;
}
