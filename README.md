# 魔女狼人杀

支持 6–14 人的 AI 狼人杀网页游戏。开局可指定人数与出庭角色，职业按人数自动平衡为 2–4 名狼人、1 名预言家、1 名女巫和其余村民。角色人格、基础职业与魔女技互相独立；

当前客户端与提示词协议版本为 `2.4.0`。发布时必须同步更新 `package.json`、Vite 版本回退值，以及主后端和代理配置中的 `acceptedClientVersions`。

## 功能

- 6–14 人可配置阵容：可随机或手动选择出庭角色，支持全自动 AI 观战及用户加入一个席位
- 仅狼队可见的夜间文字议事与匿名团队袭击、预言家查验、女巫解药/毒药、公开顺序投票和一次平票重投
- 对局结束后可保留当前参赛角色与玩家席位，确定性重新分配职业并开始下一轮连续审判
- 14 项完整魔女技：魔女杀手、死亡回溯、洗脑、操控液体、怪力、漂浮、治愈、千里眼、视线诱导、灵魂交换、幻视、点火、声音模仿、魔女因子回收
- 深度机制：诺亚的液态造物（独立意志/可毒主人）、漂浮隐匿（免疫追溯）、千里眼直播（观看者暴露职业）
- 默认使用经主后端校验与限流的公益免费服务，无需 API Key；服务不保证稳定可用，可随时切换到自定义服务
- 也可切换到自定义 Chat Completions 服务，填写完整 `/chat/completions` 端点、模型、API Key 与思考强度；`none` 不发送 `reasoning_effort`，默认 `low`
- 设置、准备区选择和可恢复游戏进度保存在浏览器 `localStorage`
- 桌面三栏、大阵容双列名册、平板自适应网格、手机横向角色带与底部行动面板

## 本地运行

要求 Node.js 22 或更高版本及 npm。

```bash
npm install
npm run dev
```

开发服务器默认使用 `http://127.0.0.1:5173/`。开发时可用 `VITE_MAIN_BACKEND_ENDPOINT=http://127.0.0.1:34022/api/ai/chat/completions` 指向主后端。用户主动选择的自定义服务仍由浏览器直连。


## 模型提供商验证工具

`scripts/verify_provider.py` 是一个零依赖的 Tkinter 桌面工具，用于验证 OpenAI 兼容服务。填写 API 根地址、`/v1` 地址或完整 `/chat/completions` 端点，以及 API Key 和待测模型后，可拉取 `/models` 列表，并分别测试普通 Chat Completions 与 `response_format: {"type":"json_object"}` 的 JSON 对象输出。

```bash
py scripts\verify_provider.py
```

API Key 以遮蔽文本输入，仅在当前进程中通过 `Authorization: Bearer` 请求头发送；不会写入磁盘或日志。网络请求在后台线程执行，界面不会冻结。单元测试不访问外部服务：`py -m unittest scripts/test_verify_provider.py`。

## 构建与部署

```bash
npm run build
npm run preview
```

生产文件输出到 `dist/`。Vite 使用相对资源路径，可部署到静态站点或子路径。公益服务使用独立 API 域名，避免 Cloudflare 静态 Worker 对同域 `POST /api/*` 返回 405；也可在构建时通过 `VITE_MAIN_BACKEND_ENDPOINT` 覆盖完整入口。

推送与 `package.json` 版本一致的 `vX.Y.Z` tag 后，GitHub Actions 会创建对应 Release，并上传 `majo-wolf-vX.Y.Z-dist.zip`（静态站点）及 `majo-wolf-vX.Y.Z-backend.zip`（`proxy/`、`shared/`、`server/` 三合一后端源码）。发布包只包含该 tag 已跟踪的后端文件，不包含 `.env`、证书或其他本地文件。

## 主后端与代理服务

主后端接受浏览器公益请求，校验客户端版本、固定游戏提示词协议和 JSON 响应要求，并按客户端 IP 执行滑动窗口与并发限制。代理节点保存服务商、模型和 API Key 池；主后端可配置多个代理节点并在网络错误或 5xx 时切换。代理向服务商发送 `stream: true`，按 SSE 数据块接收并聚合为现有 Chat Completions JSON 后再返回主后端，因此浏览器协议不变。代理节点默认监听 `34023`，主后端与代理之间使用 TLS 1.3 双向证书认证及带时间戳、nonce、请求体摘要的 HMAC-SHA256 连接密码。

本地直接运行：

```bash
npm run certs:generate
copy server\main.config.example.json server\main.config.json
copy proxy\proxy.config.example.json proxy\proxy.config.json
copy proxy\providers.example.json proxy\providers.json
npm run server:proxy
npm run server:main
```

Docker 部署使用官方 `node:22-alpine` 镜像，不构建自定义镜像。`server/`、`proxy/` 和 `.runtime/` 以可读写绑定卷挂载到容器，证书目录只读挂载；代码更新后只需重启进程，无需重新构建镜像：

```bash
copy deploy.main.env.example deploy.main.env
copy deploy.proxy.env.example deploy.proxy.env
docker compose up -d
docker compose ps
```

