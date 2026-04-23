/**
 * Lark/Feishu API Client wrapper.
 *
 * Provides a thin wrapper around the @larksuiteoapi/node-sdk REST client:
 * - sendCard — send interactive cards
 * - patchCard — update existing cards in place
 * - sendMessage — send text/post/image messages
 * - uploadImage — upload binary image for inline use
 * - Per-chat serialization queues with rate limiting
 * - Idempotent request UUIDs for recovery
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ChannelAddress, OutboundImage } from '../bridge/types.js';
import { info, error, debug } from '../config/logger.js';

const MIN_INTERVAL_MS = 250;

export interface PatchCardOptions {
  messageId?: string;
  openMessageId?: string;
}

export interface LarkClientOptions {
  appId: string;
  appSecret: string;
  domain?: 'lark';
}

export class LarkClient {
  private client: any | null = null;
  private appId: string;
  private appSecret: string;
  private domain?: 'lark';

  // Per-chat serialization queues (explicit queue, not promise chain)
  private outboundQueues: Map<string, Array<() => Promise<void>>> = new Map();
  private outboundProcessing: Map<string, boolean> = new Map();
  private lastOutboundMessageAt: Map<string, number> = new Map();

  constructor(options: LarkClientOptions) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.domain = options.domain;
  }

  private clientInit: Promise<void> | null = null;

  /**
   * Get or lazily create the SDK client.
   * Returns null if initialization fails.
   */
  async getClient(): Promise<any | null> {
    if (this.client) return this.client;

    if (!this.clientInit) {
      this.clientInit = (async () => {
        try {
          const larkModule = await import('@larksuiteoapi/node-sdk');
          const lark = larkModule.default || larkModule;
          this.client = new lark.Client({
            appId: this.appId,
            appSecret: this.appSecret,
            loggerLevel: 'info' as any,
            ...(this.domain === 'lark' ? { domain: 'lark' } : {}),
          });
        } catch (e) {
          error('lark-client', `Failed to create SDK client: ${e}`);
          this.client = null;
        }
      })();
    }

    await this.clientInit;
    return this.client;
  }

  /**
   * Set an existing SDK client (for testing).
   */
  setClient(client: any): void {
    this.client = client;
  }

  /**
   * Send a message to Feishu.
   *
   * Supports reply-to-message for threading.
   * Uses request_uuid for idempotent retries.
   */
  async sendMessage(
    address: ChannelAddress,
    msgType: 'text' | 'post' | 'image' | 'interactive',
    content: string | Record<string, unknown>,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<Record<string, unknown>> {
    const client = await this.getClient();
    if (!client) throw new Error('Lark client not initialized');

    const uuid = requestUuid || randomUUID();
    const payload: Record<string, unknown> = {
      receive_id: address.chatId,
      msg_type: msgType,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      request_id: uuid,
      ...(replyToMessageId ? { reply_in_message_id: replyToMessageId } : {}),
    };

    return this.enqueueMessage(address.chatId, async () => {
      const result = await client.request(
        'POST',
        '/open-apis/im/v1/messages',
        {
          params: { receive_id_type: 'chat_id' },
          data: payload,
        },
      );
      debug('lark-client', `Message sent: ${msgType} -> ${address.chatId} (${uuid})`);
      return result;
    });
  }

  /**
   * Send an interactive card.
   */
  async sendCard(
    address: ChannelAddress,
    card: Record<string, unknown>,
    replyToMessageId?: string,
    requestUuid?: string,
  ): Promise<Record<string, unknown>> {
    return this.sendMessage(address, 'interactive', card, replyToMessageId, requestUuid);
  }

  /**
   * Patch an existing card in place.
   *
   * Used for streaming previews and status updates.
   * Supports both message_id and open_message_id.
   */
  async patchCard(
    messageId: string,
    card: Record<string, unknown>,
    options: PatchCardOptions = {},
  ): Promise<Record<string, unknown>> {
    const client = await this.getClient();
    if (!client) throw new Error('Lark client not initialized');

    const finalMessageId = options.openMessageId || messageId;

    // Try with open_message_id first, fallback to message_id
    try {
      const result = await client.request(
        'PATCH',
        `/open-apis/im/v1/messages/${finalMessageId}`,
        {
          data: { template: card },
        },
      );
      debug('lark-client', `Card patched: ${finalMessageId}`);
      return result;
    } catch (e) {
      // If open_message_id failed and we have a message_id, try that
      if (options.messageId && options.messageId !== finalMessageId) {
        const result = await client.request(
          'PATCH',
          `/open-apis/im/v1/messages/${options.messageId}`,
          {
            data: { template: card },
          },
        );
        return result;
      }
      throw e;
    }
  }

  /**
   * Delete a message silently (ignore errors).
   *
   * Used for cleaning up blank preview placeholders.
   */
  async deleteMessageQuietly(messageId: string): Promise<void> {
    const client = await this.getClient();
    if (!client) return;

    try {
      await client.request(
        'DELETE',
        `/open-apis/im/v1/messages/${messageId}`,
        {},
      );
      debug('lark-client', `Message deleted: ${messageId}`);
    } catch (e) {
      debug('lark-client', `Delete message ignored: ${messageId}`);
    }
  }

  /**
   * Upload an image from local file.
   *
   * Returns the Feishu image_key for inline use in messages.
   */
  async uploadImage(filePath: string): Promise<string> {
    const client = await this.getClient();
    if (!client) throw new Error('Lark client not initialized');

    const content = readFileSync(filePath);
    const result = await client.request(
      'POST',
      '/open-apis/im/v1/images',
      {
        data: {
          image_type: 'message',
          image: new File([content], 'image', {
            type: 'application/octet-stream',
          }),
        },
      },
    );

    const data = result?.data;
    const imageKey = data?.image_key;
    if (!imageKey) {
      throw new Error('Image upload failed: no image_key in response');
    }

    debug('lark-client', `Image uploaded: ${imageKey}`);
    return imageKey;
  }

  /**
   * Run a diagnostic check on app scopes.
   *
   * Calls /open-apis/application/v6/applications/me to check
   * if the app has required permissions.
   */
  async runScopeDiagnostic(): Promise<Record<string, unknown> | null> {
    const client = await this.getClient();
    if (!client) return null;

    try {
      const result = await client.request(
        'GET',
        '/open-apis/application/v6/applications/me',
        {},
      );
      return result;
    } catch (e) {
      error('lark-client', `Scope diagnostic failed: ${e}`);
      return null;
    }
  }

  /**
   * Enqueue a task for a specific chat.
   *
   * Uses an explicit array-based queue instead of promise chains
   * to avoid unbounded growth under heavy load.
   */
  private async enqueueMessage(
    chatId: string,
    task: () => Promise<any>,
  ): Promise<any> {
    let chatQueue = this.outboundQueues.get(chatId);
    if (!chatQueue) {
      chatQueue = [];
      this.outboundQueues.set(chatId, chatQueue);
    }

    return new Promise((resolve, reject) => {
      chatQueue!.push(async () => {
        await this.applyRateLimit(chatId);
        try {
          const result = await task();
          resolve(result);
        } catch (e) {
          error('lark-client', `Message task failed for chat ${chatId}: ${e}`);
          reject(e);
        }
      });

      // Process queue if not already running
      if (!this.outboundProcessing.get(chatId)) {
        this.processQueue(chatId);
      }
    });
  }

  /**
   * Process the queue for a specific chat.
   */
  private async processQueue(chatId: string): Promise<void> {
    const chatQueue = this.outboundQueues.get(chatId);
    if (!chatQueue || chatQueue.length === 0) {
      this.outboundProcessing.delete(chatId);
      return;
    }

    this.outboundProcessing.set(chatId, true);
    const task = chatQueue.shift()!;

    try {
      await task();
    } catch {
      // Error already logged in the task wrapper
    }

    this.processQueue(chatId);
  }

  /**
   * Apply rate limiting between messages.
   *
   * Ensures at least MIN_INTERVAL_MS gap between messages.
   */
  private async applyRateLimit(chatId: string): Promise<void> {
    const lastAt = this.lastOutboundMessageAt.get(chatId) || 0;
    const now = Date.now();
    const gap = now - lastAt;

    if (gap < MIN_INTERVAL_MS) {
      await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - gap));
    }

    this.lastOutboundMessageAt.set(chatId, Date.now());
  }
}
