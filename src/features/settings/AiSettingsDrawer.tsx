import { Eye, EyeOff, Save, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { validateAiEndpoint } from '../../ai/client';
import type { AiProviderConfig } from '../../ai/types';
import styles from './AiSettingsDrawer.module.css';

interface AiSettingsDrawerProps {
  open: boolean;
  config: AiProviderConfig;
  onClose(): void;
  onSave(config: AiProviderConfig): void;
}

export function AiSettingsDrawer({ open, config, onClose, onSave }: AiSettingsDrawerProps) {
  const [draft, setDraft] = useState(config);
  const [showKey, setShowKey] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(config);
    setValidationError(null);
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const timer = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>('input, select, button')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [config, open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        previousFocusRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('disabled'));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, open]);

  if (!open) return null;

  const update = <K extends keyof AiProviderConfig>(key: K, value: AiProviderConfig[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  };
  const validate = () => {
    if (!draft.apiKey.trim() || !draft.model.trim()) {
      throw new Error('API Key 和模型不能为空');
    }
    validateAiEndpoint(draft.endpoint);
  };
  const close = () => {
    onClose();
    window.setTimeout(() => previousFocusRef.current?.focus(), 0);
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div ref={panelRef} className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="ai-settings-title">
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>AI SERVICE</span>
            <h2 id="ai-settings-title">AI 服务设置</h2>
          </div>
          <button className={styles.iconButton} type="button" onClick={close} aria-label="关闭设置"><X /></button>
        </header>
        <form className={styles.form} onSubmit={(event) => {
          event.preventDefault();
          try {
            validate();
            onSave(draft);
          } catch (error) {
            setValidationError(error instanceof Error ? error.message : '设置不合法');
          }
        }}>
          <label className={styles.wide}>完整端点<input value={draft.endpoint} onChange={(event) => update('endpoint', event.target.value)} inputMode="url" placeholder="https://example.com/v1/chat/completions" /></label>
          <label>模型<input value={draft.model} onChange={(event) => update('model', event.target.value)} placeholder="模型 ID" /></label>
          <label>思考强度<select value={draft.reasoningEffort} onChange={(event) => update('reasoningEffort', event.target.value as AiProviderConfig['reasoningEffort'])}>
            <option value="none">none</option><option value="low">low</option><option value="high">high</option><option value="max">max</option>
          </select></label>
          <label className={styles.wide}>API Key<span className={styles.keyField}>
            <input type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => update('apiKey', event.target.value)} autoComplete="off" />
            <button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff /> : <Eye />}</button>
          </span></label>
          <p className={styles.disclosure}><ShieldCheck />API Key 以明文仅保存在此浏览器的当前站点存储中。</p>
          {validationError && <p className={styles.error} role="alert">{validationError}</p>}
          <footer className={styles.actions}>
            <button className={styles.primary} type="submit"><Save />保存设置</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
