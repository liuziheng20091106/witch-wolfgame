import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { resolveTheme } from './theme';
import { useGameController } from './useGameController';
import { SetupView } from '../features/setup/SetupView';

// Static imports would merge these optional surfaces into the setup entry chunk; React.lazy requires dynamic module loading for this split.
const LazyGameView = lazy(async () => ({ default: (await import('../features/game/GameView')).GameView }));
const LazyAiSettingsDrawer = lazy(async () => ({ default: (await import('../features/settings/AiSettingsDrawer')).AiSettingsDrawer }));

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function App() {
  const controller = useGameController();
  const [systemDark, setSystemDark] = useState(getSystemDark);
  const previousThemeRef = useRef<string | null>(null);
  const judgmentPhase = controller.view === 'game' ? controller.observation?.phase : null;
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
    {controller.view === 'setup' || !controller.observation ? <SetupView
      settings={controller.settings}
      setup={controller.setup}
      history={controller.history}
      historyError={controller.historyError}
      savedGame={controller.savedGame}
      storageError={controller.storageError}
      onUpdateSetup={controller.updateSetup}
      onOpenSettings={() => controller.setSettingsOpen(true)}
      onContinue={controller.continueSavedGame}
      onStart={controller.startNewGame}
      onClearHistory={controller.clearHistory}
      onDiscard={controller.discardSavedGame}
    /> : <Suspense fallback={null}><LazyGameView
      observation={controller.observation}
      aiError={controller.aiError}
      awaitingRetry={controller.awaitingRetry}
      thinking={controller.thinking}
      decisionError={controller.decisionError}
      paused={controller.paused}
      onSubmit={controller.submitHumanDecision}
      onRetry={controller.retryAi}
      onLocal={controller.useLocalFallback}
      onSettings={() => controller.setSettingsOpen(true)}
      onPaused={controller.setPaused}
      onRestart={controller.startNewGame}
      onContinueRound={controller.continueWithNewRoles}
      onExit={controller.returnToSetup}
    /></Suspense>}
    {controller.settingsOpen && <Suspense fallback={null}><LazyAiSettingsDrawer
      open={controller.settingsOpen}
      config={controller.settings}
      theme={controller.theme}
      onClose={() => controller.setSettingsOpen(false)}
      onSave={controller.saveAiSettings}
    /></Suspense>}
  </>;
}
