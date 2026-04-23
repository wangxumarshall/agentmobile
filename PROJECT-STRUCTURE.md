# AgentMobile - Project Structure

AgentMobile is a dual-channel AI agent terminal supporting both **Web** and **IM** access.

```
agentmobile/
├── server.js                    # Web channel backend (Express + WebSocket + tmux/PTY)
├── package.json                 # Unified dependencies
├── .npmrc                       # npm registry configuration
├── tsconfig.json                # TypeScript configuration for IM bridge
│
├── # ─── Web Channel ───
├── frontend/                    # React SPA (xterm.js terminal)
│   ├── src/                     # TypeScript/React source
│   └── dist/                    # Vite build output (served statically)
├── public/                      # PWA assets (manifest.json, sw.js)
├── data/                        # Web data (toolbar, configs, tasks)
├── scripts/                     # Setup and deployment scripts
│
├── # ─── IM Channel ───
├── im/                          # IM Bridge module (TypeScript)
│   │
│   ├── server-im.ts             # IM server entry point
│   │
│   ├── bridge/                  # Core bridge logic
│   │   ├── types.ts             # Channel types, messages, bindings
│   │   ├── channel-adapter.ts   # BaseChannelAdapter abstract class
│   │   ├── bridge-manager.ts    # Message orchestration & session routing
│   │   ├── conversation-engine.ts # LLM conversation processing
│   │   ├── permission-broker.ts # Tool permission approval
│   │   ├── channel-router.ts    # Chat-to-session binding
│   │   ├── delivery-layer.ts    # Reliable message delivery (retry)
│   │   ├── context.ts           # Dependency injection container
│   │   └── markdown/feishu.ts   # Markdown formatting for Feishu cards
│   │
│   ├── adapters/                # IM channel adapters
│   │   ├── telegram-adapter.ts  # Telegram Bot (polling mode)
│   │   └── feishu-adapter.ts    # Feishu/Lark (WebSocket + cards)
│   │
│   ├── feishu/                  # Feishu-specific modules
│   │   ├── index.ts             # Module re-exports
│   │   ├── types.ts             # AdapterContext, Feishu events
│   │   ├── constants.ts         # Feishu config & rate limits
│   │   ├── utils.ts             # Pure utility functions
│   │   ├── lark-client.ts       # Feishu REST API wrapper
│   │   ├── cards/               # Interactive card builders
│   │   │   ├── streaming-cards.ts     # Streaming preview cards
│   │   │   ├── permission-cards.ts    # Permission approval cards
│   │   │   ├── activity-cards.ts      # Tool/file activity cards
│   │   │   ├── session-cards.ts       # Session management cards
│   │   │   └── structured-input-cards.ts # Form input cards
│   │   ├── services/            # Feishu services
│   │   │   ├── preview-service.ts     # Streaming preview (CardKit)
│   │   │   ├── activity-service.ts    # Activity card upsert
│   │   │   └── inbound-image-service.ts # Image download
│   │   └── handlers/            # Event handlers
│   │       ├── inbound-handler.ts     # Message dispatch
│   │       ├── card-action-handler.ts # Card button callbacks
│   │       ├── session-handler.ts     # Session commands
│   │       ├── plan-handler.ts        # Plan workflow
│   │       └── structured-input-handler.ts # Form input
│   │
│   ├── providers/               # AI agent SDK providers
│   │   ├── claude-sdk.ts        # Claude Code SDK streaming
│   │   ├── codex-sdk.ts         # OpenAI Codex SDK
│   │   └── multiplex.ts         # Per-session runtime routing
│   │
│   ├── runtime/                 # Runtime management
│   │   ├── types.ts             # Runtime capabilities
│   │   ├── claude-mode.ts       # Claude permission modes
│   │   └── claude-plan-exit.ts  # Plan exit workflow cards
│   │
│   ├── infra/                   # Infrastructure
│   │   ├── store.ts             # JSON file state store
│   │   ├── sse-utils.ts         # SSE event encoding
│   │   └── native-session-history.ts # Session transcript loading
│   │
│   └── config/                  # Configuration
│       ├── config.ts             # Unified .env loader
│       └── logger.ts             # Structured logger
│
└── im-data/                     # IM runtime data
    ├── bindings.json            # Chat-to-session bindings
    ├── sessions.json            # Session metadata
    ├── settings.json            # Runtime settings
    ├── cache/                   # Downloaded images
    └── runtime/                 # Runtime state
```

## Architecture

### Web Channel (Existing)
```
Browser ←→ Express.js ←→ WebSocket ←→ tmux/PTY ←→ AI Agent (Claude/Codex)
```

### IM Channel (New)
```
Telegram/Feishu ←→ ChannelAdapter ←→ BridgeManager ←→ LLM Provider ←→ AI Agent (SDK)
                                      ↓
                              PermissionBroker
                              ConversationEngine
                              ChannelRouter
```

## Development

### Web Channel
```bash
npm start          # Start web server (port 5000)
npm run dev        # Watch mode
npm run setup      # Install deps + build frontend
```

### IM Channel
```bash
npm run start:im   # Start IM bridge server
npm run dev:im     # IM watch mode
npm run build:im   # TypeScript type check
```

### Configuration

All configuration in `.env`:

```env
# Web Channel
PORT=5000
JWT_SECRET=xxx
BCRYPT_PASSWORD=xxx

# IM Bridge
IM_BRIDGE_ENABLED=true
TELEGRAM_BOT_TOKEN=xxx
CTI_FEISHU_APP_ID=xxx
CTI_FEISHU_APP_SECRET=xxx
CTI_DEFAULT_WORKDIR=/path/to/workspace
```

## Dependencies

| Category | Key Packages |
|----------|-------------|
| Web Backend | express, ws, node-pty, bcrypt, jsonwebtoken |
| Web Frontend | react, @xterm/xterm, vite, tailwindcss |
| IM Bridge | @anthropic-ai/claude-agent-sdk, @larksuiteoapi/node-sdk, markdown-it |
| Build | tsx, typescript |
