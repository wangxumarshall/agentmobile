/**
 * Telegram Channel Adapter.
 * Wraps the existing Telegram Bot logic into the BaseChannelAdapter interface.
 */

import https from 'node:https';
import type {
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  OutboundImage,
  SendResult,
} from '../bridge/types.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import { info, error, debug } from '../config/logger.js';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from: { id: number; first_name: string; username?: string };
    text?: string;
    photo?: Array<{ file_id: string; file_size: number }>;
    document?: { file_id: string; file_name: string; file_size: number };
    caption?: string;
    date: number;
  };
  edited_message?: {
    message_id: number;
    chat: { id: number };
    from: { id: number; first_name: string };
    text?: string;
    date: number;
  };
}

interface TelegramAdapterOptions {
  botToken: string;
  webhookSecret?: string;
  allowedUsers?: string[];
  defaultSession?: string;
}

export class TelegramAdapter extends BaseChannelAdapter {
  readonly channelType: ChannelType = 'telegram';

  private botToken: string;
  private webhookSecret?: string;
  private allowedUsers: string[];
  private defaultSession: string;
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private offset = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TelegramAdapterOptions) {
    super();
    this.botToken = options.botToken;
    this.webhookSecret = options.webhookSecret;
    this.allowedUsers = options.allowedUsers || [];
    this.defaultSession = options.defaultSession || 'default';
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    info('telegram-adapter', 'Starting Telegram adapter (polling mode)');
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    // Wake up all waiters
    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];
    info('telegram-adapter', 'Telegram adapter stopped');
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
      const text = this.formatText(message);
      await this.telegramRequest('sendMessage', {
        chat_id: message.address.chatId,
        text,
        parse_mode: message.parseMode === 'plain' ? undefined : message.parseMode || 'Markdown',
        reply_to_message_id: message.replyToMessageId,
      });
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('telegram-adapter', `Send failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    try {
      await this.telegramRequest('sendPhoto', {
        chat_id: image.address.chatId,
        photo: image.filePath,
        reply_to_message_id: image.replyToMessageId,
      });
      return { ok: true };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('telegram-adapter', `Send image failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  isAuthorized(userId: string): boolean {
    if (this.allowedUsers.length === 0) return true;
    return this.allowedUsers.includes(userId);
  }

  private startPolling(): void {
    if (!this.running) return;

    this.pollMessages().then(() => {
      if (this.running) {
        this.pollTimer = setTimeout(() => this.startPolling(), 1000);
      }
    }).catch(e => {
      error('telegram-adapter', `Poll error: ${e.message}`);
      if (this.running) {
        this.pollTimer = setTimeout(() => this.startPolling(), 5000);
      }
    });
  }

  private async pollMessages(): Promise<void> {
    const result = await this.telegramRequest('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message'],
    });

    if (!result.ok || !result.result) return;

    for (const update of result.result as TelegramUpdate[]) {
      this.offset = update.update_id + 1;

      const message = update.message || update.edited_message;
      if (!message || !message.text) continue;

      const inbound: InboundMessage = {
        messageId: String(message.message_id),
        address: {
          channelType: 'telegram',
          chatId: String(message.chat.id),
          userId: String(message.from.id),
          displayName: message.from.first_name,
        },
        text: message.text,
        timestamp: message.date * 1000,
      };

      // Authorization check
      if (!this.isAuthorized(inbound.address.userId || '')) {
        debug('telegram-adapter', `Unauthorized user: ${inbound.address.userId}`);
        continue;
      }

      this.enqueue(inbound);
    }
  }

  private enqueue(message: InboundMessage): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter(message);
      return;
    }
    this.queue.push(message);
  }

  private formatText(message: OutboundMessage): string {
    return message.text;
  }

  private telegramRequest(method: string, payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(
        `https://api.telegram.org/bot${this.botToken}/${method}`,
        options,
        (res) => {
          let data = '';
          res.on('data', d => data += d);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error('Invalid response'));
            }
          });
        }
      );

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
