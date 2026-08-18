# PRD — agentmobile AI 终端面板 **(v1 Complete / 已完成)**

**版本**: v1.0.0  **状态**: Complete  **锚点**: `docs/NORTH-STAR.md`  **完成日期**: 2026-04-01

---

## Problem Statement

开发者需要一个统一入口，让 AI Agent 能在任意项目目录中持续运行，并能在 PC、手机、IM 等任意渠道随时介入——现有工具（ttyd、SSH）在移动端控制字符输入残缺，且缺乏针对 AI Agent 生命周期的管理界面和异步交互能力。

---

## Target Users

**用户即开发者本人**（单用户/个人服务器）
- 同时跑多个 Claude Code Agent，需要随时从任意设备查看进度、发送指令
- 外出时通过手机/Telegram/飞书 给 AI 下任务，回家后在 PC 上接续
- 不想保持 SSH 连接，关掉浏览器后 Agent 继续运行

---

## Core Features

### Must（v1 Complete）

| ID | Feature | 验收标准 |
|---|---|---|
| F-01 | WebSocket tmux 桥接 | 浏览器关闭后 tmux 和 Agent 继续运行；重新打开可接续 |
| F-02 | JWT 单密码认证 | 密码 bcrypt hash 存 env，Token 30天有效 |
| F-03 | xterm.js 终端渲染 | 256色/TrueColor/Unicode；scrollback 50000行 |
| F-04 | 移动端控制字符工具栏 | 可发送 Esc/Tab/Ctrl+C/方向键等；触摸不弹软键盘 |
| F-05 | 移动端滚动与缩放 | 单指滑动浏览历史；双指捏合调字号（8–32px） |
| F-06 | Session 管理 API | `POST/GET/DELETE /api/sessions`；tmux 新建/切换/关闭 window |
| F-07 | 工具栏服务端持久化 | 配置存 `data/toolbar-config.json`（volume），跨设备共享 |
| F-08 | PWA 支持 | manifest.json + Service Worker，可添加主屏幕 |
| F-12 | claude -c 会话续接 | 自动检测 `.claude-data/.claude`，`claude -c` 续接历史会话 |

### Should（v1 Complete）

> 对应北极星「轴三：极致 Agent 管理体验」

| ID | Feature | 验收标准 |
|---|---|---|
| F-09 | Tab Bar UI | 顶部实时显示所有 tmux window，点击切换，活跃 tab 高亮 |
| F-10 | 移动端底导航 | 底部 Tab 快速切换 window，支持新建；覆盖顶部 Tab Bar |
| F-11 | 独立 window PTY | `ensurePty(windowId)` Map；`/ws?window=N` 多设备不互扰 |
| F-15 | Agent 状态卡片 | 每个 window 显示最后输出摘要（是否在跑/是否等待输入） |

### Could（v1 Complete）

> 对应北极星「轴二：零摩擦上下文同步」——不限于浏览器终端的交互渠道

| ID | Feature | 场景 |
|---|---|---|
| F-13 | `claude -p` 非交互派发 | 发一条 prompt，AI 在后台处理，前端显示结果卡片；不占用交互 PTY |
| F-14 | 上下文附件同步 | 在移动端将图片/文件/文本片段发送给指定 Agent session |
| F-16 | IM 频道（Telegram / Feishu） | 外出时在 Telegram 或飞书给 AI 下任务或继续对话，结果回传聊天 |
| F-17 | 多输入渠道统一路由 | 任意渠道（Web/IM/CLI）的 prompt 统一进入 task 队列，结果同步回发起方 |

F-16 v1 边界：飞书支持私聊/群聊收消息、`/new:claude`、`/new:codex`、普通对话、streaming preview fallback、权限卡片、`/reset`、`/mode`、图片作为附件上下文。Telegram 正式入口为 `agentmobile-im` polling bridge，`/start`、`/help`、无 active binding 时展示 Command Center 卡片，常用操作通过 inline button 完成；`/delete` 与 `/sessions` 删除按钮只删除 IM bridge session state，不删除 Web tmux window 或工作目录文件。

F-16 Telegram Plan workflow：Telegram Plan session 收到任务后先进入 `drafting`，生成完成后展示 Plan Ready 卡片；用户可点击 Execute Plan、Revise Plan、Cancel。状态持久化到 `im-data/plan-workflows.json`，状态机为 `drafting -> awaiting_decision -> revising -> executing -> completed | cancelled`。Legacy `server.js` Telegram webhook 不覆盖该卡片与状态机能力。

