/**
 * Feishu/Lark Channel Adapter (Full Implementation).
 *
 * Uses Feishu WebSocket SDK for real-time message delivery.
 * Integrates with:
 * - LarkClient for REST API operations
 * - PreviewService for streaming previews
 * - ActivityService for tool/file/command activity cards
 * - InboundImageService for image downloads
 * - Handlers for message dispatch
 */

import { randomUUID } from 'node:crypto';
import type {
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  OutboundImage,
  SendResult,
  ChannelBinding,
  ActivityEvent,
} from '../bridge/types.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import { LarkClient } from '../feishu/lark-client.js';
import { PreviewService } from '../feishu/services/preview-service.js';
import { ActivityService } from '../feishu/services/activity-service.js';
import { InboundImageService } from '../feishu/services/inbound-image-service.js';
import { type AdapterContext, type FeishuMessageEvent, type FeishuCardActionEvent, type SenderIdentity } from '../feishu/types.js';
import { handleIncomingEvent, handleDirectMessage, handleGroupMessage } from '../feishu/handlers/inbound-handler.js';
import { handleCardAction } from '../feishu/handlers/card-action-handler.js';
import {
  handleCreateSessionCommand,
  handleResumeSessionCommand,
  handleNewSessionCardAction,
  handleResumeCardAction,
  handleModeCommand,
  handleResetCommand,
  handleClaudeModeCardAction,
} from '../feishu/handlers/session-handler.js';
import { handlePlanCommand, handlePlanCardAction, handleClaudePlanExitCardAction } from '../feishu/handlers/plan-handler.js';
import { handleStructuredInputCardAction } from '../feishu/handlers/structured-input-handler.js';
import { PermissionBroker } from '../bridge/permission-broker.js';
import { ChannelRouter } from '../bridge/channel-router.js';
import { JsonFileStore } from '../infra/store.js';
import { info, error, debug } from '../config/logger.js';

interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  domain?: 'lark';
  allowedUsers?: string[];
  store: JsonFileStore;
  router: ChannelRouter;
  permissionBroker: PermissionBroker;
  defaultWorkDir?: string;
  showToolCallCards?: boolean;
}

interface FeishuEventDispatcherHandlers {
  onMessageReceive(data: unknown): Promise<void>;
  onMessageRead?(data: unknown): Promise<void>;
  onChatUpdated?(data: unknown): Promise<void>;
}

export function createFeishuEventDispatcher(
  lark: any,
  handlers: FeishuEventDispatcherHandlers,
): any {
  return new lark.EventDispatcher({
    loggerLevel: lark.LoggerLevel?.info ?? 'info',
  }).register({
    'im.message.receive_v1': handlers.onMessageReceive,
    'im.message.message_read_v1': handlers.onMessageRead || (async () => {}),
    'im.chat.updated_v1': handlers.onChatUpdated || (async () => {}),
  });
}

