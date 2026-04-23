/**
 * Mock LarkClient for testing.
 *
 * Captures all outgoing calls instead of making real HTTP requests.
 */

import { randomUUID } from 'node:crypto';

export interface MockSentMessage {
  address: { channelType: string; chatId: string; userId?: string };
  msgType: string;
  content: string | Record<string, unknown>;
  replyToMessageId?: string;
  messageId: string;
}

export interface MockSentCard {
  address: { channelType: string; chatId: string; userId?: string };
  card: Record<string, unknown>;
  replyToMessageId?: string;
  messageId: string;
}

export class MockLarkClient {
  private _sentMessages: MockSentMessage[] = [];
  private _sentCards: MockSentCard[] = [];
  private _patchedCards: Map<string, Record<string, unknown>> = new Map();
  private _uploadedImages: Map<string, string> = new Map();
  shouldFail = false;
  failureMessage = 'Mock failure';

  get sentMessages() { return [...this._sentMessages]; }
  get sentCards() { return [...this._sentCards]; }
  get patchedCards() { return new Map(this._patchedCards); }
  get uploadedImages() { return new Map(this._uploadedImages); }

  clear() {
    this._sentMessages = [];
    this._sentCards = [];
    this._patchedCards.clear();
    this._uploadedImages.clear();
  }

  getClient() {
    return { shouldWork: true };
  }

  setClient(_client: any) {}

  async sendMessage(
    address: any,
    msgType: string,
    content: string | Record<string, unknown>,
    replyToMessageId?: string,
  ) {
    if (this.shouldFail) throw new Error(this.failureMessage);

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._sentMessages.push({
      address,
      msgType,
      content,
      replyToMessageId,
      messageId,
    });

    return {
      code: 0,
      data: {
        message_id: messageId,
        messageId: `open_${messageId}`,
      },
    };
  }

  async sendCard(
    address: any,
    card: Record<string, unknown>,
    replyToMessageId?: string,
  ) {
    if (this.shouldFail) throw new Error(this.failureMessage);

    const messageId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._sentCards.push({
      address,
      card,
      replyToMessageId,
      messageId,
    });
    this._patchedCards.set(messageId, card);

    return {
      code: 0,
      data: {
        message_id: messageId,
        messageId: `open_${messageId}`,
      },
    };
  }

  async patchCard(
    messageId: string,
    card: Record<string, unknown>,
    _options?: { messageId?: string; openMessageId?: string },
  ) {
    if (this.shouldFail) throw new Error(this.failureMessage);
    this._patchedCards.set(messageId, { ...this._patchedCards.get(messageId), ...card });
    return { code: 0 };
  }

  async deleteMessageQuietly(messageId: string) {
    // No-op in mock
  }

  async uploadImage(filePath: string) {
    if (this.shouldFail) throw new Error(this.failureMessage);
    const imageKey = `img_${Math.random().toString(36).slice(2, 8)}`;
    this._uploadedImages.set(imageKey, filePath);
    return imageKey;
  }

  async runScopeDiagnostic() {
    return { code: 0, data: { scopes: ['im:message', 'im:chat'] } };
  }
}
