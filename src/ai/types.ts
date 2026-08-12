import type { GameObservation, PendingDecision, SubmittedDecision } from '../domain/model';

export type ReasoningEffort = 'none' | 'low' | 'high' | 'max';

export interface AiProviderConfig {
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
  endpoint: '',
  apiKey: '',
  model: '',
  reasoningEffort: 'low',
};
