import { BookOpen, Link2, X } from 'lucide-react';
import { roleNames } from '../../domain/catalog/roles';
import type { GameObservation } from '../../domain/model';
import type { CaseNotes, SuspectNote, Suspicion } from '../../storage/browserStorage';
import styles from './SuspectBook.module.css';

interface SuspectBookProps {
  headingId: string;
  observation: GameObservation;
  notes: CaseNotes;
  onUpdate(playerId: number, note: SuspectNote): void;
}

const emptyNote: SuspectNote = { suspicion: 'unknown', reason: '', evidenceIds: [] };
const options: { value: Suspicion; label: string }[] = [
  { value: 'unknown', label: '待定' },
  { value: 'good', label: '偏好人' },
  { value: 'wolf', label: '偏狼人' },
];

export function SuspectBook({ headingId, observation, notes, onUpdate }: SuspectBookProps) {
  const speeches = observation.publicEvents.filter((event) => event.kind === 'speech' || event.kind === 'last-words');
  return <section className={styles.book} aria-labelledby={headingId}>
    <header><BookOpen /><div><span>BLIND TRIAL</span><h2 id={headingId}>嫌疑簿</h2></div></header>
    <div className={styles.scroll}>
      {observation.players.filter((player) => player.id !== 99).map((player) => {
        const note = notes.suspects[String(player.id)] ?? emptyNote;
        const linked = note.evidenceIds.map((id) => speeches.find((event) => event.id === id)).filter((event) => event !== undefined);
        return <div key={player.id} className={styles.suspect}>
          <div className={styles.identity}><strong>{player.id + 1}号 {player.name}</strong>{observation.result && <span>{player.roleId ? roleNames[player.roleId] : '身份未知'}</span>}</div>
          <div className={styles.segmented} role="group" aria-label={`${player.name}的嫌疑判断`}>
            {options.map((option) => <button key={option.value} type="button" aria-pressed={note.suspicion === option.value} onClick={() => onUpdate(player.id, { ...note, suspicion: option.value })}>{option.label}</button>)}
          </div>
          <label className={styles.reasonLabel}>判断理由<textarea value={note.reason} maxLength={2000} rows={2} placeholder="写下目前的判断" onChange={(event) => onUpdate(player.id, { ...note, reason: event.target.value })} /></label>
          <label className={styles.evidenceLabel}><Link2 />引用证言
            <select value="" onChange={(event) => { if (event.target.value && !note.evidenceIds.includes(event.target.value)) onUpdate(player.id, { ...note, evidenceIds: [...note.evidenceIds, event.target.value].slice(0, 20) }); }}>
              <option value="">选择庭审记录</option>
              {speeches.filter((event) => !note.evidenceIds.includes(event.id)).map((event) => <option key={event.id} value={event.id}>第 {event.day} 天 · {event.text.slice(0, 44)}</option>)}
            </select>
          </label>
          {linked.length > 0 && <ul className={styles.evidence}>{linked.map((event) => <li key={event.id}><span title={event.text}>第 {event.day} 天 · {event.text}</span><button type="button" aria-label="移除引用证言" onClick={() => onUpdate(player.id, { ...note, evidenceIds: note.evidenceIds.filter((id) => id !== event.id) })}><X /></button></li>)}</ul>}
        </div>;
      })}
      {notes.snapshots.length > 0 && <div className={styles.snapshots}><h3>投票前判断</h3>{notes.snapshots.map((snapshot) => <details key={`${snapshot.day}-${snapshot.round}`}><summary>第 {snapshot.day} 天 · 第 {snapshot.round} 轮投票前</summary><ul>{observation.players.filter((player) => player.id !== 99).map((player) => <li key={player.id}>{player.id + 1}号 {player.name}：{options.find((option) => option.value === (snapshot.notes[String(player.id)]?.suspicion ?? 'unknown'))?.label}{snapshot.notes[String(player.id)]?.reason ? `，${snapshot.notes[String(player.id)]?.reason}` : ''}</li>)}</ul></details>)}</div>}
    </div>
  </section>;
}
