# agentmobile4CC

### 你的 AI 编程助手，随身携带。

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20商业授权-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/librae8226/agentmobile4cc?style=flat-square)](https://github.com/librae8226/agentmobile4cc/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-欢迎-brightgreen?style=flat-square)](CONTRIBUTING.md)

<!-- [English](README.md) -->

---

### 演示

<p>
  <video src="https://github.com/user-attachments/assets/083495f7-d840-4733-9307-eaa815c2756f" width="45%" controls muted align="center">
    Your browser does not support the video tag.
  </video>
</p>

---

## 亮点

| | |
|---|---|
| **双 AI 后端** | 按窗口自由切换 Claude Code ⚡ 或 OpenAI Codex CLI 🔷——按需选择最合适的工具。 |
| **随时指挥 AI** | 你的时间是碎片化的，你的 AI 不应该被困住。在地铁上、会议间隙、出差途中，随时给 AI Agent 下指令。 |
| **专为触控打造** | 不是把桌面终端硬塞进手机。左右滑动切换会话、双指缩放、可配置软键盘工具栏——从第一天起就为手指设计。 |
| **完整记忆，始终在线** | AI Agent 运行在你的电脑上，跑在 tmux 会话里——完整的代码库、完整的对话历史、完整的项目上下文。不是云端聊天，不会忘事。 |
| **发射后不管** | 下达指令，锁上手机。AI 继续执行。回来时，一切就在你离开的地方。 |

---

## 为什么选 agentmobile4CC？

|                              | Anthropic Remote Control | Happy Coder | Omnara  | **agentmobile4cc** |
|------------------------------|:---:|:---:|:---:|:---:|
| 双 AI 后端（Claude + Codex） | ❌ | ❌ | ❌ | ✅ |
| 自托管                       | ❌ | ❌ | ⚠️ | ✅ |
| 无需订阅                     | ❌ ($100+/月) | ✅ | ❌ ($9/月) | ✅ |
| 数据留在本地                 | ❌ | ❌ | ❌ | ✅ |
| 真实终端（xterm）            | ❌ | ❌ | ❌ | ✅ |
| 项目与频道管理               | ❌ | ⚠️ | ⚠️ | ✅ |
| 发射后不管                   | ⚠️ (10分钟超时) | ✅ (经中继) | ✅ (经中继) | ✅ (纯 tmux) |
| PWA / 可安装                 | ❌ | ✅ (原生 App) | ✅ (原生 App) | ✅ |
| 开源                         | ❌ | ⚠️ 部分开源 | ✅ | ✅ |

> **项目与频道管理：** 以目录为单位组织项目，每个项目下有多个频道式会话——像 Slack 频道一样即时切换，专属于你的终端工作流。

---

## 功能

- 🔌 **WebSocket ↔ tmux 桥接** — 每个 tmux 窗口一个 PTY，实时双向 I/O
- 📱 **移动端优先终端** — xterm.js + 滑动导航 + 双指缩放 + 可配置软键盘
- 🤖 **双 AI 后端** — 按窗口切换 Claude Code ⚡ 和 OpenAI Codex CLI 🔷
- 🎯 **任务面板** — 异步发送任务（`claude -p` / `codex exec`），SSE 流式监控进度
- 📂 **文件浏览器** — 浏览、编辑、上传工作区文件
- 🗂️ **项目与频道管理** — 以目录为单位组织项目，多个频道式会话，像 Slack 频道一样切换
- 🔀 **多会话管理** — 秒切 tmux session
- 🎨 **PWA** — 可安装、深色/浅色主题
- ⚡ **零延迟体感** — WebSocket 直连，无 SSH 开销
- 💬 **IM Bridge** — Telegram 与飞书 / Lark 作为 web 之外的第二种交互方式

---

## 快速开始

```bash
git clone https://github.com/librae8226/agentmobile4cc.git && cd agentmobile4cc
cp .env.example .env          # 设置 JWT_SECRET、ACC_PASSWORD_HASH、WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# 在任意设备打开 http://localhost:59000 🚀
```

> 完整配置指南（AI Profile、PM2、移动端访问、故障排查）：**[QUICKSTART.md →](docs/QUICKSTART.md)**

## IM 渠道

agentmobile 可以额外运行一个独立的 IM bridge 进程，让 web 不再是唯一入口。

```bash
# 先在 .env 中开启 IM_BRIDGE_ENABLED=true
npm run start:im
```

- Telegram 可在 Web 设置中初始化：打开 Settings → Telegram，填入 BotFather 生成的 Bot Token，并可选设置默认 tmux 窗口，然后重启 `agentmobile-im`
- 手动配置 Telegram 时仍使用 `TELEGRAM_BOT_TOKEN`
- 飞书 / Lark 可在 Web 设置中初始化：打开 Settings → Feishu，生成二维码后用飞书 / Lark 扫码认证，系统会把 `CTI_FEISHU_APP_ID`、`CTI_FEISHU_APP_SECRET` 写入 `.env` 并开启 IM bridge
- 手动配置飞书 / Lark 时仍使用 `CTI_FEISHU_APP_ID` 和 `CTI_FEISHU_APP_SECRET`
- 飞书消息事件走长连接；卡片按钮需要把 `/api/webhooks/feishu/card-action` 配到 `CTI_FEISHU_CALLBACK_PORT` 对外入口
- 运行时状态保存在 `im-data/`
- 可选 systemd unit: `agentmobile-im.service`

### 连接飞书 / Lark

推荐方式：在 Web 中扫码初始化。

1. 确认主服务已启动并可正常登录。
2. 在项目根目录的 `.env` 中开启：

```env
IM_BRIDGE_ENABLED=true
FEISHU_ENABLED=true
```

3. 登录 Web，打开 `Settings → Feishu`。
4. 按账号区域选择：
   - 中国大陆飞书账号：`Feishu`
   - 国际版 Lark 账号：`Lark`
5. 点击 `Generate QR Code`。
6. 用飞书 / Lark 扫码并确认授权。
7. 授权成功后，agentmobile 会把以下配置写入 `.env`：

```env
CTI_FEISHU_APP_ID=...
CTI_FEISHU_APP_SECRET=...
CTI_FEISHU_DOMAIN=...
```

如未设置 `CTI_FEISHU_ALLOWED_USERS`，系统还会把当前扫码用户的 `open_id` 写入允许名单。

8. 重启 IM bridge：

```bash
npm run start:im
```

如通过 systemd 或 PM2 托管 IM bridge，则重启对应的 `agentmobile-im` 进程或服务。

### 手动配置飞书 / Lark

如果你不走扫码，可以直接编辑 `.env`：

```env
IM_BRIDGE_ENABLED=true
FEISHU_ENABLED=true

CTI_FEISHU_APP_ID=your_app_id
CTI_FEISHU_APP_SECRET=your_app_secret

# 国际版 Lark 填 lark；中国大陆飞书可留空
CTI_FEISHU_DOMAIN=lark

# 可选：限制允许访问的用户，填 open_id，多个逗号分隔
CTI_FEISHU_ALLOWED_USERS=ou_xxx,ou_yyy

# 可选：是否展示工具调用卡片
CTI_FEISHU_SHOW_TOOL_CALL_CARDS=false
```

保存后启动或重启 IM bridge：

```bash
npm run start:im
```

### 启用飞书卡片按钮

普通消息收发只需要上面的配置。需要卡片按钮时，再额外配置 callback：

```env
CTI_FEISHU_CALLBACK_PORT=8788
CTI_FEISHU_VERIFICATION_TOKEN=your_verification_token
CTI_FEISHU_ENCRYPT_KEY=your_encrypt_key
```

将下面这个路径暴露到公网入口：

```text
/api/webhooks/feishu/card-action
```

例如公网域名是 `https://example.com`，则飞书后台里的卡片回调 URL 为：

```text
https://example.com/api/webhooks/feishu/card-action
```

- 飞书消息接收使用长连接，不依赖公网 webhook
- 卡片按钮回调依赖公网可访问的 callback URL
- 如果未配置 callback，消息通常仍可收发，但按钮不会生效

### 使用方式

连接完成并启动 IM bridge 后，直接在飞书里给 bot 发送消息即可。  
agent 会继续使用宿主机上的工作区、tmux 会话和 CLI 上下文处理任务；你也可以稍后回到 Web 端接管同一会话。

### 验证是否连接成功

最简单的验证方法：

1. 启动 IM bridge
2. 在飞书里给 bot 发一条测试消息
3. 确认 bot 有回复，或在 IM bridge 日志里看到入站消息

如果前台运行：

```bash
npm run start:im
```

可直接在终端查看 bridge 日志输出。

### 常见问题

- 扫码成功但飞书里没有响应：通常是 IM bridge 没有重启，或者 `IM_BRIDGE_ENABLED` / `FEISHU_ENABLED` 未开启
- 能收消息但卡片按钮不能点：通常是没有配置 `CTI_FEISHU_CALLBACK_PORT` 或 callback URL 没有公网可达
- 只有部分人能用：检查 `CTI_FEISHU_ALLOWED_USERS`，这里要求填 `open_id`，不是手机号或邮箱
- Lark 国际版无法工作：检查 `CTI_FEISHU_DOMAIN=lark` 是否正确设置

---

## 使用 AI 助手一键安装

如果你是正在帮用户安装 agentmobile 的 AI 助手，按以下步骤执行：

1. 克隆本仓库并 `cd` 进入目录
2. 运行 `node scripts/setup.js` — 自动处理依赖安装、前端构建、PM2 启动和 tmux 会话创建
3. 验证：`pm2 status` 显示 `agentmobile` 在线 → 打开 `http://localhost:59000`

前置要求：Node.js 20+、tmux。PM2 不存在时会自动全局安装。  
默认登录密码：`agentmobile123`（安装完成后可在 `.env` 中修改）。

---

## 部署建议

通过 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) 或 [Tailscale](https://tailscale.com/) 安全暴露服务，无需端口转发。

---

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | 20+ | |
| tmux | 任意近期版本 | |
| PM2 | 任意近期版本 | `setup.js` 自动安装 |
| **Claude Code** | 最新 | 使用 Claude 后端时需要 |
| **Codex CLI** | 最新 | 使用 Codex 后端时安装（可选） |
| 操作系统 | Linux / WSL2 | |

---

## 双 AI 后端

agentmobile 支持 **Claude Code** 和 **OpenAI Codex CLI** 作为并行的 AI 后端。按窗口选择：

| | Claude Code ⚡ | Codex CLI 🔷 |
|---|---|---|
| **安装** | `npm install -g @anthropic-ai/claude-code` | `npm install -g @openai/codex` |
| **交互模式** | `claude --dangerously-skip-permissions` | `codex --yolo` |
| **异步任务** | `claude -p <prompt>` | `codex exec <prompt> --yolo --json` |
| **Profile** | `data/configs/*.json`（无 `agent_type` 或 `claude`） | `data/configs/*.json`（`"agent_type": "codex"`） |

两个后端共享同一 tmux 桥接、文件浏览器、项目管理和 PWA 前端。

---

## 安全说明

agentmobile 是**单用户自托管工具**，不是多租户平台。

- 🔒 bcrypt（12 轮）密码哈希 + JWT（30天）
- ⚠️ WebSocket token 通过 query string 传递 — 生产环境请启用 TLS
- 🛡️ 在防火墙、VPN 或隧道后运行，不要直接暴露在公网

---

## 文档

| 文档 | 说明 |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | 手把手配置指南 |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | 系统架构设计 |
| [ROADMAP.md](docs/ROADMAP.md) | 未来规划 |
| [📖 agentmobile 的故事](docs/story.md) | 为什么造了这个东西 |

---

## 社区

<p>
  <img src="https://github.com/user-attachments/assets/6960ca95-f26d-484b-aa66-56b5315e39d3" width="225" />
</p>

欢迎加微信（librae8226）深入交流。

---

## 关于作者

我是 Librae——软件工程师、创业者、早期科技 VC 投资人。

这三个角色有一个共同点：**最好的想法，从来不在办公桌前产生。**

agentmobile4CC 诞生于我自己的真实需求：在机场、出租车、会议间隙，随时能指挥和管理我的 AI 军团在电脑上工作。现在，它是开源的，也是你的。

---

## 贡献

欢迎 PR 和 Issue。见 [CONTRIBUTING.md](CONTRIBUTING.md) 了解本地开发环境和贡献规范。

---

## 许可证

双重授权：**[GPL v3](LICENSE.md)**（开源使用）· **商业授权**（用于商业/SaaS 产品）— 联系 [librae8226](https://github.com/librae8226) 或 [faywong](https://github.com/faywong)

---

*用 AI 构建，为开发者而生。*
