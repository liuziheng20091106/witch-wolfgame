import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';
import type { AiDebugReport } from './debugReport';

export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';
export type JsonOutputMode = 'auto' | 'force' | 'disabled';
export type AiProviderKind = 'free' | 'custom';

export interface FreeAiProviderConfig {
  provider: 'free';
  retryCount: number;
  endpoint?: string;
  origin?: string;
  allowHttp?: boolean;
}

export type AiProfileKind = 'default' | 'fast' | 'deep';

export interface AiModelProfile {
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface AiModelProfileOverride {
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface AiModelProfiles {
  default: AiModelProfile;
  fast: AiModelProfileOverride;
  deep: AiModelProfileOverride;
}

export interface ResolvedAiProfile extends AiModelProfile {
  kind: AiProfileKind;
}
export interface CustomAiProviderConfig {
  provider: 'custom';
  endpoint: string;
  apiKey: string;
  profiles: AiModelProfiles;
  retryCount: number;
  jsonOutputMode: JsonOutputMode;
  /** 单次决策请求超时（毫秒）。默认 60s；本地大模型/长上下文建议加大。 */
  timeoutMs?: number;
}

export type AiProviderConfig = FreeAiProviderConfig | CustomAiProviderConfig;

export function classifyAiDecision(pending: PendingDecision): AiProfileKind {
  if (pending.schemaKey === 'speech'
    || pending.schemaKey === 'wolf-council'
    || pending.schemaKey === 'liquid-control'
    || pending.schemaKey === 'levitation'
    || pending.schemaKey === 'voice-mimic'
    || pending.kind === 'wolf-decision'
    || pending.kind === 'witch-action'
    || pending.kind === 'vote'
    || pending.kind === 'runoff'
    || pending.kind === 'tie-break') {
    return 'deep';
  }
  if (pending.kind === 'seer-action'
    || pending.kind === 'healing'
    || pending.schemaKey === 'ignition'
    || pending.schemaKey === 'optional-target') {
    return 'fast';
  }
  return 'default';
}

export function resolveAiProfile(config: CustomAiProviderConfig, pending: PendingDecision): ResolvedAiProfile {
  const kind = classifyAiDecision(pending);
  if (kind === 'default') return { kind, ...config.profiles.default };
  const override = config.profiles[kind];
  return {
    kind,
    model: override.model.trim() || config.profiles.default.model,
    reasoningEffort: override.reasoningEffort ?? config.profiles.default.reasoningEffort,
  };
}

export const FREE_PROVIDER_ENDPOINT = import.meta.env?.VITE_MAIN_BACKEND_ENDPOINT?.trim() || 'https://freeapi.majowolf.tkcloud.online/api/ai/chat/completions';

export interface AiDecisionRequest<T extends SubmittedDecision = SubmittedDecision> {
  observation: GameObservation;
  pendingDecision: PendingDecision;
  sessionId: string;
  resultType?: T;
}

export type AiCommandErrorKind = 'config' | 'http' | 'timeout' | 'network' | 'empty' | 'json' | 'schema' | 'target' | 'decision' | 'cancelled';

export interface AiRemoteError {
  code: string;
  reason: string | null;
  path: string | null;
}

export interface AiCommandErrorOptions {
  status?: number | null;
  rawOutput?: string | null;
  remoteError?: AiRemoteError | null;
  debugReport?: AiDebugReport | null;
}

export class AiCommandError extends Error {
  readonly kind: AiCommandErrorKind;
  readonly status: number | null;
  readonly rawOutput: string | null;
  readonly remoteError: AiRemoteError | null;
  readonly debugReport: AiDebugReport | null;

  constructor(kind: AiCommandErrorKind, message: string, options: AiCommandErrorOptions = {}) {
    super(message);
    this.name = 'AiCommandError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.rawOutput = options.rawOutput ?? null;
    this.remoteError = options.remoteError ?? null;
    this.debugReport = options.debugReport ?? null;
  }
}
export function isRetryableAiError(error: Pick<AiCommandError, 'kind' | 'status'>): boolean {
  if (error.kind === 'http') {
    return error.status === 408
      || error.status === 425
      || error.status === 429
      || (error.status !== null && error.status >= 500 && error.status <= 599);
  }
  return error.kind === 'network'
    || error.kind === 'timeout'
    || error.kind === 'empty'
    || error.kind === 'json'
    || error.kind === 'schema'
    || error.kind === 'target'
    || error.kind === 'decision';
}

export const defaultAiConfig: FreeAiProviderConfig = {
  provider: 'free',
  retryCount: 2,
};

export const defaultCustomAiConfig: CustomAiProviderConfig = {
  provider: 'custom',
  endpoint: '',
  apiKey: '',
  profiles: {
    default: { model: '', reasoningEffort: 'low' },
    fast: { model: '', reasoningEffort: 'none' },
    deep: { model: '', reasoningEffort: 'high' },
  },
  retryCount: 2,
  jsonOutputMode: 'auto',
  timeoutMs: 120_000,
};
