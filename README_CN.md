# agentmobile

### 你的 AI 编程助手，随身携带。

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20商业授权-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/wangxumarshall/agentmobile?style=flat-square)](https://github.com/wangxumarshall/agentmobile/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-欢迎-brightgreen?style=flat-square)](CONTRIBUTING.md)

[English](README.md)

> 自托管、移动优先的终端 AI agent 指挥中心——Claude Code、OpenAI Codex、OpenCode、Trae，或任何在终端里运行的 CLI。

你的 AI agent 跑在**你自己的**机器上、**你自己的** tmux 会话里——完整的代码库、完整的对话历史、完整的项目上下文，不是会忘事的云端聊天。agentmobile 直接桥接这些会话，把任意浏览器变成触控友好的指挥中心：手机、平板、折叠屏或桌面——一个界面，所有设备。无云端。无订阅。无 SSH 翻墙。只有你的终端，随身携带。

下达指令，锁上手机。AI 继续执行。回来时，一切就在你离开的地方。

---

## 亮点

| | |
|---|---|
| **多 AI 后端** | 按窗口切换 Claude Code ⚡、Codex CLI 🔷、OpenCode ◎ 或 Trae △——为每个任务选最合适的工具。 |
| **远端实例网格** | 注册其他 agentmobile 实例，本地与远端如同一体切换。终端、会话、任务、文件浏览器都走本地代理 + WS 桥接。 |
| **IM 桥接** | 把 Telegram 或飞书 / Lark 作为第二控制面——完整的 Plan 工作流、内联按钮、就地编辑——超越 web UI。 |
| **专为触控打造** | 不是把桌面终端硬塞进手机。左右滑动切窗口、双指缩放、可配置软工具栏 + 长按重复——从第一天起就为手指设计。 |
| **发射后不管** | Agent 跑在 tmux 里，不在浏览器里。关掉标签页，它们继续工作。重启后，`agentmobile-tmux` 把它们恢复。 |
| **双运行域** | Web 桥接、持久 tmux 运行域与 IM 桥接作为独立 systemd 单元运行——更新 web 不会杀死你的 agent。 |
| **任务面板** | 启动异步任务（`claude -p`、`codex exec … --json`），通过 SSE 流式输出，支持 `?from_seq=` 断线重连，持久化后可续接。 |
| **嵌入式文件浏览器** | 浏览、编辑、预览 Markdown（带 TOC），按名称/修改时间/大小排序，切换隐藏文件，宽屏并排展示。 |
| **项目与频道管理** | 以目录为单位的项目，每个项目下有频道式会话；双击频道关闭文件编辑器并跳转过去。 |
| **PWA** | 可安装到 iOS/Android，深色/浅色主题，原生触感，离线可用。 |

---

## 对比

agentmobile 是 [nexus4cc](https://github.com/librae8226/nexus4cc)（v4.8.3 谱系）的 fork——WebSocket↔tmux 桥接、xterm 前端、项目/频道模型、PWA 外壳、tmux-resurrect 持久化脚本原样继承——再与托管型替代品同台比较：

| 能力 | Anthropic Remote Control | Happy Coder | Omnara | nexus4cc | **agentmobile** |
|---|:---:|:---:|:---:|:---:|:---:|
| 多 AI 后端（Claude + Codex + …） | ❌ | ❌ | ❌ | ❌（仅 Claude） | ✅ Claude / Codex / OpenCode / Trae（`AGENT_SPECS` + 各后端启动脚本） |
| 自托管 | ❌ | ❌ | ⚠️ | ✅ | ✅ |
| 无需订阅 | ❌ ($100+/月) | ✅ | ❌ ($9/月) | ✅ | ✅ |
| 数据留在本地 | ❌ | ❌ | ❌ | ✅ | ✅ |
| 真实终端（xterm） | ❌ | ❌ | ❌ | ✅ | ✅ |
| 项目与频道管理 | ❌ | ⚠️ | ⚠️ | ✅ | ✅ |
| 远端实例网格 | ❌ | ❌ | ❌ | ❌ | ✅ `/api/remote-instances/*`——CRUD + test + login + HTTP 代理 + WS 桥接；SSH 隧道模式；bcrypt-12 远端 JWT 缓存 + 自动重登 |
| IM 渠道（Telegram / 飞书） | ❌ | ❌ | ❌ | ❌ | ✅ 独立 `im/` 进程——适配器、Plan 工作流状态机、`im-data/` 运行时存储 |
| 任务面板（异步 `claude -p` / `codex exec`） | ❌ | ❌ | ❌ | ❌ | ✅ `/api/tasks/*` + SSE 流式（`from_seq` 断线重连）+ 孤儿进程清理 |
| 发射后不管 | ⚠️ (10分钟超时) | ✅ (经中继) | ✅ (经中继) | ✅ (纯 tmux) | ✅ (纯 tmux) |
| PWA / 可安装 | ❌ | ✅ (原生 App) | ✅ (原生 App) | ✅ | ✅ |
| 开源 | ❌ | ⚠️ 部分开源 | ✅ | ✅ | ✅ |
| Web 发布不中断 agent | — | — | — | ❌ | ✅ `npm run service:deploy:web` 只重启 `agentmobile.service` |
| 进程管理 | — | — | — | PM2 | systemd 双运行域：`agentmobile`（web）+ `agentmobile-tmux`（持久 tmux）+ `agentmobile-im` |
| WebSocket 认证 | — | — | — | URL 里带 `?token=`（需 TLS） | HttpOnly cookie + in-band `{type:'auth',token}` 帧，2.5s 认证宽限 |
| `.env.example` 默认密码 | — | — | — | 预置 `nexus123` 哈希 | 留空——由你生成 |

> **项目与频道管理：** 以目录为单位组织项目，每个项目下有多个频道式会话——像 Slack 频道一样即时切换，专属于你的终端工作流。

原样继承自 nexus4cc 并保持更新：带 TOC 的嵌入式文件浏览器、`show-hidden` 切换、文件编辑器防护、双击频道关闭编辑器、`CONTEXT_TOKENS` 配置、浅色主题 ANSI 对比度、移动端键盘输入处理。

> 完整的逐补丁移植日志：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与提交历史（`feat(remote)`、`feat(persist)`、`feat(terminal): port nexus4cc …`）。

---

## 快速开始

```bash
git clone https://github.com/wangxumarshall/agentmobile.git && cd agentmobile
cp .env.example .env          # 设置 JWT_SECRET、ACC_PASSWORD_HASH、WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# 在任意设备打开 http://localhost:5000 🚀
```

> 完整配置指南——AI Profile、服务安装、移动端访问、服务操作：**[QUICKSTART.md →](docs/QUICKSTART.md)** / **[SERVICES.md →](docs/SERVICES.md)**

默认登录密码：`agentmobile`（安装完成后在 `.env` 中修改）。

---

## 用 AI 助手安装

如果你是正在帮用户安装 agentmobile 的 AI 助手，按以下步骤执行：

1. 克隆本仓库并 `cd` 进入目录
2. 运行 `node scripts/setup.js`——自动处理依赖安装、前端构建、服务安装和首个 tmux 会话
3. 验证：`npm run service:status`（systemd）或 `pm2 status`（PM2 fallback），再 `npm run service:verify` 确认 web 可达 + 持久 tmux 运行域，然后打开 `http://localhost:5000`

前置要求：见[环境要求](#环境要求)。setup 优先用 `systemd`，不可用时 fallback 到 PM2；服务操作见 [SERVICES.md](docs/SERVICES.md)。

---

## 多 AI 后端

agentmobile 支持多种终端 AI 后端。按窗口选择：

| | Claude Code ⚡ | Codex CLI 🔷 | OpenCode ◎ | Trae △ |
|---|---|---|---|---|
| **命令** | `claude` | `codex` | `opencode` | `trae` |
| **交互模式** | `claude --dangerously-skip-permissions` | `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox` | `opencode`（交互） | `trae-cli` / `trae` |
| **异步任务** | `claude -p <prompt>` | `codex exec <prompt> --yolo --json` | — | — |
| **Profile** | `data/configs/*.json`（`agent_type: claude`） | （`agent_type: codex`） | （`agent_type: opencode`） | （`agent_type: trae`） |
| **安装** | `npm i -g @anthropic-ai/claude-code` | `npm i -g @openai/codex` | `npm i -g opencode-ai` | 见 Trae 文档 |

所有后端共享同一套 tmux 桥接、文件浏览器、项目管理和 PWA 前端。启动脚本（`agentmobile-run-{claude,codex,opencode,trae}.sh`，共用 `agentmobile-run-common.sh`）负责引导 PATH、加载 profile RC 文件、把 `CONTEXT_TOKENS` 映射为 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，二进制缺失时回退到 `bash -i`。

---

## 远端实例

agentmobile 可以把其他 agentmobile 实例当作本地一样对话。注册一个远端（label、host、port、认证模式 `web` 或 `ssh`、用户名、密码、TLS），然后在顶部切换器里在本地 + 各远端之间切换。所有调用——终端、会话、任务、文件浏览器——都透明地走本端 `/api/remote-instances/:id/proxy/*` HTTP 代理和 `/api/remote-instances/:id/ws-proxy` WebSocket 桥接。

- **Web 模式**——直接 HTTPS/WS 到远端 API
- **SSH 隧道模式**——`ssh2` 对 `127.0.0.1:<port>` 开 `forwardOut`；HTTP 以裸 HTTP/1.1 经流转发
- **远端 JWT 缓存 + 自动重登**——远端的 token + JWT 过期时间被缓存；过期前自动重登；若只存了 bcrypt 哈希且缓存 token 已过期，会要求你重新输入密码
- **状态灯**——切换器按实例显示绿（token 已缓存）/黄/红

在 **Settings → Remote Instances** 管理远端实例。

---

## IM 渠道

agentmobile 可以额外运行一个独立的 IM bridge 进程，让 web 不再是唯一入口。

```bash
# 先在 .env 中开启 IM_BRIDGE_ENABLED=true
npm run start:im
```

`im/` bridge 是一个独立的 TypeScript 进程（`im/server-im.ts`），带 Telegram 和飞书 / Lark 适配器：

- **Telegram**——长轮询（启动时清理旧 webhook）。在 **Settings → Telegram** 配置：填入 BotFather token，可选设置默认 tmux 窗口，然后重启 `agentmobile-im`。原生内联按钮 + 就地编辑；`/start`、`/help` 以及没有活跃绑定的对话会显示 Command Center 卡片。新建会话按钮覆盖 Claude Code / Claude Plan / Codex Code / Codex Plan / Codex Ask。Plan 工作流是一个持久状态机（`drafting → awaiting_decision → executing → completed`，含 `revising`/`cancelled`），存于 `im-data/plan-workflows.json`。Codex 会话为每个绑定保留一个长期运行的交互式终端，带可编辑的实时预览。`/delete` 或 `/sessions` 里的删除按钮只删除 IM bridge 会话——不影响 web tmux 窗口或工作目录文件。
- **飞书 / Lark**——在 **Settings → Feishu** 初始化：生成二维码，用飞书 / Lark 扫码，系统会写入 `CTI_FEISHU_APP_ID` / `CTI_FEISHU_APP_SECRET` 并开启 IM bridge。消息事件走长连接；卡片按钮回调需要在 `CTI_FEISHU_CALLBACK_PORT` 上暴露一个 HTTP 入口 `/api/webhooks/feishu/card-action`。
- **运行时状态**——存于 `im-data/`（`bindings.json`、`sessions.json`、`plan-workflows.json`、`settings.json`，外加 `messages/` 和 `runtime/`）。
- **可选 systemd unit**——`agentmobile-im.service`（独立于 web 和 tmux 单元）。

`server.js` 里的旧版 Telegram webhook（`/api/webhooks/telegram`）仅作兼容保留，不实现新的卡片和 Plan 工作流状态机。飞书 / Lark 的完整初始化、手动配置、卡片回调、验证与常见问题见 [QUICKSTART.md](docs/QUICKSTART.md)。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 20+ | |
| tmux | 任意近期版本 | |
| systemd | 任意近期版本 | 默认服务管理方式 |
| PM2 | 任意近期版本 | systemd 不可用时由 `setup.js` 自动安装/使用 |
| **Claude Code** | 最新 | 使用 Claude 后端时需要 |
| **Codex CLI** | 最新 | 使用 Codex 后端时安装（可选） |
| **OpenCode / Trae** | 最新 | 可选后端 |
| 操作系统 | Linux / WSL2 | |

---

## 安全

agentmobile 是**单用户自托管工具**，不是多租户平台。

- 🔒 bcrypt（12 轮）密码哈希 + JWT（30天）
- 🔐 API 调用用 Bearer token；WebSocket 和 SSE 用 HttpOnly `agentmobile_token` 认证 cookie（WebSocket 发送 in-band `{type:'auth',token}` 帧，URL 里不带 token）
- 🛡️ 远端实例密码在静止时 bcrypt 哈希；远端 JWT 服务端缓存 + 自动重登
- 🧱 在防火墙、VPN 或隧道（Cloudflare Tunnel / Tailscale）后运行——不要直接暴露在公网

---

## 自动化

本仓库同时带有本地和 GitHub 侧的提交自动化：

- `npm run commit:auto` 暂存所有未忽略的本地改动并在本地创建标准提交
- `npm run commit:auto:push` 同上，并推送当前分支
- `npm run docs:index` 从 `docs/` 下的 markdown 文件重新生成 [docs/DOCS-INDEX.md](docs/DOCS-INDEX.md)
- `.github/workflows/auto-commit-generated.yml` 在 GitHub Actions 中运行，仅在已跟踪的文档改动或手动触发后才自动提交生成的文档索引

GitHub Actions 看不到未发布的本地编辑。因此云端自动提交仅限于仓库可见的、机器生成的文件。

---

## 文档

| 文档 | 说明 |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 手把手配置指南 |
| [DOCS-INDEX.md](docs/DOCS-INDEX.md) | 生成的 markdown 文档索引 |
| [SERVICES.md](docs/SERVICES.md) | 各服务的拉取、部署、重启、日志、回滚命令 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统设计与 API 参考 |
| [PRD.md](docs/PRD.md) | 功能规格 |
| [ROADMAP.md](docs/ROADMAP.md) | 未来规划 |
| [CODEX-SMART-CLI.md](docs/CODEX-SMART-CLI.md) | Codex 后端说明 |
| [📖 agentmobile 的故事](docs/story.md) | 为什么造了这个东西 |

---

## 贡献

欢迎 PR 和 Issue。见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解本地开发环境、提交规范和适合新人的 issue。

---

## 许可证

双重授权：**[GPL v3](LICENSE.md)**（开源使用）· **商业授权**（用于商业/SaaS 产品）— 联系维护者。

---

*为终端优先的 AI agent 而生——Claude Code、Codex、OpenCode、Trae，或任何在终端里运行的 CLI。Fork 自 [nexus4cc](https://github.com/librae8226/nexus4cc)。*
