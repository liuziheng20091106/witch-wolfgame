import type { GameState, PendingDecision, PlayerId } from '../model';
import { getAlivePlayerIds, getName, getRoleAssignment } from './selectors';

function nameOf(state: GameState, playerId: PlayerId): string {
  return getName(state, playerId);
}

/** 读取某玩家本日死亡事件的死亡原因集合（空数组 = 白天放逐）。 */
function deathSources(state: GameState, playerId: PlayerId): string[] {
  for (const event of state.publicEvents) {
    if (event.kind === 'death' && event.day === state.day && event.targetPlayerIds.includes(playerId)) {
      const sources = event.data.sources;
      if (Array.isArray(sources)) {
        return sources.filter((value): value is string => typeof value === 'string');
      }
      return [];
    }
  }
  return [];
}

interface ShotEligibility {
  kind: 'hunter-shot' | 'wolf-king-shot';
}

/**
 * 死亡反击资格（猎人 / 白狼王）：
 * - 猎人：被狼人袭击死亡（sources 含 'wolf'）或被放逐（sources 为空）时可开枪；被毒药、魔女杀手、枪决带走时不能。
 * - 白狼王：仅被放逐时可带走一人。
 * 资源 hunterShot / wolfKingShot 为 1 且未消耗（已消耗说明本日已反击过，防重复生成）。
 */
function shotEligibility(state: GameState, playerId: PlayerId): ShotEligibility | null {
  const assignment = getRoleAssignment(state, playerId);
  const sources = deathSources(state, playerId);
  if (assignment.roleId === 'hunter' && assignment.resources.hunterShot === 1) {
    if (sources.includes('wolf') || sources.length === 0) {
      return { kind: 'hunter-shot' };
    }
  }
  if (assignment.roleId === 'wolf-king' && assignment.resources.wolfKingShot === 1) {
    if (sources.length === 0) {
      return { kind: 'wolf-king-shot' };
    }
  }
  return null;
}

/**
 * 下一个待提交的死亡反击决策（若有）。死亡结算后、遗言前调用：
 * - 夜晚狼刀死亡（resolveNight）与白天放逐（day-resolution）都会进入这里。
 * - 提交后在 applyRoleDecision 中消耗资源并击杀目标，因此同一死者不会重复生成。
 */
export function getNextShotDecision(state: GameState): PendingDecision | null {
  const deaths = state.publicEvents.filter((event) => event.kind === 'death' && event.day === state.day);
  for (const death of deaths) {
    for (const deadId of death.targetPlayerIds) {
      const eligibility = shotEligibility(state, deadId);
      if (!eligibility) {
        continue;
      }
      const candidates = getAlivePlayerIds(state).filter((playerId) => playerId !== deadId);
      if (candidates.length === 0) {
        return null;
      }
      const isHunter = eligibility.kind === 'hunter-shot';
      const title = isHunter ? '猎人之枪' : '白狼王的獠牙';
      const description = isHunter
        ? '你已死亡。发动猎人之枪，带走一名其他存活者吗？（被毒药或魔女杀手杀害时不能开枪；可选择弃枪）'
        : '你已被放逐。发动白狼王的獠牙，带走一名其他存活者吗？（可选择弃权）';
      return {
        id: `${state.gameId}-decision-${state.day}-${eligibility.kind}-${deadId}`,
        kind: eligibility.kind,
        schemaKey: 'target',
        actorId: deadId,
        title,
        description,
        candidates,
        allowAbstain: true,
        skillInstanceId: null,
        options: {},
      };
    }
  }
  return null;
}
