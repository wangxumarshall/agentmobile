# agentmobile

### Your AI Coding Agent, Everywhere.

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20Commercial-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/librae8226/agentmobile4cc?style=flat-square)](https://github.com/librae8226/agentmobile4cc/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

---

## Highlights

| | |
|---|---|
| **Dual AI Backend** | Switch between Claude Code and OpenAI Codex CLI per window — use the best tool for each task. |
| **AI on the go** | Your time is fragmented. Your AI shouldn't be. Command your AI agents from your phone — commuting, in a meeting, or away from your desk. |
| **Built for touch** | Not a desktop terminal shoehorned onto mobile. Swipe between windows, pinch-to-zoom, configurable toolbar — purpose-built for fingers. |
| **Full context, always** | AI agents run on your machine, in your tmux sessions — your full codebase, your history, your preferences. Not a cloud chat that forgets everything. |
| **Fire and forget** | Give the instruction, close your phone. Your agents keep running. Open later — everything's exactly where you left it. |

---

## Why agentmobile?

|                          | Anthropic Remote Control | Happy Coder | Omnara  | **agentmobile** |
|--------------------------|:---:|:---:|:---:|:---:|
| Dual AI backend (Claude + Codex) | ❌ | ❌ | ❌ | ✅ |
| Self-hosted              | ❌ | ❌ | ⚠️ | ✅ |
| No subscription needed   | ❌ ($100+/mo) | ✅ | ❌ ($9/mo) | ✅ |
| Data stays on your infra | ❌ | ❌ | ❌ | ✅ |
| Real terminal (xterm)    | ❌ | ❌ | ❌ | ✅ |
| Project & channel management | ❌ | ⚠️ | ⚠️ | ✅ |
| Fire & forget            | ⚠️ (10min timeout) | ✅ (via relay) | ✅ (via relay) | ✅ (pure tmux) |
| PWA / installable        | ❌ | ✅ (native app) | ✅ (native app) | ✅ |
| Open source              | ❌ | ⚠️ partial | ✅ | ✅ |

> **Project & channel management:** Organize work by directory-based projects, each with multiple channel-like sessions — switch between them instantly, like Slack channels for your terminal.

---

## Features

- 🔌 **WebSocket ↔ tmux bridge** — one PTY per window, real-time bidirectional I/O
- 📱 **Mobile-first terminal** — xterm.js, swipe navigation, pinch-to-zoom, configurable soft toolbar
- 🤖 **Dual AI Backend** — switch between Claude Code ⚡ and OpenAI Codex CLI 🔷 per window
- 🎯 **Task Panel** — launch async tasks (claude -p / codex exec), monitor via SSE streaming
- 📂 **File browser** — browse, edit, upload workspace files (sort by name / modified / size)
- 🗂️ **Project & channel management** — directory-based projects, each with channel-like sessions (like Slack channels for your terminal)
- 🔀 **Multi-session** — switch tmux sessions instantly
- 🎨 **PWA** — installable, dark / light themes
- ⚡ **Zero overhead** — direct WebSocket pipe, no SSH
- 💬 **IM Bridge** — use Telegram or Feishu / Lark as a second interaction channel beyond the web UI

---

## Quick Start

```bash
git clone https://github.com/wangxumarshall/idea0019-agent-mobile.git && cd agentmobile
cp .env.example .env          # set JWT_SECRET, ACC_PASSWORD_HASH, WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# Open http://localhost:5000 on any device 🚀
```

> Full setup guide including Claude profile config, service install, and mobile access: **[QUICKSTART.md →](docs/QUICKSTART.md)**

## IM Channels

agentmobile can run a separate IM bridge process so web is no longer the only control surface.

```bash
# enable IM_BRIDGE_ENABLED=true in .env first
npm run start:im
```

- Telegram can be configured from the web UI: open Settings → Telegram, paste the BotFather token, optionally set a default tmux window, then restart `agentmobile-im`
- Manual Telegram setup still uses `TELEGRAM_BOT_TOKEN`
- Feishu / Lark can be initialized from the web UI: open Settings → Feishu, generate a QR code, and scan it in Feishu / Lark. This writes `CTI_FEISHU_APP_ID`, `CTI_FEISHU_APP_SECRET`, and enables the IM bridge in `.env`.
- Manual Feishu / Lark setup still uses `CTI_FEISHU_APP_ID` and `CTI_FEISHU_APP_SECRET`
- Feishu message events use long connection mode; card buttons need an HTTP callback at `/api/webhooks/feishu/card-action` on `CTI_FEISHU_CALLBACK_PORT`
- Runtime state is stored in `im-data/`
- Optional systemd unit: `agentmobile-im.service`

---

## Install with an AI Assistant

If you're an AI assistant helping a user install agentmobile, follow this path:

1. Clone this repo and `cd` into it
2. Run `node scripts/setup.js` — handles deps, frontend build, service install, and first tmux session
3. Verify:
   - `systemctl status agentmobile` if systemd is available
   - `pm2 status` if setup fell back to PM2
   - then open `http://localhost:5000`

Prerequisites: Node.js 20+, tmux. Setup prefers `systemd` and automatically falls back to PM2 when `systemd` is unavailable.  
Default login password: `agentmobile` (user can change it in `.env` after setup).
---

## Requirements

| Dependency | Version | Note |
|---|---|---|
| Node.js | 20+ | |
| tmux | any recent | |
| PM2 | any recent | auto-installed by `setup.js` when fallback is needed |
| **Claude Code** | latest | for Claude backend |
| **Codex CLI** | latest | for Codex backend (optional) |
| OS | Linux / WSL2 | |

---

## Security

agentmobile is a **single-user, self-hosted tool** — not a multi-tenant platform.

- 🔒 bcrypt (12 rounds) password hash + JWT (30d)
- ⚠️ WebSocket token passed via query string — enable TLS in production
- 🛡️ Run behind firewall, VPN, or tunnel — do not expose directly to the internet

---

## Dual AI Backend

agentmobile supports **Claude Code** and **OpenAI Codex CLI** as parallel AI backends. Choose per window:

| | Claude Code ⚡ | Codex CLI 🔷 |
|---|---|---|
| **Command** | `claude` | `codex` |
| **Interactive** | `claude --dangerously-skip-permissions` | `codex --yolo` |
| **Async Task** | `claude -p <prompt>` | `codex exec <prompt> --yolo --json` |
| **Profile** | `data/configs/*.json` (agent_type: claude) | `data/configs/*.json` (agent_type: codex) |
| **Install** | `npm install -g @anthropic-ai/claude-code` | `npm install -g @openai/codex` |

Both backends share the same tmux bridge, file browser, project management, and PWA frontend.

---

## Documentation

| Doc | |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Step-by-step setup guide |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [📖 The story behind agentmobile](docs/story.md) | Why this was built |


---

## Contributing

PRs and issues welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, commit standards, and good first issue ideas.

---

*Built with AI, for developers.*
