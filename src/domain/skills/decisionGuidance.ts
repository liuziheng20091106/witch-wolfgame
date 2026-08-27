import { CREATURE_ID, PROMPT_LIMITS } from '../../../shared/gamePromptContract.js';
import type { GameState, PendingDecision, PlayerId } from '../model';
import { getName, getPlayerAlignment } from '../engine/selectors';

function knownWolfAttackTarget(state: GameState, actorId: PlayerId): PlayerId | null {
  const attack = state.privateEvents.findLast(
    (event) => event.day === state.day
      && event.data.actionKind === 'wolf-decision'
      && event.viewerPlayerIds.includes(actorId)
      && typeof event.data.targetPlayerId === 'number',
  );
  if (attack === undefined || typeof attack.data.targetPlayerId !== 'number') {
    return null;
  }
  return attack.data.targetPlayerId as PlayerId;
}

function appendGuidance(pending: PendingDecision, hints: readonly string[]): PendingDecision {
  if (hints.length === 0) {
    return pending;
  }
  const description = `${pending.description} 阵营策略提示：${hints.join('；')}。`;
  if (description.length > PROMPT_LIMITS.actionDescriptionMaxLength) {
    return pending;
  }
  return { ...pending, description };
}

/**
 * 为合法但通常损害己方的选择添加动态提醒，不移除候选目标，保留有意识的战术空间。
 * 只使用行动者明确知道的信息，避免通过提示词泄露隐藏行动。
 */
export function withFactionStrategyGuidance(state: GameState, pending: PendingDecision): PendingDecision {
  const hints: string[] = [];
  if (pending.kind === 'healing' && getPlayerAlignment(state, pending.actorId) === 'wolf') {
    const wolfProtectionTargetNames = pending.candidates
      .filter((targetPlayerId) => getPlayerAlignment(state, targetPlayerId) === 'wolf')
      .map((targetPlayerId) => getName(state, targetPlayerId));
    hints.push(`治愈只会移除本夜的死亡意图，不能复活死者；没有明确战术时，应优先保护自己或存活狼队友（当前优先考虑：${wolfProtectionTargetNames.join('、')}），不要保护好人阵营角色`);
    const attackedPlayerId = knownWolfAttackTarget(state, pending.actorId);
    if (attackedPlayerId !== null && pending.candidates.includes(attackedPlayerId)) {
      hints.push(`本夜狼队决定袭击${getName(state, attackedPlayerId)}，治愈她会直接抵消本队狼刀；除非有明确的空刀或伪装计划，否则不要选择她`);
    }
  }
  if (pending.kind === 'witch-action' && pending.options.canPoison === true) {
    hints.push('毒杀自己已确认的同阵营者通常会直接损害己方；除非有明确战术理由，否则不要这样做');
    if (pending.actorId === CREATURE_ID) {
      const creature = state.creatures.find((entry) => entry.id === CREATURE_ID);
      if (creature !== undefined && pending.candidates.includes(creature.ownerPlayerId)) {
        hints.push(`你与主人${getName(state, creature.ownerPlayerId)}共享同一基础职业和阵营，毒杀主人等同于伤害己方`);
      }
    }
  }
  return appendGuidance(pending, hints);
}
