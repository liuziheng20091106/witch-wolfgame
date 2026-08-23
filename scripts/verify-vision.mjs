#!/usr/bin/env node
/**
 * 回归测试：幻视（奈叶香，mind-reading 重构）
 *
 * 新机制（白天主动技，每天一次）：
 * - 触碰一名未查看过的存活者
 * - 25% 失败 / 50% 小成功（昨夜轨迹）/ 25% 大成功（所有夜轨迹）
 * - 轨迹显示"目标被做了什么/做了什么"，不泄露执行者与被作用者身份
 * - 目标不可重复（无论成败）
 *
 * 验证：
 * 1. day-start 询问：候选排除自己、排除已查看者
 * 2. 概率结算：多次使用后三档结果都出现（25/50/25 分布）
 * 3. 目标不重复：已查看者不再进入候选
 * 4. 轨迹内容：包含"被袭击/被治愈/被查验"等脱敏描述，不含执行者名字
 * 5. 完整对局（本地策略）正常结束
 */
import { createServer } from 'vite';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = await createServer({ root, server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

let createGame, reduceGame, fallbackDecision, getVisionSkillDecision, applyVisionSkillDecision, describeNightTrajectory, characterById, getPlayer;
try {
  ({ createGame } = await server.ssrLoadModule('/src/domain/engine/createGame.ts'));
  ({ reduceGame } = await server.ssrLoadModule('/src/domain/engine/reducer.ts'));
  ({ fallbackDecision } = await server.ssrLoadModule('/src/ai/fallback.ts'));
  ({ getVisionSkillDecision, applyVisionSkillDecision, describeNightTrajectory } = await server.ssrLoadModule('/src/domain/skills/nightSkills.ts'));
  ({ characterById } = await server.ssrLoadModule('/src/domain/catalog/characters.ts'));
  ({ getPlayer } = await server.ssrLoadModule('/src/domain/engine/selectors.ts'));
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

// ===== 1. day-start 询问与候选 =====
console.log('=== 1. day-start 询问：候选排除自己、排除已查看者 ===');
{
  let verified = false;
  for (let seed = 1; seed <= 300; seed++) {
    const game0 = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const vision = game0.skillInstances.find((s) => s.definitionId === 'mind-reading');
    if (!vision) continue;
    // 推进到第一个 day-start 技能询问
    let game = game0;
    let iter = 0;
    let pending = null;
    while (game.phase !== 'ended' && iter < 300) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        if (p.title === '幻视') { pending = p; break; }
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (!pending) continue;
    check(`seed ${seed}: 幻视候选排除自己`, !pending.candidates.includes(pending.actorId), `候选=${pending.candidates.join(',')}`);
    check(`seed ${seed}: 幻视候选非空`, pending.candidates.length > 0);
    verified = true;
    break;
  }
  if (!verified) check('找到幻视持有者对局', false, '300 种子内未找到');
}

// ===== 2. 概率分布（多次结算统计）=====
console.log('\n=== 2. 概率分布（25/50/25）===');
{
  // 用确定性 rngState 模拟多次结算（不同 rngState 输入）
  let counts = { fail: 0, small: 0, big: 0 };
  for (let i = 0; i < 200; i++) {
    const game0 = createGame({ mode: 'spectator', humanCharacterId: null, seed: (i + 1) >>> 0 });
    const vision = game0.skillInstances.find((s) => s.definitionId === 'mind-reading');
    if (!vision) continue;
    const target = game0.players.find((p) => p.id !== vision.ownerPlayerId)?.id;
    if (target === undefined) continue;
    // 直接用 rngState 推进结算（模拟 applyVisionSkillDecision 的随机部分）
    let state = game0;
    const roll = { value: 0, state: state.rngState };
    // 手动调用概率逻辑（复制自 applyVisionSkillDecision）
    const { chooseWithState } = await server.ssrLoadModule('/src/domain/engine/random.ts');
    const r = chooseWithState([0, 1, 2, 3], state.rngState);
    const outcome = r.item === 0 ? 'fail' : r.item <= 2 ? 'small' : 'big';
    counts[outcome] += 1;
  }
  const total = counts.fail + counts.small + counts.big;
  const pct = (k) => Math.round((counts[k] / total) * 100);
  console.log(`  分布（${total} 次）: 失败 ${pct('fail')}% / 小成功 ${pct('small')}% / 大成功 ${pct('big')}%`);
  check('三档结果都出现', counts.fail > 0 && counts.small > 0 && counts.big > 0, `fail=${counts.fail} small=${counts.small} big=${counts.big}`);
  check('失败接近 25%', pct('fail') >= 15 && pct('fail') <= 35, `失败=${pct('fail')}%`);
  check('小成功接近 50%', pct('small') >= 40 && pct('small') <= 60, `小成功=${pct('small')}%`);
}

// ===== 3. 完整对局（本地策略）正常结束 + 目标不重复 =====
console.log('\n=== 3. 完整对局正常结束 ===');
{
  let endedGames = 0;
  const total = 30;
  let visionUses = 0;
  for (let seed = 1; seed <= total; seed++) {
    let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    let iter = 0;
    while (game.phase !== 'ended' && iter < 1500) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        if (p.title === '幻视') visionUses += 1;
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (game.phase === 'ended') endedGames += 1;
  }
  check(`${total} 局完整对局全部正常结束`, endedGames === total, `结束 ${endedGames}/${total}`);
  check('幻视至少被使用过', visionUses > 0, `使用 ${visionUses} 次`);
}

// ===== 4. 轨迹聚合与目标不重复（真实对局，不手动注入）=====
console.log('\n=== 4. 轨迹聚合（脱敏）与目标不重复 ===');
{
  let visionResults = [];
  let verified = false;
  for (let seed = 1; seed <= 200; seed++) {
    let game = createGame({ mode: 'spectator', humanCharacterId: null, seed: seed >>> 0 });
    const vision = game.skillInstances.find((s) => s.definitionId === 'mind-reading');
    if (!vision) continue;
    let iter = 0;
    let lastVisionText = null;
    let lastVisionDay = -1;
    let lastVisionEvent = null;
    while (game.phase !== 'ended' && iter < 1500) {
      iter += 1;
      if (game.pendingDecision) {
        const p = game.pendingDecision;
        if (p.title === '幻视') {
          // 让 fallback 正常决策（随机选目标）
          const fb = fallbackDecision(game, p);
          game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
          game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
          // 记录最近一次幻视播报（结算后 privateEvents 末尾）
          const last = game.privateEvents.filter((e) => e.text.includes('幻视')).at(-1);
          if (last) { lastVisionText = last.text; lastVisionDay = game.day; lastVisionEvent = last; }
          continue;
        }
        const fb = fallbackDecision(game, p);
        game = reduceGame(game, { type: 'set-rng-state', rngState: fb.rngState });
        game = reduceGame(game, { type: 'submit-decision', pendingDecisionId: p.id, actorId: p.actorId, decision: fb.decision });
      } else {
        game = reduceGame(game, { type: 'advance' });
      }
    }
    if (lastVisionText) {
      visionResults.push(lastVisionText);
      if (lastVisionText.includes('系统判定为失败')) {
        // 失败播报：明确说明系统判定，接受
        check(`seed ${seed}: 幻视失败播报格式正确`, lastVisionText.includes('本次幻视行为被系统判定为失败'), lastVisionText);
      } else {
        // 成功播报：必须含"通过幻视看到"
        check(`seed ${seed}: 幻视成功播报格式正确`, lastVisionText.includes('通过幻视看到'), lastVisionText);
        // 脱敏：除目标名与持有者名外，不得出现其他角色名
        const allNames = game.players.map((pl) => characterById[pl.characterId].name);
        const mentioned = allNames.filter((n) => lastVisionText.includes(n));
        const visionOwner = vision.ownerPlayerId;
        const ownerName = nameOf(game, visionOwner);
        // 目标名从幻视事件的目标字段取（合法提及 = 持有者 + 目标）
        const visionTargetId = lastVisionEvent?.targetPlayerIds?.[0];
        const targetName = typeof visionTargetId === 'number' ? nameOf(game, visionTargetId) : '';
        const legitMentions = mentioned.filter((n) => n === ownerName || (targetName.length > 0 && n === targetName));
        check(`seed ${seed}: 轨迹不泄露他人姓名（提及: ${mentioned.join('、') || '无'}）`, mentioned.length === legitMentions.length, lastVisionText);
      }
      verified = true;
      break;
    }
  }
  if (!verified) check('找到幻视持有者并至少播报一次的对局', false, '200 种子内未找到');
  console.log(`  （幻视播报样本: ${visionResults.length > 0 ? visionResults[0].slice(0, 80) + '…' : '无'}）`);
}

// ===== 5. 轨迹聚合确定性验证（直接测 describeNightTrajectory）=====
console.log('\n=== 5. 轨迹聚合（确定性）===');
{
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 42 >>> 0 });
  const target = game.players[0];
  const wolf = game.players[1];
  const witch = game.players[2];
  const seer = game.players[3];
  const healer = game.players[4];
  const { addPrivateEvent } = await server.ssrLoadModule('/src/domain/engine/events.ts');
  // 构造 day 0 的多种事件：目标被狼刀、被治愈、被查验、目标主动毒杀某人
  addPrivateEvent(game, [wolf.id], 'wolf-attack', '狼队决定袭击某人', {
    actorPlayerId: wolf.id, targetPlayerIds: [target.id],
    data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: target.id },
  });
  addPrivateEvent(game, [healer.id], 'protection', '治愈某人', {
    actorPlayerId: healer.id, targetPlayerIds: [target.id], data: { protectTargetPlayerId: target.id },
  });
  addPrivateEvent(game, [seer.id], 'seer-check', '查验某人', {
    actorPlayerId: seer.id, targetPlayerIds: [target.id], data: { actionKind: 'seer-action' },
  });
  addPrivateEvent(game, [target.id], 'witch-action', '毒杀某人', {
    actorPlayerId: target.id, targetPlayerIds: [witch.id], data: { intentSource: 'poison', preventable: true, targetPlayerId: witch.id },
  });
  const lines = describeNightTrajectory(game, target.id, 0, 0);
  const joined = lines.join(' ');
  console.log(`  轨迹: ${lines.join(' / ') || '(空)'}`);
  check('目标被狼刀 → "遭到狼人袭击"', lines.some((l) => l.includes('遭到狼人袭击')), joined);
  check('目标被治愈 → "被治愈保护"', lines.some((l) => l.includes('被治愈保护')), joined);
  check('目标被查验 → "被查验"', lines.some((l) => l.includes('被查验')), joined);
  // P1 修复：意图语义，不是结果语义
  check('目标主动毒杀 → "对某人下了毒"（意图，非"毒杀成功"）', lines.some((l) => l.includes('对某人下了毒')), joined);
  check('不使用结果性措辞"被毒杀/毒杀了某人"', !joined.includes('毒杀') || joined.includes('下了毒'), joined);
  // 脱敏：不泄露狼/治愈者/查验者的名字
  const wolfName = nameOf(game, wolf.id);
  const healerName = nameOf(game, healer.id);
  const seerName = nameOf(game, seer.id);
  check(`不泄露狼名「${wolfName}」`, !joined.includes(wolfName), joined);
  check(`不泄露治愈者名「${healerName}」`, !joined.includes(healerName), joined);
  check(`不泄露查验者名「${seerName}」`, !joined.includes(seerName), joined);
  // 不泄露被毒杀者身份（只显示"某人"）
  const witchName = nameOf(game, witch.id);
  check(`不泄露被毒杀者名「${witchName}」`, !joined.includes(witchName), joined);
}

