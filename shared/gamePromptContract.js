const freeze = Object.freeze;

export const PLAYER_IDS = freeze(/** @type {const} */([0, 1, 2, 3, 4, 5]));

export const CREATURE_ID = 99;
export const GAME_ENTITY_IDS = freeze([...PLAYER_IDS, CREATURE_ID]);

export const POTION_CHOICE_CATALOG = freeze([
 freeze(/** @type {const} */({ playerId: 0, name: '解药' })),
 freeze(/** @type {const} */({ playerId: 1, name: '毒药' })),
]);

/** @param {string} ownerName */
export function formatCreatureName(ownerName) {
 return `${ownerName}的造物`;
}

export const ROLE_CATALOG = freeze([
 freeze(/** @type {const} */({ id: 'wolf', name: '狼人', description: '与狼队协作，每夜选择一名好人袭击。狼人达到好人人数时获胜。', alignment: 'wolf' })),
 freeze(/** @type {const} */({ id: 'seer', name: '预言家', description: '每夜查验一名其他存活者的当前职业。', alignment: 'good' })),
 freeze(/** @type {const} */({ id: 'witch', name: '女巫', description: '拥有一瓶解药与一瓶毒药，每种整局只能使用一次。', alignment: 'good' })),
 freeze(/** @type {const} */({ id: 'villager', name: '村民', description: '依靠公开发言、投票与魔女技找出狼人。', alignment: 'good' })),
]);
export const ROLE_IDS = freeze(ROLE_CATALOG.map((role) => role.id));
export const ALIGNMENTS = freeze(/** @type {const} */(['wolf', 'good']));
export const BOARD_ROLE_POOL = freeze(/** @type {const} */(['wolf', 'wolf', 'seer', 'witch', 'villager', 'villager']));

/** @returns {string} */
function buildBoardDescription() {
 /** @type {Map<(typeof ROLE_IDS)[number], number>} */
 const counts = new Map();
 for (const roleId of BOARD_ROLE_POOL) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
 return `${BOARD_ROLE_POOL.length}人局：${[...counts.entries()].map(([roleId, count]) => {
  const role = ROLE_CATALOG.find((entry) => entry.id === roleId);
  if (!role) throw new Error(`提示词契约缺少职业：${roleId}`);
  return `${role.name}×${count}`;
 }).join('、')}`;
}

export const BOARD_DESCRIPTION = buildBoardDescription();

export const GAME_PHASES = freeze(/** @type {const} */([
 'first-night',
 'night-skills',
 'wolf-suggestions',
 'wolf-decision',
 'witch-action',
 'seer-action',
 'night-protection',
 'night-resolution',
 'dawn',
 'day-skills',
 'speeches',
 'vote-skills',
 'voting',
 'runoff',
 'day-resolution',
 'ended',
 'post-game',
]));

export const DECISION_EXAMPLES = freeze(/** @type {const} */({
 speech: '{"speech":"我会根据公开记录继续判断。"}',
 target: '{"targetPlayerId":2}',
 'optional-target': '{"use":true,"targetPlayerId":2}',
 witch: '{"save":true,"poisonTargetPlayerId":null}',
 'liquid-control': '{"use":true,"mode":"extract","targetPlayerId":2,"factId":null}',
 levitation: '{"use":true,"mode":"move-last","targetPlayerId":2}',
 'voice-mimic': '{"use":true,"targetPlayerId":2,"forgedSpeech":"我暂时相信3号。"}',
 ignition: '{"use":true}',
}));
export const DECISION_SCHEMA_KEYS = freeze(/** @type {Array<keyof typeof DECISION_EXAMPLES>} */(Object.keys(DECISION_EXAMPLES)));
export const DECISION_KIND_SCHEMAS = freeze(/** @type {const} */({
 skill: freeze(/** @type {const} */(['target', 'optional-target', 'liquid-control', 'levitation', 'voice-mimic', 'ignition'])),
 'wolf-suggestion': freeze(/** @type {const} */(['target'])),
 'wolf-decision': freeze(/** @type {const} */(['target'])),
 'witch-action': freeze(/** @type {const} */(['witch'])),
 'seer-action': freeze(/** @type {const} */(['target'])),
 healing: freeze(/** @type {const} */(['target'])),
 speech: freeze(/** @type {const} */(['speech'])),
 vote: freeze(/** @type {const} */(['target'])),
 runoff: freeze(/** @type {const} */(['target'])),
 'tie-break': freeze(/** @type {const} */(['target'])),
}));

