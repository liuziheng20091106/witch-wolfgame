import { CircleCheck, Eye, EyeOff, Heart, Save, ShieldCheck, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { validateAiEndpoint } from '../../ai/client';
import { APP_VERSION } from '../../config/version';
import supportQr from '../../assets/support/free-provider-wechat.png';
import {
  defaultCustomAiConfig,
  FREE_PROVIDER_ENDPOINT,
  type AiProviderConfig,
  type CustomAiProviderConfig,
} from '../../ai/types';
import styles from './AiSettingsDrawer.module.css';

interface AiSettingsDrawerProps {
  open: boolean;
  config: AiProviderConfig;
  onClose(): void;
  onSave(config: AiProviderConfig): void;
}

export function AiSettingsDrawer({ open, config, onClose, onSave }: AiSettingsDrawerProps) {
  const [draft, setDraft] = useState<AiProviderConfig>(config);
  const [customDraft, setCustomDraft] = useState<CustomAiProviderConfig>(
    config.provider === 'custom' ? config : defaultCustomAiConfig,
  );
  const [showKey, setShowKey] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(config);
    if (config.provider === 'custom') setCustomDraft(config);
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

  const updateCustom = (patch: Partial<CustomAiProviderConfig>) => {
    const next = { ...customDraft, ...patch };
    setCustomDraft(next);
    setDraft(next);
    setValidationError(null);
  };
  const updateReasoningEffort = (reasoningEffort: CustomAiProviderConfig['reasoningEffort']) => {
    updateCustom({ reasoningEffort });
  };
  const chooseProvider = (provider: AiProviderConfig['provider']) => {
    setDraft(provider === 'free' ? { provider: 'free' } : customDraft);
    setValidationError(null);
  };
  const validate = () => {
    if (draft.provider === 'free') return;
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
          <div><span className={styles.eyebrow}>AI SERVICE</span><h2 id="ai-settings-title">AI 服务设置</h2></div>
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
          <div className={styles.providerPicker} role="group" aria-label="AI 服务来源">
            <button type="button" className={draft.provider === 'free' ? styles.providerSelected : styles.providerOption} aria-pressed={draft.provider === 'free'} onClick={() => chooseProvider('free')}>
              <Sparkles /><span><strong>免费服务</strong><small>公益服务，不保证稳定可用</small></span>{draft.provider === 'free' && <CircleCheck />}
            </button>
            <button type="button" className={draft.provider === 'custom' ? styles.providerSelected : styles.providerOption} aria-pressed={draft.provider === 'custom'} onClick={() => chooseProvider('custom')}>
              <ShieldCheck /><span><strong>自定义服务</strong><small>使用你的 Chat Completions 端点</small></span>{draft.provider === 'custom' && <CircleCheck />}
            </button>
          </div>
          {draft.provider === 'free' ? <section className={styles.freeService} aria-labelledby="free-service-title">
            <span>FREE SERVICE</span><h3 id="free-service-title">魔女狼人杀免费服务</h3>
            <p>公益服务不保证稳定可用；若服务不可用，可在下方切换为自定义服务。</p>
            <dl><dt>请求地址</dt><dd>{FREE_PROVIDER_ENDPOINT}</dd></dl>
            <div className={styles.support}><div className={styles.qrFrame}><img src={supportQr} alt="微信赞赏二维码" /></div><div><Heart /><strong>支持免费服务</strong><p>若这局体验不错，欢迎扫码赞赏，让免费服务持续可用。</p></div></div>
          </section> : <>
            <label className={styles.wide}>完整端点<input value={customDraft.endpoint} onChange={(event) => updateCustom({ endpoint: event.target.value })} inputMode="url" placeholder="https://example.com/v1/chat/completions" /></label>
            <label>模型<input value={customDraft.model} onChange={(event) => updateCustom({ model: event.target.value })} placeholder="模型 ID" /></label>
            <label>API Key<span className={styles.keyField}><input type={showKey ? 'text' : 'password'} value={customDraft.apiKey} onChange={(event) => updateCustom({ apiKey: event.target.value })} autoComplete="off" /><button type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff /> : <Eye />}</button></span></label>
          </>}
          {draft.provider === 'custom' && <><label className={styles.reasoning}>思考强度<select value={customDraft.reasoningEffort} onChange={(event) => updateReasoningEffort(event.target.value as CustomAiProviderConfig['reasoningEffort'])}><option value="none">none</option><option value="low">low</option><option value="high">high</option><option value="max">max</option></select></label><p className={styles.disclosure}><ShieldCheck />API Key 以明文仅保存在此浏览器的当前站点存储中。</p></>}
          {validationError && <p className={styles.error} role="alert">{validationError}</p>}
          <footer className={styles.actions}><button className={styles.primary} type="submit"><Save />保存设置</button></footer>
        </form>
      </div>
    </div>
  );
}
