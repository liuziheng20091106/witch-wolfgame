#!/usr/bin/env node
/**
 * 协议诊断工具：定位"提示词不是当前程序生成的合法游戏请求"的具体原因
 *
 * 用法：
 *   node scripts/diagnose-protocol.mjs [种子]
 *
 * 适用场景：
 *   免费通道报 {"error":"upstream_error","message":"提示词不是当前程序生成的合法游戏请求"}
 *   时，说明【线上部署的】主后端或代理节点与前端版本不一致。
 *   本工具在本机用前端引擎生成真实对局的每次决策提示词，
 *   并【逐项】复现后端 validateGamePrompt 的校验，输出第一个失败的具体原因。
 *
 * 注意：本工具校验的是【本机仓库代码】的一致性。若本机全过但线上报错，
 * 则问题在【部署的代码版本】——见下方各步骤提示，去服务器上核对。
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = resolve(import.meta.dirname, '..');
const seed = Number(process.argv[2] ?? 20260820) >>> 0;
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

// ===== 前端侧 =====
let createGame, reduceGame, fallbackDecision, buildDecisionPrompt, selectObservation;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ buildDecisionPrompt } = await server.ssrLoadModule('/src/ai/prompts.ts'));
  ({ selectObservation } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
} finally {
  // 保持 server 打开
}

// ===== 后端侧（本机 gameProtocol.mjs 作对照）=====
const backend = await import('../server/gameProtocol.mjs');
const B = backend;

console.log(`\n========== 协议一致性诊断（种子 ${seed}）==========\n`);

// ---------- 第 0 步：版本一致性 ----------
console.log('【0】版本一致性');
{
  const pkgVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version;
  const mainCfg = JSON.parse(await readFile(resolve(root, 'server/main.config.json'), 'utf8'));
  const proxyCfg = JSON.parse(await readFile(resolve(root, 'proxy/proxy.config.json'), 'utf8'));
  console.log(`  前端 package.json 版本: ${pkgVersion}`);
  console.log(`  本地 main.config.json acceptedClientVersions: ${JSON.stringify(mainCfg.acceptedClientVersions)}`);
  console.log(`  本地 proxy.config.json acceptedClientVersions: ${JSON.stringify(proxyCfg.acceptedClientVersions)}`);
  const mainOk = mainCfg.acceptedClientVersions.includes(pkgVersion);
  const proxyOk = proxyCfg.acceptedClientVersions.includes(pkgVersion);
  console.log(`  前端版本在 main 白名单: ${mainOk ? '✓' : '✗ 需包含 ' + pkgVersion}`);
  console.log(`  前端版本在 proxy 白名单: ${proxyOk ? '✓' : '✗ 需包含 ' + pkgVersion}`);
  console.log(`  → 报错时先核对服务器上【实际部署】的配置文件是否含前端版本号（版本不匹配会直接返回"客户端版本不受支持"或协议校验失败）`);
}

// ---------- 第 1 步：逐项校验真实对局的每次决策 ----------
console.log('\n【1】真实对局逐项校验（本地前端 vs 本地后端）');
let game = createGame({ mode: 'spectator', humanCharacterId: null, seed });
let iterations = 0;
let decisions = 0;
let firstFail = null;

while (game.phase !== 'ended' && iterations < 2000) {
  iterations += 1;
  if (game.pendingDecision) {
    const pending = game.pendingDecision;
    const observation = selectObservation(game, { kind: 'player', playerId: pending.actorId });
    let messages;
    try {
      messages = buildDecisionPrompt({ observation, pendingDecision: pending });
    } catch (error) {
      firstFail = { step: 'buildDecisionPrompt 异常', detail: error.message, schema: pending.schemaKey };
      break;
    }
    decisions += 1;
    const fail = diagnoseMessages(messages);
    if (fail) {
      firstFail = { ...fail, schema: pending.schemaKey };
      break;
    }
    const fb = fallbackDecision(game, pending);
    game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
    game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: pending.id, actorId: pending.actorId, decision: fb.decision });
  } else {
    game = reduceGame(game, { type: 'advance' });
  }
}

if (firstFail) {
  console.log(`  ✗ 第 ${decisions} 次决策（schema: ${firstFail.schema}）校验失败`);
  console.log(`    失败项: ${firstFail.step}`);
  console.log(`    详情: ${firstFail.detail}`);
} else {
  console.log(`  ✓ 本地前端生成的 ${decisions} 次决策全部通过本地后端校验`);
  console.log(`  → 本仓库代码前后端一致。若线上仍报错，是【部署版本不一致】，对照教程去服务器核对。`);
}

// ---------- 第 2 步：system 模板三处一致性 ----------
console.log('\n【2】system 模板三处一致性');
{
  const promptSrc = await readFile(resolve(root, 'src/ai/prompts.ts'), 'utf8');
  const protoSrc = await readFile(resolve(root, 'server/gameProtocol.mjs'), 'utf8');
  const smokeSrc = await readFile(resolve(root, 'scripts/backend-smoke.mjs'), 'utf8');
  const marker = '只返回一个 JSON 对象';
  const extractTemplate = (src) => {
    const idx = src.indexOf('你正在进行六人魔女狼人杀');
    if (idx === -1) return null;
    return src.slice(idx, src.indexOf(marker) + marker.length);
  };
  const tFront = extractTemplate(promptSrc);
  const tProto = extractTemplate(protoSrc);
  const tSmoke = extractTemplate(smokeSrc);
  const same = Boolean(tFront && tProto && tFront === tProto && tSmoke === tFront);
  console.log(`  前端 prompts.ts == 后端 gameProtocol.mjs: ${tFront === tProto ? '一致 ✓' : '不一致 ✗'}`);
  console.log(`  前端 prompts.ts == 烟测 backend-smoke.mjs: ${tFront === tSmoke ? '一致 ✓' : '不一致 ✗'}`);
  if (tFront !== tProto) {
    console.log('  前端模板: ' + (tFront ?? '(未找到)'));
    console.log('  后端模板: ' + (tProto ?? '(未找到)'));
  }
  console.log(`  结论: ${same ? '三处一致 ✓' : '✗ 不一致！system.content 校验会失败（后端 L86 严格 === 比较），需同步三处后重新部署'}`);
}

// ---------- 第 3 步：publicSkills 白名单核对 ----------
console.log('\n【3】publicSkills 白名单核对');
{
  // 后端白名单从 gameProtocol.mjs 源码提取（PUBLIC_SKILLS Set 里的字符串字面量）
  const protoSrc = await readFile(resolve(root, 'server/gameProtocol.mjs'), 'utf8');
  const skillsSrc = await readFile(resolve(root, 'src/domain/catalog/witchSkills.ts'), 'utf8');
  // 提取前端 14 个技能的 description
  const descMatches = [...skillsSrc.matchAll(/description: '([^']+)'/g)].map((m) => m[1]);
  // 提取后端 PUBLIC_SKILLS 白名单中每条完整文案（'技能名：描述'）
  const pubSkillsSection = protoSrc.slice(protoSrc.indexOf('const PUBLIC_SKILLS'), protoSrc.indexOf('const ROLE_VALUES'));
  const whitelistEntries = [...pubSkillsSection.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  console.log(`  前端技能描述条数: ${descMatches.length}（应 14）`);
  // 每条前端描述应能被白名单中某条"以该描述结尾"匹配（白名单格式：'名：描述'）
  const mismatch = descMatches.filter((d) => !whitelistEntries.some((entry) => entry.endsWith(d)));
  if (mismatch.length === 0) {
    console.log('  全部 14 条技能描述都匹配后端 PUBLIC_SKILLS 白名单 ✓');
  } else {
    console.log(`  ✗ 以下技能描述【不在】后端白名单（publicSkills 校验 L114 会失败）:`);
    mismatch.forEach((d) => console.log(`    - ${d}`));
    console.log('  → 这些技能的 description 被前端改过但后端白名单未同步，或部署版本不一致');
  }
  console.log(`  → 特别注意：视线诱导/洗脑的描述若与白名单不一致，就是这里导致线上 400`);
}

console.log('\n========== 诊断完成 ==========');
console.log('如需线上核对，把本工具的【0】【2】【3】步结论与服务器上实际部署文件比对。');
await server.close();
process.exit(firstFail ? 1 : 0);

// ---------- 辅助：逐项复现 validateGamePrompt ----------
function diagnoseMessages(messages) {
  const [system, user] = messages;
  if (!Array.isArray(messages) || messages.length !== 2) return { step: 'messages 结构', detail: '不是 2 条消息' };
  if (!system || !user || system.role !== 'system' || user.role !== 'user') return { step: 'messages 角色', detail: 'system/user 角色错误' };
  const systemKeys = Object.keys(system);
  if (systemKeys.length !== 2 || !systemKeys.includes('role') || !systemKeys.includes('content')) return { step: 'system 键', detail: `键=${systemKeys.join(',')}` };
  const userKeys = Object.keys(user);
  if (userKeys.length !== 2 || !userKeys.includes('role') || !userKeys.includes('content')) return { step: 'user 键', detail: `键=${userKeys.join(',')}` };
  if (typeof user.content !== 'string' || user.content.length > 96000) return { step: 'user.content', detail: `长度=${user.content?.length}` };
  let prompt;
  try { prompt = JSON.parse(user.content); } catch { return { step: 'JSON.parse', detail: 'user.content 不是合法 JSON' }; }
  const expectedPromptKeys = ['action','actor','phase','day','board','alivePlayers','legalCandidates','allowAbstain','options','currentDaySpeeches','historicalSpeeches','recentPublic','privateKnowledge','publicSkills','privateEvents'];
  const missing = expectedPromptKeys.filter((k) => !(k in prompt));
  const extra = Object.keys(prompt).filter((k) => !expectedPromptKeys.includes(k));
  if (missing.length || extra.length) return { step: 'PROMPT_KEYS', detail: `缺=${missing.join(',')} 多=${extra.join(',')}` };
  // system 模板（后端 L86 严格 ===）
  const schema = prompt.action?.schema;
  if (typeof schema !== 'string') return { step: 'action.schema', detail: '缺少 schema' };
  // 用后端黑盒做最终裁决
  if (!B.validateGamePrompt(messages)) {
    return { step: 'validateGamePrompt 失败', detail: '本地后端黑盒校验失败——可能是 system 模板或字段值不在白名单；结合【2】【3】步定位' };
  }
  return null;
}
