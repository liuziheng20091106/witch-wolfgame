import { useGameController } from './useGameController';
import { GameView } from '../features/game/GameView';
import { AiSettingsDrawer } from '../features/settings/AiSettingsDrawer';
import { SetupView } from '../features/setup/SetupView';

export function App() {
  const controller = useGameController();
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
    /> : <GameView
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
      onExit={controller.returnToSetup}
    />}
    <AiSettingsDrawer
      open={controller.settingsOpen}
      config={controller.settings}
      onClose={() => controller.setSettingsOpen(false)}
      onSave={controller.saveAiSettings}
    />
  </>;
}
