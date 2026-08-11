import { Eye, Skull, Sparkles, UserRound } from 'lucide-react';
import { roleNames } from '../../domain/catalog/roles';
import { witchSkillDefinitions } from '../../domain/catalog/witchSkills';
import type { GameObservation, PlayerId } from '../../domain/model';
import styles from './PlayerRoster.module.css';

interface PlayerRosterProps {
  observation: GameObservation;
  currentActorId: PlayerId | null;
  onSelect(playerId: PlayerId): void;
}

export function PlayerRoster({ observation, currentActorId, onSelect }: PlayerRosterProps) {
  return <section className={styles.roster} aria-labelledby="roster-title">
    <header><span>CAST / 06</span><h2 id="roster-title">出庭席位</h2></header>
    <div className={styles.list}>
      {observation.players.map((player) => <button key={player.id} type="button" className={`${styles.player} ${!player.alive ? styles.dead : ''} ${currentActorId === player.id ? styles.current : ''}`} onClick={() => onSelect(player.id)}>
        <span className={styles.number}>{player.id + 1}</span>
        <img src={player.avatarUrl} alt="" />
        <span className={styles.identity}>
          <strong>{player.name}</strong>
          <small>{player.roleId ? roleNames[player.roleId] : '身份未公开'}</small>
        </span>
        <span className={styles.stateIcon}>{!player.alive ? <Skull aria-label="已死亡" /> : currentActorId === player.id ? <Eye aria-label="当前行动" /> : player.isSelf ? <UserRound aria-label="你的席位" /> : <Sparkles aria-hidden="true" />}</span>
        {player.skillId && <span className={styles.skill}>{witchSkillDefinitions[player.skillId].name}</span>}
      </button>)}
    </div>
  </section>;
}
