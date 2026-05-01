/**
 * Streaming preview cards for Telegram.
 */

import type { TelegramCard } from './types.js';
import { truncateText } from './utils.js';

const TELEGRAM_MESSAGE_LIMIT = 4096;
const STREAMING_PREFIX = '⚡ Streaming...\n\n';
const COMPLETE_PREFIX = '✅ Complete\n\n';

export function buildStreamingCardSkeleton(): TelegramCard {
  return {
    parseMode: 'plain',
    text: '⚡ Streaming...',
  };
}

export function buildStreamingPreviewCard(text: string): TelegramCard {
  return {
    parseMode: 'plain',
    text: STREAMING_PREFIX + truncateText(text, TELEGRAM_MESSAGE_LIMIT - STREAMING_PREFIX.length),
  };
}

export function buildFinalCard(text: string): TelegramCard {
  return {
    parseMode: 'plain',
    text: COMPLETE_PREFIX + truncateText(text, TELEGRAM_MESSAGE_LIMIT - COMPLETE_PREFIX.length),
  };
}
