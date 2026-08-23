import { AlertTriangle, Clipboard, Download, RefreshCcw, Send, Settings, WifiOff } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { aiDebugReportFilename, formatAiDebugReport } from '../../ai/debugReport';
import type { AiCommandError } from '../../ai/types';
import { copyTextToClipboard } from '../../app/clipboard';
import type { GameObservation, PendingDecision, SubmittedDecision } from '../../domain/model';
import styles from './DecisionPanel.module.css';

function formatPayloadSize(text: string): string {
  const bytes = new TextEncoder().encode(text).byteLength;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

interface DecisionPanelProps {
  observation: GameObservation;
  aiError: AiCommandError | null;
  awaitingRetry: boolean;
  thinking: boolean;
  decisionError: string | null;
  onSubmit(decision: SubmittedDecision): void;
  onRetry(): void;
  onLocal(): void;
  onSettings(): void;
}

export function DecisionPanel({ observation, aiError, awaitingRetry, thinking, decisionError, onSubmit, onRetry, onLocal, onSettings }: DecisionPanelProps) {
  const [debugExportStatus, setDebugExportStatus] = useState<'idle' | 'copied' | 'downloaded' | 'failed'>('idle');
  const [debugExportError, setDebugExportError] = useState<string | null>(null);
  const debugReportText = aiError?.debugReport ? formatAiDebugReport(aiError.debugReport) : null;
  const debugReportSize = debugReportText ? formatPayloadSize(debugReportText) : null;
  const copyDebugReport = async () => {
    if (!debugReportText) return;
    try {
      await copyTextToClipboard(debugReportText, { verify: true });
      setDebugExportStatus('copied');
      setDebugExportError(null);
    } catch (error) {
      setDebugExportStatus('failed');
      setDebugExportError(error instanceof Error ? `复制失败，剪贴板未更新：${error.message}` : '复制失败，剪贴板未更新。请改用下载。');
    }
  };
  const downloadDebugReport = () => {
    if (!aiError?.debugReport || !debugReportText) return;
    try {
      const url = URL.createObjectURL(new Blob([debugReportText], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = aiDebugReportFilename(aiError.debugReport);
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setDebugExportStatus('downloaded');
      setDebugExportError(null);
    } catch (error) {
      setDebugExportStatus('failed');
      setDebugExportError(error instanceof Error ? `下载调试信息失败：${error.message}` : '下载调试信息失败，请重试。');
    }
  };
  const pending = observation.pendingDecision;
  const humanDecision = pending !== null && observation.viewerPlayerId === pending.actorId;
  const [useSkill, setUseSkill] = useState(true);
  const [target, setTarget] = useState('');
  const [speech, setSpeech] = useState('');
  const [save, setSave] = useState(false);
  const [poison, setPoison] = useState('');
  const [mode, setMode] = useState('');
  const [factId, setFactId] = useState('');
  const [forgedSpeech, setForgedSpeech] = useState('');

  useEffect(() => {
    setUseSkill(true);
    setTarget('');
    setSpeech('');
    setSave(false);
    setPoison('');
    setMode('');
    setFactId('');
    setForgedSpeech('');
  }, [pending?.id]);

  useEffect(() => {
    setDebugExportStatus('idle');
    setDebugExportError(null);
  }, [aiError]);

  const candidateNames = useMemo(() => new Map(observation.players.map((player) => [player.id, player.name])), [observation.players]);
  const requiredMention = typeof pending?.options.requiredMention === 'string' ? pending.options.requiredMention : null;
  const requiredSeatLabel = typeof pending?.options.requiredSeatLabel === 'string' ? pending.options.requiredSeatLabel : null;
  const mentionsRequired = (value: string) => !requiredMention || value.includes(requiredMention) || (requiredSeatLabel !== null && value.includes(requiredSeatLabel));
  const errorMeta = aiError
    ? [
      aiError.status !== null ? `HTTP ${aiError.status}` : null,
      aiError.remoteError?.code ?? null,
      aiError.remoteError?.reason ?? null,
      aiError.remoteError?.path ?? null,
    ].filter((value): value is string => value !== null).join(' · ')
    : '';

  if (aiError || awaitingRetry) {
    return <section className={styles.panel} aria-live="polite">
      <div className={styles.errorHead}><AlertTriangle /><div><span>AI COMMAND PAUSED</span><h2>{aiError ? 'AI 决策失败' : '已恢复待处理决策'}</h2></div></div>
      <p>{aiError?.message ?? '为避免刷新后自动重复产生费用，本次 AI 请求等待你的确认。'}</p>
      {errorMeta && <p className={styles.errorMeta}>{errorMeta}</p>}
      {debugReportText && debugReportSize && <div className={styles.debugActions}>
        <button type="button" onClick={copyDebugReport}><Clipboard />{debugExportStatus === 'copied' ? `已复制 ${debugReportSize}` : `复制调试信息 · ${debugReportSize}`}</button>
        <button type="button" onClick={downloadDebugReport}><Download />{debugExportStatus === 'downloaded' ? `已下载 ${debugReportSize}` : `下载调试信息 · ${debugReportSize}`}</button>
      </div>}
      {debugExportError && <p className={styles.debugError} role="status">{debugExportError}</p>}
      <div className={styles.errorActions}>
        <button type="button" onClick={onRetry}><RefreshCcw />重试</button>
        <button type="button" onClick={onLocal}><WifiOff />本局改用本地策略</button>
        <button type="button" onClick={onSettings}><Settings />返回设置</button>
      </div>
    </section>;
  }

  if (!humanDecision || !pending) return null;

  const targetControl = (allowEmpty: boolean) => <fieldset className={styles.candidates}>
    <legend>{pending.options.potionChoice === true ? '选择药水' : '目标'}</legend>
    {allowEmpty && <label><input type="radio" name="target" value="" checked={target === ''} onChange={() => setTarget('')} /><span>弃权 / 不选择</span></label>}
    {pending.candidates.map((playerId) => {
      let label = `${playerId + 1}号 · ${candidateNames.get(playerId)}`;
      if (pending.options.potionChoice === true) {
        label = playerId === 0 ? '解药' : '毒药';
      }
      return <label key={playerId}><input type="radio" name="target" value={playerId} checked={target === String(playerId)} onChange={() => setTarget(String(playerId))} /><span>{label}</span></label>;
    })}
  </fieldset>;

  let valid = true;
  if (pending.schemaKey === 'speech') valid = speech.length <= 100 && mentionsRequired(speech);
  if (pending.schemaKey === 'target') valid = pending.allowAbstain || target !== '';
  if (pending.schemaKey === 'optional-target') valid = !useSkill || target !== '';
  if (pending.schemaKey === 'liquid-control') valid = !useSkill || (mode === 'extract' ? target !== '' : mode === 'spread' && factId !== '');
  if (pending.schemaKey === 'levitation') valid = !useSkill || mode === 'tie-break' || ((mode === 'move-first' || mode === 'move-last') && target !== '');
  if (pending.schemaKey === 'voice-mimic') valid = !useSkill || (target !== '' && forgedSpeech.length > 0 && forgedSpeech.length <= 50 && mentionsRequired(forgedSpeech));

  const submit = () => {
    let decision: SubmittedDecision;
    if (pending.schemaKey === 'speech') decision = { speech };
    else if (pending.schemaKey === 'target') decision = { targetPlayerId: target === '' ? null : Number(target) as 0 | 1 | 2 | 3 | 4 | 5 };
    else if (pending.schemaKey === 'optional-target') decision = { use: useSkill, targetPlayerId: useSkill ? Number(target) as 0 | 1 | 2 | 3 | 4 | 5 : null };
    else if (pending.schemaKey === 'witch') decision = { save, poisonTargetPlayerId: poison === '' ? null : Number(poison) as 0 | 1 | 2 | 3 | 4 | 5 };
    else if (pending.schemaKey === 'liquid-control') decision = { use: useSkill, mode: useSkill ? mode as 'extract' | 'spread' : null, targetPlayerId: useSkill && mode === 'extract' ? Number(target) as 0 | 1 | 2 | 3 | 4 | 5 : null, factId: useSkill && mode === 'spread' ? factId : null };
    else if (pending.schemaKey === 'levitation') decision = { use: useSkill, mode: useSkill ? mode as 'move-first' | 'move-last' | 'tie-break' : null, targetPlayerId: useSkill && mode !== 'tie-break' ? Number(target) as 0 | 1 | 2 | 3 | 4 | 5 : null };
    else if (pending.schemaKey === 'voice-mimic') decision = { use: useSkill, targetPlayerId: useSkill ? Number(target) as 0 | 1 | 2 | 3 | 4 | 5 : null, forgedSpeech: useSkill ? forgedSpeech : null };
    else decision = { use: useSkill };
    onSubmit(decision);
  };

  // 遗言表单文案：遗言与公开发言共用 speech 表单，用 if/else 区分文案（项目禁三目）
  let speechLabel = '公开发言';
  let speechPlaceholder = '也可以留空保持沉默';
  if (pending.options.lastWords === true) {
    speechLabel = '遗言';
    speechPlaceholder = '留下最后的话（可留空）';
  }

  return <section className={styles.panel} aria-labelledby="decision-title">
    <header><span>YOUR DECISION</span><h2 id="decision-title">{pending.title}</h2><p>{pending.description}</p></header>
    <div className={styles.body}>
      {pending.schemaKey === 'speech' && <label className={styles.textarea}>{speechLabel}<textarea maxLength={100} value={speech} onChange={(event) => setSpeech(event.target.value)} placeholder={speechPlaceholder} /><span>{speech.length}/100</span></label>}
      {pending.schemaKey === 'target' && targetControl(pending.allowAbstain)}
      {(pending.schemaKey === 'optional-target' || pending.schemaKey === 'liquid-control' || pending.schemaKey === 'levitation' || pending.schemaKey === 'voice-mimic' || pending.schemaKey === 'ignition') && <label className={styles.toggle}><input type="checkbox" checked={useSkill} onChange={(event) => setUseSkill(event.target.checked)} /><span>本次使用技能</span></label>}
      {pending.schemaKey === 'optional-target' && useSkill && targetControl(false)}
      {pending.schemaKey === 'witch' && <><label className={styles.toggle}><input type="checkbox" checked={save} disabled={pending.options.canSave !== true} onChange={(event) => setSave(event.target.checked)} /><span>使用解药救下狼刀目标</span></label><label className={styles.select}>毒药目标<select value={poison} onChange={(event) => setPoison(event.target.value)}><option value="">不用毒</option>{pending.candidates.map((id) => <option key={id} value={id}>{id + 1}号 · {candidateNames.get(id)}</option>)}</select></label></>}
      {pending.schemaKey === 'liquid-control' && useSkill && <><div className={styles.segment}><button type="button" className={mode === 'extract' ? styles.selected : ''} onClick={() => setMode('extract')}>抽取职业</button><button type="button" className={mode === 'spread' ? styles.selected : ''} onClick={() => setMode('spread')}>传播事实</button></div>{mode === 'extract' && targetControl(false)}{mode === 'spread' && <label className={styles.select}>已知事实<select value={factId} onChange={(event) => setFactId(event.target.value)}><option value="">请选择</option>{Array.isArray(pending.options.factIds) && pending.options.factIds.map((id, index) => typeof id === 'string' && <option key={id} value={id}>事实 {index + 1}</option>)}</select></label>}</>}
      {pending.schemaKey === 'levitation' && useSkill && <><div className={styles.segment}><button type="button" className={mode === 'move-first' ? styles.selected : ''} onClick={() => setMode('move-first')}>移到首位</button><button type="button" className={mode === 'move-last' ? styles.selected : ''} onClick={() => setMode('move-last')}>移到末位</button><button type="button" className={mode === 'tie-break' ? styles.selected : ''} onClick={() => setMode('tie-break')}>平票裁决</button></div>{mode !== 'tie-break' && mode !== '' && targetControl(false)}</>}
      {pending.schemaKey === 'voice-mimic' && useSkill && <>{targetControl(false)}<label className={styles.textarea}>伪造片段<textarea maxLength={50} value={forgedSpeech} onChange={(event) => setForgedSpeech(event.target.value)} /><span>{forgedSpeech.length}/50</span></label></>}
      {requiredMention && !mentionsRequired(pending.schemaKey === 'voice-mimic' ? forgedSpeech : speech) && <p className={styles.requirement}>必须提及“{requiredMention}”或“{requiredSeatLabel}”。</p>}
      {decisionError && <p className={styles.decisionError} role="alert">{decisionError}</p>}
    </div>
    <button className={styles.submit} type="button" disabled={!valid} onClick={submit}><Send />提交决策</button>
  </section>;
}
