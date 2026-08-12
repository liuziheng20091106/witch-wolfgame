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
const SYSTEM_TEMPLATE = (schema) => `你正在进行六人魔女狼人杀。只能依据提供的观察作决定，不得假设隐藏身份。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：${EXAMPLE_BY_SCHEMA[schema]}`;
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

export function validateGamePrompt(messages) {
  if (!Array.isArray(messages) || messages.length !== 2) return false;
  const [system, user] = messages;
  if (!isObject(system) || !isObject(user) || system.role !== 'system' || user.role !== 'user') return false;
  if (typeof user.content !== 'string' || user.content.length > 96_000) return false;
  let prompt;
  try { prompt = JSON.parse(user.content); } catch { return false; }
  if (!isObject(prompt) || !isObject(prompt.action) || !isObject(prompt.actor)) return false;
  if (!KIND_SCHEMAS.get(prompt.action.kind)?.has(prompt.action.schema) || !SCHEMAS.has(prompt.action.schema)) return false;
  if (system.content !== SYSTEM_TEMPLATE(prompt.action.schema)) return false;
  if (!hasOnlyKeys(prompt.action, new Set(['kind', 'title', 'description', 'schema']))) return false;
  if (typeof prompt.action.title !== 'string' || prompt.action.title.length < 1 || prompt.action.title.length > 40) return false;
  if (typeof prompt.action.description !== 'string' || prompt.action.description.length > 240) return false;
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
  if (!PHASES.has(prompt.phase) || !Number.isInteger(prompt.day) || prompt.day < 0 || prompt.day > 100) return false;
  if (!Array.isArray(prompt.alivePlayers) || prompt.alivePlayers.length < 1 || prompt.alivePlayers.length > 6 || !prompt.alivePlayers.every(validObservedPlayer)) return false;
  if (new Set(prompt.alivePlayers.map((entry) => entry.playerId)).size !== prompt.alivePlayers.length) return false;
  if (!Array.isArray(prompt.legalCandidates) || prompt.legalCandidates.length > 6 || !prompt.legalCandidates.every(validObservedPlayer)) return false;
  if (new Set(prompt.legalCandidates.map((entry) => entry.playerId)).size !== prompt.legalCandidates.length) return false;
  if (typeof prompt.allowAbstain !== 'boolean' || !isObject(prompt.options) || JSON.stringify(prompt.options).length > 8_000) return false;
  if (!boundedStrings(prompt.currentDaySpeeches, 6, 2_000) || !boundedStrings(prompt.historicalSpeeches, 12, 2_000)) return false;
  if (!boundedStrings(prompt.recentPublic, 24, 2_000) || !boundedStrings(prompt.privateEvents, 12, 2_000)) return false;
  if (!Array.isArray(prompt.privateKnowledge) || prompt.privateKnowledge.length > 64) return false;
  if (!prompt.privateKnowledge.every((fact) => isObject(fact) && validPlayerId(fact.subjectPlayerId)
    && (fact.kind === 'role' || fact.kind === 'alignment') && typeof fact.value === 'string'
    && Number.isInteger(fact.observedDay) && fact.observedDay >= 0 && fact.observedDay <= prompt.day)) return false;
  return true;
}

export function validatePublicPayload(payload, acceptedVersions) {
  if (!isObject(payload) || !isObject(payload.client)) return '缺少客户端协议';
  if (!hasOnlyKeys(payload, new Set(['client', 'messages', 'response_format']))) return '请求包含不允许的字段';
  if (!hasOnlyKeys(payload.client, new Set(['name', 'version', 'protocol']))) return '客户端协议包含不允许的字段';
  if (payload.client.name !== 'majo-wolf' || payload.client.protocol !== 'majo-wolf-free-v1') return '客户端协议不受支持';
  if (!acceptedVersions.has(payload.client.version)) return '客户端版本不受支持';
  if (!isObject(payload.response_format) || Object.keys(payload.response_format).length !== 1 || payload.response_format.type !== 'json_object') return '必须请求 JSON 对象响应';
  return validateGamePrompt(payload.messages) ? null : '提示词不是当前程序生成的合法游戏请求';
}

export function validateProviderResponse(value) {
  if (!isObject(value) || !Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 16) return false;
  const first = value.choices[0];
  if (!isObject(first) || !isObject(first.message) || typeof first.message.content !== 'string' || !first.message.content.trim()) return false;
  try {
    const content = JSON.parse(first.message.content);
    return isObject(content);
  } catch {
    return false;
  }
}
