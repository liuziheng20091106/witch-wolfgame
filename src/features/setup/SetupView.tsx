import { Bot, Check, ChevronRight, Dices, Eye, Play, Repeat, Settings, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import { rollSeed } from '../../app/useGameController';
import type { AiProviderConfig } from '../../ai/types';
import { characters } from '../../domain/catalog/characters';
import type { CharacterId } from '../../domain/model';
import type { SavedGameEnvelope, SetupPreferences } from '../../storage/browserStorage';
import brandMark from '../../assets/icon.ico';
import styles from './SetupView.module.css';

interface SetupViewProps {
  settings: AiProviderConfig;
  setup: SetupPreferences;
  savedGame: SavedGameEnvelope | null;
  storageError: string | null;
  onUpdateSetup(setup: SetupPreferences): void;
  onStartWithSeed(): void;
  onOpenSettings(): void;
  onContinue(): void;
  onStart(): void;
  onDiscard(): void;
}

function hasUsableSettings(settings: AiProviderConfig): boolean {
  if (settings.provider === 'free') return true;
  if (!settings.endpoint.trim() || !settings.apiKey.trim() || !settings.model.trim()) return false;
  try {
    const url = new URL(settings.endpoint);
    return url.pathname.endsWith('/chat/completions')
      && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
  } catch {
    return false;
  }
}

export function SetupView({ settings, setup, savedGame, storageError, onUpdateSetup, onStartWithSeed, onOpenSettings, onContinue, onStart, onDiscard }: SetupViewProps) {
  const [confirming, setConfirming] = useState(false);
  const [pendingKind, setPendingKind] = useState<'random' | 'seed'>('random');
  const ready = hasUsableSettings(settings) && (setup.mode === 'spectator' || setup.humanCharacterId !== null);
  const savedLabel = savedGame
    ? `${savedGame.state.day === 0 ? '首夜' : `第 ${savedGame.state.day} 天`} · ${savedGame.state.phase === 'ended' ? '已结束' : '进行中'}`
    : null;

  const chooseCharacter = (characterId: CharacterId) => onUpdateSetup({ ...setup, humanCharacterId: characterId });
  const launch = (kind: 'random' | 'seed') => { if (kind === 'seed') onStartWithSeed(); else onStart(); };
  const requestStart = (kind: 'random' | 'seed') => {
    if (savedGame && savedGame.state.phase !== 'ended') {
      setPendingKind(kind);
      setConfirming(true);
    } else {
      launch(kind);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.masthead}>
        <img className={styles.brandMark} src={brandMark} alt="魔女狼人杀" />
        <button className={styles.settingsButton} type="button" onClick={onOpenSettings}><Settings />AI 设置</button>
      </header>

      <section className={styles.commandBand} aria-labelledby="setup-title">
        <div className={styles.intro}>
          <span>审判准备</span>
          <h2 id="setup-title">选择你的观察位置</h2>
        </div>
        <div className={styles.modeSwitch} role="group" aria-label="游戏模式">
          <button type="button" className={setup.mode === 'spectator' ? styles.activeMode : ''} onClick={() => onUpdateSetup({ ...setup, mode: 'spectator', humanCharacterId: null })}><Eye />全自动观战</button>
          <button type="button" className={setup.mode === 'player' ? styles.activeMode : ''} onClick={() => onUpdateSetup({ ...setup, mode: 'player' })}><UserRound />加入一个席位</button>
        </div>
        <div className={styles.seedField}>
          <span>随机种子</span>
          <div className={styles.seedControls}>
            <input type="number" min="0" max="4294967295" placeholder="随机" value={setup.randomSeed ? '' : setup.seed} onChange={(event) => {
              if (event.target.value === '') {
                onUpdateSetup({ ...setup, randomSeed: true });
                return;
              }
              onUpdateSetup({ ...setup, seed: Math.max(0, Math.min(0xffff_ffff, Number(event.target.value) || 0)), randomSeed: false });
            }} />
            <button type="button" className={setup.randomSeed ? styles.seedRandomButtonActive : styles.seedRandomButton} aria-pressed={setup.randomSeed} title="生成一个种子候选填入输入框，再点「使用种子复现对局」即可复现该种子；开始新局始终使用随机种子" onClick={() => onUpdateSetup({ ...setup, seed: rollSeed(), randomSeed: false })}><Dices />随机</button>
          </div>
        </div>
      </section>

      {setup.mode === 'player' && <section className={styles.characterSection} aria-labelledby="character-title">
        <div className={styles.sectionHeading}><div><span>PLAYER SEAT</span><h2 id="character-title">选择出庭角色</h2></div><p>基础职业将在六人入场后随机分配。</p></div>
        <div className={styles.characterGrid}>
          {characters.map((character, index) => {
            const selected = setup.humanCharacterId === character.id;
            return <button key={character.id} type="button" className={selected ? styles.selectedCharacter : styles.character} onClick={() => chooseCharacter(character.id)} aria-pressed={selected}>
              <span className={styles.seatNumber}>{String(index + 1).padStart(2, '0')}</span>
              <img src={character.avatarUrl} alt="" />
              <span className={styles.characterName}>{character.name}</span>
              <span className={styles.trait}>{character.speechStyle.slice(0, 18)}…</span>
              {selected && <span className={styles.check}><Check /></span>}
            </button>;
          })}
        </div>
      </section>}

      <section className={styles.launchBand}>
        <div className={styles.aiStatus}>
          <Bot />
          <div><strong>{settings.provider === 'free' ? '免费服务' : '自定义服务'}</strong><span>{settings.provider === 'free' ? '公益服务，不保证稳定可用' : settings.model || '请填写模型'}</span></div>
          <button type="button" onClick={onOpenSettings}>{settings.provider === 'free' ? '服务详情' : '打开设置'}<ChevronRight /></button>
        </div>
        {storageError && <p className={styles.storageError} role="alert">{storageError}</p>}
        <div className={styles.launchActions}>
          {savedGame && <div className={styles.savedRun}><span>可恢复记录</span><strong>{savedLabel}</strong><button type="button" onClick={onContinue}><Play />继续上局</button><button type="button" className={styles.deleteButton} onClick={onDiscard} aria-label="删除存档"><Trash2 /></button></div>}
          <button className={styles.startButton} type="button" disabled={!ready} onClick={() => requestStart('random')}><Play />开始新局</button>
          <button className={styles.replayButton} type="button" disabled={!ready || setup.randomSeed} onClick={() => requestStart('seed')}><Repeat />{setup.randomSeed ? '使用种子复现对局' : `使用种子 ${setup.seed} 复现`}</button>
        </div>
      </section>

      {confirming && <div className={styles.confirmBackdrop} role="presentation">
        <div className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="replace-title">
          <span>REPLACE CASE</span><h2 id="replace-title">覆盖未结束存档？</h2><p>当前进行中的审判记录会被新局替换。</p>
          <div><button type="button" onClick={() => setConfirming(false)}>取消</button><button type="button" className={styles.danger} onClick={() => { setConfirming(false); launch(pendingKind); }}>覆盖并开始</button></div>
        </div>
      </div>}
    </main>
  );
}
