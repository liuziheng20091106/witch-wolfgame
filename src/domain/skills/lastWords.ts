import type {
  GameState,
  PendingDecision,
  PlayerId,
  SpeechDecision,
  SubmittedDecision,
  TimelineEvent,
} from '../model';
import { addPublicEvent } from '../engine/events';
import { getName } from '../engine/selectors';
import { exhaustSkill } from './types';
import { isRestrainedToday } from './speechSkills';

function nameOf(state: GameState, playerId: PlayerId): string {
  return getName(state, playerId);
}

/**
 * 遗言资格判定（经典狼人杀规则 + 本项目魔女技修正）：
 * - 夜晚死亡：只有首夜（day 0）死亡的玩家有遗言；第二夜及之后的夜晚死亡无遗言
 * - 白天死亡：所有白天公投放逐的玩家都有遗言
 * - 特殊：魔女杀手（precise-kill）带走的人无遗言
 * - 特殊：诺亚的造物（id 99）无遗言
 * - 特殊：当天被怪力禁言（speech-restrain）的玩家无遗言
 * - 视线诱导不影响遗言（死者没有视线，遗言不走发言校验）
 */
function canGiveLastWords(state: GameState, playerId: PlayerId, death: TimelineEvent): boolean {
  if (playerId === 99) {
    return false;
  }
  if (isRestrainedToday(state, playerId)) {
    return false;
  }
  let sources: string[] = [];
  if (Array.isArray(death.data.sources)) {
    sources = death.data.sources.filter((value): value is string => typeof value === 'string');
  }
  if (sources.includes('precise-kill')) {
    return false;
  }
  if (sources.length === 0) {
    // 白天放逐：死亡来源为空数组
    return true;
  }
  // 夜晚死亡：仅首夜（day 0）有遗言
  return state.day === 0;
}

/** 构造遗言决策：复用 speech schema（{speech: ≤100 字}），options.lastWords 标记区分。 */
function makeLastWordsDecision(state: GameState, actorId: PlayerId): PendingDecision {
  return {
    id: `${state.gameId}-decision-${state.day}-last-words-${actorId}`,
    kind: 'speech',
    schemaKey: 'speech',
    actorId,
    title: '遗言',
    description: '你已死亡，这是你最后的遗言（不超过 100 字）。遗言将公开展示给所有玩家。',
    candidates: [],
    allowAbstain: true,
    skillInstanceId: null,
    options: { lastWords: true },
  };
}

/**
 * 返回下一个需要发布遗言的死者决策（若本日还有未发遗言的合格死者）。
 * 死亡事件 day === state.day：夜晚死亡发生在当夜，白天放逐发生在当天。
 */
export function getNextLastWordsDecision(state: GameState): PendingDecision | null {
  const deaths = state.publicEvents.filter((event) => event.kind === 'death' && event.day === state.day);
  const said = new Set(
    state.publicEvents
      .filter((event) => event.kind === 'last-words' && event.day === state.day)
      .map((event) => event.actorPlayerId)
      .filter((value): value is PlayerId => value !== null),
  );
  for (const death of deaths) {
    const deadId = death.targetPlayerIds[0];
    if (deadId === undefined || said.has(deadId)) {
      continue;
    }
    if (!canGiveLastWords(state, deadId, death)) {
      continue;
    }
    return makeLastWordsDecision(state, deadId);
  }
  return null;
}

/**
 * 遗言洗脑联动：若遗言发布者持有洗脑（初始持有者为夏目安安，也可经魔女因子回收转移给他人）
 * 且技能未耗尽，遗言中的合法【1~6字】内容视为在遗言中发动洗脑并锁定（死者最后的执念，不受存活限制）。
 * 锁定后标记 lastWordsBrainwash，attachBrainwashSuggestion 会对后续所有决策持续注入。
 * 注意：判定只看"当前持有者"，与角色无关——魔女因子回收转移后，新持有者同样可在遗言中发动洗脑。
 */
function maybeLockBrainwashInLastWords(state: GameState, actorId: PlayerId, speech: string): void {
  const brainwash = state.skillInstances.find(
    (skill) => skill.definitionId === 'brainwash' && skill.ownerPlayerId === actorId && skill.status === 'ready',
  );
  if (!brainwash) {
    return;
  }
  const openCount = (speech.match(/【/g) ?? []).length;
  const closeCount = (speech.match(/】/g) ?? []).length;
  if (openCount !== 1 || closeCount !== 1) {
    return;
  }
  const pairs = speech.match(/【[^【】]*】/g);
  if (!pairs || pairs.length !== 1) {
    return;
  }
  const content = pairs[0].slice(1, -1);
  if (content.length < 1 || content.length > 6) {
    return;
  }
  brainwash.data.activeDay = state.day;
  brainwash.data.brainwashContent = content;
  brainwash.data.lastWordsBrainwash = true;
  exhaustSkill(brainwash);
}

/** 发布遗言：写入公开事件（所有人可见），并联动遗言洗脑。 */
export function applyLastWords(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  const speech = (decision as SpeechDecision).speech.trim();
  if (speech.length > 100) {
    throw new Error('遗言不能超过 100 字');
  }
  let text: string;
  if (speech.length > 0) {
    text = `${nameOf(state, pending.actorId)} 的遗言：${speech}`;
  } else {
    text = `${nameOf(state, pending.actorId)} 没有留下遗言。`;
  }
  addPublicEvent(state, 'last-words', text, {
    actorPlayerId: pending.actorId,
    targetPlayerIds: [pending.actorId],
  });
  if (speech.length > 0) {
    maybeLockBrainwashInLastWords(state, pending.actorId, speech);
  }
}
