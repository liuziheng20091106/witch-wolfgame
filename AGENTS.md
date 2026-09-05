# 仓库指南

## 项目概览

魔女狼人杀是一款基于 React/TypeScript 的浏览器社交推理游戏，支持配置 6–14 人对局。游戏支持确定性种子、localStorage 持久化、观战或真人玩家模式、AI 决策、确定性的本地回退、多人房间，以及可安装且支持离线的 PWA（`README.md`、`public/manifest.webmanifest`）。

可选服务包括公开主后端、私有提供商代理和独立多人服务器。主后端负责校验浏览器请求并限流；代理使用 TLS 1.3 双向 mTLS 与 HMAC，并管理提供商重试和回退；多人服务使用 WebSocket（`server/main.mjs`、`proxy/server.mjs`、`multiplayer/server.ts`）。

## 架构与数据流

- `src/main.tsx` 恢复主题状态并挂载 `src/app/App.tsx`。
- `App` 选择设置或游戏界面，组合本地或多人状态，挂载设置/PWA 界面，并按需加载大型视图（`src/app/App.tsx`）。
- `src/app/useGameController.ts` 管理持久 React 状态、本地持久化、生命周期、回调和 AI 自动化。本地对局依次经过 `createGame` → `reduceGame` → `selectObservation` → 功能视图（`src/domain/engine/createGame.ts`、`src/domain/engine/reducer.ts`、`src/domain/engine/selectors.ts`）。
- 状态转换由 reducer/engine 负责并采用事件驱动。`pendingDecision` 是命令边界：接受真人或异步 AI 结果前，必须校验其 ID、行动者、阶段和合法候选。严禁在 UI 代码中直接修改 `GameState`。
- `selectObservation` 是隐私边界。玩家视图不得暴露隐藏职业、私有事件、尚未公开的知识、秘密投票或真实的伪造发言作者；观战、结束和赛后复盘视图可以展示全量信息（`src/domain/engine/selectors.ts`）。
- AI 流程为 `prompts.ts` → `client.ts` → `schemas.ts`。提示词接收经过范围限制的观察；客户端校验端点、版本、会话、超时、重试和取消；Zod 校验模型决策。`fallback.ts` 使用带种子的 RNG/reducer 路径。
- 多人模式使用 `protocol.ts` 和 `useMultiplayerRoom.ts`：排队发送初始连接消息，持久化恢复令牌，消费房间快照，并且只提交观察到的待处理决策。
- 通过 `src/storage/browserStorage.ts` 持久化已提交状态；该模块校验有版本的设置、开局、对局、历史和会话数据及其迁移。历史记录按 `gameId` 去重并限制数量。
- 服务链路为浏览器 → `server/main.mjs` → mTLS/HMAC `proxy/server.mjs` → 提供商。自定义提供商流量由浏览器直连；主后端还会升级 `/multiplayer`。

核心不变量：

- 规则支持 6–14 个座位：2–4 名狼人、1 名预言家、1 名女巫，其余为村民。必须保持阵容、职业、角色、技能和实体关联有效（`src/domain/engine/createGame.ts`、`src/storage/gameStateSchema.ts`）。
- 在游戏逻辑中贯穿带种子的 `rngState`。只有明确需要生成随机种子时才使用 Web Crypto；游戏逻辑中绝不能使用 `Math.random()`（`src/domain/engine/random.ts`）。
- 确保 `package.json`、Vite 回退配置以及后端/代理的 `acceptedClientVersions` 版本同步（`README.md`、`vite.config.ts`、`server/main.config.example.json`、`proxy/proxy.config.example.json`）。
- 异步 AI 工作必须保留请求键、`AbortController`、超时、销毁保护和待处理决策校验（`src/app/useGameController.ts`、`src/ai/client.ts`）。
- 存储迁移策略：**不要为旧 localStorage 数据编写迁移**。协议或结构变更只能向 zod schema 增加可选字段；旧存档不兼容时，应确保用户能够删除旧存档（提供清理/损坏数据处理路径），而不是在代码中迁移它。
- Pull request 只能由人工维护者创建和合并：**agent 不得创建、关闭或合并 PR**。Agent 可以推送功能分支并回复审查线程，但 PR 生命周期操作归负责人负责。
- 工作文档（例如 `docs/` 下的设计草稿、模拟报告、AI 审查记录）仅作为本地工作笔记，**不得提交到仓库**。

## 关键目录

