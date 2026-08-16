import { characterById } from '../domain/catalog/characters';
import { roleDescriptions, roleNames } from '../domain/catalog/roles';
import { witchSkillDefinitions } from '../domain/catalog/witchSkills';
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
  const currentDaySpeeches = observation.publicEvents
    .filter((event) => event.kind === 'speech' && event.day === observation.day)
    .map((event) => event.text);
  const historicalSpeeches = observation.publicEvents
    .filter((event) => event.kind === 'speech' && event.day < observation.day)
    .slice(-12)
    .map((event) => event.text);
  const recentPublic = observation.publicEvents.slice(-24).map((event) => event.text);
  const privateKnowledge = observation.knowledge
    .filter((fact) => fact.kind === 'role' || fact.kind === 'alignment')
    .map((fact) => ({
      subjectPlayerId: fact.subjectPlayerId,
      kind: fact.kind,
      value: fact.value,
      observedDay: fact.observedDay,
    }));
  const publicSkills = observation.players.flatMap((player) => {
    if (player.skillId === null) return [];
    return [{ playerId: player.id, name: player.name, skill: `${witchSkillDefinitions[player.skillId].name}：${witchSkillDefinitions[player.skillId].description}` }];
  });
  const visibleRole = actor.roleId ? `${roleNames[actor.roleId]}：${roleDescriptions[actor.roleId]}` : '未公开';
  const visibleSkill = actor.skillId ? `${witchSkillDefinitions[actor.skillId].name}：${witchSkillDefinitions[actor.skillId].description}` : '无可见技能';
  const legalCandidates = pendingDecision.candidates.map((playerId) => {
    const player = observation.players.find((entry) => entry.id === playerId);
    return { playerId, name: player?.name ?? `${playerId + 1}号` };
  });

  return [
    {
      role: 'system',
      content: `你正在进行六人魔女狼人杀。只能依据提供的观察作决定，不得假设隐藏身份。只返回一个 JSON 对象，不要 Markdown、解释或思考过程。JSON 示例：${exampleBySchema[pendingDecision.schemaKey]}`,
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
