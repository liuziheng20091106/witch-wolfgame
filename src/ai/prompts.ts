import {
  CHAT_COMPLETIONS_MAX_BODY_BYTES,
  CREATURE_ID,
  POTION_CHOICE_CATALOG,
  PROMPT_LIMITS,
  buildFreeClientPayload,
  buildGameSystemPrompt,
  formatPublicSkill,
  isAllowedDecisionPair,
} from '../../shared/gamePromptContract.js';
import { characterById } from '../domain/catalog/characters';
import { roleDescriptions, roleNames } from '../domain/catalog/roles';
import { defaultSkillByCharacterId, skillUsageHints, witchSkillDefinitions } from '../domain/catalog/witchSkills';
import { buildPostGameContext } from '../domain/skills/postGame';
import { APP_VERSION } from '../config/version';
import { buildRoleplayPersonality, buildRoleplaySpeechStyle } from './roleplayLore';
import { buildPostGamePromptContext } from './postGameLore';
import type { CharacterId, PendingDecisionKind } from '../domain/model';
import type { AiDecisionRequest, AiProviderKind } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

const CREATURE_PERSONALITY = '你是诺亚用魔法创造出来的造物，你拥有和她一样的基础身份和阵营，但不拥有她的魔法。除了每天的投票权（跟随诺亚）以外，你的所有行动可以独立决策；如果你想制造混乱，也可以用毒药毒死主人（但这对你并没有好处）。';
const POST_GAME_TRUNCATION_MARKER = '\n【赛后复盘上下文过长，已保留开头和结尾；省略部分不代表没有发生】\n';
const UTF8_ENCODER = new TextEncoder();

/**
 * 在保留复盘开头、结尾的前提下做确定性截断。
 * maxLength 是最终字符串长度预算，不包含任何额外包装。
 */
function truncatePostGameContext(context: string, maxLength: number): string {
  if (context.length <= maxLength) return context;
  if (maxLength <= 0) return '';
  if (maxLength <= POST_GAME_TRUNCATION_MARKER.length) {
    return POST_GAME_TRUNCATION_MARKER.slice(0, maxLength);
  }
  const contentLength = maxLength - POST_GAME_TRUNCATION_MARKER.length;
  const headLength = Math.ceil(contentLength / 2);
  const tailLength = contentLength - headLength;
  let tail = '';
  if (tailLength > 0) {
    tail = context.slice(-tailLength);
  }
  return `${context.slice(0, headLength)}${POST_GAME_TRUNCATION_MARKER}${tail}`;
}

/**
 * 将赛后上下文放入完整 user JSON 后再计算长度；免费服务还会计算客户端实际发送的完整 UTF-8 body。
 */
function fitPostGameContext(
  promptPayload: Record<string, unknown>,
  timelineContext: string,
  provider: AiProviderKind,
  systemContent: string,
): string {
  const serializeUserContent = (candidateTimeline: string): string => JSON.stringify({
    ...promptPayload,
    postGameContext: buildPostGamePromptContext(candidateTimeline),
  });
  const fitsCandidate = (candidateTimeline: string): boolean => {
    const userContent = serializeUserContent(candidateTimeline);
    if (userContent.length > PROMPT_LIMITS.userContentMaxLength) return false;
    if (provider !== 'free') return true;
    const body = JSON.stringify(buildFreeClientPayload(APP_VERSION, [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent },
    ]));
    return UTF8_ENCODER.encode(body).byteLength <= CHAT_COMPLETIONS_MAX_BODY_BYTES;
  };
  if (fitsCandidate(timelineContext)) return buildPostGamePromptContext(timelineContext);
  if (!fitsCandidate('')) {
    throw new Error('赛后复盘提示词的基础内容已超过提供方限制');
  }

  // 二分查找可放入完整请求的最大上下文长度，结果与事件顺序完全确定。
  let low = 0;
  let high = timelineContext.length;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncatePostGameContext(timelineContext, middle);
    if (fitsCandidate(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best.length === 0 && timelineContext.length > 0) {
    throw new Error('赛后复盘上下文无法压缩到提供方限制内');
  }
  return buildPostGamePromptContext(best);
}

/** 组装 actor 负载：造物（id=99）使用专属提示词，其余角色使用紧凑静态卡。 */
function buildActorPayload(
  actor: { id: number; name: string },
  character: { id: CharacterId; decisionTraits: { conservative: number; trusting: number; aggressive: number } },
  visibleRole: string,
  visibleSkill: string,
  decisionKind: PendingDecisionKind,
  isPostGame: boolean,
) {
  if (actor.id === CREATURE_ID) {
    return {
      playerId: actor.id,
      name: actor.name,
      personality: CREATURE_PERSONALITY,
      speechStyle: '你不说话，只默默行动。',
      decisionTraits: { conservative: 0.4, trusting: 0.3, aggressive: 0.5 },
      role: visibleRole,
      skill: '无可见技能',
    };
  }
  // 诺亚（操控液体持有者）作为预言家时：提示她拥有自己与造物的双重查验结果
  let personality = buildRoleplayPersonality(character.id, decisionKind, isPostGame);
  if (visibleRole.includes('预言家') && visibleSkill.includes('操控液体')) {
    personality = `${personality}你作为预言家，拥有自己和造物的查验结果，请善加利用这两条情报。`;
  }
  return {
    playerId: actor.id,
    name: actor.name,
    personality,
    speechStyle: buildRoleplaySpeechStyle(character.id),
    decisionTraits: character.decisionTraits,
    role: visibleRole,
    skill: visibleSkill,
  };
}


