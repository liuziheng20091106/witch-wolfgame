import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { resolveTheme } from './theme';
import { useGameController } from './useGameController';
import { SetupView } from '../features/setup/SetupView';
import { useMultiplayerRoom } from '../multiplayer/useMultiplayerRoom';

// Static imports would merge these optional surfaces into the setup entry chunk; React.lazy requires dynamic module loading for this split.
const LazyGameView = lazy(async () => ({ default: (await import('../features/game/GameView')).GameView }));
const LazyAiSettingsDrawer = lazy(async () => ({ default: (await import('../features/settings/AiSettingsDrawer')).AiSettingsDrawer }));

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function App() {
  const controller = useGameController();
  const multiplayer = useMultiplayerRoom();
  const multiplayerObservation = multiplayer.room?.status === 'playing' || multiplayer.room?.status === 'ended'
    ? multiplayer.room.observation
    : null;
  const [systemDark, setSystemDark] = useState(getSystemDark);
  const previousThemeRef = useRef<string | null>(null);
  const gameObservation = multiplayerObservation ?? controller.observation;
  const judgmentPhase = gameObservation?.phase ?? null;
  const effectiveTheme = resolveTheme(controller.theme.preference, systemDark, controller.theme.judgmentMode, judgmentPhase);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (previousThemeRef.current === null) {
      root.dataset.theme = effectiveTheme;
      root.style.colorScheme = effectiveTheme;
      previousThemeRef.current = effectiveTheme;
      return;
    }
    if (previousThemeRef.current === effectiveTheme) return;
    previousThemeRef.current = effectiveTheme;
    root.classList.remove('theme-changing');
    void root.offsetWidth;
    root.classList.add('theme-changing');
    root.dataset.theme = effectiveTheme;
    root.style.colorScheme = effectiveTheme;
    const timer = window.setTimeout(() => root.classList.remove('theme-changing'), 760);
    return () => window.clearTimeout(timer);
  }, [effectiveTheme]);

  return <>
    {!multiplayerObservation && (controller.view === 'setup' || !controller.observation) ? <SetupView
      settings={controller.settings}
      setup={controller.setup}
      history={controller.history}
      historyError={controller.historyError}
      savedGame={controller.savedGame}
      storageError={controller.storageError}
      multiplayer={multiplayer}
      onUpdateSetup={controller.updateSetup}
      onOpenSettings={() => controller.setSettingsOpen(true)}
      onContinue={controller.continueSavedGame}
      onStart={controller.startNewGame}
      onClearHistory={controller.clearHistory}
      onDiscard={controller.discardSavedGame}
    /> : gameObservation ? <Suspense fallback={null}><LazyGameView
      observation={gameObservation}
      aiError={multiplayerObservation ? null : controller.aiError}
      awaitingRetry={multiplayerObservation ? false : controller.awaitingRetry}
      thinking={multiplayerObservation ? false : controller.thinking}
      decisionError={multiplayerObservation ? multiplayer.error : controller.decisionError}
      paused={multiplayerObservation ? false : controller.paused}
      onSubmit={multiplayerObservation ? multiplayer.submitDecision : controller.submitHumanDecision}
      onRetry={multiplayerObservation ? multiplayer.clearError : controller.retryAi}
      onLocal={multiplayerObservation ? multiplayer.leaveRoom : controller.useLocalFallback}
      onSettings={() => controller.setSettingsOpen(true)}
      onPaused={multiplayerObservation ? () => undefined : controller.setPaused}
      onRestart={multiplayerObservation ? multiplayer.leaveRoom : controller.startNewGame}
      onContinueRound={multiplayerObservation ? multiplayer.leaveRoom : controller.continueWithNewRoles}
      onExit={multiplayerObservation ? multiplayer.leaveRoom : controller.returnToSetup}
    /></Suspense> : null}
    {controller.settingsOpen && <Suspense fallback={null}><LazyAiSettingsDrawer
      open={controller.settingsOpen}
      config={controller.settings}
      theme={controller.theme}
      onClose={() => controller.setSettingsOpen(false)}
      onSave={controller.saveAiSettings}
    /></Suspense>}
  </>;
}
