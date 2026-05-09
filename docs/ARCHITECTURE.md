# ARCHITECTURE — agentmobile 架构现状

**Last Updated**: 2026-04-24  **版本**: v4.6.0-im  **锚点**: `docs/NORTH-STAR.md`

> **v4.6.0-im**: 新增 IM Bridge 正式入口，Telegram + Feishu / Lark 成为 web 之外的第二交互渠道。

---

## 系统概览

```
Browser (任意设备)
    ↕  WSS /ws                     ← WebSocket（HttpOnly cookie auth，原始 VT100 流）
    ↕  HTTPS /api/*                ← REST（Bearer / cookie 认证后端 JSON API）
agentmobile Server（Node.js，server.js）
    ↕  node-pty (ptyMap)           ← PTY 桥（每个 session:window 独立实例）
tmux attach-session -t <session>:<window>
agentmobile-tmux.service（systemd，持久 tmux runtime）
    ├── window 0: vault (⚡ Claude)
    ├── window 1: projects-blog (🔷 Codex)
    └── window N: ... (⚡/🔷/bash)
agentmobile IM Bridge（Node.js，im/server-im.ts，可选独立进程）
    ├── Telegram Adapter（polling）
    └── Feishu / Lark Adapter（WebSocket）
         ↕  BridgeManager → ConversationEngine → Claude / Codex provider
```

---

## 后端（server.js ~1775 行，单文件 ESM）

### 启动流程

1. 加载 `.env`（手动解析，无 dotenv 依赖）
2. 验证 `JWT_SECRET` 和 `ACC_PASSWORD_HASH`（缺失则 exit(1)）
3. 确保 `data/` 和 `data/configs/` 存在
4. 清理孤儿 running 任务（启动时 status → error）
5. 注册 Express 路由 + multipart 上传 + 静态文件
6. 创建 HTTP server + WebSocketServer（共享端口）

### API Endpoints