F-16 配置体验：Telegram 支持在 Web Settings 中填写 BotFather token 并保存到 `.env`；飞书 / Lark 支持在 Web Settings 中生成二维码，用户用飞书扫码后自动写入 app id / secret 并开启 IM bridge；卡片按钮 callback URL 仍需按部署域名在飞书后台配置。

### Nice（v4：直觉化项目管理）

> 对应北极星「轴一：零配置启动」——消灭一切不必要的决策步骤

| ID | Feature | 验收标准 |
|---|---|---|
| **F-19** | **项目-窗口两级结构** | **项目 = 目录，窗口 = 同目录标签**。新建项目时选目录；新窗口自动继承当前目录；消灭「每次新建都要选目录」的重复操作 |
| **F-20** | **统一会话管理界面** | **借鉴 Slack Workspace/Channel 模式**：项目列表（下部）+ 窗口列表（上部），新建按钮分区放置，视觉层次清晰 |

---

## Feature Detail: v3 非交互派发（F-13/F-16/F-17）

```
POST /api/tasks
  body: { session_name, prompt, attachments? }
  → spawn claude -p "<prompt>" --cwd <session.cwd>
  → 流式 SSE 返回结果
  → 前端结果卡片（不占用交互 PTY）
  → 同步回发起方渠道（Web / Telegram / ...）

POST /api/webhooks/telegram
  → legacy webhook only
  → 旧路径解析消息 + 附件（图片/文件）
  → 调用 POST /api/tasks
  → 结果回传 Telegram 对话

npm run start:im
  → Telegram adapter 使用 polling（启动时 deleteWebhook）
  → /start、/help、无 active binding 时发送 Command Center 卡片
  → 新建 session 卡片提供 Claude Code / Claude Plan / Codex Code / Codex Plan / Codex Ask
  → /mode 无参数发送模式卡片；按钮持久化 binding.mode / Claude permission mode
  → /new:codex 绑定长期运行的交互式 Codex PTY
  → 普通 Telegram 文本写入同一 Codex 进程
  → 默认编辑同一条 Telegram preview 展示终端转写，普通 prompt 与终端按键回调都会更新该 preview
  → Codex Controls 卡片与 /screen、/ctrlc 等命令等价
  → /screen 使用最新终端 live state 作为手动 fallback
  → /delete 删除当前 IM session；/sessions 卡片可删除指定 IM session
  → Plan workflow 持久化并通过 Plan Ready 卡片执行 / 修改 / 取消
```

**设计原则**：任务派发与交互终端解耦——交互 PTY 继续用于实时 claude 对话，tasks API 用于异步一次性任务，两者共存，各司其职。

---

## Feature Detail: 项目-窗口两级结构（F-19）

**问题**：当前每次新建 window 都要选目录，而用户心智模型是「项目=目录，窗口=同目录下的多个标签」。

**解法**：利用 tmux session 环境变量存储项目目录，实现「新建项目选目录，新建窗口自动继承」。

```
POST /api/windows
  body: { rel_path?, shell_type?, profile? }

  场景 1 - 新项目（提供 rel_path）:
    → tmux set-environment NEXUS_CWD <dir>
    → tmux new-window -c "$dir"

  场景 2 - 新窗口（不提供 rel_path）:
    → cwd=$(tmux show-environment NEXUS_CWD | cut -d= -f2)
    → tmux new-window -c "$cwd"
```

**交互**：
- Sidebar 「+」按钮拆分为二级菜单：「📁 新项目」/「➕ 新窗口」
- 「新项目」→ 弹出 WorkspaceSelector 选目录
- 「新窗口」→ 直接创建，继承当前项目目录

**心智模型**：
- 项目 = 目录（首次需要指定）
- 窗口 = 同目录下的多个终端标签（自动继承目录）

---

## Feature Detail: 统一会话管理界面（F-20）

**核心映射**：直接使用 tmux 原生概念，前端映射更易理解
- **tmux session** → **Project**（工作目录，环境隔离）
- **tmux window** → **Channel**（终端标签，共享目录）

**设计灵感**：Slack 的 Workspace/Channel 两层导航结构
- Channel 列表（上部）：当前 Project 下的多个终端窗口
- Project 列表（下部）：不同的工作目录（每个对应一个 tmux session）

### 界面布局

```
┌─────────────────────────────┐
│  会话管理              [×]   │
├─────────────────────────────┤
│                             │
│  📂 agentmobile ~/work/agentmobile      │  ← 标题：当前 Project 名+路径
│  ─────────────────────────  │
│  #general        ●         │  ← Channel 列表（tmux windows）
│  #backend        ○         │
│  #test          ⏳         │
│                             │
│  [+ 新 Channel]            │  ← 在下方，靠近 Channel 列表
│                             │
│  ═════════════════════════  │  ← 粗分隔线
│                             │
│  📁 Projects               │
│  ● agentmobile           (3)     │  ← Project 列表（tmux sessions）
│  ○ my-app          (1)     │
│  ○ backend-api     (2)     │
│                             │
│  [+ 新 Project]            │  ← 在下方，靠近 Project 列表
│                             │
└─────────────────────────────┘
```

