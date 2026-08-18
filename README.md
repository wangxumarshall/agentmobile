# agentmobile

### Your AI Coding Agent, Everywhere.

[![Node](https://img.shields.io/badge/node-20+-brightgreen?style=flat-square)](https://nodejs.org/)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3%20%2F%20Commercial-blue?style=flat-square)](LICENSE.md)
[![GitHub stars](https://img.shields.io/github/stars/wangxumarshall/agentmobile?style=flat-square)](https://github.com/wangxumarshall/agentmobile/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

[🇨🇳 中文](README_CN.md)

> Self-hosted, mobile-first command center for terminal-based AI agents — Claude Code, OpenAI Codex, OpenCode, Trae, or any CLI that runs in a terminal.

Your AI agents run on **your** machine, in **your** tmux sessions — full codebase, full history, full preferences, not a cloud chat that forgets everything. agentmobile bridges directly to those sessions and turns any browser into a touch-friendly command center: phone, tablet, foldable, or desktop — one interface, every device. No cloud. No subscription. No SSH gymnastics. Just your terminal, everywhere.

Give the instruction, close your phone. Your agents keep running. Open later — everything's exactly where you left it.

---

## Highlights

| | |
|---|---|
| **Multi-AI backend** | Switch between Claude Code ⚡, Codex CLI 🔷, OpenCode ◎, or Trae △ per window — pick the best tool for each task. |
| **Remote instance grid** | Register other agentmobile instances and switch between local + remotes as if they were one. Terminal, sessions, tasks, and the file browser all run through the local proxy + WS bridge. |
| **IM bridge** | Use Telegram or Feishu / Lark as a second control surface — full Plan workflow, inline buttons, in-place edits — beyond the web UI. |
| **Built for touch** | Not a desktop terminal shoehorned onto mobile. Swipe between windows, pinch-to-zoom, configurable soft toolbar with long-press repeat — purpose-built for fingers. |
| **Fire and forget** | Agents live in tmux, not the browser. Close the tab; they keep working. Reboot; `agentmobile-tmux` restores them. |
| **Dual runtime domain** | Web bridge, persistent tmux runtime, and IM bridge run as separate systemd units — update the web without killing your agents. |
| **Task Panel** | Launch async tasks (`claude -p`, `codex exec … --json`), stream output over SSE with `?from_seq=` reconnect, persist and resume later. |
| **Embedded file browser** | Browse, edit, preview Markdown (with TOC), sort by name/modified/size, toggle hidden files, side-by-side on wide screens. |
| **Project & channel management** | Directory-based projects, each with channel-like sessions; double-click a channel to close the file editor and jump to it. |
| **PWA** | Installable on iOS/Android, dark/light themes, feels native, works offline. |

---

## Comparison

agentmobile is a fork of [nexus4cc](https://github.com/librae8226/nexus4cc) (v4.8.3 lineage) — the WebSocket↔tmux bridge, xterm frontend, project/channel model, PWA shell, and tmux-resurrect persistence scripts are inherited as-is — then measured against the hosted alternatives:

| Capability | Anthropic Remote Control | Happy Coder | Omnara | nexus4cc | **agentmobile** |
|---|:---:|:---:|:---:|:---:|:---:|
| Multi-AI backend (Claude + Codex + …) | ❌ | ❌ | ❌ | ❌ (Claude only) | ✅ Claude / Codex / OpenCode / Trae (`AGENT_SPECS` + per-backend launcher) |
| Self-hosted | ❌ | ❌ | ⚠️ | ✅ | ✅ |
| No subscription needed | ❌ ($100+/mo) | ✅ | ❌ ($9/mo) | ✅ | ✅ |
| Data stays on your infra | ❌ | ❌ | ❌ | ✅ | ✅ |
| Real terminal (xterm) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Project & channel management | ❌ | ⚠️ | ⚠️ | ✅ | ✅ |
| Remote instance grid | ❌ | ❌ | ❌ | ❌ | ✅ `/api/remote-instances/*` — CRUD + test + login + HTTP proxy + WS bridge; SSH-tunnel mode; bcrypt-12 remote JWT cache + auto-relogin |
| IM channel (Telegram / Feishu) | ❌ | ❌ | ❌ | ❌ | ✅ separate `im/` process — adapters, Plan-workflow state machine, `im-data/` runtime store |
| Task Panel (async `claude -p` / `codex exec`) | ❌ | ❌ | ❌ | ❌ | ✅ `/api/tasks/*` + SSE streaming with `from_seq` reconnect + orphan cleanup |
| Fire & forget | ⚠️ (10min timeout) | ✅ (via relay) | ✅ (via relay) | ✅ (pure tmux) | ✅ (pure tmux) |
| PWA / installable | ❌ | ✅ (native app) | ✅ (native app) | ✅ | ✅ |
| Open source | ❌ | ⚠️ partial | ✅ | ✅ | ✅ |
| Web deploy without agent downtime | — | — | — | ❌ | ✅ `npm run service:deploy:web` restarts only `agentmobile.service` |
| Process manager | — | — | — | PM2 | systemd dual runtime domain: `agentmobile` (web) + `agentmobile-tmux` (persistent tmux) + `agentmobile-im` |
| WebSocket auth | — | — | — | `?token=` in URL (needs TLS) | HttpOnly cookie + in-band `{type:'auth',token}` frame, 2.5s auth grace |
| Default `.env.example` password | — | — | — | ships `nexus123` hash | left blank — you generate it |

> **Project & channel management:** Organize work by directory-based projects, each with multiple channel-like sessions — switch between them instantly, like Slack channels for your terminal.

Inherited from nexus4cc and kept current: embedded file browser with TOC, `show-hidden` toggle, file-editor guards, double-click-to-close channel, `CONTEXT_TOKENS` config, light-theme ANSI contrast, mobile keyboard input handling.

> Full graft-by-graft port log: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and commit history (`feat(remote)`, `feat(persist)`, `feat(terminal): port nexus4cc …`).

---

## Quick Start

```bash
git clone https://github.com/wangxumarshall/agentmobile.git && cd agentmobile
cp .env.example .env          # set JWT_SECRET, ACC_PASSWORD_HASH, WORKSPACE_ROOT
npm install && cd frontend && npm install && npm run build && cd ..
npm start
# Open http://localhost:5000 on any device 🚀
```

> Full setup guide — Claude profile config, service install, mobile access, service operations: **[QUICKSTART.md →](docs/QUICKSTART.md)** / **[SERVICES.md →](docs/SERVICES.md)**

Default login password: `agentmobile` (change it in `.env` after setup).

---

## Install with an AI Assistant

If you're an AI assistant helping a user install agentmobile, follow this path:

1. Clone this repo and `cd` into it
2. Run `node scripts/setup.js` — handles deps, frontend build, service install, and first tmux session
3. Verify: `npm run service:status` (systemd) or `pm2 status` (PM2 fallback), then `npm run service:verify` for web reachability + persistent tmux runtime, then open `http://localhost:5000`

Prerequisites: see [Requirements](#requirements). Setup prefers `systemd` and falls back to PM2 when unavailable; for service operations see [SERVICES.md](docs/SERVICES.md).

---

## Multi-AI Backend

agentmobile supports multiple terminal AI backends. Choose per window:

| | Claude Code ⚡ | Codex CLI 🔷 | OpenCode ◎ | Trae △ |
|---|---|---|---|---|
| **Command** | `claude` | `codex` | `opencode` | `trae` |
| **Interactive** | `claude --dangerously-skip-permissions` | `codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox` | `opencode` (interactive) | `trae-cli` / `trae` |
| **Async Task** | `claude -p <prompt>` | `codex exec <prompt> --yolo --json` | — | — |
| **Profile** | `data/configs/*.json` (`agent_type: claude`) | (`agent_type: codex`) | (`agent_type: opencode`) | (`agent_type: trae`) |
| **Install** | `npm i -g @anthropic-ai/claude-code` | `npm i -g @openai/codex` | `npm i -g opencode-ai` | see Trae docs |

All backends share the same tmux bridge, file browser, project management, and PWA frontend. The launcher scripts (`agentmobile-run-{claude,codex,opencode,trae}.sh`, sharing `agentmobile-run-common.sh`) bootstrap PATH, load profile RC files, map `CONTEXT_TOKENS` → `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, and fall back to `bash -i` if the binary is missing.

---

## Remote Instances

agentmobile can talk to other agentmobile instances as if they were one. Register a remote (label, host, port, auth mode `web` or `ssh`, username, password, TLS), then switch between local + remotes from the top switcher. Everything — Terminal, sessions, tasks, file browser — is transparently routed through the local `/api/remote-instances/:id/proxy/*` HTTP proxy and `/api/remote-instances/:id/ws-proxy` WebSocket bridge.

- **Web mode** — direct HTTPS/WS to the remote's API
- **SSH-tunnel mode** — `ssh2` opens `forwardOut` to `127.0.0.1:<port>`; HTTP is tunneled as raw HTTP/1.1 over the stream
- **Remote JWT cache + auto-relogin** — the remote's token + JWT-exp is cached; re-login happens automatically before expiry; if only the bcrypt hash is stored and the cached token has expired, you're asked to re-enter the password
- **Status lights** — the switcher shows green (token cached) / yellow / red per instance

Manage remotes in **Settings → Remote Instances**.

---

## IM Channels

agentmobile can run a separate IM bridge process so the web is no longer the only control surface.

```bash
# enable IM_BRIDGE_ENABLED=true in .env first
npm run start:im
```

The `im/` bridge is a standalone TypeScript process (`im/server-im.ts`) with adapters for Telegram and Feishu / Lark:

- **Telegram** — long-polling (clears old webhooks on startup). Configure from **Settings → Telegram**: paste the BotFather token, optionally set a default tmux window, then restart `agentmobile-im`. Native inline buttons and in-place edits; `/start`, `/help`, and chats without an active binding show a Command Center card. New-session buttons cover Claude Code / Claude Plan / Codex Code / Codex Plan / Codex Ask. Plan workflow is a persistent state machine (`drafting → awaiting_decision → executing → completed`, with `revising`/`cancelled`) stored in `im-data/plan-workflows.json`. Codex sessions keep one long-running interactive terminal per binding with an editable live preview. `/delete` or the delete button in `/sessions` removes the IM bridge session only — not the web tmux window or working-directory files.
- **Feishu / Lark** — initialize from **Settings → Feishu**: generate a QR code, scan it in Feishu / Lark, which writes `CTI_FEISHU_APP_ID` / `CTI_FEISHU_APP_SECRET` and enables the IM bridge. Message events use long-connection mode; card-button callbacks need an HTTP endpoint at `/api/webhooks/feishu/card-action` on `CTI_FEISHU_CALLBACK_PORT`.
- **Runtime state** — stored in `im-data/` (`bindings.json`, `sessions.json`, `plan-workflows.json`, `settings.json`, plus `messages/` and `runtime/`).
- **Optional systemd unit** — `agentmobile-im.service` (independent of web and tmux units).

The legacy `server.js` Telegram webhook (`/api/webhooks/telegram`) is compatibility-only and does not implement the new cards or Plan workflow state machine.

---

## Requirements

| Dependency | Version | Note |
|---|---|---|
| Node.js | 20+ | |
| tmux | any recent | |
| systemd | any recent | default service manager |
| PM2 | any recent | auto-installed by `setup.js` when fallback is needed |
| **Claude Code** | latest | for the Claude backend |
| **Codex CLI** | latest | for the Codex backend (optional) |
| **OpenCode / Trae** | latest | optional backends |
| OS | Linux / WSL2 | |

---

## Security

agentmobile is a **single-user, self-hosted tool** — not a multi-tenant platform.

- 🔒 bcrypt (12 rounds) password hash + JWT (30d)
- 🔐 API calls use Bearer tokens; WebSocket and SSE use the HttpOnly `agentmobile_token` auth cookie (WebSocket sends an in-band `{type:'auth',token}` frame, no token in the URL)
- 🛡️ Remote instance passwords are bcrypt-hashed at rest; remote JWTs are cached server-side with auto-relogin
- 🧱 Run behind a firewall, VPN, or tunnel (Cloudflare Tunnel / Tailscale) — do not expose directly to the internet

---

## Automation

This repo ships with both local and GitHub-side commit automation:

- `npm run commit:auto` stages all non-ignored local changes and creates a standard commit locally
- `npm run commit:auto:push` does the same, then pushes the current branch
- `npm run docs:index` regenerates [docs/DOCS-INDEX.md](docs/DOCS-INDEX.md) from the markdown files in `docs/`
- `.github/workflows/auto-commit-generated.yml` runs in GitHub Actions and only auto-commits the generated docs index after tracked docs changes or a manual dispatch

GitHub Actions cannot see unpublished local edits. Cloud auto-commit is therefore limited to repository-visible, machine-generated files.

---

## Documentation

| Doc | |
|---|---|
| [QUICKSTART.md](docs/QUICKSTART.md) | Step-by-step setup guide |
| [DOCS-INDEX.md](docs/DOCS-INDEX.md) | Generated index of markdown docs |
| [SERVICES.md](docs/SERVICES.md) | Pull, deploy, restart, logs, and rollback commands for each service |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design & API reference |
| [PRD.md](docs/PRD.md) | Feature specifications |
| [ROADMAP.md](docs/ROADMAP.md) | What's next |
| [CODEX-SMART-CLI.md](docs/CODEX-SMART-CLI.md) | Codex backend notes |
| [📖 The story behind agentmobile](docs/story.md) | Why this was built |

---

*Built for terminal-first AI agents — Claude Code, Codex, OpenCode, Trae, or any CLI that runs in a terminal. Forked from [nexus4cc](https://github.com/librae8226/nexus4cc).*
