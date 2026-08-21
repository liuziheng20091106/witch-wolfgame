# 待办（TODO）

## 幻视（奈叶香）部署待办（PR #xx 已提交，未合并）

- [ ] **协议白名单同步**：`PUBLIC_SKILLS` 白名单已把「看到内心」改为「幻视」（`gameProtocol.mjs` + `witchSkills.ts` 已同步，版本号 2.3.2）。**部署前 main 和 proxy 的 `gameProtocol.mjs` 必须都更新**，否则免费通道会因白名单不匹配报 400（自定义 API 不受影响，走浏览器直连）。
- [ ] **部署方式待定**：`quick_update.py`（一键部署）需要本地 `certs/update-client.crt`、`update-client.key`、`ca.crt`、`update-pass.txt` 及到 main（192.168.0.109）的 SSH 免密 —— 这些在后端同学的部署环境里，本机未配置。备选：等后端同学配置好 update 认证后使用，或由后端同学手动部署。
- [ ] 上线后需同步前端（Cloudflare 自动部署）+ main/proxy（手动或脚本），三者一致后免费 API 恢复正常。
