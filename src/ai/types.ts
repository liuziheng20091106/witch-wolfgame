import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';
import type { AiDebugReport } from './debugReport';

export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';
export type JsonOutputMode = 'auto' | 'force' | 'disabled';
export type AiProviderKind = 'free' | 'custom';

export interface FreeAiProviderConfig {
  provider: 'free';
  retryCount: number;
}

export interface CustomAiProviderConfig {
  provider: 'custom';
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  retryCount: number;
  jsonOutputMode: JsonOutputMode;
}

export type AiProviderConfig = FreeAiProviderConfig | CustomAiProviderConfig;

export const FREE_PROVIDER_ENDPOINT = import.meta.env.VITE_MAIN_BACKEND_ENDPOINT?.trim() || 'https://freeapi.majowolf.tkcloud.online/api/ai/chat/completions';

export interface AiDecisionRequest<T extends SubmittedDecision = SubmittedDecision> {
  observation: GameObservation;
  pendingDecision: PendingDecision;
  sessionId: string;
  resultType?: T;
}

export type AiCommandErrorKind = 'config' | 'http' | 'timeout' | 'network' | 'empty' | 'json' | 'schema' | 'target' | 'cancelled';

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
    || error.kind === 'schema';
}

export const defaultAiConfig: FreeAiProviderConfig = {
  provider: 'free',
  retryCount: 2,
};

export const defaultCustomAiConfig: CustomAiProviderConfig = {
  provider: 'custom',
  endpoint: '',
  apiKey: '',
  model: '',
  reasoningEffort: 'low',
  retryCount: 2,
  jsonOutputMode: 'auto',
};
