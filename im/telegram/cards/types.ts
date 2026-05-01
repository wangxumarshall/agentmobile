/**
 * Telegram card primitives.
 *
 * Telegram does not have Feishu Card 2.0. The equivalent surface is a
 * formatted message plus an inline keyboard that can later be edited in place.
 */

import type {
  CardMessage,
  ChannelAddress,
  OutboundMessage,
} from '../../bridge/types.js';

export interface TelegramCard extends CardMessage {}

export function telegramCardToOutboundMessage(
  address: ChannelAddress,
  card: TelegramCard,
  replyToMessageId?: string,
): OutboundMessage {
  return {
    address,
    text: card.text,
    parseMode: card.parseMode || 'HTML',
    inlineButtons: card.inlineButtons,
    replyToMessageId,
  };
}
