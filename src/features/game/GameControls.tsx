import { CirclePause, CirclePlay, RotateCcw, Settings, StepBack } from 'lucide-react';
import styles from './GameControls.module.css';

interface GameControlsProps {
  paused: boolean;
  onPaused(paused: boolean): void;
  onSettings(): void;
  onRestart(): void;
  onExit(): void;
}

export function GameControls({ paused, onPaused, onSettings, onRestart, onExit }: GameControlsProps) {
  return <section className={styles.controls} aria-label="游戏控制">
    <button className={styles.primary} type="button" onClick={() => onPaused(!paused)}>{paused ? <CirclePlay /> : <CirclePause />}{paused ? '继续' : '暂停'}</button>
    <button type="button" onClick={onSettings} title="应用设置"><Settings /><span>设置</span></button>
    <button type="button" onClick={onRestart} title="重新开始"><RotateCcw /><span>重开</span></button>
    <button type="button" onClick={onExit} title="返回准备区"><StepBack /><span>返回</span></button>
  </section>;
}