export class FeishuAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'feishu';

  // Core services
  private larkClient: LarkClient;
  private previewService: PreviewService;
  private activityService: ActivityService;
  private inboundImageService: InboundImageService;
  private permissionBroker: PermissionBroker;
  private channelRouter: ChannelRouter;
  private store: JsonFileStore;

  // Feishu WebSocket client
  private wsClient: any | null = null;

  // Message queue and waiters
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];

  // Configuration
  private allowedUsers: string[];
  private defaultWorkDir: string;
  private showToolCallCards: boolean;

  // State
  private running = false;

  constructor(options: FeishuAdapterOptions) {
    super();

    // Initialize services
    this.larkClient = new LarkClient({
      appId: options.appId,
      appSecret: options.appSecret,
      domain: options.domain,
    });

    this.previewService = new PreviewService(this.larkClient);
    this.activityService = new ActivityService(this.larkClient, options.showToolCallCards || false);
    this.inboundImageService = new InboundImageService(this.larkClient);
    this.permissionBroker = options.permissionBroker;
    this.channelRouter = options.router;
    this.store = options.store;

    this.allowedUsers = options.allowedUsers || [];
    this.defaultWorkDir = options.defaultWorkDir || process.cwd();
    this.showToolCallCards = options.showToolCallCards || false;
  }

  async start(): Promise<void> {
    if (this.running) return;

    info('feishu-adapter', 'Starting Feishu adapter with WebSocket...');

    try {
      // Initialize WebSocket client via dynamic import (ESM safe)
      const larkModule = await import('@larksuiteoapi/node-sdk');
      const lark = larkModule.default || larkModule;

      const connectionOptions = this.larkClient.getConnectionOptions();
      this.wsClient = new (lark.WSClient)({
        appId: connectionOptions.appId,
        appSecret: connectionOptions.appSecret,
        ...(connectionOptions.domain === 'lark' ? { domain: 'lark' } : {}),
        loggerLevel: lark.LoggerLevel?.info ?? 'info',
      });

      const eventDispatcher = createFeishuEventDispatcher(lark, {
        onMessageReceive: async (data) => {
          await this.handleIncomingEvent(data);
        },
      });

      // Start the WebSocket connection
      await this.wsClient.start({ eventDispatcher });

      this.running = true;
      info('feishu-adapter', 'Feishu adapter started successfully');
    } catch (e) {
      error('feishu-adapter', `Failed to start WebSocket client: ${e}`);
      this.running = false;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (!this.running && !this.wsClient) return;

    this.running = false;

    // Stop WebSocket client
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // Ignore errors
      }
      this.wsClient = null;
    }

    // Clean up services
    this.activityService.cleanup();

    // Wake up all waiters
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    info('feishu-adapter', 'Feishu adapter stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    try {
      const address: ChannelAddress = {
        channelType: 'feishu',
        chatId: message.address.chatId,
        userId: message.address.userId,
      };

      // Check if we should send as interactive card
      if (message.inlineButtons && message.inlineButtons.length > 0) {
        const card = this.buildInteractiveCard(message);
        const result = await this.larkClient.sendCard(address, card, message.replyToMessageId);
        const data = result?.data as Record<string, unknown> | undefined;
        return {
          ok: true,
          messageId: data?.message_id as string,
          openMessageId: data?.messageId as string,
        };
      }

      // Otherwise send as text
      const result = await this.larkClient.sendMessage(address, 'text', {
        text: message.text,
      });

      const data = result?.data as Record<string, unknown> | undefined;
      return {
        ok: true,
        messageId: data?.message_id as string,
        openMessageId: data?.messageId as string,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('feishu-adapter', `Send failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    try {
      const address: ChannelAddress = {
        channelType: 'feishu',
        chatId: image.address.chatId,
        userId: image.address.userId,
      };

      const imageKey = await this.larkClient.uploadImage(image.filePath);

      const result = await this.larkClient.sendMessage(address, 'image', {
        image_key: imageKey,
      });

      const data = result?.data as Record<string, unknown> | undefined;
      return {
        ok: true,
        messageId: data?.message_id as string,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('feishu-adapter', `Send image failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  isAuthorized(userId: string, chatId: string): boolean {
    if (this.allowedUsers.length === 0) return true;
    return this.allowedUsers.includes(userId);
  }

  async validateConfig(): Promise<string | null> {
    try {
      const client = await this.larkClient.getClient();
      if (!client) return 'Failed to initialize Lark SDK client';
    } catch (e) {
      return `Invalid config: ${e}`;
    }

    return null;
  }

  // ── Streaming Preview Methods ──────────────────────────────

  getPreviewCapabilities(address: ChannelAddress): { supported: boolean; privateOnly: boolean; finalDelivery: 'replace_preview' } | null {
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'replace_preview',
    };
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.sendPreview(address, text, draftId);
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.primePreview(address, draftId);
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    this.previewService.endPreview(address, draftId);
  }

  async finalizePreview(address: ChannelAddress, text: string, _draftId: number): Promise<SendResult> {
    return this.previewService.finalizePreview(address, text);
  }

  // ── Activity Card Methods ──────────────────────────────────

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    return this.activityService.upsertActivityEvent(address, event, replyToMessageId);
  }

  shouldProjectActivityEvent(event: ActivityEvent): boolean {
    return this.activityService.shouldProjectEvent(event);
  }

  // ── Event Handlers ─────────────────────────────────────────

  /**
   * Handle incoming Feishu message event.
   */
  private async handleIncomingEvent(data: any): Promise<void> {
    try {
      // Build HandlerContext for the handlers
      const ctx = this.getHandlerContext();

      const message = await handleIncomingEvent(ctx, data as FeishuMessageEvent);
      if (message) {
        this.enqueue(message);
      }

      // The handlers will process and either respond directly or enqueue
      // for the bridge manager via our queue
    } catch (e) {
      error('feishu-adapter', `Handle incoming event failed: ${e}`);
    }
  }

  /**
   * Handle Feishu card action/callback event.
   */
  async handleCardActionPayload(data: unknown): Promise<boolean> {
    return this.handleCardAction(data);
  }

  private async handleCardAction(data: unknown): Promise<boolean> {
    try {
      const ctx = this.getHandlerContext();

      const resolved = await handleCardAction(ctx, data as FeishuCardActionEvent);

      if (resolved) {
        const callback = (data as FeishuCardActionEvent)?.action?.value?.callback;
        debug('feishu-adapter', `Card action resolved: ${callback}`);
      }
      return resolved;
    } catch (e) {
      error('feishu-adapter', `Handle card action failed: ${e}`);
      return false;
    }
  }

  // ── Internal Helpers ───────────────────────────────────────

  /**
   * Build a Feishu interactive card from an OutboundMessage.
   */
  private buildInteractiveCard(message: OutboundMessage): Record<string, unknown> {
    const elements: any[] = [
      {
        tag: 'markdown',
        content: message.text,
      },
    ];

    if (message.inlineButtons && message.inlineButtons.length > 0) {
      elements.push({
        tag: 'action',
        actions: message.inlineButtons.flat().map((btn, i) => ({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: btn.text,
          },
          type: i === 0 ? 'primary' : 'default',
          value: {
            callback: btn.callbackData,
            chat_id: message.address.chatId,
            user_id: message.address.userId,
            channel_instance_id: message.address.channelInstanceId || this.profileId,
          },
        })),
        layout: 'horizontal',
      });
    }

    return {
      config: {
        wide_screen_mode: true,
      },
      header: message.cardHeader || {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: 'AgentMobile',
        },
      },
      elements,
    };
  }

  private enqueue(message: InboundMessage): void {
    this.queue.push(message);
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(message);
    }
  }

  /**
   * Build the AdapterContext dependency injection container.
   */
  private getHandlerContext(): AdapterContext {
    const self = this;

    return {
      larkClient: this.larkClient,
      store: this.store,
      router: this.channelRouter,
      permissionBroker: this.permissionBroker,
      previewService: this.previewService,
      activityService: this.activityService,
      inboundImageService: this.inboundImageService,
      profileId: this.profileId,

      // Session management
      async createBoundSession(runtime, sender, options) {
        return self.channelRouter.createBinding({
          channelType: 'feishu',
          channelInstanceId: self.profileId,
          chatId: sender.chatId,
          agentSessionId: `session_${Date.now()}`,
          workingDirectory: options.workingDirectory || self.defaultWorkDir,
          runtime,
          model: 'default',
          mode: options.mode || 'code',
        });
      },
      getActiveBinding(address) {
        return self.channelRouter.resolve(address);
      },
      deactivateBinding(bindingId) {
        self.channelRouter.deactivateBinding(bindingId);
      },
      isAuthorized(sender) {
        return self.isAuthorized(sender.userId, sender.chatId);
      },

      // Card operations
      async sendCard(address, card, replyToMessageId) {
        const result = await self.larkClient.sendCard(
          address,
          self.withActionRoute(card, address),
          replyToMessageId,
        );
        const data = result?.data as Record<string, unknown> | undefined;
        return {
          ok: true,
          messageId: data?.message_id as string,
        };
      },

      async patchCard(messageId, card, options) {
        const result = await self.larkClient.patchCard(messageId, card, options);
        return { ok: true };
      },

      async sendText(address, text, replyToMessageId) {
        const result = await self.larkClient.sendMessage(address, 'text', { text }, replyToMessageId);
        const data = result?.data as Record<string, unknown> | undefined;
        return {
          ok: true,
          messageId: data?.message_id as string,
        };
      },

      // Event handlers (wired to session-handler, etc.)
      async handleNewSessionCardAction(event, callbackData) {
        await handleNewSessionCardAction(self.getHandlerContext(), event as any, callbackData);
      },
      async handleResumeCardAction(event, callbackData) {
        await handleResumeCardAction(self.getHandlerContext(), event as any, callbackData);
      },
      async handleClaudeModeCardAction(event, callbackData) {
        await handleClaudeModeCardAction(self.getHandlerContext(), event as any, callbackData);
      },
      async handleStructuredInputCardAction(event, callbackData) {
        await handleStructuredInputCardAction(self.getHandlerContext(), event as any, callbackData);
      },
      async handlePlanCardAction(event, callbackData) {
        await handlePlanCardAction(self.getHandlerContext(), event as any, callbackData);
      },
      async handleClaudePlanExitCardAction(event, callbackData) {
        await handleClaudePlanExitCardAction(self.getHandlerContext(), event as any, callbackData);
      },
    };
  }

  private withActionRoute(
    card: Record<string, unknown>,
    address: ChannelAddress,
  ): Record<string, unknown> {
    const routedCard = JSON.parse(JSON.stringify(card)) as Record<string, unknown>;
    for (const elementList of this.getCardElementLists(routedCard)) {
      for (const element of elementList) {
        if (!this.isRecord(element) || element.tag !== 'action' || !Array.isArray(element.actions)) {
          continue;
        }
        for (const action of element.actions) {
          if (!this.isRecord(action)) continue;
          const value = this.isRecord(action.value) ? action.value : {};
          action.value = {
            ...value,
            chat_id: value.chat_id || address.chatId,
            user_id: value.user_id || address.userId,
            channel_instance_id: value.channel_instance_id || address.channelInstanceId || this.profileId,
          };
        }
      }
    }
    return routedCard;
  }

  private getCardElementLists(card: Record<string, unknown>): unknown[][] {
    const lists: unknown[][] = [];
    if (Array.isArray(card.elements)) {
      lists.push(card.elements);
    }

    const i18nElements = card.i18n_elements;
    if (this.isRecord(i18nElements)) {
      for (const value of Object.values(i18nElements)) {
        if (Array.isArray(value)) {
          lists.push(value);
        }
      }
    }
    return lists;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
