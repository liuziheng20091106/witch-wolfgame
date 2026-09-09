import { ROLE_IDS } from '../../../shared/gamePromptContract.js';
import { roleNames } from '../catalog/roles';
import type { AssassinDecision, GameState, PendingDecision, PlayerId, TargetDecision } from '../model';
import { isFloatingActive } from '../skills/levitation';
import { makeRoleDecision } from './decisions';
import { addKnowledge, addPrivateEvent } from './events';
import { resolveDeathBatch } from './night';
import { getAlivePlayerIds, getName, getPlayer, getRoleAssignment } from './selectors';

function nextActor(state: GameState, roleId: 'mortician' | 'assassin'): PlayerId | undefined {
  return getAlivePlayerIds(state).find((id) => {
    if (id === 99 && state.creatures.some((creature) => !getPlayer(state, creature.ownerPlayerId).alive)) return false;
    const role = getRoleAssignment(state, id);
    return role.roleId === roleId
      && (roleId !== 'assassin' || role.resources.assassination === 1)
      && !state.privateEvents.some((event) => event.day === state.day && event.actorPlayerId === id && event.data.actionKind === `${roleId}-action`);
  });
}

export function getMorticianDecision(state: GameState): PendingDecision | null {
  const actorId = nextActor(state, 'mortician');
  const candidates = [...state.players, ...state.creatures].filter((player) => !player.alive).map((player) => player.id);
  if (actorId === undefined || candidates.length === 0) return null;
  return makeRoleDecision(state, 'mortician-action', actorId, '守墓人查验', '查验一名已死亡者的职业。隐狼显示为村民。', candidates, false);
}

export function applyMorticianDecision(state: GameState, pending: PendingDecision, decision: TargetDecision): GameState {
  const target = decision.targetPlayerId;
  if (getRoleAssignment(state, pending.actorId).roleId !== 'mortician' || !getPlayer(state, pending.actorId).alive
    || target === null || !pending.candidates.includes(target) || getPlayer(state, target).alive) throw new Error('守墓人只能查验合法死者');
  const actual = getRoleAssignment(state, target).roleId;
  const roleId = actual === 'hidden-wolf' ? 'villager' : actual;
  const receivers = [pending.actorId];
  if (pending.actorId === 99) receivers.push(...state.creatures.map((creature) => creature.ownerPlayerId));
  const event = addPrivateEvent(state, receivers, 'seer-check', `${getName(state, target)} 的职业是${roleNames[roleId]}。`, {
    actorPlayerId: pending.actorId, targetPlayerIds: [target], data: { actionKind: 'mortician-action' },
  });
  for (const receiver of receivers) addKnowledge(state, receiver, { subjectPlayerId: target, kind: 'role', value: roleId, observedDay: state.day }, event.id);
  return state;
}

export function getAssassinDecision(state: GameState): PendingDecision | null {
  const actorId = nextActor(state, 'assassin');
  if (actorId === undefined) return null;
  const candidates = getAlivePlayerIds(state).filter((id) => id !== actorId && !isFloatingActive(state, id, state.day));
  const pending = makeRoleDecision(state, 'assassin-action', actorId, '暗杀者猜测', '整局一次：猜中目标当前职业则目标死亡，猜错则自己死亡。可以暂不发动。', candidates, true, 'assassin');
  pending.options = { roleIds: [...ROLE_IDS] };
  return pending;
}

export function applyAssassinDecision(state: GameState, pending: PendingDecision, decision: AssassinDecision): GameState {
  const assignment = getRoleAssignment(state, pending.actorId);
  if (assignment.roleId !== 'assassin' || assignment.resources.assassination !== 1 || !getPlayer(state, pending.actorId).alive) throw new Error('暗杀机会不可用');
  const target = decision.targetPlayerId;
  if ((target === null) !== (decision.guessedRoleId === null)) throw new Error('暗杀目标与职业必须同时选择');
  if (target !== null && (target === pending.actorId || !pending.candidates.includes(target) || !getPlayer(state, target).alive
    || isFloatingActive(state, target, state.day) || !ROLE_IDS.includes(decision.guessedRoleId!))) throw new Error('暗杀目标或职业不合法');
  addPrivateEvent(state, [pending.actorId], 'knowledge', target === null ? '本日暂不暗杀。' : '已发动暗杀。', {
    actorPlayerId: pending.actorId, data: { actionKind: 'assassin-action' },
  });
  if (target === null) return state;
  assignment.resources.assassination = 0;
  const victim = getRoleAssignment(state, target).roleId === decision.guessedRoleId ? target : pending.actorId;
  return resolveDeathBatch(state, [{ playerId: victim, sources: ['assassination'] }]);
}