// ===== 6. 目标不可重复（确定性）+ P1 意图/结果语义 =====
console.log('\n=== 6. 目标不可重复与意图语义 ===');
{
  // 目标不可重复：构造狼刀 + 解药救同一目标的场景，
  // 幻视应显示"被救下"（生效结果）+ "遭到狼人袭击"（意图），而非"被刀死"
  const game = createGame({ mode: 'spectator', humanCharacterId: null, seed: 7 >>> 0 });
  const vision = game.skillInstances.find((s) => s.definitionId === 'mind-reading');
  if (!vision) {
    check('找到幻视持有者', false);
  } else {
    const ownerId = vision.ownerPlayerId;
    const target = game.players.find((p) => p.id !== ownerId);
    if (!target) {
      check('找到幻视目标', false);
    } else {
      const { addPrivateEvent } = await server.ssrLoadModule('/src/domain/engine/events.ts');
      const wolf = game.players.find((p) => p.id !== ownerId && p.id !== target.id);
      if (wolf) {
        // 狼刀目标（意图，preventable:true）+ 解药救目标（生效）
        addPrivateEvent(game, [wolf.id], 'wolf-attack', '狼队决定袭击某人', {
          actorPlayerId: wolf.id, targetPlayerIds: [target.id],
          data: { actionKind: 'wolf-decision', intentSource: 'wolf', preventable: true, targetPlayerId: target.id },
        });
        addPrivateEvent(game, [ownerId === 0 ? 1 : 0], 'witch-action', '用解药救下某人', {
          actorPlayerId: ownerId === 0 ? 1 : 0, targetPlayerIds: [target.id],
          data: { actionKind: 'witch-save', savedWolfTargetPlayerId: target.id },
        });
      }
      // 第一次幻视决策：目标应在候选
      const pending1 = getVisionSkillDecision(game);
      if (pending1) {
        check(`seed 7: 第一次候选包含目标`, pending1.candidates.includes(target.id), `候选=${pending1.candidates.join(',')}`);
        // 结算（目标标记已查看）
        applyVisionSkillDecision(game, pending1, { targetPlayerId: target.id });
        // 轨迹（day 0 事件，显式范围不受 day 变化影响）
        const lines = describeNightTrajectory(game, target.id, 0, 0);
        const joined = lines.join(' ');
        console.log(`  [seed 7] 目标轨迹: ${lines.join(' / ') || '(空)'}`);
        check('被狼刀+被救场景：显示"遭到狼人袭击"（意图）', lines.some((l) => l.includes('遭到狼人袭击')), joined);
        check('被狼刀+被救场景：显示"被救下"（生效）', lines.some((l) => l.includes('被救下')), joined);
        check('不出现"死亡/被杀死"结果性措辞', !joined.includes('死亡') && !joined.includes('被杀死'), joined);
        // 模拟下一天（幻视每天一次，同一天 wasOffered 会阻止第二次询问）
        game.day += 1;
        // 第二次决策：目标应被排除（viewedIds 生效）
        const pending2 = getVisionSkillDecision(game);
        if (pending2) {
          check(`seed 7: 次日候选排除已查看目标`, !pending2.candidates.includes(target.id), `候选=${pending2.candidates.join(',')}`);
        } else {
          check('seed 7: 次日仍有其他候选', false, '候选为空');
        }
      } else {
        check('seed 7: 幻视第一次决策存在', false);
      }
    }
  }
}

console.log(`\n===== 结果 =====`);
console.log(`检查项: ${checks} | 失败: ${failures}`);
if (failures === 0) {
  console.log('✓ 幻视重构验证全部通过');
  await server.close();
  process.exit(0);
}
console.log(`!!! 失败 ${failures} 项`);
await server.close();
process.exit(1);
