import { ArrowDown, Gavel, MessageSquareText, Moon, ScrollText, Skull, Sparkles, Sunrise, Vote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { GameObservation, TimelineEvent } from '../../domain/model';
import styles from './Transcript.module.css';

interface TranscriptProps { observation: GameObservation; phaseLabel: string; }

function EventIcon({ event }: { event: TimelineEvent }) {
  if (event.kind === 'speech') return <MessageSquareText />;
  if (event.kind === 'vote') return <Vote />;
  if (event.kind === 'death') return <Skull />;
  if (event.kind === 'dawn') return <Sunrise />;
  if (event.kind === 'exile' || event.kind === 'result') return <Gavel />;
  if (event.phase.includes('night')) return <Moon />;
  if (event.kind === 'skill' || event.kind === 'trial-by-fire') return <Sparkles />;
  return <ScrollText />;
}

export function Transcript({ observation, phaseLabel }: TranscriptProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const playerById = new Map(observation.players.map((player) => [player.id, player]));

  useEffect(() => {
    if (!following) return;
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' });
  }, [following, observation.publicEvents.length]);

  return <section className={styles.transcript} aria-labelledby="transcript-title">
    <header><h2 id="transcript-title"><span>DAY {String(observation.day).padStart(2, '0')}</span><i aria-hidden="true">·</i><span>{phaseLabel}</span><i aria-hidden="true">·</i><strong>实时庭审记录</strong></h2></header>
    <div ref={viewportRef} className={styles.viewport} tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget;
      setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 72);
    }}>
      {observation.publicEvents.map((event) => {
        const speaker = event.kind === 'speech' && event.displayAuthorPlayerId !== null
          ? playerById.get(event.displayAuthorPlayerId)
          : null;
        return <article key={event.id} className={`${styles.event} ${event.kind === 'trial-by-fire' || event.kind === 'result' ? styles.major : ''}`}>
          <span className={styles.icon}><EventIcon event={event} /></span>
          <div><span className={styles.meta}>第 {event.day} 天 · {event.phase}</span>
            {speaker && <div className={styles.speaker}><img src={speaker.avatarUrl} alt="" /><strong>{speaker.name}</strong></div>}
            <p>{event.text}</p>
            {observation.omniscient && event.data.hasForgedFragment === true && <small>观战标记：含声音模仿片段，真实来源为 {event.actualAuthorPlayerId === null ? '未知' : `${event.actualAuthorPlayerId + 1}号`}。</small>}
          </div>
        </article>;
      })}
      {observation.publicEvents.length === 0 && <p className={styles.empty}>审判记录尚未开始。</p>}
    </div>
    {!following && <button className={styles.latest} type="button" onClick={() => { setFollowing(true); viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown />回到最新</button>}
  </section>;
}
