import {
  ALIGNMENTS,
  BOARD_DESCRIPTION,
  CREATURE_ID,
  buildGameSystemPrompt,
  CHARACTER_CATALOG,
  DECISION_SCHEMA_KEYS,
  FREE_CLIENT_PROTOCOL,
  GAME_ENTITY_IDS,
  GAME_PHASES,
  PLAYER_IDS,
  POTION_CHOICE_CATALOG,
  PROMPT_FIELD_KEYS,
  PROMPT_LIMITS,
  ROLE_IDS,
  WITCH_SKILL_IDS,
  formatPublicSkill,
  formatCreatureName,
  isAllowedDecisionPair,
} from '../shared/gamePromptContract.js';

const SCHEMAS = new Set(DECISION_SCHEMA_KEYS);
const PHASES = new Set(GAME_PHASES);
const CHARACTER_NAMES = new Set(CHARACTER_CATALOG.map((character) => character.name));
const CREATURE_NAMES = new Set(CHARACTER_CATALOG.map((character) => formatCreatureName(character.name)));
const BOARD_DESCRIPTIONS = new Set([BOARD_DESCRIPTION]);
const PUBLIC_SKILLS = new Set(WITCH_SKILL_IDS.map((skillId) => formatPublicSkill(skillId)));
const ROLE_VALUES = new Set(ROLE_IDS);
const ALIGNMENT_VALUES = new Set(ALIGNMENTS);
const PLAYER_ID_VALUES = new Set(PLAYER_IDS);
const ENTITY_ID_VALUES = new Set(GAME_ENTITY_IDS);
const POTION_CHOICE_NAMES = new Map(POTION_CHOICE_CATALOG.map((choice) => [choice.playerId, choice.name]));
const PAYLOAD_KEYS = new Set(PROMPT_FIELD_KEYS.payload);
const CLIENT_KEYS = new Set(PROMPT_FIELD_KEYS.client);
const MESSAGE_KEYS = new Set(PROMPT_FIELD_KEYS.message);
const PROMPT_KEYS = new Set(PROMPT_FIELD_KEYS.prompt);
const ACTION_KEYS = new Set(PROMPT_FIELD_KEYS.action);
const ACTOR_KEYS = new Set(PROMPT_FIELD_KEYS.actor);
const DECISION_TRAIT_KEYS = new Set(PROMPT_FIELD_KEYS.decisionTraits);
const OBSERVED_PLAYER_KEYS = new Set(PROMPT_FIELD_KEYS.observedPlayer);
const PRIVATE_KNOWLEDGE_KEYS = new Set(PROMPT_FIELD_KEYS.privateKnowledge);
const PUBLIC_SKILL_KEYS = new Set(PROMPT_FIELD_KEYS.publicSkill);

function validResult() {
  return { ok: true };
}

