import { Copy, LogIn, Play, Radio, UserRound, Users, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import type { MultiplayerController } from '../../multiplayer/useMultiplayerRoom';
import { characterById, characters } from '../../domain/catalog/characters';
import type { CharacterId } from '../../domain/model';
import { copyTextToClipboard } from '../../app/clipboard';
import styles from './MultiplayerLobby.module.css';

interface MultiplayerLobbyProps {
  multiplayer: MultiplayerController;
  defaultCharacterId: CharacterId | null;
}

export function MultiplayerLobby({ multiplayer, defaultCharacterId }: MultiplayerLobbyProps) {
  const [playerName, setPlayerName] = useState('玩家');
  const [roomCode, setRoomCode] = useState('');
  const [characterId, setCharacterId] = useState<CharacterId>(defaultCharacterId ?? 'soul-0');
  const [playerCount, setPlayerCount] = useState(6);
  const [copied, setCopied] = useState(false);
  const room = multiplayer.room;
  const self = room?.participants.find((participant) => participant.participantId === room.selfParticipantId) ?? null;
  const host = room !== null && room.hostParticipantId === room.selfParticipantId;
  const canStart = host && room?.participants.every((participant) => participant.ready) === true;
  const participantPlayerIds = new Set<number>(room?.participants.map((participant) => participant.playerId) ?? []);

  if (room !== null) {
    return <section className={styles.lobby} aria-labelledby="multiplayer-lobby-title">
      <header><Radio /><div><span>ONLINE ROOM · {room.playerCount} SEATS</span><h2 id="multiplayer-lobby-title">房间 {room.roomCode}</h2></div><button type="button" className={styles.copy} onClick={() => { void copyTextToClipboard(room.roomCode).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200); }); }}><Copy />{copied ? '已复制' : '复制房间号'}</button></header>
      <div className={styles.status}><span>{multiplayer.connected ? <Wifi /> : <WifiOff />}{multiplayer.connected ? '已连接' : '连接中断'}</span><strong>{room.status === 'lobby' ? '等待准备' : room.status === 'playing' ? '审判进行中' : room.status === 'failed' ? '审判异常终止' : '审判已结束'}</strong></div>
      <div className={styles.participants}>
        {room.participants.map((participant) => {
          const character = characterById[participant.characterId];
          return <article key={participant.participantId} className={participant.participantId === room.selfParticipantId ? styles.self : ''}>
            <img src={character.avatarUrl} alt="" />
            <div><strong>{participant.playerName}{participant.host ? ' · 房主' : ''}</strong><span>{character.name} · {participant.playerId + 1}号席</span></div>
            <small>{room.drivers[participant.playerId]?.kind === 'ai' ? participant.connected ? 'AI 驱动' : 'AI 驱动 · 等待重连' : participant.connected ? participant.ready ? '已准备' : '未准备' : '等待重连'}</small>
          </article>;
        })}
        {room.drivers.map((driver, index) => driver.kind === 'ai' && !participantPlayerIds.has(index) && <article key={`ai-${index}`} className={styles.aiSeat}><UserRound /><div><strong>AI 驱动</strong><span>{index + 1}号席</span></div><small>自动</small></article>)}
      </div>
      {room.failureMessage && <p className={styles.error} role="alert">{room.failureMessage}。房间已停止推进，请离开房间重新创建。</p>}
      {room.status === 'failed' && <div className={styles.actions}><button type="button" onClick={multiplayer.leaveRoom}>离开房间</button></div>}
      {room.status === 'lobby' && <div className={styles.actions}>
        <button type="button" className={self?.ready ? styles.ready : ''} onClick={() => multiplayer.setReady(!self?.ready)}>{self?.ready ? '取消准备' : '准备'}</button>
        {host && <button type="button" className={styles.start} disabled={!canStart} onClick={multiplayer.startGame}><Play />开始游戏</button>}
        <button type="button" onClick={multiplayer.leaveRoom}>离开房间</button>
      </div>}
      {multiplayer.error && <p className={styles.error} role="alert">{multiplayer.error}</p>}
    </section>;
  }

  return <section className={styles.join} aria-labelledby="multiplayer-title">
    <header><Users /><div><span>MULTIPLAYER · 6–14 SEATS</span><h2 id="multiplayer-title">多人联机</h2><p>房主可配置 6–14 席；真人占用的席位由浏览器驱动，其余席位由确定性 AI 驱动。</p></div></header>
    <div className={styles.fields}>
      <label>显示名<input maxLength={24} value={playerName} onChange={(event) => setPlayerName(event.target.value)} /></label>
      <label>角色<select value={characterId} onChange={(event) => setCharacterId(event.target.value as CharacterId)}>{characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>
      <label>房间人数<select value={playerCount} onChange={(event) => setPlayerCount(Number(event.target.value))}>{Array.from({ length: 9 }, (_, index) => index + 6).map((count) => <option key={count} value={count}>{count} 人</option>)}</select></label>
      <label>房间号<input maxLength={6} value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} placeholder="ABC234" /></label>
    </div>
    <div className={styles.actions}><button type="button" onClick={() => multiplayer.createRoom(playerName.trim(), characterId, playerCount)} disabled={multiplayer.connecting || !playerName.trim()}><Radio />创建房间</button><button type="button" onClick={() => multiplayer.joinRoom(roomCode, playerName.trim(), characterId)} disabled={multiplayer.connecting || roomCode.length !== 6 || !playerName.trim()}><LogIn />加入房间</button></div>
    {multiplayer.connecting && <p>正在连接多人服务器…</p>}
    {multiplayer.error && <p className={styles.error} role="alert">{multiplayer.error}</p>}
  </section>;
}
