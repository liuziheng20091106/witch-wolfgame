import { Archive, Bot, ChevronDown, Gavel, Info, List, LoaderCircle, RotateCcw, ScrollText, Sparkles, Users, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AiCommandError } from '../../ai/types';
import { roleDescriptions, roleNames } from '../../domain/catalog/roles';
import { witchSkillDefinitions } from '../../domain/catalog/witchSkills';
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
  'first-night': '首夜', 'night-skills': '夜间魔女技', 'wolf-suggestions': '狼人密议', 'wolf-decision': '狼人袭击',
  'witch-action': '女巫行动', 'seer-action': '预言家查验', 'night-protection': '夜间保护', 'night-resolution': '夜间结算',
  dawn: '黎明', 'day-skills': '白天魔女技', speeches: '公开发言', 'vote-skills': '投票前技能', voting: '公开投票',
  runoff: '平票重投', 'day-resolution': '白天结算', ended: '审判结束',
};

type MobileTab = 'live' | 'players' | 'history';

export function GameView(props: GameViewProps) {
  const { observation } = props;
  const [mobileTab, setMobileTab] = useState<MobileTab>('live');
  const [followingLatestMessage, setFollowingLatestMessage] = useState(true);
  const [selectedPlayerId, setSelectedPlayerId] = useState<PlayerId | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const [resultFaded, setResultFaded] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const gameRef = useRef<HTMLElement>(null);
  const sidePaneRef = useRef<HTMLElement>(null);
  const selectedPlayer = selectedPlayerId === null ? null : observation.players.find((player) => player.id === selectedPlayerId) ?? null;
  const activeActorId = observation.pendingDecision?.actorId ?? null;
  const privateEvents = observation.privateEvents.slice(-10).reverse();
  const hasResult = observation.result !== null;
  const humanDecisionPending = observation.pendingDecision?.actorId === observation.viewerPlayerId;
  const canAutoHide = mobileTab === 'live' && followingLatestMessage && !humanDecisionPending && !hasResult;
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
    if (!hasResult) { setResultFaded(false); return; }
    setResultFaded(false);
    const timer = window.setTimeout(() => setResultFaded(true), 4000);
    return () => window.clearTimeout(timer);
  }, [hasResult]);
  useLayoutEffect(() => {
    const game = gameRef.current;
    const sidePane = sidePaneRef.current;
    if (!humanDecisionPending || !game || !sidePane) return;
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
  }, [humanDecisionPending]);
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

  return <main ref={gameRef} className={`${styles.game} ${mobileChromeHidden ? styles.gameChromeHidden : ''} ${humanDecisionPending ? styles.humanDecisionPending : ''}`}>
    <header className={`${styles.topbar} ${chromeClass}`}>
      <div className={styles.brand}><img src={brandMark} alt="魔女狼人杀" /></div>
      <div className={styles.phase}><small>{observation.day === 0 ? 'FIRST NIGHT' : `DAY ${String(observation.day).padStart(2, '0')}`}</small><strong>{phaseNames[observation.phase]}</strong></div>
    </header>
    <nav className={`${styles.mobileTabs} ${chromeClass}`} aria-label="游戏视图">
      <button type="button" className={mobileTab === 'live' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('live'); }}><ScrollText />实况</button>
      <button type="button" className={mobileTab === 'players' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('players'); }}><Users />角色</button>
      <button type="button" className={mobileTab === 'history' ? styles.activeTab : ''} onClick={() => { revealMobileChrome(); setMobileTab('history'); }}><List />记录</button>
    </nav>
    <div className={styles.workspace} data-mobile-tab={mobileTab} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
      <div className={`${styles.rosterPane} ${chromeClass}`}><PlayerRoster observation={observation} currentActorId={activeActorId} onSelect={setSelectedPlayerId} /></div>
      <div className={styles.livePane}><Transcript observation={observation} phaseLabel={phaseNames[observation.phase]} onFollowingChange={setFollowingLatestMessage} /></div>
      <aside ref={sidePaneRef} className={`${styles.sidePane} ${chromeClass}`}>
        <GameControls paused={props.paused} onPaused={props.onPaused} onSettings={props.onSettings} onRestart={() => setConfirmRestart(true)} onExit={props.onExit} />
        <DecisionPanel observation={observation} aiError={props.aiError} awaitingRetry={props.awaitingRetry} thinking={props.thinking} decisionError={props.decisionError} onSubmit={props.onSubmit} onRetry={props.onRetry} onLocal={props.onLocal} onSettings={props.onSettings} />
        <section className={styles.intel} aria-labelledby="intel-title"><header><Info /><h2 id="intel-title">私密情报</h2></header><div>{privateEvents.length > 0 ? privateEvents.map((event) => <p key={event.id}>{event.text}</p>) : <p>尚未获得私密情报。</p>}</div></section>
      </aside>
      <section className={styles.historyPane} aria-labelledby="history-title"><header><Archive /><div><span>CASE ARCHIVE</span><h2 id="history-title">完整记录</h2></div></header><div className={styles.historyBody}><h3>私密行动</h3>{observation.privateEvents.map((event) => <p key={event.id}>{event.text}</p>)}{observation.omniscient && observation.archivedTimelines.map((archive) => <div key={archive.id} className={styles.archive}><h3>被回溯时间线 · 第 {archive.rewoundAtDay} 天</h3>{archive.publicEvents.map((event) => <p key={event.id}>{event.text}</p>)}</div>)}{observation.privateEvents.length === 0 && observation.archivedTimelines.length === 0 && <p>暂无额外记录。</p>}</div></section>
    </div>
    {!humanDecisionPending && <div className={styles.automationBar} aria-live="polite"><Bot /><div><span>{observation.automationMode === 'local' ? 'LOCAL STRATEGY' : 'AI AUTOMATION'}</span><strong>{observation.pendingDecision ? `${observation.players.find((player) => player.id === observation.pendingDecision?.actorId)?.name ?? `${observation.pendingDecision.actorId + 1}号`} 正在${observation.pendingDecision.title}` : observation.result ? '审判已结束' : '审判正在推进'}</strong></div>{observation.result && <button className={styles.mobileRestart} type="button" onClick={() => setConfirmRestart(true)}><RotateCcw />再来一局</button>}{props.thinking && <LoaderCircle className={styles.automationSpin} />}</div>}
    {mobileChromeHidden && <button className={styles.mobileReveal} type="button" onClick={(event) => { event.stopPropagation(); revealMobileChrome(); }} aria-label="显示游戏控制"><ChevronDown />显示控制</button>}
    {selectedPlayer && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedPlayerId(null)}><section className={styles.playerDialog} role="dialog" aria-modal="true" aria-labelledby="player-detail-title"><button className={styles.close} type="button" onClick={() => setSelectedPlayerId(null)} aria-label="关闭角色详情"><X /></button><img src={selectedPlayer.avatarUrl} alt="" /><div><span>{selectedPlayer.id + 1}号席位</span><h2 id="player-detail-title">{selectedPlayer.name}</h2><p>{selectedPlayer.alive ? '存活' : '已死亡'}</p><dl><dt>基础职业</dt><dd>{selectedPlayer.roleId ? `${roleNames[selectedPlayer.roleId]} · ${roleDescriptions[selectedPlayer.roleId]}` : '尚未公开'}</dd><dt>魔女技</dt><dd>{selectedPlayer.skillId ? `${witchSkillDefinitions[selectedPlayer.skillId].name} · ${witchSkillDefinitions[selectedPlayer.skillId].description}` : '尚未公开'}</dd></dl></div></section></div>}
    {observation.result && <section className={`${styles.result} ${resultFaded ? styles.resultFaded : ''}`} aria-live="assertive"><Gavel /><div><span>FINAL VERDICT</span><h2>{observation.result.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜'}</h2><p>{observation.mode === 'player' && observation.viewerPlayerId !== null ? `你的阵营${observation.players.find((player) => player.id === observation.viewerPlayerId)?.roleId === 'wolf' ? observation.result.winner === 'wolf' ? '获胜' : '失败' : observation.result.winner === 'good' ? '获胜' : '失败'}。` : '所有职业、技能与伪造来源已揭晓。'}</p></div><button className={styles.desktopRestart} type="button" onClick={() => setConfirmRestart(true)}><RotateCcw />再来一局</button></section>}
    {confirmRestart && <div className={styles.modalBackdrop} role="presentation"><section className={styles.confirm} role="alertdialog" aria-modal="true" aria-labelledby="restart-title"><Sparkles /><span>NEW CASE</span><h2 id="restart-title">开始同配置新局？</h2><p>当前存档将被覆盖，并重新随机生成种子。</p><div><button type="button" onClick={() => setConfirmRestart(false)}>取消</button><button type="button" className={styles.danger} onClick={() => { setConfirmRestart(false); props.onRestart(); }}>覆盖并重开</button></div></section></div>}
  </main>;
}
