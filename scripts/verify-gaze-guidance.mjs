#!/usr/bin/env node
/**
 * 回归测试：视线诱导（gaze-guidance）重做为主动技
 *
 * 新机制：每日一次，先选「被诱导者」（其发言必须提及对象），再选「诱导对象」
 * （可指向自己——角色人设：渴望被注视；也可指向他人）。
 *
 * 验证：
 * 1. day-start 两步决策：先问被诱导者（optional-target，候选排除自己），
 *    再问诱导对象（target，候选含自己）
 * 2. 被诱导者的发言校验：必须提及诱导对象（名字或座位号），否则被拒
 * 3. 诱导对象可指向自己（人设）
 * 4. 诱导对象可指向他人
 * 5. 第一步保留（use:false）→ 当天不生效，且不会重复询问
 * 6. 未使用视线诱导的对局正常推进
 * 7. 完整对局（本地策略）可正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getNextDayStartSkillDecision, publishSpeech, characterById;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getNextDayStartSkillDecision } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts'));
  ({ publishSpeech } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
} finally {
  // 保持 server 打开
}

let failures = 0;
let checks = 0;
function check(label, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}
const nameOf = (game, id) => characterById[game.players.find((p) => p.id === id).characterId].name;

// ===== 1. day-start 两步决策流程 =====
console.log('=== 1. 两步决策：先被诱导者、再诱导对象 ===');
{
  let verified = false;
  for (let seed = 1; seed <= 200; seed++) {
    const game0 = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const gaze = game0.skillInstances.find((s) => s.definitionId === 'gaze-guidance');
    if (!gaze) continue;
    // 推进到 day-start 决策
    let game = game0;
    let iter = 0;
    let step1 = null;
    let step2 = null;
    let sawGaze = false;
    while (game.phase !== 'ended' && iter < 500 && !(step1 && step2)) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        if (p.title === '视线诱导') {
          sawGaze = true;
          step1 = p;
          // 提交第一步：选被诱导者（随机一个非自己）
          const candidates = p.candidates;
          if (candidates.length === 0) { check('第一步候选非空', false); break; }
          const subject = candidates[0];
          game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { use: true, targetPlayerId: subject } });
          continue;
        }
        if (p.title === '视线诱导-目标') {
          step2 = p;
          break;
        }
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (step1 && step2) {
      check(`seed ${seed}: 第一步候选排除持有者自己`, !step1.candidates.includes(step1.actorId), `候选=${step1.candidates.join(',')} actor=${step1.actorId}`);
      check(`seed ${seed}: 第二步候选包含自己（可指向自己）`, step2.candidates.includes(step2.actorId), `候选=${step2.candidates.join(',')}`);
      verified = true;
      break;
    }
    if (sawGaze) {
      // 走到这里说明第二步没出现，检查是否因第一步保留
      check(`seed ${seed}: 两步决策流程完整`, false, '未出现第二步');
      break;
    }
  }
  if (!verified) check('找到视线诱导持有者对局', false, '200 种子内未找到');
}

// ===== 2. 被诱导者发言必须提及诱导对象 =====
console.log('\n=== 2. 被诱导者发言校验 ===');
{
  let verified = false;
  for (let seed = 1; seed <= 300; seed++) {
    const game0 = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const gaze = game0.skillInstances.find((s) => s.definitionId === 'gaze-guidance');
    if (!gaze) continue;
    // 手动构造完整 gaze 状态：被诱导者 = 某玩家，诱导对象 = 持有者自己
    let game = game0;
    let iter = 0;
    // 先推进到 day 1 speeches 之前
    while (game.phase !== 'speeches' && iter < 300) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        // 视线诱导两步：第一步选被诱导者（随机），第二步选持有者自己
        if (p.title === '视线诱导') {
          const subject = p.candidates[0];
          game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { use: true, targetPlayerId: subject } });
          continue;
        }
        if (p.title === '视线诱导-目标') {
          // 指向自己
          game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { targetPlayerId: p.actorId } });
          continue;
        }
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (game.phase !== 'speeches') continue;
    // 找到被诱导者与诱导对象
    const gazeSkill = game.skillInstances.find((s) => s.definitionId === 'gaze-guidance' && s.data.activeDay === game.day);
    if (!gazeSkill || typeof gazeSkill.data.gazeSubjectId !== 'number' || typeof gazeSkill.data.gazeObjectId !== 'number') continue;
    const subjectId = gazeSkill.data.gazeSubjectId;
    const objectId = gazeSkill.data.gazeObjectId;
    const objectName = nameOf(game, objectId);
    // 被诱导者发言不提及对象 → 应抛错
    let rejected = false;
    try {
      publishSpeech(game, subjectId, { speech: '今天天气不错，我暂时没有想法。' });
    } catch (error) {
      rejected = true;
    }
    check(`seed ${seed}: 被诱导者不提及对象 → 发言被拒`, rejected);
    // 提及对象 → 应通过
    let accepted = false;
    try {
      publishSpeech(game, subjectId, { speech: `我认为 ${objectName} 值得关注，${objectName} 的表现很关键。` });
      accepted = true;
    } catch (error) {
      accepted = false;
    }
    check(`seed ${seed}: 被诱导者提及对象 → 发言通过（对象=${objectName}）`, accepted);
    verified = true;
    break;
  }
  if (!verified) check('找到含视线诱导的对局', false, '300 种子内未找到');
}

// ===== 3. use:false 当天不再询问、次日可再次询问 =====
console.log('\n=== 3. 生命周期：use:false 当天不再询问，次日可再次询问 ===');
{
  let verified = false;
  for (let seed = 1; seed <= 300; seed++) {
    const game0 = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const gaze = game0.skillInstances.find((s) => s.definitionId === 'gaze-guidance');
    if (!gaze) continue;
    let game = game0;
    let iter = 0;
    let day1Asked = 0;
    let day2Asked = 0;
    let reachedDay2 = false;
    const askedDays = new Map();
    while (game.phase !== 'ended' && iter < 1500) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        if (p.title === '视线诱导') {
          askedDays.set(game.day, (askedDays.get(game.day) ?? 0) + 1);
          // 第一天：use:false（保留）；后续天：正常使用
          if (game.day === 0 || game.day === 1) {
            game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { use: false, targetPlayerId: null } });
          } else {
            const subject = p.candidates[0];
            game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { use: true, targetPlayerId: subject } });
          }
          continue;
        }
        if (p.title === '视线诱导-目标') {
          game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: { targetPlayerId: p.candidates.includes(p.actorId) ? p.actorId : p.candidates[0] } });
          continue;
        }
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    const daysAsked = [...askedDays.entries()].sort((a, b) => a[0] - b[0]);
    if (daysAsked.length >= 2) {
      const firstDay = daysAsked[0];
      const secondDay = daysAsked[1];
      check(`seed ${seed}: 第 ${firstDay[0]} 天 use:false 后当天不再重复询问（次数=${firstDay[1]}）`, firstDay[1] === 1, `次数=${firstDay[1]}`);
      check(`seed ${seed}: 次日（第 ${secondDay[0]} 天）可再次询问（次数=${secondDay[1]}）`, secondDay[1] === 1, `次数=${secondDay[1]}`);
      verified = true;
      break;
    }
  }
  if (!verified) check('找到跨天使用视线诱导的对局', false, '300 种子内未找到');
}

// ===== 4. 声音模仿 × 视线诱导：伪造内容不校验视线诱导 =====
console.log('\n=== 4. 声音模仿伪造内容不校验视线诱导（约束只作用于被诱导者真实发言）===');
{
  let verified = false;
  for (let seed = 1; seed <= 200; seed++) {
    const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const gaze = game.skillInstances.find((s) => s.definitionId === 'gaze-guidance');
    const mimic = game.skillInstances.find((s) => s.definitionId === 'voice-mimic');
    if (!gaze || !mimic || mimic.ownerPlayerId === gaze.ownerPlayerId) continue;
    // 手动构造视线诱导激活状态：被诱导者 A、诱导对象 B（指向他人，A≠B）
    const subjectId = game.players.find((p) => p.id !== gaze.ownerPlayerId && p.id !== mimic.ownerPlayerId)?.id;
    const objectId = game.players.find((p) => p.id !== subjectId && p.id !== gaze.ownerPlayerId)?.id;
    if (subjectId === undefined || objectId === undefined || subjectId === objectId) continue;
    gaze.data.activeDay = game.day;
    gaze.data.gazeSubjectId = subjectId;
    gaze.data.gazeObjectId = objectId;
    // 声音模仿者 C 伪造 A 的发言，内容不含诱导对象 B → 应通过
    const { applySpeechSkillDecision } = await server.ssrLoadModule('/src/domain/skills/speechSkills.ts');
    const pendingMimic = {
      id: 'test-mimic', kind: 'skill', schemaKey: 'voice-mimic', actorId: mimic.ownerPlayerId,
      title: '声音模仿', description: '', candidates: [subjectId], allowAbstain: true,
      skillInstanceId: mimic.id, options: {},
    };
    let accepted = false;
    try {
      applySpeechSkillDecision(game, pendingMimic, { use: true, targetPlayerId: subjectId, forgedSpeech: '这段伪造内容完全不提对象。' });
      accepted = true;
    } catch (error) {
      accepted = false;
    }
    check(`seed ${seed}: 模仿者伪造被诱导者发言（不提对象）→ 通过（声音模仿不校验视线诱导）`, accepted);
    verified = true;
    break;
  }
  if (!verified) check('找到声音模仿+视线诱导组合对局', false, '200 种子内未找到');
}

// ===== 5. 完整对局可正常结束 =====
console.log('\n=== 5. 完整对局（本地策略）正常结束 ===');
{
  let endedGames = 0;
  const total = 30;
  for (let seed = 1; seed <= total; seed++) {
    let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    let iter = 0;
    let ended = false;
    while (game.phase !== 'ended' && iter < 1200) {
      iter += 1;
      if (game.pendingDecision) {
        const fb = fallbackDecision(game, game.pendingDecision);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: game.pendingDecision.id, actorId: game.pendingDecision.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (game.phase === 'ended') endedGames += 1;
  }
  check(`${total} 局完整对局全部正常结束`, endedGames === total, `结束 ${endedGames}/${total}`);
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures === 0) {
  console.log('✓ 视线诱导重做验证全部通过');
  await server.close();
  process.exit(0);
}
console.log(`!!! 失败 ${failures} 项`);
await server.close();
process.exit(1);