### 关键设计决策

| 概念 | 对应 | 说明 |
|------|------|------|
| Project | tmux session | 每个 session 独立环境变量，有自己的 NEXUS_CWD |
| Channel | tmux window | 同 session 内的多个窗口，共享工作目录 |
| 激活态 | active session/window | 高亮显示当前所在的 project 和 channel |

### 状态指示

```
Channel 列表项（带 # 前缀）：
  #general      ●    ← 绿色点 = 运行中
  #backend      ○    ← 灰色点 = 空闲
  #deploy      ⏳    ← 黄色点 = 等待输入
  #shell       💤    ← 灰色 = shell 状态

Project 列表项：
  ● agentmobile      (3)   ← 蓝色高亮 = 当前激活，(3)=3个channel
  ○ my-app     (1)   ← 未激活，有1个channel
  ○ backend-api (2)  ← 未激活，有2个channel
  ○ legacy          ← 无括号 = 该session没有窗口（异常）
```

### API 设计（简化版）

```
GET  /api/projects                → 列出所有 tmux sessions（Project 列表）
GET  /api/projects/:name/channels → 列出指定 session 的所有 windows（Channel 列表）

POST /api/projects                → 新建 Project
  body: { name, path, shell_type, profile? }
  → tmux new-session -d -s <name> -c <path>
  → tmux set-environment NEXUS_CWD <path>

POST /api/projects/:name/channels → 新建 Channel
  body: { shell_type, profile? }
  → 在当前 session 内 tmux new-window -c "$NEXUS_CWD"

POST /api/projects/:name/activate → 切换到指定 Project
  → 切换 active tmux session（attach-client 或设置 target）

POST /api/channels/:index/attach  → 切换到指定 Channel（已有接口）
DELETE /api/channels/:index       → 关闭 Channel（已有接口）
```

### 交互流程

**1. 新建 Project**
```
点击「+ 新 Project」
  → 弹出 WorkspaceSelector 选择目录
  → 用户输入 Project 名称（默认目录名）
  → POST /api/projects { name: "my-app", path: "/home/libra/work/my-app" }
  → tmux new-session -d -s my-app -c /home/libra/work/my-app
  → tmux set-environment -t my-app NEXUS_CWD /home/libra/work/my-app
  → 在该 session 创建第一个 window（自动命名为 #general 或目录名）
  → 自动切换到新 Project（Project 列表更新，Channel 列表加载）
```

**2. 新建 Channel**
```
点击「+ 新 Channel」
  → 检查当前是否有激活 Project
  → POST /api/projects/:name/channels { shell_type, profile }
  → 在当前 session 内创建新 window
  → 自动继承该 session 的 NEXUS_CWD
  → Channel 列表更新，自动切换到新 Channel
```

**3. 切换 Project**
```
点击 Project 列表中的某项
  → 设置该 session 为 active
  → Channel 列表区域刷新：显示该 Project 的所有 Channel
  → 自动切换到该 Project 的 active window（或第一个 window）
  → 终端 WebSocket 重连到新的 session:window
```

**4. 切换 Channel**
```
点击 Channel 列表中的某项
  → POST /api/channels/:index/attach
  → 同现有行为：切换到该 window
```

### Channel 命名规则

```
第一个 Channel（创建 Project 时）：
  - 默认：目录名（如 agentmobile）
  - 或：#general

后续 Channels：
  - 默认：目录名-序号（如 agentmobile-1, agentmobile-2）
  - 用户可重命名（重命名 tmux window）
```

### 空状态处理

**无任何 Project 时：**
```
Channel 列表区域：
  「没有活跃的 Project」

Project 列表区域：
  「暂无 Projects」
  [+ 创建第一个 Project]
```

**当前 Project 无 Channel（异常情况）：**
```
Channel 列表区域：
  "📂 agentmobile ~/work/agentmobile"
  「该 Project 没有 Channel」
  [+ 创建第一个 Channel]
```

### 向后兼容

- 现有 tmux session 直接显示为 Projects（name 作为 project name）
- 现有 windows 显示为 Channels
- 首次打开界面时，为当前 session 尝试读取 NEXUS_CWD
  - 如果未设置，提示用户「为当前 Project 设置工作目录」
  - 或自动设置为 WORKSPACE_ROOT