| Method | Path | Auth | 描述 |
|---|---|---|---|
| POST | `/api/auth/login` | 无 | 密码 bcrypt 比对，返回 JWT |
| GET | `/api/auth/session` | Cookie | 校验浏览器 HttpOnly 登录 cookie |
| **窗口 / 会话** | | | |
| GET | `/api/sessions` | Bearer | tmux list-windows（指定 session） |
| POST | `/api/sessions` | Bearer | tmux new-window（claude/bash/profile） |
| POST | `/api/windows` | Bearer | 新建窗口（附 profile/cwd） |
| DELETE | `/api/sessions/:id` | Bearer | tmux kill-window |
| POST | `/api/sessions/:id/attach` | Bearer | tmux select-window |
| POST | `/api/sessions/:id/rename` | Bearer | tmux rename-window |
| GET | `/api/sessions/:id/output` | Bearer | 获取窗口最新输出 + 状态 |
| GET | `/api/sessions/:id/scrollback` | Bearer | 获取完整滚动缓冲区 |
| GET | `/api/session-cwd` | Bearer | 获取当前 pane 工作目录 |
| GET | `/api/tmux-sessions` | Bearer | 列出全部 tmux session 名 |
| **项目 / Channel** | | | |
| GET | `/api/projects` | Bearer | 列出 project-channel 树 |
| POST | `/api/projects` | Bearer | 创建 project |
| GET | `/api/projects/:name/channels` | Bearer | 列出 project 下的 channel |
| POST | `/api/projects/:name/channels` | Bearer | 创建 channel（新窗口） |
| POST | `/api/projects/:name/activate` | Bearer | 激活 project |
| POST | `/api/projects/:name/rename` | Bearer | 重命名 project |
| DELETE | `/api/projects/:name` | Bearer | 删除 project |
| **工作区文件** | | | |
| GET | `/api/browse` | Bearer | 列出 WORKSPACE_ROOT 子目录 |
| GET | `/api/workspaces` | Bearer | 扫描 WORKSPACE_ROOT 子目录 |
| GET | `/api/workspace/files` | Bearer | 列出目录内容（带 stat 信息） |
| POST | `/api/workspace/mkdir` | Bearer | 创建目录 |
| POST | `/api/workspace/files` | Bearer | 创建文件 |
| GET | `/api/workspace/file` | Bearer | 读取文件内容 |
| PUT | `/api/workspace/file` | Bearer | 写入文件内容 |
| DELETE | `/api/workspace/entry` | Bearer | 删除文件或目录 |
| POST | `/api/workspace/rename` | Bearer | 重命名条目 |
| POST | `/api/workspace/copy` | Bearer | 复制条目 |
| POST | `/api/workspace/move` | Bearer | 移动条目 |
| **文件上传** | | | |
| POST | `/api/upload` | Bearer | 图片/文档上传（终端粘贴用） |
| POST | `/api/files/upload` | Bearer | 文件上传到工作区 |
| GET | `/api/files` | Bearer | 列出已上传文件 |
| DELETE | `/api/files/:date/:filename` | Bearer | 删除单个上传文件 |
| DELETE | `/api/files/all` | Bearer | 清空所有上传文件 |
| **配置** | | | |
| GET | `/api/config` | Bearer | 返回 WORKSPACE_ROOT 等配置 |
| GET | `/api/configs` | Bearer | 列出 claude profile |
| POST | `/api/configs/:id` | Bearer | 创建/更新 profile |
| DELETE | `/api/configs/:id` | Bearer | 删除 profile |
| GET | `/api/toolbar-config` | Bearer | 读取工具栏配置 |
| POST | `/api/toolbar-config` | Bearer | 保存工具栏配置 |
| **任务** | | | |
| GET | `/api/tasks` | Bearer | 列出任务历史（data/tasks.json） |
| POST | `/api/tasks` | Bearer | 提交任务（SSE 流式输出） |
| DELETE | `/api/tasks/:id` | Bearer | 删除任务记录 |
| **Telegram** | | | |
| POST | `/api/webhooks/telegram` | 无（secret check） | Legacy Telegram Bot webhook；正式 IM bridge 使用 `agentmobile-im` polling |
| GET | `/api/telegram/setup` | Bearer | Telegram Bot 状态信息 |
| GET | `*` | 无 | SPA fallback → index.html |

### PTY 层（ptyMap 多实例）

```javascript
// 每个 "session:windowIndex" 独立 PTY 实例
const ptyMap = new Map()
// entry: { pty, clients: Set<ws>, clientSizes: Map<ws, {cols,rows}>, lastOutput, lastActivity }
// scrollback: tmux history-limit 50000; API capture clamps to the same limit.

function getOrCreatePty(session, windowIndex) {
  // key = "session:windowIndex"
  // 按需 spawn tmux attach-session -t session:window
  // 不存在时自动 fallback 到可用窗口
}
```

**Resize 策略**: 多客户端时取所有连接的最小尺寸（min cols/rows），防止小屏遮挡内容。

### Agent 抽象层（v4.5.0+）

```javascript
// agent_type 优先级: 请求参数 > profile.agent_type > 默认 'claude'
function buildAgentShellCmd(agentType, profile, cwd, proxyPrefix) {
  if (agentType === 'bash') return bashShellCmd
  if (profile) {
    // profile 中 agent_type 字段决定使用哪个 run 脚本
    return agentType === 'codex'
      ? `agentmobile-run-codex.sh ${profile} ${cwd}`
      : `agentmobile-run-claude.sh ${profile} ${cwd}`
  }
  return agentType === 'codex'
    ? `codex --yolo`
    : `claude --dangerously-skip-permissions`
}
```

