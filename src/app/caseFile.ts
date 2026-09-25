import { roleNames } from '../domain/catalog/roles';
import { getName, getRoleAssignment } from '../domain/engine/selectors';
import type { GameState, TimelineEvent } from '../domain/model';
import type { CaseNotes, SuspectNote } from '../storage/browserStorage';

const verdict = { good: '好人阵营', wolf: '狼人阵营', neutral: '呆头鹅' };
const suspicion = { unknown: '待定', good: '偏好人', wolf: '偏狼人' };

function eventLine(event: TimelineEvent, state: GameState): string {
  const author = event.displayAuthorPlayerId === null ? '' : `${getName(state, event.displayAuthorPlayerId)}：`;
  return `- ${author}${event.text.replaceAll('\n', '\n  ')}`;
}

function noteLines(notes: Record<string, SuspectNote>, state: GameState): string[] {
  return state.players.map((player) => {
    const note = notes[String(player.id)];
    if (!note || (note.suspicion === 'unknown' && !note.reason && note.evidenceIds.length === 0)) return '';
    const evidence = note.evidenceIds.map((id) => [
      ...state.publicEvents,
      ...state.archivedTimelines.flatMap((archive) => archive.publicEvents),
    ].find((event) => event.id === id)?.text).filter(Boolean);
    return `- ${player.id + 1}号 ${getName(state, player.id)}：${suspicion[note.suspicion]}${note.reason ? `；${note.reason}` : ''}${evidence.length ? `\n  - 引用证言：${evidence.join('；')}` : ''}`;
  }).filter(Boolean);
}

export function formatCaseFile(state: GameState, notes: CaseNotes): string {
  if (!state.result) throw new Error('案件尚未结案');
  const lines = [
    '# 魔女狼人杀 · 案件卷宗',
    '',
    `案件编号：${state.gameId}`,
    `随机种子：${state.seed}`,
    `轮次：第 ${state.roundNumber} 轮`,
    `结案：第 ${state.result.finishedDay} 天，${verdict[state.result.winner]}获胜`,
    '',
    '## 真相：出庭身份',
    '',
    ...state.players.map((player) => `- ${player.id + 1}号 ${getName(state, player.id)}：${roleNames[getRoleAssignment(state, player.id).roleId]}，${player.alive ? '存活' : '出局'}`),
    '',
    '## 公开庭审记录',
  ];
  for (const day of [...new Set(state.publicEvents.map((event) => event.day))]) {
    lines.push('', `### ${day === 0 ? '首夜' : `第 ${day} 天`}`, '', ...state.publicEvents.filter((event) => event.day === day).map((event) => eventLine(event, state)));
  }
  lines.push('', '## 幕后行动', '', ...state.privateEvents.map((event) => `- 第 ${event.day} 天：${event.text}`));
  if (state.archivedTimelines.length) {
    lines.push('', '## 被回溯的时间线');
    for (const archive of state.archivedTimelines) {
      lines.push('', `### 第 ${archive.rewoundAtDay} 天`, '', ...archive.publicEvents.map((event) => eventLine(event, state)), ...archive.privateEvents.map((event) => `- 幕后：${event.text}`));
    }
  }
  if (notes.snapshots.length || noteLines(notes.suspects, state).length) {
    lines.push('', '## 盲审嫌疑簿');
    for (const snapshot of notes.snapshots) {
      const recorded = noteLines(snapshot.notes, state);
      lines.push('', `### 第 ${snapshot.day} 天${snapshot.round === 1 ? '首轮' : '第二轮'}投票前`, '', ...(recorded.length ? recorded : ['- 尚无判断']));
    }
    const finalNotes = noteLines(notes.suspects, state);
    lines.push('', '### 结案时记录', '', ...(finalNotes.length ? finalNotes : ['- 尚无判断']));
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const DB_NAME = 'majo-wolf-case-files';
const STORE = 'cases';

function openCases(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function useCases<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  const db = await openCases();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    let result: T;
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
    action(transaction.objectStore(STORE), (value) => { result = value; });
  });
}

export function saveCaseFile(gameId: string, markdown: string): Promise<void> {
  return useCases('readwrite', (store) => {
    store.put(markdown, gameId);
  });
}

export function loadCaseFile(gameId: string): Promise<string | null> {
  return useCases('readonly', (store, done) => {
    const request = store.get(gameId);
    request.onsuccess = () => done(typeof request.result === 'string' ? request.result : null);
  });
}

export async function clearCaseFiles(): Promise<void> {
  return useCases('readwrite', (store) => {
    store.clear();
  });
}
