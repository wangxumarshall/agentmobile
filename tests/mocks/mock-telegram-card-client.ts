/**
 * Mock Telegram card client for preview/activity service tests.
 */

import type { CardMessage, ChannelAddress, SendResult } from '../../im/bridge/types.js';
import type { TelegramCardClient } from '../../im/telegram/services/index.js';

export class MockTelegramCardClient implements TelegramCardClient {
  sentCards: Array<{ address: ChannelAddress; card: CardMessage; replyToMessageId?: string; messageId: string }> = [];
  patchedCards: Array<{ address: ChannelAddress; messageId: string; card: CardMessage }> = [];
  deletedCards: Array<{ address: ChannelAddress; messageId: string }> = [];
  shouldFail = false;
  private nextId = 1;

  async sendCard(
    address: ChannelAddress,
    card: CardMessage,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (this.shouldFail) return { ok: false, error: 'mock failure' };
    const messageId = String(this.nextId++);
    this.sentCards.push({ address, card, replyToMessageId, messageId });
    return { ok: true, messageId };
  }

  async patchCard(
    address: ChannelAddress,
    messageId: string,
    card: CardMessage,
  ): Promise<SendResult> {
    if (this.shouldFail) return { ok: false, error: 'mock failure' };
    this.patchedCards.push({ address, messageId, card });
    return { ok: true, messageId };
  }

  async deleteCard(
    address: ChannelAddress,
    messageId: string,
  ): Promise<void> {
    this.deletedCards.push({ address, messageId });
  }
}
