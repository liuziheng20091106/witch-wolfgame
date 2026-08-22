import { APP_VERSION } from '../config/version';
import type { GameObservation } from '../domain/model';
import type { PromptMessage } from './prompts';
import { FREE_PROVIDER_ENDPOINT, type AiCommandError, type AiDecisionRequest, type AiProviderConfig } from './types';

export interface AiDebugReport {
  formatVersion: 1;
  generatedAt: string;
  appVersion: string;
  error: {
    kind: AiCommandError['kind'];
    message: string;
    status: number | null;
    attempt: number;
    maxAttempts: number;
  };
  game: {
    gameId: string;
    seed: number;
    mode: GameObservation['mode'];
    automationMode: GameObservation['automationMode'];
    usedFreeProvider: boolean;
    day: number;
    phase: GameObservation['phase'];
    board: string;
    viewerPlayerId: GameObservation['viewerPlayerId'];
    omniscient: boolean;
    players: GameObservation['players'];
    currentVotes: GameObservation['currentVotes'];
    pendingDecision: AiDecisionRequest['pendingDecision'];
    result: GameObservation['result'];
  };
  request: {
    promptMessages: PromptMessage[];
    jsonOutputRequested: boolean;
    provider: {
      kind: AiProviderConfig['provider'];
      baseUrl: string;
      apiKey: string;
      model: string | null;
      reasoningEffort: string | null;
      retryCount: number;
      jsonOutputMode: string | null;
    };
  };
  response: {
    rawOutput: string | null;
  };
}

interface BuildAiDebugReportOptions {
  request: AiDecisionRequest;
  config: AiProviderConfig;
  messages: PromptMessage[];
  error: AiCommandError;
  attempt: number;
  maxAttempts: number;
  jsonOutputRequested: boolean;
  generatedAt?: Date;
}

function maskHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]') return normalized;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) {
    const [first = '*', second = '*'] = normalized.split('.');
    return `${first}.${second}.*.*`;
  }
  if (normalized.includes(':')) return '[redacted-ipv6]';
  const labels = normalized.split('.');
  const first = labels[0] ?? '';
  labels[0] = first.length > 0 ? `${first[0]}***` : '***';
  return labels.join('.');
}

export function sanitizeAiBaseUrl(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol}//${maskHostname(url.hostname)}${port}${url.pathname}`;
  } catch {
    return '[invalid endpoint]';
  }
}

export function sanitizeApiKey(apiKey: string): string {
  const value = apiKey.trim();
  return value ? `[REDACTED; length=${Array.from(value).length}]` : '[not configured]';
}

export function buildAiDebugReport(options: BuildAiDebugReportOptions): AiDebugReport {
  const { request, config, messages, error } = options;
  const observation = request.observation;
  return {
    formatVersion: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    appVersion: APP_VERSION,
    error: {
      kind: error.kind,
      message: error.message,
      status: error.status,
      attempt: options.attempt,
      maxAttempts: options.maxAttempts,
    },
    game: {
      gameId: observation.gameId,
      seed: observation.seed,
      mode: observation.mode,
      automationMode: observation.automationMode,
      usedFreeProvider: observation.usedFreeProvider,
      day: observation.day,
      phase: observation.phase,
      board: observation.board,
      viewerPlayerId: observation.viewerPlayerId,
      omniscient: observation.omniscient,
      players: observation.players.map((player) => ({ ...player })),
      currentVotes: observation.currentVotes.map((vote) => ({ ...vote })),
      pendingDecision: {
        ...request.pendingDecision,
        candidates: [...request.pendingDecision.candidates],
        options: { ...request.pendingDecision.options },
      },
      result: observation.result ? { ...observation.result } : null,
    },
    request: {
      promptMessages: messages.map((message) => ({ ...message })),
      jsonOutputRequested: options.jsonOutputRequested,
      provider: config.provider === 'custom'
        ? {
          kind: config.provider,
          baseUrl: sanitizeAiBaseUrl(config.endpoint),
          apiKey: sanitizeApiKey(config.apiKey),
          model: config.model,
          reasoningEffort: config.reasoningEffort,
          retryCount: config.retryCount,
          jsonOutputMode: config.jsonOutputMode,
        }
        : {
          kind: config.provider,
          baseUrl: sanitizeAiBaseUrl(FREE_PROVIDER_ENDPOINT),
          apiKey: '[not used by browser]',
          model: null,
          reasoningEffort: null,
          retryCount: config.retryCount,
          jsonOutputMode: null,
        },
    },
    response: {
      rawOutput: error.rawOutput,
    },
  };
}

export function formatAiDebugReport(report: AiDebugReport): string {
  return JSON.stringify(report, null, 2);
}

export function aiDebugReportFilename(report: AiDebugReport): string {
  const gameId = report.game.gameId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'game';
  const timestamp = report.generatedAt.replace(/[:.]/g, '-');
  return `majo-wolf-debug-${gameId}-${timestamp}.json`;
}
