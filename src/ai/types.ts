import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';

export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';
export type AiProviderKind = 'free' | 'custom';

export interface FreeAiProviderConfig {
  provider: 'free';
}

export interface CustomAiProviderConfig {
  provider: 'custom';
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export type AiProviderConfig = FreeAiProviderConfig | CustomAiProviderConfig;

export const FREE_PROVIDER_ENDPOINT = import.meta.env.VITE_MAIN_BACKEND_ENDPOINT?.trim() || '/api/ai/chat/completions';
export const FREE_PROVIDER_CLIENT_NAME = 'majo-wolf';

export interface AiDecisionRequest<T extends SubmittedDecision = SubmittedDecision> {
  observation: GameObservation;
  pendingDecision: PendingDecision;
  resultType?: T;
}

export type AiCommandErrorKind = 'config' | 'http' | 'timeout' | 'network' | 'empty' | 'json' | 'schema' | 'target';

export class AiCommandError extends Error {
  readonly kind: AiCommandErrorKind;
  readonly status: number | null;

  constructor(kind: AiCommandErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'AiCommandError';
    this.kind = kind;
    this.status = status;
  }
}

export const defaultAiConfig: FreeAiProviderConfig = {
  provider: 'free',
};

export const defaultCustomAiConfig: CustomAiProviderConfig = {
  provider: 'custom',
  endpoint: '',
  apiKey: '',
  model: '',
  reasoningEffort: 'low',
};
