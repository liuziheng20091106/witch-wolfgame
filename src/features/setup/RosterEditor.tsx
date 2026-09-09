import { Minus, Plus, RotateCcw } from 'lucide-react';
import { ROLE_CATALOG, rolePoolError, rolePoolForPlayerCount } from '../../../shared/gamePromptContract.js';
import type { RoleId, RosterOptions } from '../../domain/model';
import styles from './RosterEditor.module.css';

interface Props {
  playerCount: number;
  value: RosterOptions;
  onChange(value: RosterOptions): void;
}

export function RosterEditor({ playerCount, value, onChange }: Props) {
  const pool = value.rolePool ?? [...rolePoolForPlayerCount(playerCount)];
  const error = rolePoolError(pool, playerCount);
  const updateCount = (id: RoleId, count: number) => {
    const counts = new Map(ROLE_CATALOG.map((role) => [role.id, pool.filter((entry) => entry === role.id).length]));
    counts.set(id, count);
    onChange({ ...value, rolePool: ROLE_CATALOG.flatMap((role) => Array<RoleId>(counts.get(role.id) ?? 0).fill(role.id)) });
  };
  return <div className={styles.editor}>
    <div className={styles.heading}><h3>职业版型 <small>{pool.length} / {playerCount}</small></h3><button type="button" onClick={() => onChange({ assignmentMode: value.assignmentMode ?? 'classic' })} title="恢复默认版型" aria-label="恢复默认版型"><RotateCcw /></button></div>
    <div className={styles.modes} role="group" aria-label="身份分配方式">
      <button type="button" aria-pressed={value.assignmentMode !== 'draft'} onClick={() => onChange({ ...value, assignmentMode: 'classic' })}>随机分配</button>
      <button type="button" aria-pressed={value.assignmentMode === 'draft'} onClick={() => onChange({ ...value, assignmentMode: 'draft' })}>顺序选职</button>
    </div>
    <div className={styles.roles}>{ROLE_CATALOG.map((role) => {
      const count = pool.filter((id) => id === role.id).length;
      const cap = role.id === 'wolf' || role.id === 'villager' ? playerCount : 1;
      return <div key={role.id} className={styles.role} data-alignment={role.alignment}>
        <span title={role.description}>{role.name}</span>
        <button type="button" aria-label={`减少${role.name}`} title={`减少${role.name}`} disabled={count === 0} onClick={() => updateCount(role.id, count - 1)}><Minus /></button>
        <output aria-label={`${role.name}人数`}>{count}</output>
        <button type="button" aria-label={`增加${role.name}`} title={`增加${role.name}`} disabled={count >= cap || pool.length >= playerCount} onClick={() => updateCount(role.id, count + 1)}><Plus /></button>
      </div>;
    })}</div>
    {error && <p className={styles.error} role="status">{error}</p>}
  </div>;
}
