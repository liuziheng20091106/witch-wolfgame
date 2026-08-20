import { characterById } from '../domain/catalog/characters';
import { roleDescriptions, roleNames } from '../domain/catalog/roles';
import { defaultSkillByCharacterId, skillUsageHints, witchSkillDefinitions } from '../domain/catalog/witchSkills';
import type { AiDecisionRequest } from './types';

export interface PromptMessage {
  role: 'system' | 'user';
  content: string;
}

const exampleBySchema = {
  speech: '{"speech":"我会根据公开记录继续判断。"}',
  target: '{"targetPlayerId":2}',
  'optional-target': '{"use":true,"targetPlayerId":2}',
  witch: '{"save":true,"poisonTargetPlayerId":null}',
  'liquid-control': '{"use":true,"mode":"extract","targetPlayerId":2,"factId":null}',
  levitation: '{"use":true,"mode":"move-last","targetPlayerId":2}',
  'voice-mimic': '{"use":true,"targetPlayerId":2,"forgedSpeech":"我暂时相信3号。"}',
  ignition: '{"use":true}',
} as const;

export function buildDecisionPrompt(request: AiDecisionRequest): PromptMessage[] {
  const { observation, pendingDecision } = request;
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
  const publicSkills = observation.players.map((player) => {
    const definition = witchSkillDefinitions[defaultSkillByCharacterId[player.characterId]];
    return { playerId: player.id, name: player.name, skill: `${definition.name}：${definition.description}` };
  });
  const visibleRole = actor.roleId ? `${roleNames[actor.roleId]}：${roleDescriptions[actor.roleId]}` : '未公开';
  const visibleSkill = actor.skillId
    ? `${witchSkillDefinitions[actor.skillId].name}：${witchSkillDefinitions[actor.skillId].description}${skillUsageHints[actor.skillId] ?? ''}`
    : '无可见技能';
  const legalCandidates = pendingDecision.candidates.map((playerId) => {
    const player = observation.players.find((entry) => entry.id === playerId);
    return { playerId, name: player?.name ?? `${playerId + 1}号` };
  });

  return [
    {
      role: 'system',
      content: `你正在进行六人魔女狼人杀。基础职业（狼人/预言家/女巫/村民）与魔女技是两套独立信息：公开的默认魔女技不能用于推断基础职业，基础职业也不决定当前持有的魔女技；角色或技能可能因游戏效果发生变化，请以观察中提供的当前状态为准。胜负规则：好人阵营在全部狼人出局后获胜；狼人阵营在存活狼人不少于存活好人时获胜。只能依据提供的观察作决定，不得假设隐藏身份。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：${exampleBySchema[pendingDecision.schemaKey]}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        action: { kind: pendingDecision.kind, title: pendingDecision.title, description: pendingDecision.description, schema: pendingDecision.schemaKey },
        actor: {
          playerId: actor.id,
          name: actor.name,
          personality: character.personality,
          speechStyle: character.speechStyle,
          decisionTraits: character.decisionTraits,
          role: visibleRole,
          skill: visibleSkill,
        },
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