export const CHARACTER_CATALOG = freeze([
 freeze(/** @type {const} */({ id: 'soul-0', name: '樱羽艾玛', defaultSkillId: 'witch-killer' })),
 freeze(/** @type {const} */({ id: 'soul-1', name: '二阶堂希罗', defaultSkillId: 'death-rewind' })),
 freeze(/** @type {const} */({ id: 'soul-2', name: '夏目安安', defaultSkillId: 'brainwash' })),
 freeze(/** @type {const} */({ id: 'soul-3', name: '城崎诺亚', defaultSkillId: 'liquid-control' })),
 freeze(/** @type {const} */({ id: 'soul-4', name: '橘雪莉', defaultSkillId: 'speech-restrain' })),
 freeze(/** @type {const} */({ id: 'soul-5', name: '远野汉娜', defaultSkillId: 'levitation' })),
 freeze(/** @type {const} */({ id: 'soul-6', name: '月代雪', defaultSkillId: 'witch-factor-recovery' })),
 freeze(/** @type {const} */({ id: 'soul-7', name: '宝生玛格', defaultSkillId: 'voice-mimic' })),
 freeze(/** @type {const} */({ id: 'soul-8', name: '冰上梅露露', defaultSkillId: 'healing' })),
 freeze(/** @type {const} */({ id: 'soul-9', name: '紫藤亚里沙', defaultSkillId: 'ignition' })),
 freeze(/** @type {const} */({ id: 'soul-10', name: '佐伯米莉亚', defaultSkillId: 'soul-exchange' })),
 freeze(/** @type {const} */({ id: 'soul-11', name: '莲见蕾雅', defaultSkillId: 'gaze-guidance' })),
 freeze(/** @type {const} */({ id: 'soul-12', name: '黑部奈叶香', defaultSkillId: 'mind-reading' })),
 freeze(/** @type {const} */({ id: 'soul-13', name: '泽渡可可', defaultSkillId: 'clairvoyance' })),
]);
export const CHARACTER_IDS = freeze(CHARACTER_CATALOG.map((character) => character.id));