### 视觉设计

```css
/* Channel 列表区域（上部）*/
- 标题栏："📂 {project.name} {cwd路径}"（cwd 用灰色小字）
- Channel 项："#{name}" 前缀（Slack 风格）
- 状态点：跟在名字后面
- +按钮：在区域底部，样式与列表项对齐

/* Project 列表区域（下部）*/
- 标题栏："📁 Projects"
- 背景：var(--agentmobile-bg2) - 稍暗，与 Channel 区形成层次
- Project 项：简洁显示，名称 + 右侧 channel 计数
- +按钮：在区域底部

/* 分隔线 */
- Channel 区标题下：1px solid var(--agentmobile-border)
- 两区域之间：2px solid var(--agentmobile-border)
```

### 数据结构（前端状态）

```typescript
// 不再需要独立的 projects.json
// 直接从 tmux 读取

interface Project {
  name: string;           // tmux session name
  path: string;           // NEXUS_CWD (tmux show-environment)
  active: boolean;        // 是否是当前 active session
  channelCount: number;   // window 数量
}

interface Channel {
  index: number;          // tmux window index
  name: string;           // tmux window name
  active: boolean;        // 是否是该 session 的 active window
  status: 'running' | 'idle' | 'waiting' | 'shell'; // 状态推断
}
```

---

## Success Metrics

| Metric | Target |
|---|---|
| 移动端 Esc/Ctrl+C 发送成功率 | 100% |
| 浏览器重连后终端恢复时间 | < 2s |
| 工具栏配置跨设备同步 | 重连后自动加载 |
| 从 IM 渠道发出 prompt 到收到首个 token | < 5s |
| PWA 添加主屏并可用 | iOS Safari / Android Chrome |

---

## Out of Scope

- 多用户/团队功能、注册系统、权限管理
- 替换 tmux（持久化/scrollback 继续由 tmux 负责）
- 通用 Web SSH 工具（不针对 claude CLI 工作流的功能不做）
- Session 数据库（JSON 文件 + tmux 实时读取）
- Docker socket 暴露给前端

---

## Feature Detail: 远端 agentmobile 实例连接（F-21）

**问题**：用户在两台不同服务器上各部署一个 agentmobile 实例，希望从一个入口同时管理两者，切换后体验与本地一致。

**解法**：在本端 agentmobile Web 界面注册远端实例（host/port/label/password），切换后整个前端 API/WS 调用走本端 server.js 的代理路由，由本端 server.js 转发到远端实例。

```
POST /api/remote-instances
  body: { label, host, port, useTls?, authMode, username?, password, sshPort? }
  → bcrypt hash password 存 data/remote-instances.json
  → 调用远端 /api/auth/login 缓存 JWT
  → 返回 publicInstance（无敏感字段）

POST /api/remote-instances/:id/test
  body: { password? }
  → 验证密码 + 测试远端连通性

POST /api/remote-instances/:id/login
  body: { password }
  → bcrypt.compare + 远端 /api/auth/login → 缓存 JWT

ALL /api/remote-instances/:id/proxy/*
  → 注入 Authorization: Bearer <remoteToken>
  → 剥离本端 cookie/host
  → fetch 透传到远端 http(s)://host:port/<path>
  → 流式转发响应（支持 SSE）

WS /api/remote-instances/:id/ws-proxy
  → 本端建立 WS ↔ 远端 WS（注入 in-band auth {type:'auth', token}）
  → 双向转发数据帧
```

**前端**：
- `RemoteInstanceSwitcher` 组件挂在侧边栏顶部（PC）/ SessionManagerV2 header（移动端）。
- `RemoteInstancesSettings` 在 GeneralSettings 中管理实例 CRUD。
- `apiUrl()` / `wsUrl()` 根据 `setRemoteInstanceContext(id)` 自动切换为代理路径。
- 切换实例时 `instanceId` 加入 Effect B 依赖项，触发 WebSocket 重连 + tmux 状态清空。

**安全**：
- 远端密码本端 bcrypt 12 轮 hash 存储，明文不持久化。
- 远端 JWT 缓存到 `data/remote-instances.json`，过期自动重登（需提供明文密码）。
- 本端代理剥离 cookie/host，避免泄漏。
- 不在日志中打印远端密码或 token。

**单用户场景**：远端实例列表为本端用户私有，不引入团队/权限复杂度（与 NORTH-STAR 一致）。

**Out of Scope**：
- SSH 模式（远端 SSH 账号登录）作为 Phase 5+ 增量。
- multipart 文件上传到远端目前仅流式转发原始 body，未做完整 busboy 解析。

