import { z } from 'zod';
import type { PendingDecision, PlayerId, SubmittedDecision } from '../domain/model';
import { AiCommandError } from './types';

// 注意：使用 z.object（默认 strip 未知键）而非 z.strictObject。
// 模型常自创多余顶层字段（如把思考内容里的 skill/target 塞进 JSON），strictObject 会因此整单失败；
// z.object 会在解析时自动剥离未知键（且不修改输入对象），schema 本身即是唯一的字段白名单，
// 避免手写白名单与 schema 双重定义导致的漂移。必填缺失/类型错误仍会被拦截。
export const speechDecisionSchema = z.object({ speech: z.string().max(100) });
export const targetDecisionSchema = z.object({ targetPlayerId: z.number().int().min(0).max(5).nullable() });
export const optionalTargetDecisionSchema = z.object({
  use: z.boolean(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
}).superRefine((value, context) => {
  if (value.use !== (value.targetPlayerId !== null)) {
    context.addIssue({ code: 'custom', message: 'use 与 targetPlayerId 必须一致' });
  }
});
export const witchDecisionSchema = z.object({
  save: z.boolean(),
  poisonTargetPlayerId: z.number().int().min(0).max(5).nullable(),
});
export const liquidControlDecisionSchema = z.object({
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
export const levitationDecisionSchema = z.object({
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
export const voiceMimicDecisionSchema = z.object({
  use: z.boolean(),
  targetPlayerId: z.number().int().min(0).max(5).nullable(),
  forgedSpeech: z.string().min(1).max(100).nullable(),
}).superRefine((value, context) => {
  const valid = value.use
    ? value.targetPlayerId !== null && value.forgedSpeech !== null
    : value.targetPlayerId === null && value.forgedSpeech === null;
  if (!valid) context.addIssue({ code: 'custom', message: '声音模仿字段组合不合法' });
});
export const ignitionDecisionSchema = z.object({ use: z.boolean() });

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

function normalizeMinimalSkillOptOut(pending: PendingDecision, value: unknown): unknown {
  if (pending.schemaKey === 'ignition' || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.use !== false || Object.keys(record).length !== 1) return value;
  if (pending.schemaKey === 'optional-target') return { use: false, targetPlayerId: null };
  if (pending.schemaKey === 'liquid-control') return { use: false, mode: null, targetPlayerId: null, factId: null };
  if (pending.schemaKey === 'levitation') return { use: false, mode: null, targetPlayerId: null };
  if (pending.schemaKey === 'voice-mimic') return { use: false, targetPlayerId: null, forgedSpeech: null };
  return value;
}

export function parseDecision(pending: PendingDecision, value: unknown): SubmittedDecision {
  // 先处理 {use:false} 最小化形式（补全契约字段），再交给 z.object 解析；
  // z.object 会自动剥离模型自创的多余键（schema 即白名单，无需手写）。
  const normalizedValue = normalizeMinimalSkillOptOut(pending, value);
  const result = schemaByKey[pending.schemaKey].safeParse(normalizedValue);
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
