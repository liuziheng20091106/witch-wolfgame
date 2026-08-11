import { z } from 'zod';
import type { PendingDecision, PlayerId, SubmittedDecision } from '../domain/model';
import { AiCommandError } from './types';

export const speechDecisionSchema = z.strictObject({ speech: z.string().max(100) });
export const targetDecisionSchema = z.strictObject({ targetPlayerId: z.number().int().min(0).max(5).nullable() });
export const optionalTargetDecisionSchema = z.strictObject({
  use: z.boolean(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
}).superRefine((value, context) => {
  if (value.use !== (value.targetPlayerId !== null)) {
    context.addIssue({ code: 'custom', message: 'use 与 targetPlayerId 必须一致' });
  }
});
export const witchDecisionSchema = z.strictObject({
  save: z.boolean(),
  poisonTargetPlayerId: z.number().int().min(0).max(5).nullable(),
});
export const liquidControlDecisionSchema = z.strictObject({
  use: z.boolean(),
  mode: z.enum(['extract', 'spread']).nullable(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
  factId: z.string().nullable(),
}).superRefine((value, context) => {
  const valid = !value.use
    ? value.mode === null && value.targetPlayerId === null && value.factId === null
    : value.mode === 'extract'
      ? value.targetPlayerId !== null && value.factId === null
      : value.mode === 'spread' && value.factId !== null;
  if (!valid) context.addIssue({ code: 'custom', message: '操控液体字段组合不合法' });
});
export const levitationDecisionSchema = z.strictObject({
  use: z.boolean(),
  mode: z.enum(['move-first', 'move-last', 'tie-break']).nullable(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
}).superRefine((value, context) => {
  const valid = !value.use
    ? value.mode === null && value.targetPlayerId === null
    : value.mode === 'tie-break'
      ? value.targetPlayerId === null
      : (value.mode === 'move-first' || value.mode === 'move-last') && value.targetPlayerId !== null;
  if (!valid) context.addIssue({ code: 'custom', message: '漂浮字段组合不合法' });
});
export const voiceMimicDecisionSchema = z.strictObject({
  use: z.boolean(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
  forgedSpeech: z.string().min(1).max(100).nullable(),
}).superRefine((value, context) => {
  const valid = value.use
    ? value.targetPlayerId !== null && value.forgedSpeech !== null
    : value.targetPlayerId === null && value.forgedSpeech === null;
  if (!valid) context.addIssue({ code: 'custom', message: '声音模仿字段组合不合法' });
});
export const ignitionDecisionSchema = z.strictObject({ use: z.boolean() });

const schemaByKey = {
  speech: speechDecisionSchema,
  target: targetDecisionSchema,
  'optional-target': optionalTargetDecisionSchema,
  witch: witchDecisionSchema,
  'liquid-control': liquidControlDecisionSchema,
  levitation: levitationDecisionSchema,
  'voice-mimic': voiceMimicDecisionSchema,
  ignition: ignitionDecisionSchema,
} as const;

export function parseDecision(pending: PendingDecision, value: unknown): SubmittedDecision {
  const result = schemaByKey[pending.schemaKey].safeParse(value);
  if (!result.success) {
    throw new AiCommandError('schema', `AI JSON 不符合 ${pending.schemaKey} 契约：${result.error.issues[0]?.message ?? '未知结构错误'}`);
  }
  const decision = result.data as SubmittedDecision;
  validateDecisionTargets(pending, decision);
  return decision;
}

function validateDecisionTargets(pending: PendingDecision, decision: SubmittedDecision): void {
  const record = decision as unknown as Record<string, unknown>;
  for (const key of ['targetPlayerId', 'poisonTargetPlayerId']) {
    const value = record[key];
    if (value !== null && value !== undefined && !pending.candidates.includes(value as PlayerId)) {
      throw new AiCommandError('target', `AI 返回了非法目标：${String(value)}`);
    }
  }
  if (typeof record.factId === 'string') {
    const factIds = Array.isArray(pending.options.factIds) ? pending.options.factIds : [];
    if (!factIds.includes(record.factId)) {
      throw new AiCommandError('target', 'AI 返回了未知事实 ID');
    }
  }
}