export const WITCH_SKILL_CATALOG = freeze([
 freeze({ id: 'witch-killer', name: '魔女杀手', description: '每局一次，夜间指定一名无法被解药或治愈保护的目标。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
 freeze({ id: 'death-rewind', name: '死亡回溯', description: '首次死亡时回到当日发言前，旧时间线会在赛后完整记录中揭晓。', timings: freeze(/** @type {const} */(['on-death'])), usage: 'passive' }),
 freeze({ id: 'brainwash', name: '洗脑', description: '每天可发动一次：当天发言须含【1~6字】内容，作为强提示词影响其他玩家。', timings: freeze(/** @type {const} */(['before-speech'])), usage: 'once' }),
 freeze({ id: 'liquid-control', name: '操控液体', description: '每局一次，夜间用液体创造自己的造物：造物继承使用者的基础职业与阵营（不继承魔女技），使用者可选择给它解药或毒药。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
 freeze({ id: 'speech-restrain', name: '怪力', description: '使用怪力将一名玩家按在椅子上，使其本轮不能发言。', timings: freeze(/** @type {const} */(['day-start'])), usage: 'once' }),
 freeze({ id: 'levitation', name: '漂浮', description: '每局一次，夜间发动隐藏自己的脚印：直到第二天白天结束，你的行动不留任何可追溯记录，也无法被选中（女巫药、灵魂交换等失效）。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
 freeze({ id: 'healing', name: '治愈', description: '每夜保护一名存活者，移除其所有可防止死亡意图。', timings: freeze(/** @type {const} */(['night-protection'])), usage: 'nightly' }),
 freeze({ id: 'clairvoyance', name: '千里眼', description: '每局一次，白天开启直播：任何选择观看直播的玩家，其职业将被你获知。', timings: freeze(/** @type {const} */(['day-start'])), usage: 'once' }),
 freeze({ id: 'gaze-guidance', name: '视线诱导', description: '每天指定一名被诱导者与一名诱导对象，被诱导者当天发言必须提及诱导对象。', timings: freeze(/** @type {const} */(['day-start'])), usage: 'daily' }),
 freeze({ id: 'soul-exchange', name: '灵魂交换', description: '每局一次，交换自己与另一名存活者的基础职业及职业资源。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
 freeze({ id: 'mind-reading', name: '幻视', description: '每天一次，触碰一名存活者，概率看到其夜间行动轨迹。', timings: freeze(/** @type {const} */(['day-start'])), usage: 'daily' }),
 freeze({ id: 'ignition', name: '点火', description: '每局一次，选择夜间或白天使用：夜间可烧毁目标的物品（90%）或全部魔女技（10%）；白天可烧毁目标的投票（90%）或全部魔女技（10%）。', timings: freeze(/** @type {const} */(['night-start', 'after-vote'])), usage: 'once' }),
 freeze({ id: 'voice-mimic', name: '声音模仿', description: '把一段伪造内容混入本日尚未发言者的公开记录。', timings: freeze(/** @type {const} */(['after-speech'])), usage: 'once' }),
 freeze({ id: 'witch-factor-recovery', name: '魔女因子回收', description: '回收一名死亡者尚未耗尽的实际技能实例。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
]);
export const WITCH_SKILL_IDS = freeze(WITCH_SKILL_CATALOG.map((skill) => skill.id));

export const CHAT_COMPLETIONS_MAX_BODY_BYTES = 128 * 1024;
export const FREE_CLIENT_PROTOCOL = freeze(/** @type {const} */({ name: 'majo-wolf', protocol: 'majo-wolf-free-v1' }));

/**
 * @param {string} version
 * @param {ReadonlyArray<{ role: 'system' | 'user', content: string }>} messages
 */
export function buildFreeClientPayload(version, messages) {
 return { client: { ...FREE_CLIENT_PROTOCOL, version }, messages };
}

export const PROMPT_FIELD_KEYS = freeze({
 payload: freeze(/** @type {const} */(['client', 'messages', 'response_format'])),
 client: freeze(/** @type {const} */(['name', 'version', 'protocol'])),
 message: freeze(/** @type {const} */(['role', 'content'])),
 prompt: freeze(/** @type {const} */(['action', 'actor', 'phase', 'day', 'board', 'alivePlayers', 'legalCandidates', 'allowAbstain', 'options', 'currentDaySpeeches', 'historicalSpeeches', 'recentPublic', 'privateKnowledge', 'publicSkills', 'privateEvents', 'finalRoles', 'postGameContext'])),
 action: freeze(/** @type {const} */(['kind', 'title', 'description', 'schema'])),
 actor: freeze(/** @type {const} */(['playerId', 'name', 'personality', 'speechStyle', 'decisionTraits', 'role', 'skill'])),
 decisionTraits: freeze(/** @type {const} */(['conservative', 'trusting', 'aggressive'])),
 observedPlayer: freeze(/** @type {const} */(['playerId', 'name'])),
 privateKnowledge: freeze(/** @type {const} */(['subjectPlayerId', 'kind', 'value', 'observedDay'])),
 publicSkill: freeze(/** @type {const} */(['playerId', 'name', 'skill'])),
 finalRole: freeze(/** @type {const} */(['playerId', 'name', 'roleId', 'roleName'])),
});

export const PROMPT_LIMITS = freeze(/** @type {const} */({
 messageCount: 2,
 userContentMaxLength: 96_000,
 actionTitleMinLength: 1,
 actionTitleMaxLength: 40,
 actionDescriptionMaxLength: 240,
 actorPersonalityMinLength: 1,
 actorPersonalityMaxLength: 2_000,
 actorSpeechStyleMinLength: 1,
 actorSpeechStyleMaxLength: 2_000,
 actorRoleMaxLength: 240,
 actorSkillMaxLength: 240,
 dayMin: 0,
 dayMax: 100,
 alivePlayersMinItems: 1,
 postGameAlivePlayersMinItems: 0,
 alivePlayersMaxItems: 7,
 finalRolesMinItems: 6,
 finalRolesMaxItems: 7,
 legalCandidatesMaxItems: 7,
 optionsMaxJsonLength: 8_000,
 currentDaySpeechesMaxItems: 6,
 historicalSpeechesMaxItems: 12,
 recentPublicMaxItems: 24,
 privateEventsMaxItems: 12,
 speechMaxLength: 2_000,
 privateKnowledgeMaxItems: 64,
 publicSkillsItems: 6,
}));

export const INVALID_GAME_REQUEST_MESSAGE = '提示词不是当前程序生成的合法游戏请求';

/**
 * @param {keyof typeof DECISION_EXAMPLES} schemaKey
 * @returns {string}
 */
export function buildGameSystemPrompt(schemaKey) {
 if (!Object.hasOwn(DECISION_EXAMPLES, schemaKey)) throw new Error(`未知提示词响应契约：${String(schemaKey)}`);
 let promptHint = ' 性别与称谓边界：本作所有可选角色均为女性。佐伯米莉亚的“大叔我”只是她的自称和纪念，不代表男性身份；称呼其他角色时使用姓名、小姐、亲等女性或中性称谓，不使用“哥”“哥哥”“先生”等男性称谓。除非当前角色卡明确要求，否则不得改变角色性别。';
 if (schemaKey === 'ignition') {
  promptHint += ' 该决策只需回答是否使用（true 或 false），无需选择任何目标。';
 }
 return `你正在进行六人魔女狼人杀。基础职业（狼人/预言家/女巫/村民）与魔女技是两套独立信息：公开的默认魔女技不能用于推断基础职业，基础职业也不决定当前持有的魔女技；角色或技能可能因游戏效果发生变化，请以观察中提供的当前状态为准。胜负规则：好人阵营在全部狼人出局后获胜；狼人阵营在存活狼人不少于存活好人时获胜。actor.personality 是当前角色的静态演绎卡，actor.speechStyle 是同一静态卡的声音指纹；两者只约束稳定性格、关系语气和表达边界，不提供本局身份、阵营、存活、技能或隐藏情报；actor.role、actor.skill、phase、day、board、alivePlayers、legalCandidates、currentDaySpeeches、historicalSpeeches、recentPublic、privateKnowledge、publicSkills、privateEvents 与其他观察字段才是本局事实来源。只能依据提供的观察作决定，不得假设隐藏身份，不得把静态卡或原作旧剧情中的死亡、凶手、证据、关系变化当成本局事实。当前对局默认不继承角色在其他作品时间线中的权能，只有 actor.skill 和本局事件明确授予的效果有效。legalCandidates 是唯一合法目标集合：回答中的任意非 null 玩家目标必须取自其中的 playerId；除非 actor.playerId 明确出现在 legalCandidates 中，否则不得选择自己。allowAbstain 为 false 时不得放弃必选目标。若 options.postGame 为 true，这是温和的赛后复盘：finalRoles 是最终身份唯一来源，postGameContext 中的本局时间线是事件唯一来源，不要新增秘密计划或争吵。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：${DECISION_EXAMPLES[schemaKey]}${promptHint}`;
}

/**
 * @param {(typeof WITCH_SKILL_IDS)[number]} skillId
 * @returns {string}
 */
export function formatPublicSkill(skillId) {
 const skill = WITCH_SKILL_CATALOG.find((entry) => entry.id === skillId);
 if (!skill) throw new Error(`未知魔女技契约：${String(skillId)}`);
 return `${skill.name}：${skill.description}`;
}

/**
 * @param {unknown} kind
 * @param {unknown} schemaKey
 * @returns {boolean}
 */
export function isAllowedDecisionPair(kind, schemaKey) {
 if (typeof kind !== 'string' || typeof schemaKey !== 'string' || !Object.hasOwn(DECISION_KIND_SCHEMAS, kind)) return false;
 const schemas = /** @type {readonly string[]} */ (DECISION_KIND_SCHEMAS[/** @type {keyof typeof DECISION_KIND_SCHEMAS} */ (kind)]);
 return schemas.includes(schemaKey);
}
