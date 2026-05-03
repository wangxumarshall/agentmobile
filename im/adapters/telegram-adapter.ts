/**
 * Telegram Channel Adapter.
 * Wraps the existing Telegram Bot logic into the BaseChannelAdapter interface.
 */

import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { basename, extname } from 'node:path';
import type {
  ActivityEvent,
  CardMessage,
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundMessage,
  OutboundImage,
  PreviewCapabilities,
  SendResult,
} from '../bridge/types.js';
import { BaseChannelAdapter } from '../bridge/channel-adapter.js';
import type { TelegramCard } from '../telegram/cards/index.js';
import { TelegramActivityService, TelegramPreviewService } from '../telegram/services/index.js';
import type { TelegramCardClient } from '../telegram/services/index.js';
import { info, error, debug } from '../config/logger.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

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
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: {
      message_id: number;
      chat: { id: number; type: string };
      text?: string;
      date?: number;
    };
    data?: string;
  };
}

interface TelegramAdapterOptions {
  botToken: string;
  webhookSecret?: string;
  allowedUsers?: string[];
  defaultSession?: string;
  showToolCallCards?: boolean;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
  error_code?: number;
}

interface TelegramSentMessage {
  message_id: number;
  chat?: { id: number | string };
}

export class TelegramAdapter extends BaseChannelAdapter implements TelegramCardClient {
  readonly channelType: ChannelType = 'telegram';

