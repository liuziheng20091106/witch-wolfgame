import { Bot, Check, ChevronRight, Copy, Eye, Minus, Play, Plus, Settings, Trash2, TriangleAlert, UserRound } from 'lucide-react';
import { MAX_PLAYERS, MIN_PLAYERS } from '../../../shared/gamePromptContract.js';
import { useState } from 'react';
import type { AiProviderConfig } from '../../ai/types';
import { copyTextToClipboard } from '../../app/clipboard';
import { characters } from '../../domain/catalog/characters';
import { postGameDone } from '../../domain/skills/postGame';
import type { CharacterId } from '../../domain/model';
import { getSavedGameCompatibilityWarning, type GameHistoryEntry, type SavedGameEnvelope, type SetupPreferences } from '../../storage/browserStorage';
import brandMark from '../../assets/icon.ico';
import type { MultiplayerController } from '../../multiplayer/useMultiplayerRoom';
import { MultiplayerLobby } from './MultiplayerLobby';
import styles from './SetupView.module.css';


interface SetupViewProps {
  settings: AiProviderConfig;
  setup: SetupPreferences;
  history: GameHistoryEntry[];
  savedGame: SavedGameEnvelope | null;
  historyError: string | null;
  storageError: string | null;
  multiplayer: MultiplayerController;
  onUpdateSetup(setup: SetupPreferences): void;
  onOpenSettings(): void;
  onContinue(): void;
  onStart(): void;
  onClearHistory(): void;
  onDiscard(): void;
}

