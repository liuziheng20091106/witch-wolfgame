#!/usr/bin/env node
/**
 * 验证：模型自创多余字段不再导致决策解析失败（z.object 默认 strip 未知键）
 *
 * 场景来自实战：deepseek 返回
 *   {"speech":"【不要跟票】…","skill":"洗脑","target":"不要跟票"}
 * 多出的 skill/target 字段此前会让 z.strictObject 整单失败。
 * 修复后：多余字段被剥离，正常解析；必填缺失/类型错误/非法目标仍被拦截。
 *
 * 覆盖全部 8 个 DecisionSchemaKey 的白名单容错 + 严格性回归（GPT review 建议）。
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let parseDecision;
try {
  ({ parseDecision } = await server.ssrLoadModule('/src/ai/schemas.ts'));
} finally {
  await server.close();
}

let failures = 0;
let passed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

function pending(schemaKey, candidates = []) {
  return {
    id: 't', kind: 'skill', schemaKey, actorId: 1,
    title: '技能', description: '', candidates, allowAbstain: true,
    skillInstanceId: null, options: {},
  };
}
const speechPending = { ...pending('speech'), kind: 'speech' };

// ===== A. 各 schema 带多余字段应可解析 =====
const toleranceCases = [
  ['speech', speechPending, { speech: '【不要跟票】现在信息不足。', skill: '洗脑', target: '不要跟票' }, (r) => r.speech === '【不要跟票】现在信息不足。'],
  ['target', pending('target', [0, 2]), { targetPlayerId: 2, extra: 'x', note: 1 }, (r) => r.targetPlayerId === 2],
  ['optional-target', pending('optional-target', [0, 2]), { use: true, targetPlayerId: 2, extraField: '多余' }, (r) => r.use === true && r.targetPlayerId === 2],
  ['witch', pending('witch'), { save: true, poisonTargetPlayerId: null, mood: 'calm' }, (r) => r.save === true && r.poisonTargetPlayerId === null],
  ['liquid-control', pending('liquid-control', [0, 2]), { use: true, mode: 'extract', targetPlayerId: 2, factId: null, leak: false }, (r) => r.mode === 'extract' && r.targetPlayerId === 2],
  ['levitation', pending('levitation', [0, 2]), { use: true, mode: 'move-first', targetPlayerId: 2, magic: 'float' }, (r) => r.mode === 'move-first' && r.targetPlayerId === 2],
  ['voice-mimic', pending('voice-mimic', [0, 2]), { use: true, targetPlayerId: 2, forgedSpeech: '我暂时相信3号。', style: 'fake' }, (r) => r.forgedSpeech === '我暂时相信3号。'],
  ['ignition', pending('ignition'), { use: true, flame: 'hot' }, (r) => r.use === true],
];
for (const [name, p, value, assert] of toleranceCases) {
  try {
    const result = parseDecision(p, value);
    check(`${name} 带多余字段可解析`, assert(result), JSON.stringify(result));
  } catch (error) {
    check(`${name} 带多余字段可解析`, false, error.message);
  }
}

// ===== B. 严格性保留 =====
// B1. 缺失必填字段仍被拒绝
try {
  parseDecision(speechPending, { skill: '洗脑' });
  check('缺失必填字段仍被拒绝', false, '竟然通过了');
} catch (error) {
  check('缺失必填字段仍被拒绝', error.message.includes('不符合 speech 契约'), error.message);
}
// B2. 类型错误仍被拒绝
try {
  parseDecision(speechPending, { speech: 123 });
  check('类型错误仍被拒绝', false, '竟然通过了');
} catch (error) {
  check('类型错误仍被拒绝', error.message.includes('不符合 speech 契约'), error.message);
}
// B3. superRefine 组合校验仍生效（liquid-control use 与字段不一致）
try {
  parseDecision(pending('liquid-control', [0, 2]), { use: true, mode: 'extract', targetPlayerId: null, factId: null });
  check('superRefine 组合校验仍生效', false, '竟然通过了');
} catch (error) {
  check('superRefine 组合校验仍生效', error.message.includes('不符合 liquid-control 契约'), error.message);
}
// B4. strip 后非法目标仍被拒绝
try {
  parseDecision(pending('optional-target', [0, 2]), { use: true, targetPlayerId: 5, extra: 1 });
  check('strip 后非法目标仍被拒绝', false, '竟然通过了');
} catch (error) {
  check('strip 后非法目标仍被拒绝', error.message.includes('非法目标'), error.message);
}
// B5. 未知事实 ID 仍被拒绝
try {
  const factPending = { ...pending('liquid-control', [0, 2]), options: { factIds: ['fact-1'] } };
  parseDecision(factPending, { use: true, mode: 'spread', targetPlayerId: null, factId: 'fact-999' });
  check('未知事实 ID 仍被拒绝', false, '竟然通过了');
} catch (error) {
  check('未知事实 ID 仍被拒绝', error.message.includes('未知事实 ID'), error.message);
}
// B6. 最小化 {use:false} 仍被归一化（模型只回 {"use":false} 时应成功且补全字段）
try {
  const result = parseDecision(pending('optional-target', [0, 2]), { use: false });
  check('最小化 {use:false} 被归一化', result.use === false && result.targetPlayerId === null, JSON.stringify(result));
} catch (error) {
  check('最小化 {use:false} 被归一化', false, error.message);
}
// B7. 输入对象不被原地修改（GPT review 建议）
const input = { speech: '我会冷静观察。', skill: '洗脑', target: 'x' };
parseDecision(speechPending, input);
check('输入对象不被原地修改', Object.keys(input).length === 3 && input.skill === '洗脑', JSON.stringify(input));

console.log(`\n===== ${failures === 0 ? '全部通过 ✓' : `失败 ${failures} 项 ✗`}（${passed} 通过 / ${failures} 失败）=====`);
process.exit(failures === 0 ? 0 : 1);