export function buildDecisionPrompt(request: AiDecisionRequest, provider: AiProviderKind = 'custom'): PromptMessage[] {
  const { observation, pendingDecision } = request;
  if (!isAllowedDecisionPair(pendingDecision.kind, pendingDecision.schemaKey)) {
    throw new Error('当前决策不属于受支持的提示词契约');
  }
  const actor = observation.players.find((player) => player.id === pendingDecision.actorId);
  if (!actor) {
    throw new Error('观察视图缺少当前行动者');
  }
  const character = characterById[actor.characterId];
  // 发言来源映射：每条发言必须标注"是谁说的"，否则 AI 只能靠内容猜发言者（曾导致把甲的发言安到乙头上）。
  const nameById = new Map<number, string>(observation.players.map((player) => [player.id, player.name]));
  const speechWithAuthor = (event: { displayAuthorPlayerId: number | null; actorPlayerId: number | null; text: string }): string => {
    const authorId = event.displayAuthorPlayerId ?? event.actorPlayerId;
    let authorName = '未知';
    if (authorId !== null && authorId !== undefined) {
      const known = nameById.get(authorId);
      if (known !== undefined) {
        authorName = known;
      } else {
        authorName = `${authorId + 1}号`;
      }
    }
    return `发言来源：${authorName}。发言内容：${event.text}`;
  };
  const currentDaySpeeches = observation.publicEvents
    .filter((event) => event.kind === 'speech' && event.day === observation.day)
    .map(speechWithAuthor);
  const historicalSpeeches = observation.publicEvents
    .filter((event) => event.kind === 'speech' && event.day < observation.day)
    .slice(-12)
    .map(speechWithAuthor);
  const recentPublic = observation.publicEvents.slice(-24).map((event) => {
    if (event.kind === 'speech') {
      return speechWithAuthor(event);
    }
    return event.text;
  });
  const privateKnowledge = observation.knowledge
    .filter((fact) => fact.kind === 'role' || fact.kind === 'alignment')
    .map((fact) => ({
      subjectPlayerId: fact.subjectPlayerId,
      kind: fact.kind,
      value: fact.value,
      observedDay: fact.observedDay,
    }));
  // 公开技能按角色默认技生成：与开局公开播报一致，始终恰好 6 项且唯一；
  // 魔女因子回收等技能转移通过公开事件（factor-recovered）向 AI 呈现。
  const publicSkills = observation.players
    .filter((player) => player.id !== CREATURE_ID)
    .map((player) => ({
      playerId: player.id,
      name: player.name,
      skill: formatPublicSkill(defaultSkillByCharacterId[player.characterId]),
    }));
  const visibleRole = actor.roleId ? `${roleNames[actor.roleId]}：${roleDescriptions[actor.roleId]}` : '未公开';
  const visibleSkill = actor.skillId
    ? `${witchSkillDefinitions[actor.skillId].name}：${witchSkillDefinitions[actor.skillId].description}${skillUsageHints[actor.skillId] ?? ''}`
    : '无可见技能';
  const legalCandidates = pendingDecision.candidates.map((playerId) => {
    if (pendingDecision.options.potionChoice === true) {
      const potion = POTION_CHOICE_CATALOG.find((choice) => choice.playerId === playerId);
      if (!potion) throw new Error(`未知药水候选：${playerId}`);
      return { playerId, name: potion.name };
    }
    const player = observation.players.find((entry) => entry.id === playerId);
    const name = player?.name ?? `${playerId + 1}号`;
    return { playerId, name };
  });
  const systemContent = buildGameSystemPrompt(pendingDecision.schemaKey);

  const promptPayload: Record<string, unknown> = {
    action: { kind: pendingDecision.kind, title: pendingDecision.title, description: pendingDecision.description, schema: pendingDecision.schemaKey },
    actor: buildActorPayload(
      actor,
      character,
      visibleRole,
      visibleSkill,
      pendingDecision.kind,
      pendingDecision.options.postGame === true,
    ),
    phase: observation.phase,
    day: observation.day,
    board: observation.board,
    alivePlayers: observation.players.filter((player) => player.alive).map((player) => ({ playerId: player.id, name: player.name })),
    legalCandidates,
    allowAbstain: pendingDecision.allowAbstain,
    options: pendingDecision.options,
    currentDaySpeeches,
    historicalSpeeches,
    recentPublic,
    privateKnowledge,
    publicSkills,
    privateEvents: observation.privateEvents.slice(-12).map((event) => event.text),
  };
  if (pendingDecision.options.postGame === true) {
    promptPayload.finalRoles = observation.players.map((player) => {
      if (player.roleId === null) throw new Error('赛后全知观察缺少最终职业');
      return { playerId: player.id, name: player.name, roleId: player.roleId, roleName: roleNames[player.roleId] };
    });
    // 赛后复盘：额外提供全量对局时间线；超出当前提供方限制时确定性保留首尾。
    promptPayload.postGameContext = fitPostGameContext(promptPayload, buildPostGameContext(observation), provider, systemContent);
  }

  return [
    {
      role: 'system',
      content: systemContent,
    },
    {
      role: 'user',
      content: JSON.stringify(promptPayload),
    },
  ];
}