`deploy.main.env` 只保存主后端所需的连接密码；`deploy.proxy.env` 额外保存独立的 `MAJO_UPDATE_PASS` 和 `providers.json` 引用的 API Key 环境变量。两个真实文件均被 Git 忽略，且 `MAJO_PROXY_PASSWORD_PRIMARY` 必须一致。主后端和代理容器共享代码卷与 `.runtime/restart-token`：更新事务全部成功后，代理写入重启信号；两个服务都会停止并由 Compose 的 `restart: unless-stopped` 使用原镜像重新启动，从而避免协议模块版本分裂。

代理自动更新接口仍受 mTLS 保护，并额外要求请求头 `Authorization: Bearer <MAJO_UPDATE_PASS>`；密钥不接受查询字符串。下载允许最多 5 次 HTTPS 重定向，网络错误、HTTP 408/425/429 和 5xx 默认自动重试 3 次，并在流式读取超过 8MB 时立即中止。更新文件先完整暂存，任一下载或替换失败都会清理临时文件并回滚已替换文件。同一时刻只允许一个更新事务。
主后端保持 HTTP 监听，由外部 Cloudflare/反向代理负责公网 HTTPS 终止；不要给主后端配置或暴露独立 HTTPS 端口。代理节点内部继续使用 TLS 1.3 mTLS。

快速更新工具：

```bash
py scripts\quick_update.py
```

工具通过 SSH 隧道连接代理的 mTLS `/update` 接口，读取本地 `certs/update-client.crt`、`certs/update-client.key`、`certs/ca.crt` 和 `certs/update-pass.txt`，先暂存主后端文件，再更新代理，最后重启并检查两个服务。执行前会要求确认生产更新；密钥不会写入日志。


把 `server/.env.example` 与 `proxy/.env.example` 中对应的 `MAJO_PROXY_PASSWORD_PRIMARY` 设置为同一个高熵随机值。`providers.json` 的 `apiKeysEnv` 指向逗号分隔的密钥环境变量。每个 provider 必须配置 `enabled`、`totalTimeoutMs`、`firstByteTimeoutMs` 和 `retryCount`：`enabled: false` 时完全跳过且不读取其 API Key；`retryCount` 只计算初次请求之后的额外重试。provider 按配置文件顺序组成固定 fallback 链，每次新请求都从第一个已启用 provider 开始；当前 provider 的重试预算耗尽后才尝试下一个，成功后立即停止。每次尝试轮换 API Key，首字节或总请求超时会中止当前上游连接。每个代理节点可使用独立密码变量、证书和服务商池；在主后端 `proxies` 中分别配置。主后端和代理的结构化日志均含 ISO `time`，成功请求分别记录 `ai_success`、`proxy_success` 和 `provider_success`。

`npm run certs:generate` 生成私有 CA、代理服务端证书和主后端客户端证书。部署时：

- 代理节点只放置 `ca.crt`、`proxy-server.crt`、`proxy-server.key`。
- 主后端只放置 `ca.crt`、`main-client.crt`、`main-client.key`。

主后端默认绑定 `127.0.0.1:34022`。公网必须只能通过你的 Cloudflare/反向代理访问该端口；反向代理必须覆盖客户端提交的同名头并写入可信的 `CF-Connecting-IP`。主后端按你的要求直接信任此头，不校验请求是否来自 Cloudflare，因此不要把主后端监听端口直接暴露公网。代理节点应通过防火墙只允许主后端来源访问 `34023`，mTLS 与 HMAC 是额外防线。

更新烟测：

```bash
npm run test:update
```

> [!WARNING]
> 不要在共享或不受信任的浏览器中保存真实密钥。


## 浏览器存储

- `majo-wolf.settings.v1`：免费服务选择，或自定义 Chat Completions 端点、模型、API Key 与思考强度
- `majo-wolf.setup.v1`：模式、玩家角色和随机种子
- `majo-wolf.game.v1`：版本化完整游戏状态

刷新发生在 AI 请求中时，只恢复待处理决策，不会自动重发请求。用户可以重试、将本局切换为确定性本地策略，或返回设置。

## 免费服务与赞赏

水梦梦给大家提供了免费服务，快来谢谢水梦梦大佬~

## 角色与技能

| 角色 | 默认魔女技 |
|---|---|
| 樱羽艾玛 | 魔女杀手 |
| 二阶堂希罗 | 死亡回溯 |
| 夏目安安 | 洗脑 |
| 城崎诺亚 | 操控液体 |
| 橘雪莉 | 怪力 |
| 远野汉娜 | 漂浮 |
| 月代雪 | 魔女因子回收 |
| 宝生玛格 | 声音模仿 |
| 冰上梅露露 | 治愈 |
| 紫藤亚里沙 | 点火 |
| 佐伯米莉亚 | 灵魂交换 |
| 莲见蕾雅 | 视线诱导 |
| 黑部奈叶香 | 幻视 |
| 泽渡可可 | 千里眼 |

## 版权与费用

本项目为非商业同人创作，仅供个人学习与交流。角色灵感与立绘来源于《魔法少女的魔女审判》，相关版权归原作者所有。版权联系：2730866258@qq.com。

项目本身免费。AI 服务请求由用户自己的服务商账户产生，费用和数据处理规则以所选服务商为准。

## 开源许可

与[上游](https://github.com/Illusory-moon/witch-wolfgame)保持相同。

详见LICENSE界面