- `src/app/`：应用组合、控制器、主题/PWA、剪贴板、下载和导出适配器。
- `src/domain/`：模型、目录/数据、确定性引擎、事件、选择器和技能。
- `src/ai/`：提供商类型、提示词、客户端、schema、回退、诊断和设定集辅助工具。
- `src/features/setup/`、`src/features/game/`、`src/features/settings/`：受控 React 界面；CSS Module 与组件并列存放。
- `src/storage/`：持久化、迁移和 Zod schema。
- `src/multiplayer/`：浏览器 WebSocket 协议和房间 hook。
- `shared/`：浏览器/Node 契约，尤其是 `gamePromptContract.js`。
- `server/`：公开校验、CORS、速率/并发限制、代理编排和更新。
- `proxy/`：私有 mTLS 提供商代理、提供商/配置文件和更新。
- `multiplayer/`：独立房间服务器和持久化房间处理。
- `scripts/`：冒烟测试、模拟、证书生成、提供商工具和运维辅助脚本。
- `public/`：manifest 和图标。`dist/` 为生成目录并被忽略。

## 开发命令

需要 Node.js 22+ 和 npm。使用仓库已提交的 lockfile：

```bash
npm ci
npm run dev                    # Vite，通常为 127.0.0.1:5173
npm run build                  # 先运行 tsc -b，再运行 vite build
npm run preview
npm run server:multiplayer    # 通常为 127.0.0.1:34024
npm run server:local-ai       # 通常为 127.0.0.1:34025
npm run server:proxy
npm run server:main
```

常用检查：

```bash
npm run test:domain            # 知识 + 投票
npm run test:backend           # 离线主后端/代理集成
npm run test:multiplayer       # 离线 WebSocket 集成
npm run test:update             # 离线更新器/回滚
npm run test:storage
npm run test:ai-guidance
npm run sim -- --games 1000    # 相对 Monte Carlo 信号，不是通过/失败测试
py -m unittest scripts/test_verify_provider.py
```

`npm run certs:generate` 需要 OpenSSL 并会修改证书文件；仅在本地后端配置或冒烟测试时使用。`compose.yaml` 是当前集成式 Node 22 部署配置；拆分的 `compose.main.yaml` 和 `compose.proxy.yaml` 使用旧版 `./app/...` 挂载、缺少多人服务，未经检查不得视为规范配置（`compose.yaml`、`compose.main.yaml`、`compose.proxy.yaml`）。

## 代码规范与常见模式

- 使用严格 TypeScript：ES module、具名导出、单引号、分号、两空格缩进、`noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`（`tsconfig.json`、`src/**/*.ts`）。
- 在 `src/domain/model.ts` 集中定义领域类型，并使用可辨识联合。适用时从 `shared/gamePromptContract.js` 导入共享协议/目录契约。
- 信任任何外部、提供商、WebSocket、配置或 localStorage 数据前，先用 Zod 校验。AI 错误、无效决策、存储失败和损坏历史记录必须保持为相互独立的错误类别（`src/ai/schemas.ts`、`src/multiplayer/protocol.ts`、`src/storage/`）。
- 保持引擎逻辑纯粹且确定。新增规则应实现为 reducer/engine 的状态转换和结构化事件，不要写成 React 条件分支。
- 组件采用受控模式：传递范围明确且有类型的回调；临时表单状态放在功能模块，持久状态放在控制器/领域层。
- 组件/类型使用 PascalCase，函数/局部变量使用 camelCase，存储键/常量使用 UPPER_SNAKE_CASE。阶段/职业/技能判别值使用小写连字符字符串。
- 优先使用浏览器原生 API，包括 localStorage、Web Crypto、WebSocket、service worker、`AbortController`、`structuredClone`、剪贴板/下载、媒体查询和尺寸观察。
- 复用全局 CSS token/主题和 CSS Module；保留 focus-visible 无障碍行为及 `prefers-reduced-motion` 支持（`src/styles/global.css`）。
- 后端配置采用 JSON 加环境变量名称。绝不要把 API key、密码、证书内容或私有更新材料写入源码或日志。

## 重要文件

