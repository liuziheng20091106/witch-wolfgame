import { loadGame } from '../storage/browserStorage';
import { downloadTextFile } from './download';

export function exportCurrentGame(): void {
  const result = loadGame();
  if (!result.ok) {
    throw new Error(`无法导出当前对局：${result.error}`);
  }
  if (!result.value) {
    throw new Error('当前没有可导出的对局');
  }

  const gameId = result.value.state.gameId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'game';
  const timestamp = result.value.savedAt.replace(/[:.]/g, '-');
  downloadTextFile(
    JSON.stringify(result.value, null, 2),
    `majo-wolf-game-${gameId}-${timestamp}.json`,
    'application/json;charset=utf-8',
  );
}
