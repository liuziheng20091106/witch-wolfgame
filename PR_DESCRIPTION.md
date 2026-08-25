# 上游 PR 说明草案

## 建议标题

扩展固定八人局、双轮发言、平票发言与猎人流程，并强化 AI 决策信息边界

## 背景与实际反馈

本改动来自连续实际游玩反馈，而不是单纯扩大人数：

- 狼人在首轮没有公开依据、前面也没有票型时随机带票，把自己推成焦点位。
- 六人局只有一轮发言，两人平票时缺少候选人补充辩解环节。
- 参与模式的玩家狼人有时只能提交建议，最终袭击被座位更靠前的 AI 队友覆盖。
- AI 把“存活”脑补成“确定知道自己被狼刀后获救”，或把别人公开发的银水当成自身私密记忆。
- AI 把公开魔女技和基础职业能力混淆，例如认为公开技能是魔女杀手的人不可能拥有女巫解药。
- 角色亲自观看千里眼直播后又否认自己观看过。
- 视线诱导要求提及某人时，模型偶尔漏词并导致自动游戏暂停。
- 幻视的部分、脱敏轨迹容易被误解成完整职业证明。

本 PR 以当前 `main` 的 `be6b3c3` 为基线，只列出上游尚未包含的有效增量。详细的问题原因、代码路径和边界见 `CHANGE_README.md`。

## 改动摘要

- 新局固定为 8 人：2 狼人、预言家、女巫、猎人、3 村民。
- 每天增加第二轮确定性随机顺序发言；发言事件记录轮次。
- 两人最高票平票时追加发言后重投；三人以上平票时无人出局。
- 新增猎人死亡后强制开枪，顺序为：死亡结算 → 可选死亡回溯 → 猎人开枪/连锁 → 遗言 → 胜负判断。
- 进行中的旧六人存档追加猎人和村民；已结束/赛后六人局保持原结果。
- AI 请求增加结构化 `currentVotes`，本地投票 fallback 根据当前票型和角色性格决定跟票或弃票。
- 参与模式中，玩家为存活狼人时固定负责最终夜刀，AI 队友仍提供密议建议。
- 在上游已有职业/魔女技基础分层上，为 14 项技能补全效果、时机、目标、消耗、知情范围和例外。
- 把当前行动者可见的私密事件标为 `【你亲历的私密事实】`，同时明确存活者不会自动知道自己被袭击、救下或保护。
- 视线诱导漏提对象时，在远程响应解析后确定性补入姓名并保持 100 字上限。

## 关键行为边界

- 没有强制狼人首轮弃票；有公开理由时仍可主动投票。
- 玩家最终夜刀权只在“参与模式 + 玩家是存活狼人”时生效。
- 猎人必须开枪，不能弃权；死亡回溯撤销猎人死亡时不触发开枪。
- 幻视没有显示袭击轨迹不能作为“必定不是狼人”的反向证明；本 PR 只强化认知说明，不重写上游轨迹机制。
- 允许讨论别人公开声称的银水，但没有本人私密事件时不能说自己确定被救。
- 460 毫秒状态推进间隔和模型配置没有作为源码改动提交；八人双轮发言增加了远程请求总数，性能优化应另开改动。
- 固定八人不是动态人数实现，不声称完成 Issue #70/#73。

## 与上游已有工作的关系

- PR #9 已有发言来源标注；本 PR 只增加发言轮次。
- PR #11 已有职业与魔女技基础分层；本 PR 增加全部技能的精确认知和职业资源边界。
- PR #37 已有千里眼双方私密反馈；本 PR 增加本人事实一致性提示。
- PR #57 已有非法目标与女巫行动校验；本 PR 不重复该逻辑。
- Issue #58 已有存档版本警告；本 PR 新增的是进行中六人状态到八人状态的数据迁移。
- Open PR #65 正在修改动态演绎和提示词预算；若先合并，应基于其新结构移植本 PR 的提示词增量。

## 兼容性

- 本地运行方式不变：`npm install`、`npm run dev`。
- 构建方式不变：`npm run build`。
- 自定义 AI 继续使用完整 `/chat/completions` 端点、模型和 API Key。
- 不增加 npm 依赖；`package-lock.json` 保持上游版本。
- 存档 schema 版本仍为 1，通过可选字段和加载迁移兼容历史六人局。
- 后端协议接受八人新请求，也允许历史六人赛后数据。

## 建议审阅顺序

1. `shared/gamePromptContract.js`、`src/domain/model.ts`：八人契约、猎人、新阶段和票型字段。
2. `src/domain/engine/createGame.ts`、`reducer.ts`、`night.ts`：状态机、死亡顺序和玩家狼人最终夜刀。
3. `src/storage/browserStorage.ts`：六转八迁移及已结束存档边界。
4. `src/ai/fallback.ts`、`prompts.ts`、`schemas.ts`、`src/domain/catalog/witchSkills.ts`：投票、私密事实、技能认知和漏词补全。
5. `server/gameProtocol.mjs`：八人/历史六人协议兼容。
6. `scripts/eight-player-smoke.mjs`、`scripts/browser-storage-smoke.mjs`、`scripts/ai-debug-report-smoke.mjs`：回归覆盖。

## 建议拆分提交

1. `feat: add fixed eight-player board and active-save migration`
2. `feat: add second speech round, runoff speeches and hunter shot`
3. `fix: stabilize player wolf decision and vote context`
4. `fix: clarify AI skill rules and private knowledge boundaries`
5. `test/docs: add focused regression coverage and review notes`

## 验证

已通过：

```bash
npm run build
npm run test:eight-player
npm run test:domain
npm run test:storage
npm run test:debug-report
```

`npm run test:backend` 在当前 Windows 环境中因找不到 OpenSSL，未进入断言阶段。错误为：

```text
未找到 OpenSSL。请安装 Git for Windows/OpenSSL，或将 openssl.exe 完整路径写入环境变量 OPENSSL_BIN。
```

## 已知未解决

- 治愈 AI 可能连续自守。
- 狼人 AI 在没有玩家最终控制时，可能重复袭击疑似长期受保护目标。
- 提示词不能绝对保证远程模型不犯自然语言常识错误。
- 六转八迁移不重放历史时间线。
- 当前主要是 smoke 测试，猎人所有死亡来源和连锁组合仍可补充更细单元测试。

## 隐私检查

提交和交付包不包含个人 API Key、本机绝对路径、聊天记录、浏览器存档、证书、`.env` 或真实服务配置。上游作者、许可证和版权信息保持不变。
