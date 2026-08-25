import { ROLE_CATALOG } from '../../../shared/gamePromptContract.js';
import type { Alignment, RoleId } from '../model';

export const roleNames = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.name]),
) as Record<RoleId, string>;

export const roleDescriptions = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.description]),
) as Record<RoleId, string>;

export const roleAlignment = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.alignment]),
) as Record<RoleId, Alignment>;

/** 仅供 AI 决策使用，不改变共享职业规则或 UI 展示。 */
export const roleUsageHints: Partial<Record<RoleId, string>> = {
  wolf: '对局建议：这是一场游戏，请以狼队获胜为目标并与队友协作。不要仅因诚实、正义或避免猜疑而自曝狼人；自曝会让队友孤立无援。只有在能显著提高狼队胜率的明确战术下，才考虑公开身份。',
};
