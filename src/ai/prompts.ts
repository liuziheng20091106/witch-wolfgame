import { buildGameSystemPrompt, formatPublicSkill, isAllowedDecisionPair } from '../../shared/gamePromptContract.js';
import { characterById } from '../domain/catalog/characters';
import { roleDescriptions, roleNames } from '../domain/catalog/roles';
import { defaultSkillByCharacterId, skillUsageHints, witchSkillDefinitions } from '../domain/catalog/witchSkills';
import type { AiDecisionRequest } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

const CREATURE_PERSONALITY = '你是诺亚用魔法创造出来的造物，你拥有和她一样的基础身份和阵营，但不拥有她的魔法。除了每天的投票权（跟随诺亚）以外，你的所有行动可以独立决策；如果你想制造混乱，也可以用毒药毒死主人（但这对你并没有好处）。';

/** 组装 actor 负载：造物（id=99）使用专属提示词，否则用角色原始数据。 */
function buildActorPayload(actor: { id: number; name: string }, character: { personality: string; speechStyle: string; decisionTraits: { conservative: number; trusting: number; aggressive: number } }, visibleRole: string, visibleSkill: string) {
  if (actor.id === 99) {
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
  let personality = character.personality;
  if (visibleRole.includes('预言家') && visibleSkill.includes('操控液体')) {
    personality = `${personality}你作为预言家，拥有自己和造物的查验结果，请善加利用这两条情报。`;
  }
  return {
    playerId: actor.id,
    name: actor.name,
    personality,
    speechStyle: character.speechStyle,
    decisionTraits: character.decisionTraits,
    role: visibleRole,
    skill: visibleSkill,
  };
}


export function buildDecisionPrompt(request: AiDecisionRequest): PromptMessage[] {
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
  const publicSkills = observation.players.map((player) => ({
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
      // 药选择：candidates 是药索引（0=解药 1=毒药），不是玩家 id
      return { playerId, name: playerId === 0 ? '解药' : '毒药' };
    }
    const player = observation.players.find((entry) => entry.id === playerId);
    return { playerId, name: player?.name ?? `${playerId + 1}号` };
  });

  return [
    {
      role: 'system',
      content: buildGameSystemPrompt(pendingDecision.schemaKey),
    },
    {
      role: 'user',
      content: JSON.stringify({
        action: { kind: pendingDecision.kind, title: pendingDecision.title, description: pendingDecision.description, schema: pendingDecision.schemaKey },
        actor: buildActorPayload(actor, character, visibleRole, visibleSkill),
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
      }),
    },
  ];
}
