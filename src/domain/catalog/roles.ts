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