**Profile 格式**:
```json
// Claude profile (agent_type: "claude")
{ "label": "Anthropic", "BASE_URL": "", "API_KEY": "sk-ant-...", "DEFAULT_MODEL": "claude-sonnet-4-6" }

// Codex profile (agent_type: "codex")
{ "agent_type": "codex", "label": "OpenAI Codex", "BASE_URL": "https://api.openai.com/v1", "API_KEY": "sk-proj-...", "DEFAULT_MODEL": "gpt-5.4", "REASONING_EFFORT": "high", "SANDBOX_MODE": "danger-full-access" }
```

### 任务系统（runTask 统一抽象）

```javascript
function runTask(prompt, cwd, opts) {
  // opts: { sessionName, source, tmuxSession, profile, agentType, onChunk, onDone }
  // 1. 确定 agent: opts.agentType > profile.agent_type > 'claude'
  // 2. 创建任务记录（立即写入 data/tasks.json）
  // 3. 根据 agent_type 分支:
  //    - claude: spawn('claude', ['-p', prompt, '--dangerously-skip-permissions'])
  //    - codex:  spawn('codex', ['exec', prompt, '--yolo', '--json'])
  // 4. stdout/stderr → onChunk() 回调
  // 5. close → updateTask() + onDone() 回调
  // 返回 { taskId, kill }
}
```

- Web 端（`POST /api/tasks`）通过 `onChunk` 推 SSE 帧
- Telegram 端通过 `onChunk` 定时 editMessageText（每 5 秒）
- `tasks.json` 上限 200 条（`saveTasks` 强制执行）

### Telegram Bot（Legacy Webhook）

- 支持命令：`/list`（列窗口）、`/switch <name>`（切换目标窗口）、`/agent claude|codex`（切换 AI 后端）
- 接收消息 → `runTask()` 在目标窗口 cwd 执行（使用当前 agent_type）
- 接收文件/图片 → 下载到 WORKSPACE_ROOT → `runTask()` 附路径执行
- 目标窗口状态：持久化在内存 `telegramAgentType`（默认 'claude'）和服务重启后重置）
- 该入口仅保留兼容；新 Telegram 能力在 `agentmobile-im` Telegram adapter 中实现，避免 webhook 与 polling 两套行为并存。

### IM Bridge（im/server-im.ts）

- 独立进程入口：`npm run start:im`
- 统一桥接层：`BridgeManager` + `ChannelRouter` + `ConversationEngine`
- 支持渠道：Telegram、Feishu / Lark
- Feishu 初始化：Web 设置页调用 `/api/feishu/setup`，通过 SDK `registerApp` 生成扫码二维码，扫码成功后写入 `.env` 中的 app id / secret 并提示重启 IM bridge
- Feishu 消息事件：SDK long connection 订阅 `im.message.receive_v1`
- Feishu 卡片交互：HTTP callback `/api/webhooks/feishu/card-action`，用于权限按钮和 session/mode 卡片操作
- Claude runtime 使用 `@anthropic-ai/claude-agent-sdk`
- Telegram Codex runtime 使用长期运行的交互式 Codex PTY（`--no-alt-screen` + 全自动无审批），每个 binding 维护一个 terminal session；普通文本写入同一 PTY，`//<text>` 转义发送 Codex slash 命令。
- Telegram Command Center：`/start`、`/help`、无 active binding 时发送 inline button 卡片；callback dispatcher 统一处理 `cmd:*`、`new-session:*`、`mode:*`、`terminal-key:*`、`plan:*`、`resume:*`、`claude-mode:*`。
- Telegram 新建 session 卡片：Claude Code、Claude Plan、Codex Code、Codex Plan、Codex Ask；旧 slash commands 保留 fallback。
- Telegram 模式卡片：`/mode` 无参数返回当前 runtime 可用模式；Claude 保留 Plan / Auto-Edits / Default permission mode，Codex 提供 code / plan / ask。
- Telegram Codex 控制卡：`/screen` 发送原始终端快照；`/enter`、`/esc`、`/tab`、`/backspace`、`/ctrlc`、`/ctrld`、`/up`、`/down`、`/left`、`/right`、`/pgup`、`/pgdn` 映射终端按键；`/stop` 发送 Ctrl+C 并保留会话，`/reset` 终止 PTY 并停用 binding。卡片按钮与 slash command 行为等价。
- Telegram Plan workflow：状态保存在 `im-data/plan-workflows.json`，结构为 `PlanWorkflow { id, bindingId, channel route, promptText, planText, status, previewMessageId?, createdAt, updatedAt }`；状态机为 `drafting -> awaiting_decision -> revising -> executing -> completed | cancelled`。Plan Ready 卡片提供 Execute Plan、Revise Plan、Cancel；Execute 阶段临时切换到 code 执行并持续用 streaming preview / activity card 反馈，完成后按 runtime 恢复原 mode。
- 非 Telegram Codex runtime 仍使用 `codex exec` 非交互 provider；Web TaskPanel 的 `codex exec` 异步任务能力不变。
- 运行时状态持久化到 `im-data/`（bindings / sessions / plan-workflows / cache）
- v1 边界：普通对话、`/new`、`/reset`、`/mode`、streaming preview fallback、权限卡片、图片附件上下文、Telegram 卡片化入口与 Telegram Plan workflow 可用；Feishu Plan confirmation workflow 与 structured input cards 保持文本降级，后续补全。
- 可选 systemd unit：`agentmobile-im.service`

