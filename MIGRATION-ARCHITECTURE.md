# AgentMobile 双模式架构设计

## 1. 架构概览

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           AgentMobile Server                              │
│                                                                          │
│  ┌─────────────────────────────┐     ┌────────────────────────────────┐ │
│  │      Web Channel (原有)      │     │     IM Channel Layer (新增)    │ │
│  │                             │     │                                │ │
│  │  Express + WebSocket        │     │  BridgeManager                  │ │
│  │  ├─ Static files (SPA)      │     │  ├─ Session Router             │ │
│  │  ├─ REST API                │     │  ├─ Channel Manager            │ │
│  │  └─ PTY WebSocket Bridge    │     │  └─ Message Dispatcher         │ │
│  └──────────────┬──────────────┘     └──────────┬─────────────────────┘ │
│                 │                               │                        │
│  ┌──────────────┴──────────────────────────────┴──────────────────────┐ │
│  │                    Channel Adapter Interface                        │ │
│  │                                                                     │ │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────┐ │ │
│  │  │ WebSocketAdapter│  │ TelegramAdapter  │  │  FeishuAdapter    │ │ │
│  │  │ (PTY mode)      │  │ (SDK mode)       │  │  (SDK mode)       │ │ │
│  │  └─────────────────┘  └──────────────────┘  └───────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
│                                                  │                        │
│  ┌───────────────────────────────────────────────┴──────────────────────┐ │
│  │                     Backend Execution Layer                           │ │
│  │                                                                       │ │
│  │  ┌─────────────────────┐         ┌───────────────────────────────┐  │ │
│  │  │  tmux/PTY Backend   │         │  SDK Backend (agents-to-im)   │  │ │
│  │  │  (Web Channel用)    │         │  (IM Channel用)                │  │ │
│  │  │                     │         │                               │  │ │
│  │  │  ├─ node-pty        │         │  ├─ Claude SDK Provider       │  │ │
│  │  │  ├─ tmux sessions   │         │  ├─ Codex SDK Provider        │  │ │
│  │  │  └─ shell scripts   │         │  └─ SSE Stream Handler        │  │ │
│  │  └─────────────────────┘         └───────────────────────────────┘  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 核心设计原则

### 2.1 双后端隔离

| 特性 | Web Channel (tmux/PTY) | IM Channel (SDK) |
|------|------------------------|------------------|
| 用途 | 交互式终端（xterm.js） | IM消息收发 |
| Agent调用 | shell脚本 → tmux → PTY | @anthropic-ai/claude-agent-sdk |
| 会话模型 | tmux window | Channel Binding (群↔会话) |
| 流式输出 | VT100原始终端流 | SSE结构化事件 |
| 权限审批 | 用户在终端手动操作 | IM交互式卡片审批 |
| 状态持久化 | tmux会话状态 | JSON文件 (~/.agentmobile/im/) |

### 2.2 统一抽象层

所有Channel通过`BaseChannelAdapter`抽象统一接口：

```typescript
interface BaseChannelAdapter {
  readonly channelType: 'web' | 'telegram' | 'feishu';
  readonly mode: 'pty' | 'sdk';  // 标识使用哪种后端
  
  start(): Promise<void>;
  stop(): Promise<void>;
  
  // 接收消息
  consumeOne(): Promise<InboundMessage | null>;
  
  // 发送消息
  send(message: OutboundMessage): Promise<SendResult>;
  
  // 可选能力
  sendPreview?(...);
  sendImage?(...);
  upsertActivityEvent?(...);
}
```

## 3. 目录结构设计

```
agentmobile/
├── server.js                    # 原有server（保留，重构为模块化）
├── server-im.ts                 # IM bridge server（新增）
│
├── src/                         # 新增源码目录
│   ├── bridge/                  # 从agents-to-im移植
│   │   ├── channel-adapter.ts   # BaseChannelAdapter抽象
│   │   ├── bridge-manager.ts    # 消息路由和会话管理
│   │   ├── conversation-engine.ts # 对话处理引擎
│   │   ├── permission-broker.ts # 权限审批代理
│   │   ├── delivery-layer.ts    # 消息发送层
│   │   ├── channel-router.ts    # Channel路由
│   │   ├── context.ts           # 依赖注入容器
│   │   ├── types.ts             # 核心类型定义
│   │   └── markdown/            # Markdown渲染
│   │
│   ├── adapters/                # Channel适配器实现
│   │   ├── websocket-adapter.ts # Web终端（PTY模式）
│   │   ├── telegram-adapter.ts  # Telegram（SDK模式，重构现有）
│   │   └── feishu-adapter.ts    # Feishu/Lark（从agents-to-im移植）
│   │
│   ├── providers/               # AI Agent Providers
│   │   ├── pty-provider.ts      # tmux/PTY provider（Web用）
│   │   ├── claude-sdk.ts        # Claude SDK provider（IM用）
│   │   ├── codex-sdk.ts         # Codex SDK provider（IM用）
│   │   └── multiplex.ts         # 多运行时路由
│   │
│   ├── infra/                   # 基础设施
│   │   ├── store.ts             # JSON文件状态存储
│   │   └── logger.ts            # 日志
│   │
│   └── config/                  # 配置
│       └── config.ts            # 统一配置加载
│
├── im-data/                     # IM通道数据（新增）
│   ├── sessions.json            # 会话绑定
│   ├── bindings.json            # Channel↔Session映射
│   ├── messages/                # 消息历史
│   └── runtime/                 # 运行时状态
│
├── frontend/                    # 原有前端（不变）
├── data/                        # 原有数据（不变）
├── package.json                 # 更新依赖
└── tsconfig.json                # TypeScript配置（新增）
```

