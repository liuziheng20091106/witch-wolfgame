const freeze = Object.freeze;

export const MIN_PLAYERS = 6;
export const MAX_PLAYERS = 14;
export const PLAYER_IDS = freeze(/** @type {const} */([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));

export const CREATURE_ID = 99;
export const GAME_ENTITY_IDS = freeze([...PLAYER_IDS, CREATURE_ID]);
export const SPEECH_PROMPT_MAX_LENGTH = 80;
export const SPEECH_MAX_LENGTH = 160;
export const VOICE_MIMIC_PROMPT_MAX_LENGTH = 80;
export const VOICE_MIMIC_MAX_LENGTH = 160;
export const WOLF_COUNCIL_PROMPT_MAX_LENGTH = 80;
export const WOLF_COUNCIL_MESSAGE_MAX_LENGTH = 160;
export const COMBINED_SPEECH_MAX_LENGTH = SPEECH_MAX_LENGTH + VOICE_MIMIC_MAX_LENGTH + 1;

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
 freeze(/** @type {const} */({ id: 'guard', name: '守卫', description: '每夜守护一名其他存活者，被守护者当夜免疫狼人袭击；不能连续两夜守护同一人。', alignment: 'good' })),
 freeze(/** @type {const} */({ id: 'hunter', name: '猎人', description: '被狼人袭击死亡或被放逐时，可开枪带走一名其他存活者；被毒药、魔女杀手或其他技能致死时不能开枪。', alignment: 'good' })),
 freeze(/** @type {const} */({ id: 'wolf-king', name: '白狼王', description: '狼队头领。被放逐时，可带走一名其他存活者。', alignment: 'wolf' })),
 freeze(/** @type {const} */({ id: 'hidden-wolf', name: '隐狼', description: '隐匿于好人中的狼。被查验职业时，对方看到的结果是村民；夜里与狼队一同行动。', alignment: 'wolf' })),
 freeze(/** @type {const} */({ id: 'dodo', name: '呆头鹅', description: '中立的迷途者。若她在白天被放逐，将立即独自获胜；被狼人袭击或其他方式死亡、或活到终局，则她失败。', alignment: 'neutral' })),
]);
export const ROLE_IDS = freeze(ROLE_CATALOG.map((role) => role.id));
export const ALIGNMENTS = freeze(/** @type {const} */(['wolf', 'good', 'neutral']));
/**
 * 每档人数固定版型（Issue #95 v2）：
 * - 6/7 人：2 狼；8/11 人狼数对齐经典网杀惯例（8 人 3 狼、11 人 4 狼）；10 人 4 狼局（白狼王入队）。
 * - 守卫仅 9+ 人档（小局双保护拖局）；隐狼仅在 13/14 人档；呆头鹅（中立）仅 9/12 人档试点。
 */