  private botToken: string;
  private webhookSecret?: string;
  private allowedUsers: string[];
  private defaultSession: string;
  private previewService: TelegramPreviewService;
  private activityService: TelegramActivityService;
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
    this.previewService = new TelegramPreviewService(this);
    this.activityService = new TelegramActivityService(this, options.showToolCallCards || false);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    info('telegram-adapter', 'Starting Telegram adapter (polling mode)');
    await this.clearWebhookForPolling();
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
      const formatted = this.formatText(message.text, message.parseMode);
      const result = await this.telegramTextRequest('sendMessage', {
        chat_id: message.address.chatId,
        text: formatted.text,
        parse_mode: this.toTelegramParseMode(formatted.parseMode),
        reply_to_message_id: message.replyToMessageId,
        reply_markup: this.buildReplyMarkup(message.inlineButtons),
      });
      this.assertTelegramOk(result, 'sendMessage');
      const sent = result.result as TelegramSentMessage | undefined;
      return { ok: true, messageId: sent?.message_id ? String(sent.message_id) : undefined };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('telegram-adapter', `Send failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async sendCard(
    address: ChannelAddress,
    card: TelegramCard,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    return this.send({
      address,
      text: card.text,
      parseMode: card.parseMode,
      inlineButtons: card.inlineButtons,
      replyToMessageId,
    });
  }

  async patchCard(
    address: ChannelAddress,
    messageId: string,
    card: CardMessage,
  ): Promise<SendResult> {
    try {
      const formatted = this.formatText(card.text, card.parseMode || 'HTML');
      const result = await this.telegramTextRequest('editMessageText', {
        chat_id: address.chatId,
        message_id: Number(messageId),
        text: formatted.text,
        parse_mode: this.toTelegramParseMode(formatted.parseMode),
        reply_markup: this.buildReplyMarkup(card.inlineButtons),
      });
      this.assertTelegramOk(result, 'editMessageText');
      return { ok: true, messageId };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('telegram-adapter', `Patch card failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async deleteCard(address: ChannelAddress, messageId: string): Promise<void> {
    try {
      const result = await this.telegramRequest('deleteMessage', {
        chat_id: address.chatId,
        message_id: Number(messageId),
      });
      this.assertTelegramOk(result, 'deleteMessage');
    } catch (e) {
      debug('telegram-adapter', `Delete card failed: ${e}`);
    }
  }

  async sendImage(image: OutboundImage): Promise<SendResult> {
    try {
      const payload = {
        chat_id: image.address.chatId,
        reply_to_message_id: image.replyToMessageId,
      };
      const result = existsSync(image.filePath)
        ? await this.telegramMultipartRequest('sendPhoto', payload, {
            fieldName: 'photo',
            filePath: image.filePath,
          })
        : await this.telegramRequest('sendPhoto', {
            ...payload,
            photo: image.filePath,
          });
      this.assertTelegramOk(result, 'sendPhoto');
      const sent = result.result as TelegramSentMessage | undefined;
      return { ok: true, messageId: sent?.message_id ? String(sent.message_id) : undefined };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('telegram-adapter', `Send image failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      const result = await this.telegramRequest('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text,
      });
      this.assertTelegramOk(result, 'answerCallbackQuery');
    } catch (e) {
      debug('telegram-adapter', `Answer callback failed: ${e}`);
    }
  }

  isAuthorized(userId: string, _chatId?: string): boolean {
    if (this.allowedUsers.length === 0) return true;
    return this.allowedUsers.includes(userId);
  }

  getPreviewCapabilities(_address: ChannelAddress): PreviewCapabilities {
    return {
      supported: true,
      privateOnly: false,
      finalDelivery: 'replace_preview',
    };
  }

  async primePreview(address: ChannelAddress, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.primePreview(address, draftId);
  }

  async sendPreview(address: ChannelAddress, text: string, draftId: number): Promise<'sent' | 'skip' | 'degrade'> {
    return this.previewService.sendPreview(address, text, draftId);
  }

  async finalizePreview(address: ChannelAddress, text: string, _draftId: number): Promise<SendResult> {
    return this.previewService.finalizePreview(address, text);
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    this.previewService.endPreview(address, draftId);
  }

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

  private async clearWebhookForPolling(): Promise<void> {
    try {
      const result = await this.telegramRequest('deleteWebhook', { drop_pending_updates: false });
      if (!result.ok) {
        debug('telegram-adapter', `deleteWebhook returned non-ok response: ${result.description || 'unknown error'}`);
      }
    } catch (e) {
      debug('telegram-adapter', `deleteWebhook failed before polling: ${e}`);
    }
  }

  private async pollMessages(): Promise<void> {
    const result = await this.telegramRequest('getUpdates', {
      offset: this.offset,
      timeout: 30,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    });

    if (!result.ok || !result.result) return;

    for (const update of result.result as TelegramUpdate[]) {
      this.offset = update.update_id + 1;

      if (update.callback_query) {
        const inbound = this.buildCallbackInbound(update);
        if (inbound) this.enqueue(inbound);
        continue;
      }

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
      if (!this.isAuthorized(inbound.address.userId || '', inbound.address.chatId)) {
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

  private formatText(
    text: string,
    parseMode: OutboundMessage['parseMode'],
  ): { text: string; parseMode: OutboundMessage['parseMode'] } {
    if (text.length <= TELEGRAM_MESSAGE_LIMIT) {
      return { text, parseMode };
    }

    const suffix = '\n...';
    if (parseMode === 'HTML') {
      return {
        text: this.truncateText(this.stripHtml(text), TELEGRAM_MESSAGE_LIMIT - suffix.length) + suffix,
        parseMode: 'plain',
      };
    }

    return {
      text: this.truncateText(text, TELEGRAM_MESSAGE_LIMIT - suffix.length) + suffix,
      parseMode,
    };
  }

  private buildCallbackInbound(update: TelegramUpdate): InboundMessage | null {
    const callback = update.callback_query;
    if (!callback?.message || !callback.data) return null;

    const inbound: InboundMessage = {
      messageId: callback.id,
      callbackMessageId: String(callback.message.message_id),
      address: {
        channelType: 'telegram',
        chatId: String(callback.message.chat.id),
        userId: String(callback.from.id),
        displayName: callback.from.first_name,
      },
      text: callback.message.text || '',
      callbackData: callback.data,
      timestamp: (callback.message.date || Math.floor(Date.now() / 1000)) * 1000,
      raw: update,
      updateId: update.update_id,
    };

    if (!this.isAuthorized(inbound.address.userId || '', inbound.address.chatId)) {
      debug('telegram-adapter', `Unauthorized callback user: ${inbound.address.userId}`);
      void this.answerCallback(callback.id, 'Unauthorized');
      return null;
    }

    return inbound;
  }

  private buildReplyMarkup(inlineButtons: OutboundMessage['inlineButtons']): Record<string, unknown> | undefined {
    if (!inlineButtons || inlineButtons.length === 0) return undefined;
    return {
      inline_keyboard: inlineButtons.map(row =>
        row.map(button => {
          const callbackBytes = Buffer.byteLength(button.callbackData, 'utf8');
          if (callbackBytes < 1 || callbackBytes > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
            throw new Error(
              `Telegram callback_data must be 1-${TELEGRAM_CALLBACK_DATA_LIMIT_BYTES} bytes; got ${callbackBytes}`,
            );
          }
          return {
            text: button.text,
            callback_data: button.callbackData,
          };
        }),
      ),
    };
  }

  private toTelegramParseMode(parseMode: OutboundMessage['parseMode']): 'HTML' | 'Markdown' | undefined {
    return parseMode === 'plain' ? undefined : parseMode || 'Markdown';
  }

  private async telegramTextRequest(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramApiResponse> {
    const result = await this.telegramRequest(method, payload);
    if (result.ok || !payload.parse_mode || !this.isParseModeError(result)) {
      return result;
    }

    debug('telegram-adapter', `${method} parse mode failed, retrying as plain text: ${result.description}`);
    const plainPayload = { ...payload };
    delete plainPayload.parse_mode;
    return this.telegramRequest(method, plainPayload);
  }

  private isParseModeError(result: TelegramApiResponse): boolean {
    const description = result.description || '';
    return result.error_code === 400 && (
      description.includes('parse entities') ||
      description.includes('entity') ||
      description.includes('Unsupported start tag')
    );
  }

  private truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars));
  }

  private stripHtml(text: string): string {
    return text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }

  private assertTelegramOk(result: TelegramApiResponse, method: string): void {
    if (!result.ok) {
      throw new Error(`${method} failed (${result.error_code || 'unknown'}): ${result.description || 'Unknown error'}`);
    }
  }

  private telegramRequest(method: string, payload: Record<string, unknown>): Promise<TelegramApiResponse> {
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

  private telegramMultipartRequest(
    method: string,
    fields: Record<string, unknown>,
    file: { fieldName: string; filePath: string },
  ): Promise<TelegramApiResponse> {
    return new Promise((resolve, reject) => {
      const boundary = `agentmobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const chunks: Buffer[] = [];

      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || value === null) continue;
        chunks.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
          `${String(value)}\r\n`,
        ));
      }

      const fileName = basename(file.filePath);
      chunks.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.fieldName}"; filename="${fileName}"\r\n` +
        `Content-Type: ${this.guessMimeType(file.filePath)}\r\n\r\n`,
      ));
      chunks.push(readFileSync(file.filePath));
      chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(chunks);
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
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
        },
      );

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private guessMimeType(filePath: string): string {
    switch (extname(filePath).toLowerCase()) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.webp':
        return 'image/webp';
      default:
        return 'image/png';
    }
  }
}