---

## Feature Detail: nexus4cc v4.8.3 补丁移植

从上游 nexus4cc v4.8.3 反向移植一批补丁到 agentmobile（保留 agentmobile 已有的 IM / Tasks / 远端实例 / Codex 多 Agent / cookie 认证子系统）。

### 文件浏览器增强（WorkspaceBrowser.tsx）

- **Markdown TOC**：markdown 文件编辑器内置可折叠目录树（`marked.lexer` 解析，正确跳过代码块内的 `#`）。双击节点展开/折叠，点击导航 + `scrollIntoView`，展开/收起全部。标题经自定义 marked renderer 注入 `id`，DOMPurify `ALLOWED_ATTR` 增加 `id`/`type`。
- **嵌入式侧栏 + 拖拽缩放**：宽屏（`canEmbedBrowser` ≥700px，matchMedia 检测）下文件浏览器作为侧栏而非全屏 modal；右侧拖拽手柄调整宽度，持久化到 `agentmobile_filetree_width`。`forwardRef` 暴露 `closeEditor()` 供父组件协调。
- **折叠机 overlay 模式**：折叠屏（≥700px <1024px）侧栏与编辑器并排；编辑器 `onClickCapture` 阻止 click-through 到下层 markdown 链接。
- **紧凑编辑器头部**：`ResizeObserver` 在 < 480px 隐藏按钮文字只留图标。
- **显示隐藏文件**：切换显示 dotfile，持久化到 `agentmobile_show_hidden`，向后端 `/api/workspace/files?showHidden=1` 传参。
- **双击 channel 关编辑器**：`SessionManagerV2.onCloseEditor` 在双击 channel 时先关编辑器再切换。
- **文本编辑器限制**：前端 `isTextFile` 预检 + 后端 415（二进制扩展名/null-byte 检测）回退只读视图 + 413（>5MB）友好提示。

### 后端

- `GET /api/workspace/files` 支持 `?showHidden=1`。
- `GET/PUT /api/workspace/file` 拒绝二进制（415）与超大文件（413，上限 5MB），防止编辑器 OOM 与乱码。
- `POST /api/launch-iterm`（macOS-only，tmux -CC 接管 session；非 darwin 返回 400）。

### CONTEXT_TOKENS

每个 API profile 新增 `CONTEXT_TOKENS` 字段，`agentmobile-run-claude.sh` 读出并 `export CLAUDE_CODE_MAX_CONTEXT_TOKENS`。第三方/非 Claude Code 已知模型默认 200k 上下文窗口会过早触发 auto-compact，此字段让用户声明真实窗口。

### 会话持久化（tmux 域）

开机后自动恢复 tmux session/window/pane 结构（tmux-resurrect 快照）并在每个 claude 频道精确接续对话（pane 标题 → `~/.claude/projects/**/*.jsonl` 首条用户消息模糊匹配 → `claude --resume <uuid>`，回退 `--continue`）。运行在 `agentmobile-tmux.service` 域（`scripts/tmux-runtime.sh` 调用 `agentmobile-restore-tmux.sh` + `agentmobile-resume-claude.sh`），**非** web 服务。`AGENTMOBILE_RESTORED` 标记守护，普通重启跳过，绝不覆盖运行中的会话。只对 claude pane 注入，不碰 codex/opencode/trae pane。前置条件：tmux-resurrect 插件（详见 SERVICES.md）。

### 显式不做（保留 agentmobile 现有实现）

- 不移植 nexus4cc 的 query-token WS 认证（agentmobile 用 cookie + in-band message）。
- 不移植 workspace-global 文件路径隔离（agentmobile 用 session 级隔离 `isPathAllowedForSession`）。
- 不移植 nexus4cc 的 mobileKeyboard 简化模型（agentmobile 保留 chunked paste / stripMobileInputArtifacts / codex alt-screen refresh / paddingBottom 布局）。
- 不移植 `New` 下拉菜单（保留 agentmobile 的 New Folder/New File + Edit/View/Download 行）。

---

## Known Limitations（v1）

| 问题 | 影响 | v2 解法 |
|---|---|---|
| 多客户端 resize 冲突 | 多设备同时连接时 PTY 尺寸以最后收到的为准 | 取最小尺寸策略 |
| 单 PTY 全局切换 | window 切换所有设备同步跳转 | 独立 window PTY Map（F-11） |
| claude 配置未挂载 | 容器内 claude 使用镜像内配置，非宿主机配置 | docker-compose volumes 增加挂载 |
| 文件权限 | 容器 claude UID ≠ 宿主机 UID 时写文件失败 | Dockerfile usermod -u 1000 |