function invalidResult(reason, path) {
  return { ok: false, reason, path };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedStrings(value, maxItems, maxLength) {
  return Array.isArray(value) && value.length <= maxItems && value.every((entry) => typeof entry === 'string' && entry.length <= maxLength);
}

function validEntityId(value) {
  return ENTITY_ID_VALUES.has(value);
}

function validEntityName(playerId, name) {
  if (playerId === CREATURE_ID) return CREATURE_NAMES.has(name);
  return PLAYER_ID_VALUES.has(playerId) && CHARACTER_NAMES.has(name);
}

function validObservedPlayer(value) {
  return isObject(value)
    && hasOnlyKeys(value, OBSERVED_PLAYER_KEYS)
    && validEntityId(value.playerId)
    && validEntityName(value.playerId, value.name);
}

function validPotionChoice(value) {
  return isObject(value)
    && hasOnlyKeys(value, OBSERVED_PLAYER_KEYS)
    && POTION_CHOICE_NAMES.get(value.playerId) === value.name;
}

function validPublicSkill(value) {
  return isObject(value)
    && hasOnlyKeys(value, PUBLIC_SKILL_KEYS)
    && PLAYER_ID_VALUES.has(value.playerId)
    && CHARACTER_NAMES.has(value.name)
    && PUBLIC_SKILLS.has(value.skill);
}

export function validateGamePrompt(messages) {
  if (!Array.isArray(messages) || messages.length !== PROMPT_LIMITS.messageCount) {
    return invalidResult('messages_shape', 'messages');
  }
  const [system, user] = messages;
  if (!isObject(system) || !isObject(user)) return invalidResult('messages_shape', 'messages');
  if (system.role !== 'system' || user.role !== 'user') return invalidResult('message_roles', 'messages');
  if (!hasOnlyKeys(system, MESSAGE_KEYS) || !hasOnlyKeys(user, MESSAGE_KEYS)) {
    return invalidResult('message_keys', 'messages');
  }
  if (typeof user.content !== 'string' || user.content.length > PROMPT_LIMITS.userContentMaxLength) {
    return invalidResult('user_content_shape', 'messages[1].content');
  }

  let prompt;
  try {
    prompt = JSON.parse(user.content);
  } catch {
    return invalidResult('user_content_json', 'messages[1].content');
  }
  if (!isObject(prompt)) return invalidResult('prompt_shape', 'prompt');
  if (!hasOnlyKeys(prompt, PROMPT_KEYS)) return invalidResult('prompt_keys', 'prompt');
  if (!isObject(prompt.action) || !hasOnlyKeys(prompt.action, ACTION_KEYS)) {
    return invalidResult('action_shape', 'action');
  }
  if (!SCHEMAS.has(prompt.action.schema) || !isAllowedDecisionPair(prompt.action.kind, prompt.action.schema)) {
    return invalidResult('action_schema', 'action.schema');
  }
  if (system.content !== buildGameSystemPrompt(prompt.action.schema)) {
    return invalidResult('system_template', 'messages[0].content');
  }
  if (typeof prompt.action.title !== 'string'
    || prompt.action.title.length < PROMPT_LIMITS.actionTitleMinLength
    || prompt.action.title.length > PROMPT_LIMITS.actionTitleMaxLength) {
    return invalidResult('action_title', 'action.title');
  }
  if (typeof prompt.action.description !== 'string'
    || prompt.action.description.length > PROMPT_LIMITS.actionDescriptionMaxLength) {
    return invalidResult('action_description', 'action.description');
  }

  if (!isObject(prompt.actor) || !hasOnlyKeys(prompt.actor, ACTOR_KEYS)) {
    return invalidResult('actor_keys', 'actor');
  }
  if (!validEntityId(prompt.actor.playerId) || !validEntityName(prompt.actor.playerId, prompt.actor.name)) {
    return invalidResult('actor_identity', 'actor');
  }
  if (typeof prompt.actor.personality !== 'string'
    || prompt.actor.personality.length < PROMPT_LIMITS.actorPersonalityMinLength
    || prompt.actor.personality.length > PROMPT_LIMITS.actorPersonalityMaxLength) {
    return invalidResult('actor_personality', 'actor.personality');
  }
  if (typeof prompt.actor.speechStyle !== 'string'
    || prompt.actor.speechStyle.length < PROMPT_LIMITS.actorSpeechStyleMinLength
    || prompt.actor.speechStyle.length > PROMPT_LIMITS.actorSpeechStyleMaxLength) {
    return invalidResult('actor_speech_style', 'actor.speechStyle');
  }
  if (!isObject(prompt.actor.decisionTraits)
    || Object.keys(prompt.actor.decisionTraits).length !== DECISION_TRAIT_KEYS.size
    || !hasOnlyKeys(prompt.actor.decisionTraits, DECISION_TRAIT_KEYS)) {
    return invalidResult('decision_traits_shape', 'actor.decisionTraits');
  }
  if (![...DECISION_TRAIT_KEYS].every((key) => typeof prompt.actor.decisionTraits[key] === 'number'
    && Number.isFinite(prompt.actor.decisionTraits[key])
    && prompt.actor.decisionTraits[key] >= 0
    && prompt.actor.decisionTraits[key] <= 1)) {
    return invalidResult('decision_traits_value', 'actor.decisionTraits');
  }
  if (typeof prompt.actor.role !== 'string' || prompt.actor.role.length > PROMPT_LIMITS.actorRoleMaxLength) {
    return invalidResult('actor_role', 'actor.role');
  }
  if (typeof prompt.actor.skill !== 'string' || prompt.actor.skill.length > PROMPT_LIMITS.actorSkillMaxLength) {
    return invalidResult('actor_skill', 'actor.skill');
  }

  if (!BOARD_DESCRIPTIONS.has(prompt.board)) return invalidResult('board', 'board');
  if (!PHASES.has(prompt.phase)) return invalidResult('phase', 'phase');
  if (!Number.isInteger(prompt.day) || prompt.day < PROMPT_LIMITS.dayMin || prompt.day > PROMPT_LIMITS.dayMax) {
    return invalidResult('day', 'day');
  }
  if (!Array.isArray(prompt.alivePlayers)
    || prompt.alivePlayers.length < PROMPT_LIMITS.alivePlayersMinItems
    || prompt.alivePlayers.length > PROMPT_LIMITS.alivePlayersMaxItems
    || !prompt.alivePlayers.every(validObservedPlayer)) {
    return invalidResult('alive_players_shape', 'alivePlayers');
  }
  if (new Set(prompt.alivePlayers.map((entry) => entry.playerId)).size !== prompt.alivePlayers.length) {
    return invalidResult('alive_players_unique', 'alivePlayers.playerId');
  }
  const validLegalCandidate = isObject(prompt.options) && prompt.options.potionChoice === true
    ? validPotionChoice
    : validObservedPlayer;
  if (!Array.isArray(prompt.legalCandidates)
    || prompt.legalCandidates.length > PROMPT_LIMITS.legalCandidatesMaxItems
    || !prompt.legalCandidates.every(validLegalCandidate)) {
    return invalidResult('legal_candidates_shape', 'legalCandidates');
  }
  if (new Set(prompt.legalCandidates.map((entry) => entry.playerId)).size !== prompt.legalCandidates.length) {
    return invalidResult('legal_candidates_unique', 'legalCandidates.playerId');
  }
  if (typeof prompt.allowAbstain !== 'boolean') return invalidResult('allow_abstain', 'allowAbstain');
  if (!isObject(prompt.options)) return invalidResult('options_shape', 'options');
  if (JSON.stringify(prompt.options).length > PROMPT_LIMITS.optionsMaxJsonLength) {
    return invalidResult('options_size', 'options');
  }

  if (!boundedStrings(prompt.currentDaySpeeches, PROMPT_LIMITS.currentDaySpeechesMaxItems, PROMPT_LIMITS.speechMaxLength)) {
    return invalidResult('current_day_speeches', 'currentDaySpeeches');
  }
  if (!boundedStrings(prompt.historicalSpeeches, PROMPT_LIMITS.historicalSpeechesMaxItems, PROMPT_LIMITS.speechMaxLength)) {
    return invalidResult('historical_speeches', 'historicalSpeeches');
  }
  if (!boundedStrings(prompt.recentPublic, PROMPT_LIMITS.recentPublicMaxItems, PROMPT_LIMITS.speechMaxLength)) {
    return invalidResult('recent_public', 'recentPublic');
  }
  if (!boundedStrings(prompt.privateEvents, PROMPT_LIMITS.privateEventsMaxItems, PROMPT_LIMITS.speechMaxLength)) {
    return invalidResult('private_events', 'privateEvents');
  }
  if (!Array.isArray(prompt.privateKnowledge) || prompt.privateKnowledge.length > PROMPT_LIMITS.privateKnowledgeMaxItems) {
    return invalidResult('private_knowledge_shape', 'privateKnowledge');
  }
  if (!prompt.privateKnowledge.every((fact) => isObject(fact)
    && hasOnlyKeys(fact, PRIVATE_KNOWLEDGE_KEYS)
    && validEntityId(fact.subjectPlayerId)
    && ((fact.kind === 'role' && ROLE_VALUES.has(fact.value)) || (fact.kind === 'alignment' && ALIGNMENT_VALUES.has(fact.value)))
    && Number.isInteger(fact.observedDay)
    && fact.observedDay >= PROMPT_LIMITS.dayMin
    && fact.observedDay <= prompt.day)) {
    return invalidResult('private_knowledge_entry', 'privateKnowledge');
  }
  if (!Array.isArray(prompt.publicSkills)
    || prompt.publicSkills.length !== PROMPT_LIMITS.publicSkillsItems
    || !prompt.publicSkills.every(validPublicSkill)) {
    return invalidResult('public_skills_shape', 'publicSkills');
  }
  if (new Set(prompt.publicSkills.map((skill) => skill.playerId)).size !== prompt.publicSkills.length) {
    return invalidResult('public_skills_unique_player', 'publicSkills.playerId');
  }
  if (new Set(prompt.publicSkills.map((skill) => skill.name)).size !== prompt.publicSkills.length) {
    return invalidResult('public_skills_unique_name', 'publicSkills.name');
  }
  if (new Set(prompt.publicSkills.map((skill) => skill.skill)).size !== prompt.publicSkills.length) {
    return invalidResult('public_skills_unique_skill', 'publicSkills.skill');
  }
  return validResult();
}

export function validatePublicPayload(payload, acceptedVersions) {
  if (!isObject(payload)) return invalidResult('payload_shape', 'payload');
  if (!hasOnlyKeys(payload, PAYLOAD_KEYS)) return invalidResult('payload_keys', 'payload');
  if (!isObject(payload.client)) return invalidResult('client_shape', 'client');
  if (!hasOnlyKeys(payload.client, CLIENT_KEYS)) return invalidResult('client_keys', 'client');
  if (payload.client.name !== FREE_CLIENT_PROTOCOL.name || payload.client.protocol !== FREE_CLIENT_PROTOCOL.protocol) {
    return invalidResult('client_identity', 'client');
  }
  if (!acceptedVersions.has(payload.client.version)) return invalidResult('client_version', 'client.version');
  if (payload.response_format !== undefined
    && (!isObject(payload.response_format)
      || Object.keys(payload.response_format).length !== 1
      || payload.response_format.type !== 'json_object')) {
    return invalidResult('response_format', 'response_format');
  }
  return validateGamePrompt(payload.messages);
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
