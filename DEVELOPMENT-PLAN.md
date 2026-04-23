# AgentMobile IM Bridge - 后续开发计划

## 📊 总体进度

**当前完成度: ~70%**

```
✅ 已完成: 架构设计、TypeScript基础设施、核心Bridge模块、Telegram适配器、Claude Provider
⚠️ 进行中: 无
⏳ 待开发: Feishu适配器、Codex Provider、完整卡片系统、Handler、测试
```

---

## 🎯 开发目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| **完整Feishu支持** | 流式预览、权限卡片、活动卡片、会话管理 | P0 |
| **完整Codex支持** | App Server通信、线程管理、审批处理 | P0 |
| **Telegram完整测试** | 端到端验证现有实现 | P1 |
| **Feishu完整测试** | 端到端验证新建功能 | P1 |
| **部署更新** | 服务配置、脚本、文档 | P2 |

---

## 📋 Phase 1: 基础模块 (1-2天)

**目标**: 零依赖或低依赖的纯工具模块，为后续模块提供基础。

### 1.1 SSE 工具
- **文件**: `src/infra/sse-utils.ts`
- **来源**: `agents-to-im/src/infra/sse-utils.ts`
- **内容**:
  - `CanonicalTurnEvent<TType>` 接口
  - `encodeCanonicalTurnEvent(event)`
  - `emitCanonicalTurnEvent(controller, event)`
  - `sseEvent(type, data)`
- **依赖**: 无
- **工作量**: 0.5小时
- **状态**: ⏳ 待创建

### 1.2 常量定义
- **文件**: `src/feishu/constants.ts`
- **内容**:
  - `FEISHU_REQUIRED_APP_SCOPES` 列表
  - Feishu API 限制常量
  - 预览/活动卡片配置默认值
- **依赖**: 无
- **工作量**: 0.5小时
- **状态**: ⏳ 待创建

### 1.3 纯工具函数
- **文件**: `src/feishu/utils.ts`
- **内容**:
  - `buildRouteKey()`, `routeKeyForAddress()`, `previewKey()`, `activityKey()`
  - `stableMessageUuid()` - 幂等UUID
  - `parseTextContent()`, `parseImageResourceKey()`
  - `extensionForMimeType()`, `normalizePath()`
  - `assertLarkOk()`, `isRecoverableMessageSendError()`
  - `collectTextFragments()`
- **依赖**: 无
- **工作量**: 1小时
- **状态**: ⏳ 待创建

### 1.4 流式预览卡片骨架
- **文件**: `src/feishu/cards/streaming-cards.ts`
- **内容**:
  - `buildStreamingCardSkeleton()` - Feishu Card 2.0 JSON, `streaming_mode: true`
- **依赖**: `constants.ts`
- **工作量**: 0.5小时
- **状态**: ⏳ 待创建

### 1.5 Runtime 类型定义
- **文件**: `src/runtime/types.ts`
- **内容**:
  - `RuntimeName = 'claude' | 'codex'`
  - 运行时能力接口
- **依赖**: 无
- **工作量**: 0.5小时
- **状态**: ⏳ 待创建

---

## 📋 Phase 2: 卡片构建器 (2-3天)

**目标**: 纯组件，构建Feishu交互式卡片JSON结构，不依赖网络。

### 2.1 权限卡片
- **文件**: `src/feishu/cards/permission-cards.ts`
- **内容**:
  - `buildSimpleCard()` - 基础卡片模板
  - `buildStatusCard()` - 状态卡片
  - `buildActionCard()` - 操作按钮卡片
  - `buildPermissionCard()` - 权限审批卡片（允许/拒绝按钮）
  - `buildHandledPermissionCard()` - 已处理权限卡片
- **依赖**: Phase 1 (constants, utils)
- **工作量**: 3小时
- **状态**: ⏳ 待创建

### 2.2 活动卡片
- **文件**: `src/feishu/cards/activity-cards.ts`
- **内容**:
  - 工具调用活动卡片
  - 文件修改活动卡片
  - 命令执行卡片
  - 进度指示器卡片
- **依赖**: Phase 1 (constants, utils)
- **工作量**: 3小时
- **状态**: ⏳ 待创建

### 2.3 会话卡片
- **文件**: `src/feishu/cards/session-cards.ts`
- **内容**:
  - 新建会话卡片（Claude/Codex选项）
  - 恢复会话卡片
  - 模式切换卡片
  - 运行时选择卡片
- **依赖**: Phase 1, 2.1, 2.2 + Runtime类型
- **注意**: 需要stub `native-session-history` 和 `recent-workspaces` 依赖
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 2.4 结构化输入卡片
- **文件**: `src/feishu/cards/structured-input-cards.ts`
- **内容**:
  - 表单输入卡片
  - 多选/单选问题卡片
  - 文本输入卡片
