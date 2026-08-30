import { Archive, Bot, ChevronDown, Copy, Gavel, Info, List, LoaderCircle, RotateCcw, ScrollText, Sparkles, Users, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiCommandError } from '../../ai/types';
import { copyTextToClipboard } from '../../app/clipboard';
import { roleDescriptions, roleNames } from '../../domain/catalog/roles';
import { witchSkillDefinitions } from '../../domain/catalog/witchSkills';
import { isCreatureId } from '../../domain/engine/selectors';
import type { GameObservation, PlayerId, SubmittedDecision } from '../../domain/model';
import brandMark from '../../assets/icon.ico';
import { DecisionPanel } from './DecisionPanel';
import { GameControls } from './GameControls';
import { PlayerRoster } from './PlayerRoster';
import { Transcript } from './Transcript';
import styles from './GameView.module.css';

interface GameViewProps {
  observation: GameObservation;
  aiError: AiCommandError | null;
  awaitingRetry: boolean;
  thinking: boolean;
  decisionError: string | null;
  paused: boolean;
  onSubmit(decision: SubmittedDecision): void;
  onRetry(): void;
  onLocal(): void;
  onSettings(): void;
  onPaused(paused: boolean): void;
  onRestart(): void;
  onExit(): void;
}

const phaseNames: Record<GameObservation['phase'], string> = {
  'first-night': '首夜', 'night-skills': '夜间·魔女们正在行动', 'wolf-suggestions': '狼人正在密议...', 'wolf-decision': '狼人正在准备袭击...',
  'witch-action': '女巫正在行动...', 'seer-action': '预言家正在行动...', 'night-protection': '选择夜间保护...', 'night-resolution': '正在结算夜间行动...',
  dawn: '黎明', 'day-skills': '白天·魔女们正在行动', speeches: '魔女们正在发言', 'vote-skills': '即将投票...', voting: '正在投票...',
  runoff: '平票？重投！', 'day-resolution': '正在结算白天行动...', ended: '审判结束', 'post-game': '赛后复盘',
};

type MobileTab = 'live' | 'players' | 'history';

function automationStatus(observation: GameObservation): string {
  const pending = observation.pendingDecision;
  if (pending !== null) {
    if (pending.kind === 'wolf-decision') {
      return '狼队正在决定袭击目标';
    }
    const actor = observation.players.find((player) => player.id === pending.actorId);
    let actorName = `${pending.actorId + 1}号`;
    if (actor !== undefined) {
      actorName = actor.name;
    }
    return `${actorName} 正在${pending.title}`;
  }
  if (observation.result !== null) {
    return '审判已结束';
  }
  return '审判正在推进';
}

function automationModeLabel(observation: GameObservation): string {
  if (observation.automationMode === 'local') {
    return 'LOCAL STRATEGY';
  }
  return 'AI AUTOMATION';
}

function HistoryBody({ observation }: { observation: GameObservation }) {
  const empty = observation.privateEvents.length === 0 && observation.archivedTimelines.length === 0;
  return <div className={styles.historyBody}>
    <h3>私密行动</h3>
    {observation.privateEvents.map((event) => <p key={event.id}>{event.text}</p>)}
    {observation.archivedTimelines.map((archive) => <div key={archive.id} className={styles.archive}>
      <h3>被回溯时间线 · 第 {archive.rewoundAtDay} 天</h3>
      {archive.publicEvents.map((event) => <p key={event.id}>{event.text}</p>)}
      {archive.privateEvents.length > 0 && <><h4>私密行动</h4>{archive.privateEvents.map((event) => <p key={event.id}>{event.text}</p>)}</>}
    </div>)}
    {empty && <p>暂无额外记录。</p>}
  </div>;
}