---

## 前端（frontend/src/）

### 组件树

```
App.tsx（路由）
├── LoginPage（内联于 App.tsx）
│    └── POST /api/auth/login
└── Terminal.tsx（主终端页）
     ├── TabBar.tsx              ← 窗口标签（< 768px 顶部导航）
     │    └── windowStatus.ts   ← 共享状态逻辑
     ├── xterm.js（Terminal 核心）
     │    ├── FitAddon
     │    ├── WebLinksAddon
     │    └── mobile touch handlers（单指滚动、双指缩放、水平滑动切换窗口）
     ├── Toolbar.tsx             ← 可配置按键栏（固定行 + 展开区）
     │    └── toolbarDefaults.ts
     ├── GhostShield.tsx         ← 覆盖层守卫（防止意外 keyboard 弹出）
     ├── SessionFAB.tsx          ← 移动端浮动操作按钮
     ├── NewWindowDialog.tsx     ← 新建窗口对话框
     ├── SessionManagerV2.tsx    ← project-channel 双层会话管理（lazy）
     ├── SessionManager.tsx      ← 旧版 session 面板（legacy，lazy）
     ├── WorkspaceSelector.tsx   ← 路径选择器（lazy）
     ├── WorkspaceBrowser.tsx    ← 文件浏览器（排序、右键菜单、lazy）
     │    └── FilePanel.tsx      ← 文件查看/编辑/Markdown 预览（lazy）
     ├── GeneralSettings.tsx     ← 通用设置面板（lazy）
     │    └── FeishuSettings.tsx ← 飞书扫码初始化与连接状态
     └── TaskPanel.tsx           ← claude -p 异步任务 + SSE 流（lazy）
```

### 布局断点

| 条件 | 布局 |
|---|---|
| `>= 768px` (isWidePC) | Sidebar (200px) + Terminal + Toolbar |
| `< 768px` | TabBar (top) + Terminal + Toolbar (bottom) |

### 状态管理

- 无全局状态库（React useState/useEffect）
- `token` 存 localStorage
- `toolbar config` 缓存 localStorage，权威源为服务端 `/api/toolbar-config`
- `font size`、`theme`、`active window` 持久化 localStorage

### 双 Effect 模式（Terminal.tsx）

```
Effect A [token]                 — 创建 XTerm + DOM + 触摸/resize 事件（只运行一次）
Effect B [token, activeWindowIndex] — 管理 WebSocket（窗口切换时重建）
```

