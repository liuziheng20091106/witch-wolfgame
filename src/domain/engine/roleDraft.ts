import type { DraftDecision, GameState, PendingDecision } from '../model';
import { initialRoleResources, roleNames } from '../catalog/roles';
import { createRewindSnapshot } from './createGame';
import { makeRoleDecision } from './decisions';
import { addPrivateEvent, addPublicEvent } from './events';
import { chooseWithState, shuffleWithState } from './random';
import { getRoleAssignment } from './selectors';

export function advanceRoleDraft(state: GameState): GameState {
  const draft = state.roleDraft;
  if (!draft) throw new Error('缺少轮抽状态');
  const actorId = draft.order[draft.selectedPlayerIds.length];
  if (actorId === undefined) {
    state.roleDraft = null;
    state.phase = 'first-night';
    addPublicEvent(state, 'system', '选职完成，首夜开始。');
    state.morningCheckpoint = createRewindSnapshot(state);
    return state;
  }
  const choices = shuffleWithState([...new Set(draft.remainingRoles)], state.rngState);
  state.rngState = choices.state;
  const pending = makeRoleDecision(state, 'role-draft', actorId, '顺序选职', '从候选职业中选择，或随机抽取一个剩余职业。', [], true, 'role-draft');
  pending.options = { roleIds: choices.items.slice(0, 3) };
  state.pendingDecision = pending;
  return state;
}

export function applyDraftDecision(state: GameState, pending: PendingDecision, decision: DraftDecision): GameState {
  const draft = state.roleDraft;
  if (!draft || draft.order[draft.selectedPlayerIds.length] !== pending.actorId) throw new Error('轮抽顺序不合法');
  let roleId = decision.roleId;
  if (roleId === null) {
    const random = chooseWithState(draft.remainingRoles, state.rngState);
    roleId = random.item;
    state.rngState = random.state;
  } else if (!Array.isArray(pending.options.roleIds) || !pending.options.roleIds.includes(roleId)) {
    throw new Error('职业不在轮抽候选中');
  }
  const index = draft.remainingRoles.indexOf(roleId);
  if (index < 0) throw new Error('该职业已被选完');
  // 未选席位保留内部占位分配，投影隐藏它们；交换保证存档中的职业多重集始终有效。
  const assignment = getRoleAssignment(state, pending.actorId);
  const donor = state.roleAssignments.find((entry) => entry.roleId === roleId && !draft.selectedPlayerIds.includes(entry.ownerPlayerId));
  if (!donor) throw new Error('轮抽职业分配不一致');
  donor.roleId = assignment.roleId;
  donor.resources = initialRoleResources(donor.roleId);
  assignment.roleId = roleId;
  assignment.resources = initialRoleResources(roleId);
  draft.remainingRoles.splice(index, 1);
  draft.selectedPlayerIds.push(pending.actorId);
  const event = addPrivateEvent(state, [pending.actorId], 'knowledge', `你的职业是${roleNames[roleId]}。`, { actorPlayerId: pending.actorId, data: { actionKind: 'role-draft' } });
  state.knowledgeByPlayer[pending.actorId].push({ id: `${state.gameId}-fact-${pending.actorId}-self`, subjectPlayerId: pending.actorId, kind: 'role', value: roleId, observedDay: 0, sourceEventId: event.id });
  return state;
}
