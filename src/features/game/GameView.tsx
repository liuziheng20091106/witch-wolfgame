import { Archive, Gavel, Info, List, ScrollText, Sparkles, Users, X } from 'lucide-react';
import { useState } from 'react';
import type { AiCommandError } from '../../ai/types';
import type { GameSpeed } from '../../app/useGameController';
import { roleDescriptions, roleNames } from '../../domain/catalog/roles';
import { witchSkillDefinitions } from '../../domain/catalog/witchSkills';
import type { GameObservation, PlayerId, SubmittedDecision } from '../../domain/model';
import brandMark from '../../assets/icon.ico';
import supportQr from '../../assets/support/free-provider-wechat.png';
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
  speed: GameSpeed;
  onSubmit(decision: SubmittedDecision): void;
  onRetry(): void;
  onLocal(): void;
  onSettings(): void;
  onPaused(paused: boolean): void;
  onSpeed(speed: GameSpeed): void;
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
  const [selectedPlayerId, setSelectedPlayerId] = useState<PlayerId | null>(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const selectedPlayer = selectedPlayerId === null ? null : observation.players.find((player) => player.id === selectedPlayerId) ?? null;
  const activeActorId = observation.pendingDecision?.actorId ?? null;
  const privateEvents = observation.privateEvents.slice(-10).reverse();

  return <main className={styles.game}>
    <header className={styles.topbar}>
      <div className={styles.brand}><img src={brandMark} alt="魔女狼人杀" /></div>
      <div className={styles.phase}><small>{observation.day === 0 ? 'FIRST NIGHT' : `DAY ${String(observation.day).padStart(2, '0')}`}</small><strong>{phaseNames[observation.phase]}</strong></div>
    </header>

    <nav className={styles.mobileTabs} aria-label="游戏视图">
      <button type="button" className={mobileTab === 'live' ? styles.activeTab : ''} onClick={() => setMobileTab('live')}><ScrollText />实况</button>
      <button type="button" className={mobileTab === 'players' ? styles.activeTab : ''} onClick={() => setMobileTab('players')}><Users />角色</button>
      <button type="button" className={mobileTab === 'history' ? styles.activeTab : ''} onClick={() => setMobileTab('history')}><List />记录</button>
    </nav>

    <div className={styles.workspace} data-mobile-tab={mobileTab}>
      <div className={styles.rosterPane}><PlayerRoster observation={observation} currentActorId={activeActorId} onSelect={setSelectedPlayerId} /></div>
      <div className={styles.livePane}><Transcript observation={observation} /></div>
      <aside className={styles.sidePane}>
        <GameControls paused={props.paused} speed={props.speed} onPaused={props.onPaused} onSpeed={props.onSpeed} onSettings={props.onSettings} onRestart={() => setConfirmRestart(true)} onExit={props.onExit} />
        <DecisionPanel observation={observation} aiError={props.aiError} awaitingRetry={props.awaitingRetry} thinking={props.thinking} decisionError={props.decisionError} onSubmit={props.onSubmit} onRetry={props.onRetry} onLocal={props.onLocal} onSettings={props.onSettings} />
        <section className={styles.intel} aria-labelledby="intel-title"><header><Info /><h2 id="intel-title">私密情报</h2></header>
          <div>{privateEvents.length > 0 ? privateEvents.map((event) => <p key={event.id}>{event.text}</p>) : <p>尚未获得私密情报。</p>}</div>
        </section>
      </aside>
      <section className={styles.historyPane} aria-labelledby="history-title">
        <header><Archive /><div><span>CASE ARCHIVE</span><h2 id="history-title">完整记录</h2></div></header>
        <div className={styles.historyBody}>
          <h3>私密行动</h3>{observation.privateEvents.map((event) => <p key={event.id}>{event.text}</p>)}
          {observation.omniscient && observation.archivedTimelines.map((archive) => <div key={archive.id} className={styles.archive}><h3>被回溯时间线 · 第 {archive.rewoundAtDay} 天</h3>{archive.publicEvents.map((event) => <p key={event.id}>{event.text}</p>)}</div>)}
          {observation.privateEvents.length === 0 && observation.archivedTimelines.length === 0 && <p>暂无额外记录。</p>}
        </div>
      </section>
    </div>

    {observation.result && <section className={`${styles.result} ${observation.usedFreeProvider ? styles.resultWithSupport : ''}`} aria-live="assertive"><Gavel /><div><span>FINAL VERDICT</span><h2>{observation.result.winner === 'wolf' ? '狼人阵营获胜' : '好人阵营获胜'}</h2><p>{observation.mode === 'player' && observation.viewerPlayerId !== null ? `你的阵营${observation.players.find((player) => player.id === observation.viewerPlayerId)?.roleId === 'wolf' ? observation.result.winner === 'wolf' ? '获胜' : '失败' : observation.result.winner === 'good' ? '获胜' : '失败'}。` : '所有职业、技能与伪造来源已揭晓。'}</p></div><button type="button" onClick={() => setConfirmRestart(true)}>再来一局</button>{observation.usedFreeProvider && <aside className={styles.resultSupport}><div className={styles.resultQr}><img src={supportQr} alt="微信赞赏二维码" /></div><div><span>FREE SERVICE</span><strong>本局使用了免费服务</strong><p>若这局体验不错，欢迎扫码赞赏。</p></div></aside>}</section>}

    {selectedPlayer && <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setSelectedPlayerId(null)}><section className={styles.playerDialog} role="dialog" aria-modal="true" aria-labelledby="player-detail-title">
      <button className={styles.close} type="button" onClick={() => setSelectedPlayerId(null)} aria-label="关闭角色详情"><X /></button>
      <img src={selectedPlayer.avatarUrl} alt="" /><div><span>{selectedPlayer.id + 1}号席位</span><h2 id="player-detail-title">{selectedPlayer.name}</h2><p>{selectedPlayer.alive ? '存活' : '已死亡'}</p>
        <dl><dt>基础职业</dt><dd>{selectedPlayer.roleId ? `${roleNames[selectedPlayer.roleId]} · ${roleDescriptions[selectedPlayer.roleId]}` : '尚未公开'}</dd><dt>魔女技</dt><dd>{selectedPlayer.skillId ? `${witchSkillDefinitions[selectedPlayer.skillId].name} · ${witchSkillDefinitions[selectedPlayer.skillId].description}` : '尚未公开'}</dd></dl>
      </div>
    </section></div>}

    {confirmRestart && <div className={styles.modalBackdrop} role="presentation"><section className={styles.confirm} role="alertdialog" aria-modal="true" aria-labelledby="restart-title"><Sparkles /><span>NEW CASE</span><h2 id="restart-title">开始同配置新局？</h2><p>当前存档将被覆盖，随机种子与模式保持不变。</p><div><button type="button" onClick={() => setConfirmRestart(false)}>取消</button><button type="button" className={styles.danger} onClick={() => { setConfirmRestart(false); props.onRestart(); }}>覆盖并重开</button></div></section></div>}
  </main>;
}