- `intentionalClose` flag：避免 React cleanup 时触发重连
- `wsRef.current`：闭包中始终引用最新 WS
- `windowsRef + attachWindowFnRef`：Ref 确保 Effect A 的触摸 handler 可切换窗口无 stale 闭包

### 轮询架构

| 来源 | 端点 | 间隔 | 用途 |
|---|---|---|---|
| Terminal.tsx | `/api/sessions/:id/output?session=` | 3s | windowOutputs → TabBar + Sidebar |
| Terminal.tsx | `/api/tasks` | 5s | runningTaskCount → 徽标 + 标题 |
| TabBar.tsx（fallback） | `/api/sessions/:id/output` | 5s | 仅当 Terminal 未传入 windowOutputs 时 |
| TaskPanel.tsx | `/api/tasks` | 5s | 任务历史列表 |

### 国际化（i18n）

- 使用 `i18next` + `react-i18next` + `i18next-browser-languagedetector`
- 支持语言：中文（zh-CN）、英文（en）、日文（ja）、韩文（ko）、德文（de）、法文（fr）、西班牙文（es）、俄文（ru）
- 翻译文件：`frontend/src/locales/<lang>/translation.json`
- 入口：`frontend/src/i18n/index.ts`

---

## 数据层

```
data/
├── toolbar-config.json    # 工具栏布局（所有设备共享）
├── tasks.json             # 任务历史（上限 200 条）
└── configs/
    ├── profile-a.json     # claude 启动配置 profile
    └── profile-b.json
```

**特点**: No database — JSON files + live tmux state.

**Polling**:
- Terminal: `/api/sessions/:id/output?session=` (3s) → windowOutputs (shared to TabBar/Sidebar)
- Tasks: `/api/tasks` (5s) → badges/title/notifications

---

## 部署结构

```
agentmobile/
├── server.js              # 唯一后端（ESM，Node 20）
├── package.json           # 依赖：express ws node-pty bcrypt
├── agentmobile.service    # Web/PTY bridge systemd unit（可安全重启）
├── agentmobile-tmux.service # 持久 tmux runtime systemd unit
├── agentmobile-im.service # 可选 IM bridge systemd unit
├── ecosystem.config.cjs   # PM2 fallback 配置（systemd 不可用时生成/使用）
├── start.sh               # 手动启动脚本
├── scripts/service-control.sh # 服务拉取/部署/重启/验证统一入口
├── scripts/tmux-runtime.sh # tmux runtime keepalive
├── scripts/migrate-tmux-runtime.sh # 既有安装迁移到 runtime cgroup
├── agentmobile-run-claude.sh    # claude 会话启动脚本（server.js 调用）
├── frontend/
│   ├── src/               # React + TypeScript 源码
│   └── dist/              # Vite 构建产物（server.js 静态伺服）
├── public/
│   ├── icon.svg           # PWA 图标
│   ├── manifest.json      # PWA manifest
│   └── sw.js              # Service Worker（cache-first 静态资源，跳过导航请求）
└── data/                  # 持久化数据目录
```

### systemd 运行域

默认 systemd 部署拆成两个 unit：

| Unit | 职责 | 重启影响 |
|---|---|---|
| `agentmobile-tmux.service` | 持有 tmux server 和 Agent 后代进程 | 不随 Web 部署重启 |
| `agentmobile.service` | Express / WebSocket / node-pty bridge | 可重启；只清理临时 `tmux attach-session` 客户端 |

这样满足“浏览器或 Web 服务重启后 Agent 继续运行”的核心约束。`agentmobile.service`
保留正常 `KillMode=control-group`，用于清理 node-pty 派生的短生命周期 attach client；
真实会话进程由 `agentmobile-tmux.service` 承载。

PM2 fallback 仍是单进程管理路径，适用于 systemd 不可用的环境；生产部署优先使用 systemd 双运行域。

