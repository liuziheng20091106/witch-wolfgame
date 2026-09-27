# 仓库指南

## 协作与审查范围

- 以本次任务、PR 描述和维护者确认的范围为准。下文用于帮助理解项目，不是要求每个 PR 整改全仓库的检查清单。
- 审查聚焦本次变更引入或加重的实际缺陷。报告时说明具体位置、触发条件、可观察影响，以及它与本次改动的关系；上下文不足时说明不确定性，不把猜测作为阻塞项。
- 既有问题、个人风格偏好、可选重构、假设中的未来需求，以及与本次改动无关的测试或文档补全，不作为必须修复的问题。确有价值的建议标为非阻塞，不要求作者顺带处理。
- 同一根因只报告一次。维护者已明确接受的取舍，不在缺少新证据时反复要求修改；仍有具体缺陷时说明新证据和影响。未发现可验证的问题时直接说明，无需凑数。
- 普通功能、修复、重构和文档 PR 不要求升级版本或同步所有版本字符串。涉及发布或协议变更时，按实际请求链检查兼容性；`acceptedClientVersions` 是允许列表，不必与包版本逐字一致。只有能证明目标部署会拒绝本次客户端请求等实际问题时，才提出相应缺陷。
- 不默认承诺兼容所有历史存档，也不因新增字段或调整 schema 就要求补默认值、迁移或旧档恢复。兼容范围以本次需求和明确支持的数据格式为准；破坏仍受支持的数据读取、丢失数据或绕过校验时，应报告具体路径和影响。
- Agent 可以创建 PR、推送功能分支并回复审查线程；PR 的关闭和合并由人工维护者负责，agent 不得关闭或合并 PR。
- 临时设计草稿、模拟报告和 AI 审查记录默认保留在本地；正式文档按任务需要提交。

## 项目与代码导航

魔女狼人杀是基于 React/TypeScript 的浏览器社交推理游戏，支持 6–14 人、确定性种子、本地持久化、真人或观战模式、AI 决策、本地回退、多人房间和离线 PWA。

- `src/main.tsx`、`src/app/App.tsx`：启动、主题恢复、界面组合与按需加载。
- `src/app/useGameController.ts`：持久状态、本地存储、生命周期、回调和 AI 自动化。
- `src/domain/model.ts`、`src/domain/engine/`：领域模型与 `createGame` → `reduceGame` → `selectObservation` 数据流。
- `src/domain/skills/`：魔女技实现；共享版型与协议契约见 `shared/gamePromptContract.js`。
- `src/ai/`：`prompts.ts` 接收限定视角的观察，`client.ts` 请求提供商，`schemas.ts` 校验决策，`fallback.ts` 提供确定性回退。
- `src/features/`：准备区、游戏和设置界面；组件旁放置 CSS Module，全局主题见 `src/styles/global.css`。
- `src/storage/`：浏览器持久化、schema 与显式兼容处理。
- `src/multiplayer/`：浏览器 WebSocket 协议与房间 hook；`multiplayer/`：独立房间服务器及持久化。
- `server/`、`proxy/`：公益请求经主后端校验、限流，再通过 mTLS/HMAC 代理访问提供商；自定义提供商由浏览器直连。主后端也转发 `/multiplayer`。
- `scripts/`：冒烟测试、模拟和运维工具。`public/`：PWA 资源。`dist/`：生成产物。

## 修改相关代码时保留的边界

- 游戏状态通过 reducer/engine 转换。`reduceGame` 复制状态后在副本上推进，UI 不直接修改 `GameState`。提交决策沿用 `pendingDecision` 的身份和合法性校验。
- `selectObservation` 是隐私边界。玩家只能收到其有权看到的角色、事件、知识和投票信息，包括伪造发言作者及狼队私密记录的受众限制；观战和赛后视角按现有规则处理。
- 游戏随机性沿用 `rngState` 和 `src/domain/engine/random.ts`，不使用 `Math.random()`。密码学随机数用于种子、会话和房间令牌等边界数据。
- 阵容以共享契约和 `rolePoolForPlayerCount` 为准。保持职业、角色、技能和实体链接有效；造物 ID `99` 是额外实体，不占普通席位。
- 异步 AI 请求保留取消、超时、请求身份、销毁保护和待处理决策校验，防止过期结果写入新状态。
- 外部请求、AI 决策和持久化数据沿用所在模块的 Zod schema 或显式校验函数；未经校验的数据不直接进入领域逻辑。
- 密钥、密码、证书和私有更新材料不写入源码或日志。保留已有部署配置、证书及运行时数据。

## 实现习惯

沿用相邻代码的 TypeScript 类型、具名导出、单引号、分号和两空格缩进。领域类型及共享契约优先复用已有定义；领域规则放在引擎，临时表单状态放在功能组件，持久状态放在控制器或领域层。优先使用标准库和浏览器原生 API，仅在能减少实际复杂度时增加抽象或依赖。

界面改动复用现有 CSS token、主题和 CSS Module，保留键盘焦点与减少动画支持。这些习惯不要求对未涉及的代码统一改写。

## 开发与验证

使用 Node.js 22+ 和 npm，依赖按已提交的 lockfile 安装。可执行命令以 `package.json` 为准：

```bash
npm ci
npm run dev                    # 通常为 http://127.0.0.1:5173
npm run build                  # TypeScript 检查与 Vite 构建
npm run test:domain            # 知识与投票
npm run test:backend           # 离线主后端/代理集成
npm run test:multiplayer       # 离线 WebSocket 集成
npm run test:update            # 离线更新与回滚
npm run test:storage
npm run test:ai-guidance
npm run sim -- --games 1000    # 确定性模拟，结果用于比较，不是平衡性通过标准
py -m unittest scripts/test_verify_provider.py
```

- 验证范围与改动风险匹配。文档修改检查内容和差异即可；代码修改运行相关检查，跨模块改动结合构建和受影响的集成测试。无需每个 PR 跑全套或新增测试。
- 新增回归覆盖应验证有意义的行为或失败边界，避免断言源码文本或内部拆分方式。额外技能检查见 `scripts/verify-*.mjs`，按受影响功能选择。
- 改动界面布局或交互时，在浏览器验证受影响的桌面/移动界面。`test:visual-evidence` 只生成 JSON，不等于浏览器验证。
- 在线 AI 测试可能消耗提供商配额，仅在任务需要且已授权时运行。离线后端测试可能需要 OpenSSL，Windows 可通过 `OPENSSL_BIN` 指定路径；不要覆盖现有线上证书。
- 记录已运行的检查及结果；不能运行时说明原因，不把未验证说成通过。

部署与环境变量说明见 `README.md`，集成部署优先参考 `compose.yaml`。执行运维脚本前核对实际文件和配置；文档中的现状描述可能过时，遇到冲突以源码、配置和明确的任务要求为准。
