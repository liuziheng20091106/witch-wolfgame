import loreData from '../data/post-game-lore.json';
import type { CharacterId } from '../domain/model';

interface PostGameLoreData {
  world_context: string[];
  conversation_rules: string[];
  relations: Record<CharacterId, string>;
}

const POST_GAME_LORE: PostGameLoreData = loreData;

export const POST_GAME_GUIDANCE_MARKER = '【赛后复盘专用创作规则（必须遵守）】';

/** 生成只在赛后复盘使用的角色关系背景，避免污染普通对局提示。 */
export function buildPostGameActorContext(characterId: CharacterId): string {
  const relation = POST_GAME_LORE.relations[characterId];
  if (relation === undefined) {
    return `${POST_GAME_GUIDANCE_MARKER}\n当前角色没有额外关系条目，请只依据原始角色设定和对局时间线发言。`;
  }
  return `${POST_GAME_GUIDANCE_MARKER}\n${relation}\n关系背景只用于保持角色一致和友好语气，不得替代对局事实或改变任何游戏决策。`;
}

/** 将世界观、降冲突规则和真实时间线放入已有 postGameContext 字段。 */
export function buildPostGamePromptContext(timelineContext: string): string {
  const world = POST_GAME_LORE.world_context.join('\n');
  const rules = POST_GAME_LORE.conversation_rules.join('\n');
  return `${POST_GAME_GUIDANCE_MARKER}\n${world}\n\n【复盘相处规则】\n${rules}\n\n【已发生的对局时间线】\n${timelineContext}`;
}