服务操作以 [`docs/SERVICES.md`](SERVICES.md) 和 `scripts/service-control.sh` 为准。普通拉代码发布只重启 `agentmobile.service`；IM bridge 变更只重启 `agentmobile-im.service`；`agentmobile-tmux.service` 只在受控维护窗口处理。

### 环境变量

| 变量 | 必须 | 默认 | 说明 |
|---|---|---|---|
| `JWT_SECRET` | ✓ | — | JWT 签名密钥（openssl rand -hex 32） |
| `ACC_PASSWORD_HASH` | ✓ | — | bcrypt hash 的登录密码 |
| `TMUX_SESSION` | | `main` | 要 attach 的 tmux session 名 |
| `WORKSPACE_ROOT` | | `/workspace` | 工作区根目录 |
| `PORT` | | `59000` | 监听端口 |
| `PROXY` | | — | 通用网络代理（Claude 和 Codex 共用） |
| `CLAUDE_PROXY` | | — | Claude Code 专用代理（覆盖 PROXY） |
| `CODEX_PROXY` | | — | Codex CLI 专用代理（覆盖 PROXY） |
| `OPENAI_API_KEY` | | — | OpenAI API Key（用于自动创建 codex profile） |
| `OPENAI_BASE_URL` | | — | OpenAI API Base URL（自定义 endpoint） |
| `TELEGRAM_BOT_TOKEN` | | — | Telegram Bot token（可选） |
| `TELEGRAM_CHAT_ID` | | — | 允许的 Telegram chat ID（可选） |
| `TELEGRAM_SHOW_TOOL_CALL_CARDS` | | `false` | 是否在 Telegram 显示 tool / activity cards |
| `IM_BRIDGE_ENABLED` | | `false` | 是否启用 IM bridge 进程 |
| `FEISHU_ENABLED` | | `false` | 是否启用 Feishu / Lark adapter |
| `CTI_HOME` | | `./im-data` | IM bridge 持久化目录（bindings / sessions / plan-workflows） |
| `CTI_DEFAULT_WORKDIR` | | `WORKSPACE_ROOT` | IM 默认工作目录 |
| `CTI_FEISHU_APP_ID` | | — | Feishu / Lark app id |
| `CTI_FEISHU_APP_SECRET` | | — | Feishu / Lark app secret |
| `CTI_FEISHU_DOMAIN` | | — | 海外 Lark 场景填 `lark`，国内飞书留空；扫码初始化会自动写入 |
| `CTI_FEISHU_CALLBACK_PORT` | | `0` | 飞书卡片按钮 callback HTTP 端口；0 表示不启用 |
| `CTI_FEISHU_VERIFICATION_TOKEN` | | — | 飞书卡片 callback verification token |
| `CTI_FEISHU_ENCRYPT_KEY` | | — | 飞书卡片 callback encrypt key |
| `CTI_FEISHU_ALLOWED_USERS` | | — | 允许使用 IM bridge 的 Feishu open_id 列表 |
| `CTI_FEISHU_SHOW_TOOL_CALL_CARDS` | | `false` | 是否显示 tool / activity cards |

---

## 已知技术债

| 位置 | 问题 | 优先级 |
|---|---|---|
| `server.js` | tmux 命令 cwd/name 特殊字符转义不完整 | 中 |
| `server.js` | `telegramAgentType` 重启后丢失，不持久化 | 低 |
| `server.js` | `collectProxyVars` 只接受一个代理参数，Codex 专用代理（`CODEX_PROXY`）未独立处理 | 低 |
| `Terminal.tsx` | window 切换通过 `\x02{index}` 键序列，依赖 tmux 快捷键 | 低 |
| `toolbarDefaults.ts` | 按键序列硬编码，无运行时验证 | 低 |
| `frontend/locales/` | 仅 en 和 zh-CN 有翻译，其他 6 种语言缺失 | 低 |