const PLAYER_COUNT_ROLE_POOLS = freeze(/** @type {Record<number, ReadonlyArray<(typeof ROLE_IDS)[number]>>} */({
 6: ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager'],
 7: ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
 8: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
 9: ['wolf', 'wolf', 'wolf', 'seer', 'witch', 'guard', 'villager', 'villager', 'dodo'],
 10: ['wolf', 'wolf', 'wolf', 'wolf-king', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'],
 11: ['wolf', 'wolf', 'wolf', 'wolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager', 'villager'],
 12: ['wolf', 'wolf', 'wolf', 'wolf-king', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager', 'villager', 'dodo'],
 13: ['wolf', 'wolf', 'wolf-king', 'hidden-wolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager', 'villager', 'villager', 'villager'],
 14: ['wolf', 'wolf', 'wolf', 'wolf-king', 'hidden-wolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager', 'villager', 'villager', 'villager'],
}));

/** @param {number} playerCount */
export function rolePoolForPlayerCount(playerCount) {
 if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
  throw new Error(`玩家人数必须在 ${MIN_PLAYERS} 到 ${MAX_PLAYERS} 之间`);
 }
 const pool = PLAYER_COUNT_ROLE_POOLS[playerCount];
 if (!pool) throw new Error(`缺少 ${playerCount} 人版型定义`);
 return freeze([...pool]);
}

/** @param {ReadonlyArray<(typeof ROLE_IDS)[number]>} rolePool */
export function formatBoardDescription(rolePool) {
 const counts = new Map();
 for (const roleId of rolePool) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
 return `${rolePool.length}人局：${[...counts.entries()].map(([roleId, count]) => {
  const role = ROLE_CATALOG.find((entry) => entry.id === roleId);
  if (!role) throw new Error(`提示词契约缺少职业：${roleId}`);
  return `${role.name}×${count}`;
 }).join('、')}`;
}

export const BOARD_ROLE_POOL = rolePoolForPlayerCount(MIN_PLAYERS);
export const BOARD_DESCRIPTION = formatBoardDescription(BOARD_ROLE_POOL);

/** @param {unknown} board */
export function isValidBoardDescription(board) {
 if (typeof board !== 'string') return false;
 for (let playerCount = MIN_PLAYERS; playerCount <= MAX_PLAYERS; playerCount += 1) {
  if (board === formatBoardDescription(rolePoolForPlayerCount(playerCount))) return true;
 }
 return false;
}

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
 'wolf-council': '{"message":"我建议袭击3号。她的公开判断最可能威胁狼队。","recommendedTargetPlayerId":2}',
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
 'wolf-suggestion': freeze(/** @type {const} */(['target', 'wolf-council'])),
 'guard-action': freeze(/** @type {const} */(['target'])),
 'hunter-shot': freeze(/** @type {const} */(['target'])),
 'wolf-king-shot': freeze(/** @type {const} */(['target'])),
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
 freeze({ id: 'liquid-control', name: '操控液体', description: '每局一次，夜间用液体创造诺亚的造物：造物绑定当前主人（初始为诺亚），与主人始终共享同一基础职业与阵营（不继承魔女技），双方明确知道这一身份关系；造物可独立行动但投票跟随主人，使用者可选择给它解药或毒药。', timings: freeze(/** @type {const} */(['night-start'])), usage: 'once' }),
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
 prompt: freeze(/** @type {const} */(['action', 'actor', 'phase', 'day', 'board', 'alivePlayers', 'entityRoster', 'legalCandidates', 'allowAbstain', 'options', 'publicVotes', 'currentDaySpeeches', 'historicalSpeeches', 'recentPublic', 'privateKnowledge', 'publicSkills', 'privateEvents', 'finalRoles', 'postGameContext'])),
 action: freeze(/** @type {const} */(['kind', 'title', 'description', 'schema'])),
 actor: freeze(/** @type {const} */(['playerId', 'name', 'personality', 'speechStyle', 'decisionTraits', 'role', 'skill'])),
 decisionTraits: freeze(/** @type {const} */(['conservative', 'trusting', 'aggressive'])),
 observedPlayer: freeze(/** @type {const} */(['playerId', 'name'])),
 entityRoster: freeze(/** @type {const} */(['playerId', 'name'])),
 publicVote: freeze(/** @type {const} */(['round', 'voterPlayerId', 'targetPlayerId'])),
 privateKnowledge: freeze(/** @type {const} */(['subjectPlayerId', 'kind', 'value', 'observedDay'])),
 publicSkill: freeze(/** @type {const} */(['playerId', 'name', 'skill'])),
 finalRole: freeze(/** @type {const} */(['playerId', 'name', 'roleId', 'roleName'])),
 wolfCouncilMessage: freeze(/** @type {const} */(['speakerPlayerId', 'speakerName', 'message', 'recommendedTargetPlayerId'])),
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
 alivePlayersMaxItems: MAX_PLAYERS + 1,
 entityRosterMinItems: MIN_PLAYERS,
 entityRosterMaxItems: MAX_PLAYERS + 1,
 finalRolesMinItems: MIN_PLAYERS,
 finalRolesMaxItems: MAX_PLAYERS + 1,
 legalCandidatesMaxItems: MAX_PLAYERS + 1,
 optionsMaxJsonLength: 12_000,
 currentDaySpeechesMaxItems: MAX_PLAYERS,
 historicalSpeechesMaxItems: 28,
 recentPublicMaxItems: 32,
 privateEventsMaxItems: 20,
 speechMaxLength: 2_000,
 wolfCouncilMessagesMaxItems: 4,
 wolfCouncilMessageMaxLength: WOLF_COUNCIL_MESSAGE_MAX_LENGTH,
 privateKnowledgeMaxItems: MAX_PLAYERS * MAX_PLAYERS,
 publicSkillsMaxItems: MAX_PLAYERS,
 publicVotesMaxItems: 2 * (MAX_PLAYERS + 1),
}));