export function GameView(props: GameViewProps) {
  const { observation } = props;
  const [mobileTab, setMobileTab] = useState<MobileTab>('live');
  const [followingLatestMessage, setFollowingLatestMessage] = useState(true);
  const [selectedPlayerId, setSelectedPlayerId] = useState<PlayerId | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [seedCopyStatus, setSeedCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [resultFaded, setResultFaded] = useState(false);
  const [resultDismissed, setResultDismissed] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const gameRef = useRef<HTMLElement>(null);
  const sidePaneRef = useRef<HTMLElement>(null);
  const selectedPlayer = selectedPlayerId === null ? null : observation.players.find((player) => player.id === selectedPlayerId) ?? null;
  let selectedSeatLabel: string | null = null;
  if (selectedPlayer) selectedSeatLabel = isCreatureId(selectedPlayer.id) ? '造物' : `${selectedPlayer.id + 1}号席位`;
  let activeActorId = observation.pendingDecision?.actorId ?? null;
  if (observation.pendingDecision?.kind === 'wolf-decision') {
    activeActorId = null;
  }
  const recentPrivateEvents = observation.privateEvents.slice(-10).reverse();
  const hasResult = observation.result !== null;
  const humanDecisionPending = observation.pendingDecision?.actorId === observation.viewerPlayerId;
  const decisionPanelVisible = humanDecisionPending || props.aiError !== null || props.awaitingRetry;
  const canAutoHide = mobileTab === 'live' && followingLatestMessage && !decisionPanelVisible && !hasResult;
  const copySeed = async () => {
    try {
      await copyTextToClipboard(String(observation.seed));
      setSeedCopyStatus('copied');
    } catch {
      setSeedCopyStatus('failed');
    }
    window.setTimeout(() => setSeedCopyStatus('idle'), 1500);
  };
  const revealMobileChrome = () => {
    setMobileChromeHidden(false);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    if (canAutoHide) hideTimerRef.current = window.setTimeout(() => setMobileChromeHidden(true), 4000);
  };
  useEffect(() => {
    if (!canAutoHide) { setMobileChromeHidden(false); return; }
    revealMobileChrome();
    return () => { if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current); };
  }, [canAutoHide]);
  useEffect(() => {
    if (!hasResult) { setResultFaded(false); setResultDismissed(false); return; }
    setResultFaded(false);
    const timer = window.setTimeout(() => setResultFaded(true), 4000);
    return () => window.clearTimeout(timer);
  }, [hasResult]);
  useLayoutEffect(() => {
    const game = gameRef.current;
    const sidePane = sidePaneRef.current;
    if (!decisionPanelVisible || !game || !sidePane) return;
    const updateHeight = () => {
      game.style.setProperty('--mobile-action-overlay-height', `${Math.ceil(sidePane.getBoundingClientRect().height)}px`);
    };
    updateHeight();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateHeight);
    observer?.observe(sidePane);
    return () => {
      observer?.disconnect();
      game.style.removeProperty('--mobile-action-overlay-height');
    };
  }, [decisionPanelVisible]);
  const handleTouchStart = (event: React.TouchEvent<HTMLElement>) => { touchStartYRef.current = event.touches[0]?.clientY ?? null; };
  const handleTouchEnd = (event: React.TouchEvent<HTMLElement>) => {
    const startY = touchStartYRef.current;
    const endY = event.changedTouches[0]?.clientY ?? startY ?? 0;
    touchStartYRef.current = null;
    if (startY !== null && startY - endY > 42 && canAutoHide) {
      if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
      setMobileChromeHidden(true);
    } else if (startY !== null && endY - startY > 42) {
      revealMobileChrome();
    }
  };
  const chromeClass = mobileChromeHidden ? styles.mobileChromeHidden : '';

  return <main ref={gameRef} className={`${styles.game} ${mobileChromeHidden ? styles.gameChromeHidden : ''} ${decisionPanelVisible ? styles.decisionPanelVisible : ''}`}>
    <header className={`${styles.topbar} ${chromeClass}`}>
      <div className={styles.brand}><img src={brandMark} alt="魔女狼人杀" /></div>
      <div className={styles.phase}><small>{observation.day === 0 ? 'FIRST NIGHT' : `DAY ${String(observation.day).padStart(2, '0')}`}</small><strong>{phaseNames[observation.phase]}</strong></div>
      <div className={styles.seedDisplay}><span>{seedCopyStatus === 'copied' ? '已复制' : seedCopyStatus === 'failed' ? '复制失败' : `种子 ${observation.seed}`}</span><button type="button" title="复制本局种子" aria-label={seedCopyStatus === 'failed' ? '复制本局种子失败' : '复制本局种子'} onClick={() => { void copySeed(); }}><Copy /></button></div>
    </header>
    <nav className={`${styles.mobileTabs} ${chromeClass}`} aria-label="游戏视图">
      <button type="button" className={mobileTab === 'live' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('live'); }}><ScrollText />发言</button>
      <button type="button" className={mobileTab === 'players' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('players'); }}><Users />角色</button>
      <button type="button" className={mobileTab === 'history' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('history'); }}><List />观察</button>
    </nav>
    <div className={styles.workspace} data-mobile-tab={mobileTab} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className={`${styles.rosterPane} ${chromeClass}`}><PlayerRoster observation={observation} currentActorId={activeActorId} onSelect={setSelectedPlayerId} /></div>
      <div className={styles.livePane}><Transcript observation={observation} phaseLabel={phaseNames[observation.phase]} onFollowingChange={setFollowingLatestMessage} /></div>
      <aside ref={sidePaneRef} className={`${styles.sidePane} ${chromeClass}`}>
        <GameControls paused={props.paused} onPaused={props.onPaused} onSettings={props.onSettings} onRestart={() => setConfirmRestart(true)} onExit={props.onExit} />
        <DecisionPanel observation={observation} aiError={props.aiError} awaitingRetry={props.awaitingRetry} thinking={props.thinking} decisionError={props.decisionError} onSubmit={props.onSubmit} onRetry={props.onRetry} onLocal={props.onLocal} onSettings={props.onSettings} />
        {observation.omniscient
          ? <section className={`${styles.intel} ${styles.desktopHistory}`} aria-labelledby="desktop-history-title">
            <header><Archive /><div><span>CASE ARCHIVE</span><h2 id="desktop-history-title">完整记录</h2></div></header>
            <HistoryBody observation={observation} />
          </section>
          : <section className={styles.intel} aria-labelledby="intel-title">
            <header><Info /><h2 id="intel-title">私密情报</h2></header>
            <div>{recentPrivateEvents.length > 0 ? recentPrivateEvents.map((event) => <p key={event.id}>{event.text}</p>) : <p>尚未获得私密情报。</p>}</div>
          </section>}
      </aside>
      <section className={styles.historyPane} aria-labelledby="history-title">
        <header><Archive /><div><span>CASE ARCHIVE</span><h2 id="history-title">完整记录</h2></div></header>
        <HistoryBody observation={observation} />
      </section>
    </div>
    {!decisionPanelVisible && <div className={styles.automationBar} aria-live="polite"><Bot /><div><span>{automationModeLabel(observation)}</span><strong>{automationStatus(observation)}</strong></div>{observation.result && <button className={styles.mobileRestart} type="button" onClick={() => setConfirmRestart(true)}><RotateCcw />再来一局</button>}{props.thinking && <LoaderCircle className={styles.automationSpin} />}</div>}
    {mobileChromeHidden && <button className={styles.mobileReveal} type="button" onClick={(event) => { event.stopPropagation(); revealMobileChrome(); }} aria-label="显示游戏控制"><ChevronDown />展开面板</button>}
    {selectedPlayer && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedPlayerId(null)}><section className={styles.playerDialog} role="dialog" aria-modal="true" aria-labelledby="player-detail-title"><button className={styles.close} type="button" onClick={() => setSelectedPlayerId(null)} aria-label="关闭角色详情"><X /></button><img src={selectedPlayer.avatarUrl} alt="" /><div><span>{selectedSeatLabel}</span><h2 id="player-detail-title">{selectedPlayer.name}</h2><p>{selectedPlayer.alive ? '存活' : '已死亡'}</p><dl><dt>基础职业</dt><dd>{selectedPlayer.roleId ? `${roleNames[selectedPlayer.roleId]} · ${roleDescriptions[selectedPlayer.roleId]}` : '尚未公开'}</dd><dt>魔女技</dt><dd>{selectedPlayer.skillId ? `${witchSkillDefinitions[selectedPlayer.skillId].name} · ${witchSkillDefinitions[selectedPlayer.skillId].description}` : '尚未公开'}</dd></dl></div></section></div>}
    {observation.result && !resultDismissed && <section className={`${styles.result} ${resultFaded ? styles.resultFaded : ''}`} aria-live="assertive"><Gavel /><div><span>FINAL VERDICT</span><h2>{observation.result.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜'}</h2><p>{observation.mode === 'player' && observation.viewerPlayerId !== null ? `你的阵营${observation.players.find((player) => player.id === observation.viewerPlayerId)?.roleId === 'wolf' ? observation.result.winner === 'wolf' ? '获胜' : '失败' : observation.result.winner === 'good' ? '获胜' : '失败'}。` : '对局详细已揭晓~'}</p></div><button className={styles.desktopRestart} type="button" onClick={() => setConfirmRestart(true)}><RotateCcw />再来一局</button><button className={styles.resultClose} type="button" onClick={() => setResultDismissed(true)} aria-label="关闭结果面板" title="关闭结果面板"><X /></button></section>}
    {confirmRestart && <div className={styles.modalBackdrop} role="presentation"><section className={styles.confirm} role="alertdialog" aria-modal="true" aria-labelledby="restart-title"><Sparkles /><span>NEW CASE</span><h2 id="restart-title">开始同配置新局？</h2><p>当前存档将被覆盖，并重新随机生成种子。</p><div><button type="button" onClick={() => setConfirmRestart(false)}>取消</button><button type="button" className={styles.danger} onClick={() => { setConfirmRestart(false); props.onRestart(); }}>覆盖并重开</button></div></section></div>}
  </main>;
}
