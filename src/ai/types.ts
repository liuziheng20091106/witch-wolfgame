import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';

export type AiProtocol = 'openai-compatible' | 'deepseek';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface AiProviderConfig {
  providerName: string;
  protocol: AiProtocol;
  endpoint: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

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

export const defaultAiConfig: AiProviderConfig = {
  providerName: 'DeepSeek',
  protocol: 'deepseek',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  apiKey: '',
  model: '',
  reasoningEffort: 'low',
};