- **依赖**: Phase 1, 2.1
- **工作量**: 3小时
- **状态**: ⏳ 待创建

### 2.5 计划工作流卡片
- **文件**: `src/feishu/cards/plan-cards.ts`
- **内容**:
  - 计划请求卡片
  - 计划确认卡片
  - 计划执行卡片
  - Plan exit工作流卡片
- **依赖**: Phase 1, 2.1, Runtime类型
- **工作量**: 3小时
- **状态**: ⏳ 待创建

---

## 📋 Phase 3: 基础设施 (3-4天)

**目标**: Feishu SDK集成、网络通信、服务层。

### 3.1 Lark客户端
- **文件**: `src/feishu/lark-client.ts`
- **内容**:
  - `LarkClient` 类
  - `sendMessage()` - 发送消息（幂等UUID）
  - `sendCard()` - 发送交互式卡片
  - `patchCard()` - 更新现有卡片
  - `deleteMessageQuietly()` - 删除预览占位
  - `uploadImage()` - 上传图片
  - `enqueueMessage()` - 每聊天FIFO队列 + 250ms限速
  - `runScopeDiagnostic()` - 检查app scope
- **依赖**: `@larksuiteoapi/node-sdk`
- **工作量**: 6小时
- **状态**: ⏳ 待创建

### 3.2 流式预览服务
- **文件**: `src/feishu/services/preview-service.ts`
- **内容**:
  - `PreviewService` 类
  - `sendPreview()` - 流式更新（CardKit模式 → 降级patch模式）
  - `primePreview()` - 预创建占位符
  - `endPreview()` - 清理空占位
  - `finalizePreview()` - 最终化卡片
  - 节流控制（700ms间隔，20字符增量，3900最大字符）
- **依赖**: 3.1 (LarkClient), Phase 1, Phase 2 (streaming-cards)
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 3.3 活动卡片服务
- **文件**: `src/feishu/services/activity-service.ts`
- **内容**:
  - `ActivityService` 类
  - `upsertActivityEvent()` - 创建/更新活动卡片
  - 幂等`requestUuid`恢复机制
  - 超时发送恢复
- **依赖**: 3.1 (LarkClient), Phase 2 (activity-cards)
- **工作量**: 2小时
- **状态**: ⏳ 待创建

### 3.4 图片下载服务
- **文件**: `src/feishu/services/inbound-image-service.ts`
- **内容**:
  - 下载Feishu消息中的图片
  - 本地缓存
  - 内存去重
- **依赖**: `@larksuiteoapi/node-sdk`
- **工作量**: 2小时
- **状态**: ⏳ 待创建

---

## 📋 Phase 4: 消息处理器 (3-4天)

**目标**: 消息路由、命令处理、卡片回调分发。

### 4.1 AdapterContext接口
- **文件**: `src/feishu/types.ts`
- **内容**:
  - `AdapterContext` 接口定义
  - 统一DI容器，所有Handler通过此接口访问依赖
  - 包含store、llm、router、permissionBroker、larkClient等
- **依赖**: 所有Phase 1-3
- **工作量**: 2小时
- **状态**: ⏳ 待创建

### 4.2 卡片回调Handler
- **文件**: `src/feishu/handlers/card-action-handler.ts`
- **内容**:
  - `handleCardAction()` - 主分发器
  - 按回调数据前缀路由:
    - `perm:*` → PermissionBroker
    - `new-session:*` → 新建会话
    - `claude-mode:*` → 模式切换
    - `resume:*` → 恢复会话
    - `input:*` → 结构化输入
    - `plan:*` → 计划工作流
  - `patchActionCardSafely()` - 安全更新卡片
- **依赖**: 4.1 (AdapterContext), Phase 2-3
- **工作量**: 3小时
- **状态**: ⏳ 待创建

### 4.3 入站消息Handler
- **文件**: `src/feishu/handlers/inbound-handler.ts`
- **内容**:
  - `handleIncomingEvent()` - 消息去重→鉴权→解析→分发
  - `handleDirectMessage()` - 私聊命令: `/new:claude`, `/new:codex`, `/resume:*`
  - `handleGroupMessage()` - 群聊命令: `/reset`, `/stop`, `/mode`, `/plan`
  - 图片消息处理: 下载 + 缓存
  - 文本消息解析
- **依赖**: 4.1 (AdapterContext), 3.4 (inbound-image), Phase 1-2
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 4.4 会话Handler
- **文件**: `src/feishu/handlers/session-handler.ts`
- **内容**:
  - `handleCreateSessionCommand()` - 创建新会话
  - `handleResumeSessionCommand()` - 列出可恢复会话
  - `handleNewSessionCardAction()` - 卡片会话创建
  - `handleResumeCardAction()` - 卡片恢复
  - `handleResetCommand()` - 重置会话
  - `handleModeCommand()` - 模式切换
  - `replayNativeSessionHistory()` - 重放历史
