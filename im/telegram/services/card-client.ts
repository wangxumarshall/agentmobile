import type { CardMessage, ChannelAddress, SendResult } from '../../bridge/types.js';

export interface TelegramCardClient {
  sendCard(
    address: ChannelAddress,
    card: CardMessage,
    replyToMessageId?: string,
  ): Promise<SendResult>;

  patchCard(
    address: ChannelAddress,
    messageId: string,
    card: CardMessage,
  ): Promise<SendResult>;

  deleteCard?(
    address: ChannelAddress,
    messageId: string,
  ): Promise<void>;
}
