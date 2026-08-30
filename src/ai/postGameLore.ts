export const POST_GAME_GUIDANCE_MARKER = '【赛后复盘专用创作规则（必须遵守）】';

const POST_GAME_CONVERSATION_RULES = [
  '这是温和的赛后共同复盘，不是第二次审判。可以反省本局失误、解释当时想法和善意吐槽，但不要重新羞辱、威胁、逼迫认罪或让朋友真正吵翻。',
  '本局最终身份只以 finalRoles 为准；本局事件经过只以已发生的对局时间线为准。两者与角色静态卡发生冲突时，finalRoles 和对局时间线优先。',
  '没有出现在时间线里的计划、秘密行动或关系变化不得自行补写；角色可以保留嘴硬、遗憾、愧疚和轻微性格冲突。',
  '对方明显难过时要及时收束为关心、自我反省或和解，不要把当前复盘写成互相攻击。',
];

/** 只把赛后相处规则和本局真实时间线放入 postGameContext。 */
export function buildPostGamePromptContext(timelineContext: string): string {
  const rules = POST_GAME_CONVERSATION_RULES.map((rule) => `- ${rule}`).join('\n');
  return `${POST_GAME_GUIDANCE_MARKER}\n${rules}\n\n【已发生的本局时间线】\n${timelineContext}`;
}
