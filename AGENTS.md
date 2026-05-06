# AGENTS.md — agentmobile Development Standards

Project: **agentmobile** — WebSocket tmux 桥接，AI 终端移动端面板

---

## Quick Start

- Anchor: `docs/NORTH-STAR.md` — 修改任何文档前先对照锚点三原则
- Core standards: this file (`AGENTS.md`)
- Claude Code users: `CLAUDE.md` references this file

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js (ESM) + Express + ws + node-pty |
| Frontend | React 18 + TypeScript + xterm.js + Vite |
| Auth | JWT (30d) + bcrypt password hash |
| Runtime | 宿主机（WSL2）直接运行，Node.js + systemd 管理（PM2 fallback）；systemd 下 Web bridge 与 tmux runtime 分离 |
| Config | `.env` → `server.js` 顶部解构，无 dotenv 依赖 |
| Persist | `./data/`（toolbar config、session configs） |

## Architecture Constraints

- **多 PTY 架构**（F-11）：每个 `tmux session:window` 独立 PTY 实例，`ptyMap` 管理
- **systemd 双运行域**：`agentmobile.service` 只承载 Web/PTY bridge，`agentmobile-tmux.service` 承载持久 tmux/Agent；普通 Web 发布只重启 `agentmobile`
- **前端 dist 由 Vite 构建**，server.js 静态伺服 `frontend/dist/` + `public/`
- **no database**：会话状态从 tmux 实时读取，持久化只用 JSON 文件
- `WORKSPACE_ROOT` 指向宿主机工作区根目录，server.js 直接访问

## Key Files

```
server.js                  # 唯一后端入口：Express + WS + PTY + Tasks + Telegram
data/                      # 持久化数据（toolbar、tasks、configs）
public/
  sw.js                    # Service Worker（cache-first 静态资源）
  icon.svg                 # PWA 图标
frontend/src/
  App.tsx                  # 路由：登录页 / 终端页
  Terminal.tsx             # xterm.js + WebSocket + 触摸处理 + 双 Effect 模式
  Toolbar.tsx              # 可配置工具栏（固定行 + 展开区）
  TabBar.tsx               # tmux window 标签（< 768px 顶部导航）
  TaskPanel.tsx            # claude -p 异步任务面板（SSE 流式）
  SessionManager.tsx       # 新建/切换 session 面板（lazy）
  WorkspaceSelector.tsx    # 目录选择器（lazy）
  toolbarDefaults.ts       # 按键定义与出厂配置
  windowStatus.ts          # 窗口状态检测（Terminal + TabBar 共享）
docs/
  NORTH-STAR.md            # 锚点文件（核心问题/用户/Out-of-Scope）
  PRD.md                   # 功能规格
  ROADMAP.md               # 迭代路线图
  ARCHITECTURE.md          # 架构现状
  SERVICES.md              # 服务拉取、部署、重启、日志、回滚操作手册
```

---

## Agent Workflow Rules

- **用 `/plan`**：涉及多文件改动、架构变更、新 API endpoint、PTY 行为变更
- **用 `/tdd`**：新增工具栏按键逻辑、认证流程、API endpoint
- **直接做**：单文件 UI 调整、样式修复、文档更新

## Definition of Done

- Implementation matches requirements — no speculative features
- `docs/NORTH-STAR.md` 三原则未被违反（对照确认）
- Manual verification：打开浏览器验证受影响的用户流
- Commit follows standard below

## Version Management

**Source of truth: git tag**（`git describe --tags --abbrev=0`）

每次发布新版本时必须同步更新以下文件，否则版本显示会不一致：

| 文件 | 字段 |
|---|---|
| `package.json` | `"version"` |
| `frontend/package.json` | `"version"` |

发布流程：
```bash
# 1. 确认工作区干净
git status

# 2. 更新两个 package.json 的 version 字段

# 3. 提交
git add package.json frontend/package.json
git commit -m "chore: bump version to X.Y.Z"

# 4. 打 tag 并推送
git tag vX.Y.Z
git push && git push --tags
```

**不要**在 i18n 文件或代码里硬编码版本号 — Settings > About 通过 `/api/version`（读 git tag）动态显示，无需手动维护。

## Git Commit Standard

```
type(scope): imperative subject ≤ 72 chars

Body (optional, any language): explain why, not what.
Bug fixes: explain root cause.

Co-Authored-By: Claude <noreply@anthropic.com>
```

Types: `feat` `fix` `docs` `refactor` `test` `chore` `style`

Rules: English subject, imperative mood, no trailing period, blank line before body, **Co-Authored-By trailer required**.

## Code Standards

### General
- Implement only what the current task requires
- No speculative features, no opportunistic cleanup
- One logical change per commit

### TypeScript / React
- Strict mode; no `any`
- State and side effects via hooks only
- Single responsibility per component

### Security
- Secrets via env vars only — never hardcoded
- `.env` must not be committed (verify `.gitignore`)
- CORS: production must list explicit origins, no wildcards

## Agentic Behavior

- **Minimal footprint**: use only permissions needed
- **Prefer reversible actions**: confirm before destructive ops
- **Pause and ask** when scope exceeds request, destructive side-effect discovered, or intent is unclear
- **No opportunistic work**: no unrequested refactoring

---

## Deployment Constraints

- Service operations source of truth: [`docs/SERVICES.md`](docs/SERVICES.md) and `scripts/service-control.sh`.
- Normal Web/API/frontend deploy: `npm run service:pull:web` or `npm run service:deploy:web`; this restarts **only** `agentmobile.service`.
- IM bridge deploy: `npm run service:deploy:im` or `npm run service:restart:im`; this targets **only** `agentmobile-im.service`.
- `agentmobile-tmux.service` owns persistent tmux sessions and Agent descendants. Do **not** restart it during normal deploys; only use `scripts/service-control.sh restart-tmux --force` in a controlled maintenance window.
- After any restart, run `npm run service:verify`. If the affected service becomes unreachable after deployment, **rollback** the deployed code to the previous version immediately and restart only that affected service.

## Skills

- Installation and deployment workflow: see [`docs/skills/install-deploy/agentmobile-install-deploy.md`](docs/skills/install-deploy/agentmobile-install-deploy.md)

---

## Documentation Map

| Change type | Update |
|---|---|
| New feature / interface | `README.md` + `docs/PRD.md` |
| Roadmap / scope change | `docs/ROADMAP.md` |
| Architecture change | `docs/ARCHITECTURE.md` |
| Process / convention | `AGENTS.md` (this file) |
| Service operation change | `docs/SERVICES.md` + `scripts/service-control.sh` |
| Env var added | `.env.example` + commit body |
| Bug fix | commit body (root cause) |
