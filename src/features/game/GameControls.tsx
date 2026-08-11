import { CirclePause, CirclePlay, RotateCcw, Settings, StepBack } from 'lucide-react';
import type { GameSpeed } from '../../app/useGameController';
import styles from './GameControls.module.css';

interface GameControlsProps {
  paused: boolean;
  speed: GameSpeed;
  onPaused(paused: boolean): void;
  onSpeed(speed: GameSpeed): void;
  onSettings(): void;
  onRestart(): void;
  onExit(): void;
}

export function GameControls({ paused, speed, onPaused, onSpeed, onSettings, onRestart, onExit }: GameControlsProps) {
  return <section className={styles.controls} aria-label="游戏控制">
    <button className={styles.primary} type="button" onClick={() => onPaused(!paused)}>{paused ? <CirclePlay /> : <CirclePause />}{paused ? '继续' : '暂停'}</button>
    <div className={styles.speed} role="group" aria-label="推进速度">
      {([0.5, 1, 2] as const).map((value) => <button key={value} type="button" className={speed === value ? styles.active : ''} onClick={() => onSpeed(value)}>{value}x</button>)}
    </div>
    <button type="button" onClick={onSettings} title="AI 设置"><Settings /><span>设置</span></button>
    <button type="button" onClick={onRestart} title="重新开始"><RotateCcw /><span>重开</span></button>
    <button type="button" onClick={onExit} title="返回准备区"><StepBack /><span>返回</span></button>
  </section>;
}