if (!Number.isInteger(PROMPT_LIMITS.privateKnowledgeMaxItems) || PROMPT_LIMITS.privateKnowledgeMaxItems < MAX_PLAYERS) throw new Error('私有知识数量限制契约未同步');
if (PROMPT_LIMITS.wolfCouncilMessageMaxLength !== WOLF_COUNCIL_MESSAGE_MAX_LENGTH) throw new Error('狼人议事消息限制契约未同步');
export const INVALID_GAME_REQUEST_MESSAGE = '提示词不是当前程序生成的合法游戏请求';

/**
 * @param {keyof typeof DECISION_EXAMPLES} schemaKey
 * @returns {string}
 */
export function buildGameSystemPrompt(schemaKey) {
 if (!Object.hasOwn(DECISION_EXAMPLES, schemaKey)) throw new Error(`未知提示词响应契约：${String(schemaKey)}`);
 const base = `你是魔女狼人杀（6-14 人）的玩家，按角色人格行动，只依据观察决定，不得假设隐藏身份或继承原作剧情。基础职业（狼人/守卫/猎人/预言家/女巫/村民/白狼王/隐狼/呆头鹅）与魔女技互相独立，均以观察中的当前状态为准。胜负：狼人全部出局则好人胜；存活狼人不少于存活好人则狼胜；呆头鹅（中立）被白天放逐则独自获胜，其他结局她失败。所有角色均为女性，不得改变性别。编号：playerId 从 0 起，座位号=playerId+1；所有列表中的数字均为 playerId，正文引用玩家必须写“座位号+姓名”。隐私：privateEvents 只能按受众标签使用，未列明受众的事实不可用；结论区分“已知/公开声称/推测”。legalCandidates 是唯一合法目标集合，非 null 目标必须取自其中；allowAbstain 为 false 时不得弃权。`;
 let hint = ' 职业要点：狼人不自曝；守卫每夜守护一名其他存活者且不可连守；猎人被狼袭或被放逐可开枪带走一人（被毒/技能致死不可），无把握可弃枪；白狼王被放逐可带走一人；隐狼被查验显示村民；呆头鹅被放逐即独自获胜，狼刀对她有效。';
 if (schemaKey === 'wolf-council') {
  hint += ` 这是仅狼队可见的内部议事。message 不超过 ${WOLF_COUNCIL_PROMPT_MAX_LENGTH} 字，推荐目标须来自 legalCandidates 且与 message 中的人物一致；袭击目标必在队外，理由从威胁收益出发，不得用“她可能是狼”等好人句式。`;
 }
 if (schemaKey === 'speech') {
  hint += ` speech 不超过 ${SPEECH_PROMPT_MAX_LENGTH} 字；先回应针对自己的质疑，再提出一条可验证的新判断；不照抄共识，不用公开技能推断职业；公开场合禁说狼队黑话（袭击/刀/狼队记录/队友），只用白天语言（怀疑/查验/放逐）。`;
 }
 if (schemaKey === 'witch') {
  hint += ' 优先保留药水；无可靠毒杀依据时 poisonTargetPlayerId 应为 null。';
 }
 if (schemaKey === 'optional-target') {
  hint += ' 只有行动能产生明确阵营收益时才发动，否则 use:false、targetPlayerId:null。';
 }
 if (schemaKey === 'ignition') {
  hint += ' 该决策只需回答是否使用，无需选择目标。';
 }
 return `仅返回一个 JSON 对象，不要 Markdown，不要解释。响应格式示例：${DECISION_EXAMPLES[schemaKey]}${base}${hint}`;
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