- **依赖**: 4.1 (AdapterContext), Phase 2 (session-cards)
- **工作量**: 6小时
- **状态**: ⏳ 待创建

### 4.5 计划Workflow Handler
- **文件**: `src/feishu/handlers/plan-handler.ts`
- **内容**:
  - `handlePlanCommand()` - 启动计划
  - `handlePlanWorkflowMessage()` - 计划消息处理
  - `handlePlanCardAction()` - 计划卡片交互
  - `handleClaudePlanExitCardAction()` - Plan Exit工作流
- **依赖**: 4.1-4.4, Phase 2 (plan-cards)
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 4.6 结构化输入Handler
- **文件**: `src/feishu/handlers/structured-input-handler.ts`
- **内容**:
  - `handleStructuredInputRequest()` - 发送结构化输入请求
  - `handleStructuredInputCardAction()` - 处理表单提交
  - 解析输入到消息格式
- **依赖**: 4.1 (AdapterContext), Phase 2 (structured-input-cards)
- **工作量**: 3小时
- **状态**: ⏳ 待创建

---

## 📋 Phase 5: Feishu适配器完成 (3-4天)

**目标**: 替换stub，实现完整Feishu适配器。

### 5.1 WebSocket客户端集成
- **文件**: `src/adapters/feishu-adapter.ts` (替换stub)
- **内容**:
  - `lark.WSClient` 创建和配置
  - `EventDispatcher` 注册:
    - `im.message.receive_v1` → 入站消息
    - `im.message.message_read_v1` → 已读回执
    - `im.chat.updated_v1` → 群名变更
    - `card.action.trigger` → 卡片按钮
  - 自动重连
- **依赖**: Phase 1-4全部
- **工作量**: 6小时
- **状态**: ⏳ 待创建

### 5.2 消息发送集成
- **内容**:
  - `send()` → LarkClient.sendMessage
  - `sendImage()` → LarkClient.uploadImage + sendImage
  - `sendPreview()` → PreviewService.sendPreview
  - `primePreview()` → PreviewService.primePreview
  - `endPreview()` → PreviewService.endPreview
  - `upsertActivityEvent()` → ActivityService.upsertActivityEvent
- **依赖**: 5.1, Phase 3
- **工作量**: 3小时
- **状态**: ⏳ 待创建

### 5.3 命令处理集成
- **内容**:
  - `handleDirectMessage()` → 路由到inbound-handler
  - `handleGroupMessage()` → 路由到inbound-handler
  - `handleCardAction()` → 路由到card-action-handler
  - 会话创建: `createBoundSession()` → Feishu im.chat.create API
  - 群名同步: `syncChatName()`
- **依赖**: 5.1, 5.2, Phase 4
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 5.4 BridgeManager重构
- **文件**: `src/bridge/bridge-manager.ts`
- **内容**:
  - 将Feishu特定命令处理迁移到FeishuAdapter
  - 简化BridgeManager为通用消息分发器
  - 保留会话锁定、权限Broker集成
  - 添加AdapterContext注入
- **依赖**: 5.1-5.3
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 5.5 类型一致性修复
- **内容**:
  - 统一`ActivityEvent`字段: `kind` vs `type`
  - 统一`SessionBinding.agentSessionId` vs `codepilotSessionId`
  - 统一`ClaudePermissionMode`位置
  - ChannelBinding的`runtime`字段直接使用
- **工作量**: 2小时
- **状态**: ⏳ 待创建

---

## 📋 Phase 6: 补充模块 (3-4天)

**目标**: 边缘功能完善、Codex完整支持。

### 6.1 Feishu Markdown格式化
- **文件**: `src/bridge/markdown/feishu.ts`
- **内容**:
  - `buildCardContent()` - Markdown转Feishu Card内容
  - `buildPostContent()` - 富文本格式
  - `preprocessFeishuMarkdown()` - Markdown预处理
- **依赖**: `markdown-it`
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 6.2 Claude模式管理
- **文件**: `src/runtime/claude-mode.ts`
- **内容**:
  - `ClaudePermissionMode` 枚举
  - `getClaudeModeOptions()` - 模式选项
  - `getClaudeModeTitle()` - 模式标题
  - `normalizeClaudePermissionMode()`
- **工作量**: 2小时
- **状态**: ⏳ 待创建

### 6.3 Native会话历史
- **文件**: `src/infra/native-session-history.ts`
- **内容**:
  - `listRecentNativeSessions()` - 列出最近会话
  - `loadNativeSessionTranscript()` - 加载会话转录
  - `NativeReplayItem` 类型
  - `NativeSessionSummary` 类型