## 4. 数据流

### 4.1 Web Channel (PTY模式)

```
用户 (浏览器)
  │
  ├─ HTTP请求 → Express API → 原有逻辑
  └─ WebSocket连接 → server.js PTY Bridge → tmux window ↔ AI Agent
```

### 4.2 IM Channel (SDK模式)

```
用户 (Telegram/Feishu)
  │
  ▼
ChannelAdapter (消费消息)
  │
  ▼
BridgeManager
  ├─ 解析命令 (/new, /reset, /stop, /mode)
  └─ 路由到ConversationEngine
        │
        ▼
    MultiplexLLMProvider
        ├─ Claude SDK Provider
        └─ Codex SDK Provider
              │
              ▼
          AI Agent SDK
              │
              ▼ (SSE事件流)
    ConversationEngine (消费SSE)
        ├─ onPermissionRequest → PermissionBroker → IM卡片
        ├─ onPartialText → sendPreview → IM流式预览
        ├─ onActivityEvent → upsertActivityEvent → IM活动卡片
        └─ onResult → send → IM最终消息
```

## 5. 关键集成点

### 5.1 统一配置

合并`.env`和`config.env`到统一配置：

```env
# ============ Web Channel (原有) ============
PORT=5000
JWT_SECRET=xxx
BCRYPT_PASSWORD=xxx
TMUX_SESSION=agentmobile
WORKSPACE_ROOT=/home/ubuntu/workspace

# ============ IM Channel - Telegram ============
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_WEBHOOK_SECRET=xxx
TELEGRAM_DEFAULT_SESSION=default

# ============ IM Channel - Feishu ============
CTI_FEISHU_APP_ID=cli_xxx
CTI_FEISHU_APP_SECRET=xxx
CTI_FEISHU_DOMAIN=lark
CTI_FEISHU_ALLOWED_USERS=user1,user2

# ============ IM Channel - Common ============
CTI_DEFAULT_WORKDIR=/home/ubuntu/workspace
CTI_CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude

# ============ Feature Flags ============
IM_BRIDGE_ENABLED=true
TELEGRAM_ENABLED=true
FEISHU_ENABLED=false
```

### 5.2 双后端启动

```javascript
// server.js (原有，不变)
const httpServer = createServer(app);
setupWebSocketBridge(httpServer);  // Web通道

// server-im.ts (新增)
import { BridgeManager } from './src/bridge/bridge-manager';
import { registerAdapters } from './src/adapters';

if (process.env.IM_BRIDGE_ENABLED === 'true') {
  const bridgeManager = new BridgeManager();
  registerAdapters(bridgeManager);  // 注册Telegram/Feishu适配器
  await bridgeManager.start();
}
```

### 5.3 会话隔离

- **Web Channel**: 通过tmux session + window隔离
- **IM Channel**: 通过JSON文件存储的bindings.json隔离

两者**完全独立**，互不干扰。

## 6. 迁移风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| SDK依赖冲突 | npm依赖可能冲突 | 使用独立package.json或workspace |
| 内存占用增加 | SDK模式需要更多内存 | 按需加载，IM通道可单独部署 |
| Agent授权冲突 | Web和IM可能使用不同认证 | 统一使用~/.claude.json和.env |
| 权限审批不一致 | PTY无法触发IM审批卡片 | IM通道强制使用SDK模式 |
| 部署复杂性 | 需要同时维护两种架构 | 清晰的Feature Flag开关 |

## 7. 部署选项

### 模式A: 单体部署（默认）
```
agentmobile服务同时启动Web和IM通道
```

### 模式B: 分离部署（推荐用于生产）
```
实例1: agentmobile --mode=web    # 仅Web终端
实例2: agentmobile --mode=im      # 仅IM桥接
```

通过启动参数控制：
```bash
# 仅Web
node server.js

# 仅IM
node --loader ts-node/esm server-im.ts

# 两者
node server.js --with-im
```

## 8. 实施阶段

### Phase 1: 基础设施 (Week 1)
- [ ] 添加TypeScript支持 (tsconfig.json, ts-node)
- [ ] 创建src/目录结构
- [ ] 移植BaseChannelAdapter抽象
- [ ] 移植核心类型定义

### Phase 2: SDK Provider (Week 2)
- [ ] 实现Claude SDK Provider
- [ ] 实现Codex SDK Provider
- [ ] 实现MultiplexLLMProvider
- [ ] 测试SDK调用

### Phase 3: IM Channel (Week 3-4)
- [ ] 重构Telegram为Adapter模式
- [ ] 移植FeishuAdapter
- [ ] 实现BridgeManager
- [ ] 实现ConversationEngine
- [ ] 实现PermissionBroker

### Phase 4: 集成测试 (Week 5)
- [ ] 集成测试Telegram通道
- [ ] 集成测试Feishu通道
- [ ] 验证Web通道不受影响
- [ ] 压力测试和性能优化

### Phase 5: 部署和文档 (Week 6)
- [ ] 更新部署脚本
- [ ] 更新服务配置
- [ ] 编写迁移文档
- [ ] 用户手册更新
