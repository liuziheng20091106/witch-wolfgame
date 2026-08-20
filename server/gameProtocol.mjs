const EXAMPLE_BY_SCHEMA = {
  speech: '{"speech":"我会根据公开记录继续判断。"}',
  target: '{"targetPlayerId":2}',
  'optional-target': '{"use":true,"targetPlayerId":2}',
  witch: '{"save":true,"poisonTargetPlayerId":null}',
  'liquid-control': '{"use":true,"mode":"extract","targetPlayerId":2,"factId":null}',
  levitation: '{"use":true,"mode":"move-last","targetPlayerId":2}',
  'voice-mimic': '{"use":true,"targetPlayerId":2,"forgedSpeech":"我暂时相信3号。"}',
  ignition: '{"use":true}',
};
const SYSTEM_TEMPLATE = (schema) => `你正在进行六人魔女狼人杀。基础职业（狼人/预言家/女巫/村民）与魔女技是两套独立信息：公开的默认魔女技不能用于推断基础职业，基础职业也不决定当前持有的魔女技；角色或技能可能因游戏效果发生变化，请以观察中提供的当前状态为准。胜负规则：好人阵营在全部狼人出局后获胜；狼人阵营在存活狼人不少于存活好人时获胜。只能依据提供的观察作决定，不得假设隐藏身份。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：${EXAMPLE_BY_SCHEMA[schema]}`;
const KIND_SCHEMAS = new Map([
  ['skill', new Set(['optional-target', 'liquid-control', 'levitation', 'voice-mimic', 'ignition'])],
  ['wolf-suggestion', new Set(['target'])],
  ['wolf-decision', new Set(['target'])],
  ['witch-action', new Set(['witch'])],
  ['seer-action', new Set(['target'])],
  ['healing', new Set(['target'])],
  ['speech', new Set(['speech'])],
  ['vote', new Set(['target'])],
  ['runoff', new Set(['target'])],
  ['tie-break', new Set(['target'])],
]);
const SCHEMAS = new Set(Object.keys(EXAMPLE_BY_SCHEMA));
const PHASES = new Set(['first-night', 'night-skills', 'wolf-suggestions', 'wolf-decision', 'witch-action', 'seer-action', 'night-protection', 'night-resolution', 'dawn', 'day-skills', 'speeches', 'vote-skills', 'voting', 'runoff', 'day-resolution', 'ended']);
const CHARACTER_NAMES = new Set(['樱羽艾玛', '二阶堂希罗', '夏目安安', '城崎诺亚', '橘雪莉', '远野汉娜', '月代雪', '宝生玛格', '冰上梅露露', '紫藤亚里沙', '佐伯米莉亚', '莲见蕾雅', '黑部奈叶香', '泽渡可可']);
const BOARD_DESCRIPTIONS = new Set(['6人局：狼人×2、预言家×1、女巫×1、村民×2']);
const PROMPT_KEYS = new Set(['action', 'actor', 'phase', 'day', 'board', 'alivePlayers', 'legalCandidates', 'allowAbstain', 'options', 'currentDaySpeeches', 'historicalSpeeches', 'recentPublic', 'privateKnowledge', 'publicSkills', 'privateEvents']);
const ACTOR_KEYS = new Set(['playerId', 'name', 'personality', 'speechStyle', 'decisionTraits', 'role', 'skill']);
const PRIVATE_KNOWLEDGE_KEYS = new Set(['subjectPlayerId', 'kind', 'value', 'observedDay']);
const PUBLIC_SKILLS = new Set([
  '魔女杀手：每局一次，夜间指定一名无法被解药或治愈保护的目标。',
  '死亡回溯：首次死亡时回到当日发言前，旧时间线仅观战者可见。',
  '洗脑：发言前指定当天的怀疑焦点。',
  '操控液体：抽取他人职业，或公开一条已知事实。',
  '力气大：指定一人当天无法发言。',
  '漂浮：调整公开投票顺序，或取得二次平票裁决权。',
  '治愈：每夜保护一名存活者，移除其所有可防止死亡意图。',
  '千里眼：有人提及自己时，看穿真实发言者的当前职业。',
  '视线诱导：存活时，其他人的正常与伪造发言必须提及自己。',
  '灵魂交换：每局一次，交换自己与另一名存活者的基础职业及职业资源。',
  '看到内心：每局一次，私下获知一名存活者的当前阵营。',
  '点火：每局一次，公开随机一名其他存活者的阵营。',
  '声音模仿：把一段伪造内容混入本日尚未发言者的公开记录。',
  '魔女因子回收：回收一名死亡者尚未耗尽的实际技能实例。',
]);
const ROLE_VALUES = new Set(['wolf', 'seer', 'witch', 'villager']);
const ALIGNMENT_VALUES = new Set(['wolf', 'good']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedStrings(value, maxItems, maxLength) {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => typeof entry === 'string' && entry.length <= maxLength);
}

