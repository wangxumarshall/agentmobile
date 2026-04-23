/**
 * Feishu-specific types and AdapterContext interface.
 */

import type { InboundMessage, ChannelAddress, ChannelBinding, SendResult } from '../bridge/types.js';
import type { LarkClient } from './lark-client.js';
import type { PreviewService } from './services/preview-service.js';
import type { ActivityService } from './services/activity-service.js';
import type { InboundImageService } from './services/inbound-image-service.js';
import type { PermissionBroker } from '../bridge/permission-broker.js';
import type { ChannelRouter } from '../bridge/channel-router.js';
import type { JsonFileStore } from '../infra/store.js';

// ── AdapterContext ──────────────────────────────────────────────

/**
 * Dependency injection container for Feishu handlers.
 *
 * Rather than passing dozens of dependencies to each handler function,
 * this interface bundles all the methods and state each handler needs.
 */
export interface AdapterContext {
  // Core services
  larkClient: LarkClient;
  store: JsonFileStore;
  router: ChannelRouter;
  permissionBroker: PermissionBroker;
  previewService: PreviewService;
  activityService: ActivityService;
  inboundImageService: InboundImageService;

  // Session management
  createBoundSession(
    runtime: 'claude' | 'codex',
    sender: ChannelAddress,
    options: {
      permissionMode?: 'plan' | 'acceptEdits' | 'default';
      mode?: 'code' | 'plan' | 'ask';
      workingDirectory?: string;
    }
  ): Promise<ChannelBinding>;

  // Card operations
  sendCard(
    address: ChannelAddress,
    card: Record<string, unknown>,
    replyToMessageId?: string
  ): Promise<SendResult>;

  patchCard(
    messageId: string,
    card: Record<string, unknown>,
    options?: { messageId?: string; openMessageId?: string }
  ): Promise<SendResult>;

  sendText(
    address: ChannelAddress,
    text: string,
    replyToMessageId?: string
  ): Promise<SendResult>;

  // Profile
  profileId: string;

  // Event handlers
  handleNewSessionCardAction(event: unknown, callbackData: string): Promise<void>;
  handleResumeCardAction(event: unknown, callbackData: string): Promise<void>;
  handleClaudeModeCardAction(event: unknown, callbackData: string): Promise<void>;
  handleStructuredInputCardAction(event: unknown, callbackData: string): Promise<void>;
  handlePlanCardAction(event: unknown, callbackData: string): Promise<void>;
  handleClaudePlanExitCardAction(event: unknown, callbackData: string): Promise<void>;
}

// ── Sender Identity ──────────────────────────────────────────────

/**
 * Extracted sender identity from Feishu events.
 */
export interface SenderIdentity {
  userId: string;
  chatId: string;
  displayName?: string;
  unionId?: string;
  openId?: string;
}

// ── Feishu Event Types ──────────────────────────────────────────

/**
 * Raw Feishu message receive event payload.
 */
export interface FeishuMessageEvent {
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: 'text' | 'image' | 'file' | 'audio' | 'sticker' | 'interactive';
    content: string;
    create_time: string;
    update_time: string;
    mentions?: Array<{
      key: string;
      id: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
      name: string;
    }>;
  };
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
    sender_type: 'user' | 'app';
    tenant_key?: string;
  };
}

/**
 * Raw Feishu card action trigger event payload.
 */
export interface FeishuCardActionEvent {
  open_chat_id: string;
  open_message_id: string;
  open_id: string;
  user_id?: string;
  union_id?: string;
  tenant_key?: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
    form_value?: Record<string, unknown>;
    timezone?: string;
  };
  operator: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
}

// ── Pending Image ──────────────────────────────────────────────

/**
 * A pending inbound image from Feishu message.
 */
export interface PendingInboundImage {
  imageKey: string;
  localPath?: string;
  mimeType: string;
  fileSize?: number;
}