function hasUsableSettings(settings: AiProviderConfig): boolean {
  if (settings.provider === 'free') return true;
  if (!settings.endpoint.trim() || !settings.apiKey.trim() || !settings.profiles.default.model.trim()) return false;
  try {
    const url = new URL(settings.endpoint);
    return url.pathname.endsWith('/chat/completions')
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

export function SetupView({ settings, setup, history, historyError, savedGame, storageError, multiplayer, onUpdateSetup, onOpenSettings, onContinue, onStart, onClearHistory, onDiscard }: SetupViewProps) {
  const [confirming, setConfirming] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copiedSeed, setCopiedSeed] = useState<number | null>(null);
  const customRosterComplete = setup.selectedCharacterIds.length === 0 || setup.selectedCharacterIds.length === setup.playerCount;
  const humanCharacterReady = setup.mode === 'spectator'
    || (setup.humanCharacterId !== null && (setup.selectedCharacterIds.length === 0 || setup.selectedCharacterIds.includes(setup.humanCharacterId)));
  const ready = hasUsableSettings(settings) && customRosterComplete && humanCharacterReady;
  const savedLabel = savedGame
    ? `${savedGame.state.day === 0 ? '首夜' : `第 ${savedGame.state.day} 天`} · ${savedGame.state.phase === 'ended' || savedGame.state.phase === 'post-game' ? '已结束' : '进行中'}`
    : null;
  let savedGameWarning: string | null = null;
  if (savedGame !== null) {
    savedGameWarning = getSavedGameCompatibilityWarning(savedGame);
  }

  const toggleCharacter = (characterId: CharacterId) => {
    const alreadySelected = setup.selectedCharacterIds.includes(characterId);
    if (!alreadySelected && setup.selectedCharacterIds.length >= setup.playerCount) return;
    const selectedCharacterIds = alreadySelected
      ? setup.selectedCharacterIds.filter((id) => id !== characterId)
      : [...setup.selectedCharacterIds, characterId];
    const humanCharacterId = setup.humanCharacterId === characterId && alreadySelected ? null : setup.humanCharacterId;
    onUpdateSetup({ ...setup, selectedCharacterIds, humanCharacterId });
  };
  const updatePlayerCount = (playerCount: number) => {
    const boundedCount = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, playerCount));
    const selectedCharacterIds = setup.selectedCharacterIds.slice(0, boundedCount);
    const humanCharacterId = setup.humanCharacterId && selectedCharacterIds.length > 0 && !selectedCharacterIds.includes(setup.humanCharacterId)
      ? null
      : setup.humanCharacterId;
    onUpdateSetup({ ...setup, playerCount: boundedCount, selectedCharacterIds, humanCharacterId });
  };
  const copySeed = async (seed: number) => {
    try {
      await copyTextToClipboard(String(seed));
      setCopiedSeed(seed);
      setCopyError(null);
    } catch (error) {
      setCopiedSeed(null);
      setCopyError(error instanceof Error ? `复制种子失败：${error.message}` : '复制种子失败，请手动复制');
    }
    window.setTimeout(() => setCopiedSeed((current) => (current === seed ? null : current)), 1500);
  };
  const requestStart = () => {
    // ended 与"赛后已完成"（post-game 且全员已发言）可无确认直接开新局；
    // 进行中的对局（含未完成的赛后复盘）需要覆盖确认，避免丢失未完成的赛后记录。
    const postGameFinished = savedGame?.state.phase === 'post-game' && postGameDone(savedGame.state);
    if (savedGame && savedGame.state.phase !== 'ended' && !postGameFinished) {
      setConfirming(true);
    } else {
      onStart();
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.brandLockup}><img className={styles.brandMark} src={brandMark} alt="" /><div><span>MAJO WOLF / CASE SYSTEM</span><strong>魔女狼人杀</strong></div></div>
        <p>在封闭审判中观察证言、身份与魔法留下的裂痕。</p>
        <button className={styles.settingsButton} type="button" onClick={onOpenSettings}><Settings />设置</button>
      </header>

      <section className={styles.commandBand} aria-labelledby="setup-title">
        <div className={styles.intro}>
          <span>FILE 01 · 审判准备</span>
          <h2 id="setup-title">决定你如何进入这桩案件</h2>
          <p>旁观所有真相，或认领一名少女的席位。</p>
        </div>
        <div className={styles.modeSwitch} role="group" aria-label="游戏模式">
          <button type="button" className={setup.mode === 'spectator' ? styles.activeMode : ''} onClick={() => onUpdateSetup({ ...setup, mode: 'spectator', humanCharacterId: null })}><Eye />全自动观战</button>
          <button type="button" className={setup.mode === 'player' ? styles.activeMode : ''} onClick={() => onUpdateSetup({ ...setup, mode: 'player', humanCharacterId: setup.humanCharacterId ?? setup.selectedCharacterIds[0] ?? null })}><UserRound />加入一个席位</button>
        </div>
        <div className={styles.countField}><span>出庭人数</span><div><button type="button" onClick={() => updatePlayerCount(setup.playerCount - 1)} disabled={setup.playerCount <= MIN_PLAYERS} aria-label="减少出庭人数"><Minus /></button><strong>{setup.playerCount}</strong><button type="button" onClick={() => updatePlayerCount(setup.playerCount + 1)} disabled={setup.playerCount >= MAX_PLAYERS} aria-label="增加出庭人数"><Plus /></button></div></div>
        <div className={styles.seedField}>
          <span>随机种子</span>
          <div className={styles.seedControls}>
            <input type="number" min="0" max="4294967295" placeholder="留空以使用随机种子" value={setup.randomSeed ? '' : setup.seed} onChange={(event) => {
              if (event.target.value === '') {
                onUpdateSetup({ ...setup, randomSeed: true });
                return;
              }
              onUpdateSetup({ ...setup, seed: Math.max(0, Math.min(0xffff_ffff, Number(event.target.value) || 0)), randomSeed: false });
            }} />
          </div>
        </div>
      </section>

      <section className={styles.characterSection} aria-labelledby="character-title">
        <div className={styles.sectionHeading}><div><span>CAST SELECTION</span><h2 id="character-title">配置出庭阵容</h2></div><p>{setup.selectedCharacterIds.length === 0 ? `当前使用种子随机选择 ${setup.playerCount} 人` : `已选择 ${setup.selectedCharacterIds.length} / ${setup.playerCount} 人`}{setup.mode === 'player' ? '；再次点击已入选角色的「设为我的角色」即可锁定席位。' : '。'}</p></div>
        <div className={styles.characterGrid}>
          {characters.map((character) => {
            const included = setup.selectedCharacterIds.includes(character.id);
            const selectedSeat = included ? setup.selectedCharacterIds.indexOf(character.id) + 1 : null;
            const human = setup.humanCharacterId === character.id;
            const inclusionDisabled = !included && setup.selectedCharacterIds.length >= setup.playerCount;
            return <article key={character.id} className={`${styles.characterCard} ${included ? styles.selectedCharacter : ''} ${human ? styles.humanCharacter : ''}`}>
              <button type="button" className={styles.characterToggle} onClick={() => toggleCharacter(character.id)} aria-pressed={included} disabled={inclusionDisabled}>
                <span className={styles.seatNumber}>{selectedSeat === null ? '候选' : `${String(selectedSeat).padStart(2, '0')} 席`}</span>
                <img src={character.avatarUrl} alt="" />
                <span className={styles.characterMeta}><strong>{character.name}</strong><small>{character.speechStyle.slice(0, 20)}…</small></span>
                {included && <span className={styles.check}><Check /></span>}
              </button>
              {setup.mode === 'player' && (included || setup.selectedCharacterIds.length === 0) && <button type="button" className={styles.humanSeat} onClick={() => onUpdateSetup({ ...setup, humanCharacterId: character.id })}>{human ? '已认领此席' : '设为我的角色'}</button>}
            </article>;
          })}
        </div>
        {setup.selectedCharacterIds.length > 0 && setup.selectedCharacterIds.length !== setup.playerCount && <p className={styles.rosterError} role="status">还需选择 {setup.playerCount - setup.selectedCharacterIds.length} 名角色才能开始。</p>}
      </section>

      <section className={styles.launchBand} aria-label="案件启动">
        <div className={styles.aiStatus}>
          <div className={styles.aiSummary}>
            <span className={styles.aiIcon}><Bot /></span>
            <div className={styles.aiCopy}><strong>{settings.provider === 'free' ? '免费服务' : '自定义服务'}</strong><span>{settings.provider === 'free' ? '公益服务，不保证稳定可用' : settings.profiles.default.model || '请填写默认模型'}</span></div>
          </div>
          <button type="button" onClick={onOpenSettings}>{settings.provider === 'free' ? '服务详情' : '打开设置'}<ChevronRight /></button>
        </div>
        {storageError && <p className={styles.storageError} role="alert">{storageError}</p>}
        {historyError && <div className={styles.storageErrorAction} role="alert"><span>{historyError}</span><button type="button" onClick={onClearHistory}>清除损坏历史</button></div>}
        {copyError && <p className={styles.storageError} role="status">{copyError}</p>}
        <div className={styles.launchActions}>
          {savedGame && <div className={styles.savedGameGroup}>
            {savedGameWarning && <p className={styles.saveVersionWarning} role="alert"><TriangleAlert aria-hidden="true" /><span>{savedGameWarning}</span></p>}
            <div className={styles.savedRun}><span>可恢复记录</span><strong>{savedLabel}</strong><button type="button" onClick={onContinue}><Play />继续上局</button><button type="button" className={styles.deleteButton} onClick={onDiscard} aria-label="删除存档"><Trash2 /></button></div>
          </div>}
          <button className={styles.startButton} type="button" disabled={!ready} onClick={requestStart}><span>OPEN CASE</span><Play />开启审判</button>
        </div>
      </section>
      <div className={styles.multiplayerWrap}><MultiplayerLobby multiplayer={multiplayer} defaultCharacterId={setup.humanCharacterId} /></div>

      {history.length > 0 && <section className={styles.historySection} aria-labelledby="seed-history-title">
        <div className={styles.sectionHeading}><div><span>FILE 03 · SEED ARCHIVE</span><h2 id="seed-history-title">封存案件</h2></div><p>种子是案件编号；复制后即可复现完全相同的入场阵容。</p></div>
        <div className={styles.historyList}>
          {history.map((entry) => (
            <div key={entry.gameId} className={styles.historyEntry}>
              <strong>种子 {entry.seed}</strong>
              <span>第 {entry.finishedDay} 天 · {entry.winner === 'wolf' ? '狼人胜' : '好人胜'}</span>
              <span>{new Date(entry.finishedAt).toLocaleString()}</span>
              <button type="button" className={styles.copyButton} onClick={() => copySeed(entry.seed)}><Copy />{copiedSeed === entry.seed ? '已复制' : '复制'}</button>
            </div>
          ))}
        </div>
      </section>}

      {confirming && <div className={styles.confirmBackdrop} role="presentation">
        <div className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="replace-title">
          <span>REPLACE CASE</span><h2 id="replace-title">覆盖未结束存档？</h2><p>当前进行中的审判记录会被新局替换。</p>
          <div><button type="button" onClick={() => setConfirming(false)}>取消</button><button type="button" className={styles.danger} onClick={() => { setConfirming(false); onStart(); }}>覆盖并开始</button></div>
        </div>
      </div>}
    </main>
  );
}