- `package.json`：版本、脚本和依赖；命令以此为准。
- `vite.config.ts`、`tsconfig.json`：构建、相对 base、service worker 生成、注入应用版本和严格编译器设置。
- `src/main.tsx`、`src/app/App.tsx`、`src/app/useGameController.ts`：浏览器启动和应用编排。
- `src/domain/model.ts`、`src/domain/engine/createGame.ts`、`reducer.ts`、`selectors.ts`、`random.ts`：权威状态、初始化、转换、隐私投影和确定性。
- `src/ai/client.ts`、`prompts.ts`、`schemas.ts`：提供商边界和合法决策契约。
- `src/storage/browserStorage.ts`、`gameStateSchema.ts`：持久化和不变量。
- `src/multiplayer/protocol.ts`、`useMultiplayerRoom.ts`：WebSocket 边界。
- `server/gameProtocol.mjs`、`server/main.mjs`、`proxy/server.mjs`：协议校验和服务路由。
- `server/main.config.example.json`、`proxy/proxy.config.example.json`、`proxy/providers.example.json`：规范配置结构；机密信息应放在环境文件中。
- `compose.yaml`：首选的集成部署配置。`README.md`：运维手册。`CHANGELOG.md`：面向用户的变更记录，不是命令权威来源。

## 运行时/工具偏好

- 使用 Node.js 22+ 和 npm；项目脚本不得改用 Bun。CI 固定使用 Node 22，并运行 `npm ci` 和 `npm run build`（`.github/workflows/release.yml`）。
- 仓库不提交 package-manager 版本字段、`.nvmrc` 或 `.node-version`；lockfile 使用 npm lockfileVersion 3。
- 浏览器代码依赖现代 `fetch`、`AbortController`、`structuredClone`、Web Crypto、`matchMedia`、`ResizeObserver`、`localStorage` 和 WebSocket。
- Python 为可选工具，用于零依赖的 Tkinter 提供商验证器及其标准库单元测试。证书生成/后端冒烟配置需要 OpenSSL；Windows 上可用 `OPENSSL_BIN` 覆盖自动发现路径。
- 前端环境变量为 `VITE_MAIN_BACKEND_ENDPOINT` 和 `VITE_MULTIPLAYER_ENDPOINT`。本地 AI 读取 `OMP_AI_CONFIG_FILE` 或 `OMP_AI_BASE_URL`、`OMP_AI_API_KEY`、`OMP_AI_MODEL`（`src/vite-env.d.ts`、`scripts/local-ai-proxy.mjs`）。
- 将 `.env`、部署环境文件、`certs/`、提供商密钥、更新密码、mTLS 密钥和 `.runtime/` 状态视为敏感信息。保留线上配置/证书，绝不要记录机密。

## 测试与质量保证

- QA 由脚本驱动而非测试框架驱动：`.mjs` 冒烟测试使用 Vite SSR 配合 Node `assert/strict` 或本地检查；Python 使用标准库 `unittest`。项目没有 Jest/Vitest/Playwright/Cypress 依赖、lint 命令、格式化命令、coverage 命令或覆盖率阈值（`package.json`、`scripts/`）。
- 离线领域/存储/AI/角色扮演/投票检查包括 `knowledge-fact-smoke.mjs`、`verify-voting.mjs`、`browser-storage-smoke.mjs`、`ai-debug-report-smoke.mjs`、`verify-ai-decision-guidance.mjs`、`roleplay-resource-smoke.mjs` 和 `configurable-roster-smoke.mjs`。
- `test:backend`、`test:multiplayer` 和 `test:update` 使用本地主机 fixture、临时目录、子进程、WebSocket 或生成的证书隔离依赖，并在结束后清理。它们覆盖协议/安全、重连、重试/回退、SSE、回滚、锁和重启信号。
- `test:visual-evidence` 在 `.runtime/ai-evidence` 下写入 JSON；它不是浏览器自动化。修改 UI 时，运行 `npm run dev`，待动画/主题稳定后在真实浏览器中检查桌面和移动界面。
- `test:ai-live`、`scripts/live-ai-integration-smoke.mjs` 和 `scripts/verify_provider.py` 可能发起真实网络请求并消耗提供商配额。只有在明确携带凭据并有意测试时才运行；绝不要在日志或产物中暴露密钥。
- `npm run sim` 运行确定性的本地回退对局（默认 200 局）并报告相对结果变化；它不是平衡性通过/失败测试。
- 多个 `scripts/verify-*.mjs` 功能检查没有 npm 别名，包括声音模仿、视野、漂浮、造物、点火、遗言、赛后复盘和千里眼。只有受影响行为需要时才直接运行。
- 为变更后的可观察契约和失败边界增加针对性回归覆盖。避免测试源代码文本或偶然的实现细节。

运维文档仍包含对 `scripts/quick_update.py` 和 `certs/update-pass.txt` 的过时引用；使用更新说明前请先确认这些文件。`deploy.main.env.example` 和 `deploy.proxy.env.example` 确实存在，但只有在复制出部署环境文件后才会被忽略。`package.json` 是可执行命令的权威来源；`README.md` 是运维手册，但并非绝对可靠。
