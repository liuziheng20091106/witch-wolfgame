import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';

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
export const FREE_PROVIDER_CLIENT_NAME = 'majo-wolf';

export interface AiDecisionRequest<T extends SubmittedDecision = SubmittedDecision> {
  observation: GameObservation;
  pendingDecision: PendingDecision;
  sessionId: string;
  resultType?: T;
}

export type AiCommandErrorKind = 'config' | 'http' | 'timeout' | 'network' | 'empty' | 'json' | 'schema' | 'target';

export class AiCommandError extends Error {
  readonly kind: AiCommandErrorKind;
  readonly status: number | null;
  readonly rawOutput: string | null;

  constructor(kind: AiCommandErrorKind, message: string, status: number | null = null, rawOutput: string | null = null) {
    super(message);
    this.name = 'AiCommandError';
    this.kind = kind;
    this.status = status;
    this.rawOutput = rawOutput;
  }
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
