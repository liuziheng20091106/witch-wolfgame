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

/** 仅供 AI 决策使用，不改变共享职业规则或 UI 展示。 */
export const roleUsageHints: Partial<Record<RoleId, string>> = {
  wolf: '对局建议：这是一场游戏，请以狼队获胜为目标并与队友协作。不要仅因诚实、正义或避免猜疑而自曝狼人；自曝会让队友孤立无援。只有在能显著提高狼队胜率的明确战术下，才考虑公开身份。',
  guard: '对局建议：每夜选择一名其他存活者守护（不能连续两夜守护同一人）。优先守护你认为狼队最可能袭击的高价值目标（疑似神职或信息核心）。',
  hunter: '对局建议：被狼人袭击死亡或被放逐时可以开枪带走一名玩家（被毒药或技能杀死不能开枪）。枪是威慑也是输出：除非有高确信目标，否则可弃枪保留悬念。',
  'wolf-king': '对局建议：被放逐时可以带走一名玩家，这是对好人冲票的威慑。若必被放逐，带走你最确信的神职；平时利用威慑让好人不敢轻易放逐你。',
  'hidden-wolf': '对局建议：你是伪装成村民的狼——预言家/千里眼查验你时看到的结果是村民。与狼队一起行动，白天像普通村民一样发言投票，避免过度维护狼队友或从不投票狼队友而暴露关联。',
  dodo: '对局建议：你是中立的呆头鹅，唯一胜利条件是白天被放逐。可选风格：搅局资产（带偏好人的推理和票，同时让狼队觉得留着你有价值）、假神对跳（跳预言家制造混乱引票）、边缘排水（低存在感摇摆，做最可疑的边缘人）。你没有任何夜间自保手段，狼刀对你有效；被预言家验出后你将无法再被放逐。',
};

/** 按职业初始化资源（女巫药瓶 / 猎人子弹 / 白狼王扳机）。 */
export function initialRoleResources(roleId: RoleId): RoleResources {
  if (roleId === 'witch') return { antidote: 1, poison: 1 };
  if (roleId === 'hunter') return { hunterShot: 1 };
  if (roleId === 'wolf-king') return { wolfKingShot: 1 };
  return {};
}