function validPlayerId(value) {
  return Number.isInteger(value) && value >= 0 && value <= 5;
}

function validObservedPlayer(value) {
  return isObject(value) && hasOnlyKeys(value, new Set(['playerId', 'name']))
    && validPlayerId(value.playerId) && CHARACTER_NAMES.has(value.name);
}

function validPublicSkill(value) {
  return isObject(value) && hasOnlyKeys(value, new Set(['playerId', 'name', 'skill']))
    && validPlayerId(value.playerId) && CHARACTER_NAMES.has(value.name) && PUBLIC_SKILLS.has(value.skill);
}

export function validateGamePrompt(messages) {
  if (!Array.isArray(messages) || messages.length !== 2) return false;
  const [system, user] = messages;
  if (!isObject(system) || !isObject(user) || system.role !== 'system' || user.role !== 'user') return false;
  if (!hasOnlyKeys(system, new Set(['role', 'content'])) || !hasOnlyKeys(user, new Set(['role', 'content']))) return false;
  if (typeof user.content !== 'string' || user.content.length > 96_000) return false;
  let prompt;
  try { prompt = JSON.parse(user.content); } catch { return false; }
  if (!isObject(prompt) || !hasOnlyKeys(prompt, PROMPT_KEYS) || !isObject(prompt.action) || !isObject(prompt.actor)) return false;
  if (!KIND_SCHEMAS.get(prompt.action.kind)?.has(prompt.action.schema) || !SCHEMAS.has(prompt.action.schema)) return false;
  if (system.content !== SYSTEM_TEMPLATE(prompt.action.schema)) return false;
  if (!hasOnlyKeys(prompt.action, new Set(['kind', 'title', 'description', 'schema']))) return false;
  if (typeof prompt.action.title !== 'string' || prompt.action.title.length < 1 || prompt.action.title.length > 40) return false;
  if (typeof prompt.action.description !== 'string' || prompt.action.description.length > 240) return false;
  if (!hasOnlyKeys(prompt.actor, ACTOR_KEYS)) return false;
  if (!validPlayerId(prompt.actor.playerId) || !CHARACTER_NAMES.has(prompt.actor.name)) return false;
  if (typeof prompt.actor.personality !== 'string' || prompt.actor.personality.length < 1 || prompt.actor.personality.length > 2_000) return false;
  if (typeof prompt.actor.speechStyle !== 'string' || prompt.actor.speechStyle.length < 1 || prompt.actor.speechStyle.length > 2_000) return false;
  const traitKeys = ['conservative', 'trusting', 'aggressive'];
  if (!isObject(prompt.actor.decisionTraits)
    || Object.keys(prompt.actor.decisionTraits).length !== traitKeys.length
    || !hasOnlyKeys(prompt.actor.decisionTraits, new Set(traitKeys))) return false;
  if (!traitKeys.every((key) => typeof prompt.actor.decisionTraits[key] === 'number'
    && Number.isFinite(prompt.actor.decisionTraits[key]) && prompt.actor.decisionTraits[key] >= 0 && prompt.actor.decisionTraits[key] <= 1)) return false;
  if (typeof prompt.actor.role !== 'string' || prompt.actor.role.length > 240 || typeof prompt.actor.skill !== 'string' || prompt.actor.skill.length > 240) return false;
  if (!BOARD_DESCRIPTIONS.has(prompt.board) || !PHASES.has(prompt.phase) || !Number.isInteger(prompt.day) || prompt.day < 0 || prompt.day > 100) return false;
  if (!Array.isArray(prompt.alivePlayers) || prompt.alivePlayers.length < 1 || prompt.alivePlayers.length > 6 || !prompt.alivePlayers.every(validObservedPlayer)) return false;
  if (new Set(prompt.alivePlayers.map((entry) => entry.playerId)).size !== prompt.alivePlayers.length) return false;
  if (!Array.isArray(prompt.legalCandidates) || prompt.legalCandidates.length > 6 || !prompt.legalCandidates.every(validObservedPlayer)) return false;
  if (new Set(prompt.legalCandidates.map((entry) => entry.playerId)).size !== prompt.legalCandidates.length) return false;
  if (typeof prompt.allowAbstain !== 'boolean' || !isObject(prompt.options) || JSON.stringify(prompt.options).length > 8_000) return false;
  if (!boundedStrings(prompt.currentDaySpeeches, 6, 2_000) || !boundedStrings(prompt.historicalSpeeches, 12, 2_000)) return false;
  if (!boundedStrings(prompt.recentPublic, 24, 2_000) || !boundedStrings(prompt.privateEvents, 12, 2_000)) return false;
  if (!Array.isArray(prompt.privateKnowledge) || prompt.privateKnowledge.length > 64) return false;
  if (!prompt.privateKnowledge.every((fact) => isObject(fact) && hasOnlyKeys(fact, PRIVATE_KNOWLEDGE_KEYS)
    && validPlayerId(fact.subjectPlayerId)
    && ((fact.kind === 'role' && ROLE_VALUES.has(fact.value)) || (fact.kind === 'alignment' && ALIGNMENT_VALUES.has(fact.value)))
    && Number.isInteger(fact.observedDay) && fact.observedDay >= 0 && fact.observedDay <= prompt.day)) return false;
  if (!Array.isArray(prompt.publicSkills) || prompt.publicSkills.length !== 6 || !prompt.publicSkills.every(validPublicSkill)) return false;
  if (new Set(prompt.publicSkills.map((skill) => skill.playerId)).size !== prompt.publicSkills.length) return false;
  if (new Set(prompt.publicSkills.map((skill) => skill.name)).size !== prompt.publicSkills.length) return false;
  if (new Set(prompt.publicSkills.map((skill) => skill.skill)).size !== prompt.publicSkills.length) return false;
  return true;
}

