import type {
  GameObservation,
  GameState,
  PendingDecision,
  PlayerId,
  SpeechDecision,
  SubmittedDecision,
  TimelineEvent,
} from '../model';
import { addPublicEvent } from '../engine/events';
import { getName } from '../engine/selectors';

function nameOf(state: GameState, playerId: PlayerId): string {
  return getName(state, playerId);
}

/**
 * 赛后复盘（post-game）：对局结束（ended）后，全员按座位编号 0→5 依次发表赛后发言。
 * - 造物（id 99）不参与赛后发言
 * - 每个发言者可见：① 全量对局发言（含遗言）② 全部私密行动 ③ 前面玩家的赛后发言
 * - 决策复用 kind:'speech' + schemaKey:'speech'，options.postGame = true 标记区分
 */

/** 构造赛后发言决策（无候选、可留空）。 */
function makePostGameDecision(state: GameState, actorId: PlayerId): PendingDecision {
  return {
    id: `${state.gameId}-decision-post-game-${actorId}`,
    kind: 'speech',
    schemaKey: 'speech',
    actorId,
    title: '赛后复盘',
    description: '对局已经结束，真相已经揭晓。请以你真实的身份与视角，复盘这一局的经过，说说你的判断、遗憾或感想（不超过 100 字）。',
    candidates: [],
    allowAbstain: true,
    skillInstanceId: null,
    options: { postGame: true },
  };
}

/**
 * 返回下一个需要赛后发言的玩家决策（按座位顺序，跳过造物 99 与已发言者）。
 * 赛后发言事件以 post-game-speech 记录在公开时间线。
 */
export function getNextPostGameDecision(state: GameState): PendingDecision | null {
  const said = new Set(
    state.publicEvents
      .filter((event) => event.kind === 'post-game-speech')
      .map((event) => event.actorPlayerId)
      .filter((value): value is PlayerId => value != null),
  );

  // 遍历当前玩家列表（按座位或玩家数组顺序），避免硬编码玩家数量
  if (Array.isArray((state as any).players) && (state as any).players.length > 0) {
    for (const p of (state as any).players) {
      const id = p.id as PlayerId;
      if (id === 99 || said.has(id)) {
        continue;
      }
      return makePostGameDecision(state, id);
    }
    return null;
  }

  // 回退兼容：若没有 players 列表，保留原先 0..5 的循环（向后兼容）
  for (let playerId = 0; playerId < 6; playerId += 1) {
    const id = playerId as PlayerId;
    if (id === 99 || said.has(id)) {
      continue;
    }
    return makePostGameDecision(state, id);
  }
  return null;
}

/** 已完成的赛后发言（供 UI/阶段机判断是否全部发完）。 */
export function postGameDone(state: GameState): boolean {
  return getNextPostGameDecision(state) === null;
}

/** 发布赛后发言：写入公开事件（全员可见）。 */
export function applyPostGameSpeech(state: GameState, pending: PendingDecision, decision: SubmittedDecision): void {
  // 基本校验：确保这是一个赛后发言决策
  if (pending.kind !== 'speech' || !pending.options || pending.options.postGame !== true) {
    throw new Error('pending 非赛后发言决策');
  }

  const speechRaw = (decision as SpeechDecision).speech;
  if (typeof speechRaw !== 'string') {
    throw new Error('无效的发言内容');
  }

  // 标准化文本：trim，并把 CRLF 统一为 LF
  const speech = speechRaw.trim().replace(/\r\n?/g, '\n');
  if (speech.length > 100) {
    throw new Error('赛后发言不能超过 100 字');
  }

  // 文本只保留发言内容：UI 已通过 displayAuthorPlayerId 渲染头像与名字，无需在文本中重复。
  // 空发言使用不含作者名的固定占位文本，避免时间线重复显示作者、或被 AI 复盘误认为本人发言。
  const text = speech.length > 0 ? speech : '（没有留下赛后感想）';

  // 目标设为全体玩家以明确“全员可见”语义；若 state.players 不存在则保留空数组
  const allPlayerIds: PlayerId[] = Array.isArray((state as any).players)
    ? (state as any).players.map((p: any) => p.id as PlayerId)
    : [];

  addPublicEvent(state, 'post-game-speech', text, {
    actorPlayerId: pending.actorId,
    targetPlayerIds: allPlayerIds,
    displayAuthorPlayerId: pending.actorId,
    actualAuthorPlayerId: pending.actorId,
  });
}

/**
 * 赛后复盘的时间线摘录（供 AI 提示词使用）：汇总对局内全部公开发言（含遗言）、
 * 全部私密行动、死亡回溯归档的旧时间线，以及前面玩家的赛后发言，拼成一段复盘上下文。
 * 注意：post-game 阶段 observation 已全知（omniscient），私密行动与回溯时间线直接展示（真相已揭晓）。
 */
export function buildPostGameContext(observation: GameObservation): string {
  const lines: string[] = [];
  const dayOf = (event: TimelineEvent): string => {
    const day = (event as any).day;
    return Number.isFinite(day) ? `第 ${day} 天` : '未知日';
  };
  const nameOfId = (playerId: number | null): string => {
    if (playerId === null || playerId === undefined) {
      return '系统';
    }
    const player = observation.players.find((entry) => entry.id === playerId);
    if (player) {
      return player.name;
    }
    return `${playerId}号`;
  };

  // 单条公开事件转一行复盘文本：发言/遗言等带名字与语气前缀，其余事件兜底全量输出。
  // 不使用白名单（避免遗漏 role-exchange / trial-by-fire / factor-recovered 等关键因果事件）。
  const formatPublicEvent = (event: TimelineEvent): string => {
    const text = (event as any).text ?? '';
    if (event.kind === 'speech') {
      return `${dayOf(event)} 发言（${nameOfId(event.actorPlayerId)}）：${text}`;
    }
    if (event.kind === 'last-words') {
      return `${dayOf(event)} 遗言（${nameOfId(event.actorPlayerId)}）：${text}`;
    }
    if (event.kind === 'post-game-speech') {
      return `赛后发言（${nameOfId(event.actorPlayerId)}）：${text}`;
    }
    // 兜底：任何其它公开事件（死亡/投票/放逐/火刑/灵魂交换/因子回收/时间回溯/系统等）均全量输出
    return `${dayOf(event)} ${text}`;
  };

  for (const event of observation.publicEvents) {
    lines.push(formatPublicEvent(event));
  }
  for (const event of observation.privateEvents) {
    const text = (event as any).text ?? '';
    lines.push(`${dayOf(event)} 私密行动：${text}`);
  }
  // 死亡回溯归档的旧时间线：以"被回溯的时间线"区块呈现，作为真实发生过的历史供复盘
  for (const archive of observation.archivedTimelines) {
    lines.push(`【被回溯的时间线 · 回溯于第 ${archive.rewoundAtDay} 天】`);
    for (const event of archive.publicEvents) {
      lines.push(formatPublicEvent(event));
    }
    for (const event of archive.privateEvents) {
      const text = (event as any).text ?? '';
      lines.push(`${dayOf(event)} 私密行动：${text}`);
    }
  }
  // 不做本地截断：赛后复盘必须"全知"（完整时间线 + 私密行动 + 回溯归档），
  // 截断会让小魔女们复盘缺失关键信息。最终防线是契约的 userContentMaxLength（96,000）后端校验。
  return lines.join('\n');
}