- **工作量**: 4小时
- **状态**: ⏳ 待创建

### 6.4 Codex App Server客户端
- **文件**: `src/providers/codex/app-server-client.ts`
- **内容**:
  - `CodexAppServerClient` 类
  - 子进程管理: spawn `codex app-server`
  - JSON-RPC 2.0协议
  - `prepare()` - 启动和初始化
  - `call()` - JSON-RPC请求/响应
  - `respond()` - 响应服务器请求
  - `subscribe()` - 事件监听
  - `supportsCollaborationMode()` - 检查计划模式支持
  - `close()` - 关闭子进程
- **依赖**: 合并到 `providers/codex-sdk.ts`
- **工作量**: 8小时
- **状态**: ⏳ 待创建

### 6.5 本地命令历史
- **文件**: `src/infra/local-command-history.ts`
- **内容**:
  - `appendLocalCommandExchange()` - 记录命令交换
  - 持久化到JSON
- **工作量**: 1小时
- **状态**: ⏳ 待创建

---

## ⚠️ 关键决策点

### 1. 命令处理归属

**问题**: Feishu特定命令处理应该放在`BridgeManager`还是`FeishuAdapter`？

**建议**: 放在`FeishuAdapter`内
- 理由: Feishu交互卡片（权限按钮、会话创建卡片等）是Feishu特有
- Telegram和其他IM不需要这些功能
- 保持BridgeManager通用

### 2. Codex集成方式

**问题**: 完整复用`app-server-client.ts`还是简化？

**建议**: 优先实现完整版本
- 理由: 计划模式和审批处理依赖完整的JSON-RPC通信
- 但可以分阶段: 先实现基本转/start，再实现turn/resume

### 3. 预览模式选择

**问题**: 使用CardKit真流式还是patch模式？

**建议**: 两者都支持，优先CardKit
- CardKit提供更好的用户体验
- patch模式作为降级方案

---

## 🕐 时间估算

| Phase | 内容 | 估计时间 | 依赖 |
|-------|------|----------|------|
| Phase 1 | 基础模块 | 0.5-1天 | 无 |
| Phase 2 | 卡片构建器 | 2-3天 | Phase 1 |
| Phase 3 | 基础设施 | 3-4天 | Phase 1-2 |
| Phase 4 | 消息处理器 | 3-4天 | Phase 1-3 |
| Phase 5 | Feishu适配器 | 3-4天 | Phase 1-4 |
| Phase 6 | 补充模块 | 3-4天 | Phase 1-5 |
| 测试 | 端到端测试 | 3-5天 | Phase 1-6 |
| **总计** | | **~3-4周** | |

---

## 📦 依赖安装

当前遇到网络问题，重试方案：

```bash
# 方案1: 使用代理
export https_proxy=http://proxy:port
npm install

# 方案2: 使用国内镜像
npm install --registry=https://registry.npmmirror.com

# 方案3: 手动安装关键依赖
npm i @anthropic-ai/claude-agent-sdk --registry=https://registry.npmmirror.com
npm i @larksuiteoapi/node-sdk --registry=https://registry.npmmirror.com
npm i markdown-it --registry=https://registry.npmmirror.com
npm i tsx @types/node --save-dev --registry=https://registry.npmmirror.com
```

---

## ✅ 验收标准

### Telegram通道
- [ ] `/new:claude` 创建新会话
- [ ] 消息发送给Claude并返回响应
- [ ] 工具使用权审批（通过按钮）
- [ ] `/reset` 重置会话
- [ ] `/stop` 停止当前任务

### Feishu通道
- [ ] WebSocket连接建立
- [ ] 私聊`/new:claude`创建群并绑定
- [ ] 群聊消息流式预览（CardKit）
- [ ] 权限审批卡片
- [ ] 工具调用活动卡片
- [ ] 会话模式切换
- [ ] 计划工作流

### Web终端
- [ ] 不受IM变更影响
- [ ] xterm.js终端正常工作
- [ ] WebSocket PTY桥接正常

---

## 📝 下一步行动

**立即执行** (今日):
1. [ ] 解决npm install网络问题
2. [ ] 创建Phase 1基础模块
3. [ ] TypeScript编译验证

**本周内**:
1. [ ] 完成Phase 1-2
2. [ ] 开始Phase 3 (Lark客户端)
3. [ ] Telegram端到端测试

**下周**:
1. [ ] 完成Phase 3-4
2. [ ] Feishu适配器集成
3. [ ] 初步Feishu测试

**第3周**:
1. [ ] 完成Phase 5-6
2. [ ] 完整测试和优化
3. [ ] 部署更新

**第4周**:
1. [ ] 用户验收测试
2. [ ] 文档更新
3. [ ] 生产部署准备
