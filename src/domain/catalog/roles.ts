import { ROLE_CATALOG } from '../../../shared/gamePromptContract.js';
import type { Alignment, RoleId, RoleResources } from '../model';

export const roleNames = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.name]),
) as Record<RoleId, string>;

export const roleDescriptions = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.description]),
) as Record<RoleId, string>;

export const roleAlignment = Object.fromEntries(
  ROLE_CATALOG.map((role) => [role.id, role.alignment]),
) as Record<RoleId, Alignment>;


/** 按职业初始化资源（女巫药瓶 / 猎人子弹 / 白狼王扳机）。 */
export function initialRoleResources(roleId: RoleId): RoleResources {
  if (roleId === 'witch') return { antidote: 1, poison: 1 };
  if (roleId === 'hunter') return { hunterShot: 1 };
  if (roleId === 'wolf-king') return { wolfKingShot: 1 };
  return {};
}