export function validatePublicPayload(payload, acceptedVersions) {
  if (!isObject(payload) || !isObject(payload.client)) return '缺少客户端协议';
  if (!hasOnlyKeys(payload, new Set(['client', 'messages', 'response_format']))) return '请求包含不允许的字段';
  if (!hasOnlyKeys(payload.client, new Set(['name', 'version', 'protocol']))) return '客户端协议包含不允许的字段';
  if (payload.client.name !== 'majo-wolf' || payload.client.protocol !== 'majo-wolf-free-v1') return '客户端协议不受支持';
  if (!acceptedVersions.has(payload.client.version)) return '客户端版本不受支持';
  if (payload.response_format !== undefined && (!isObject(payload.response_format) || Object.keys(payload.response_format).length !== 1 || payload.response_format.type !== 'json_object')) return 'response_format 必须是 JSON 对象格式';
  return validateGamePrompt(payload.messages) ? null : '提示词不是当前程序生成的合法游戏请求';
}

export function validateChatCompletionsResponse(value) {
  if (!isObject(value) || !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 16) return false;
  const first = value.choices[0];
  return isObject(first) && isObject(first.message) && typeof first.message.content === 'string' && Boolean(first.message.content.trim());
}

export function validateProviderResponse(value) {
  if (!validateChatCompletionsResponse(value)) return false;
  try {
    const content = JSON.parse(value.choices[0].message.content);
    return isObject(content);
  } catch {
    return false;
  }
}
