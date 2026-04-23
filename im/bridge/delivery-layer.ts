/**
 * Reliable outbound delivery layer.
 * Handles retry, error handling, and message dispatch.
 */

import type { BaseChannelAdapter } from './channel-adapter.js';
import type { OutboundMessage, OutboundImage, SendResult } from './types.js';
import { error, debug } from '../config/logger.js';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function deliver(
  adapter: BaseChannelAdapter,
  message: OutboundMessage,
): Promise<SendResult> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await adapter.send(message);
      if (result.ok) {
        debug('delivery', `Message sent successfully (attempt ${attempt})`);
        return result;
      }
      lastError = new Error(result.error || 'Send failed');
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      error('delivery', `Send attempt ${attempt} failed: ${lastError.message}`);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'Unknown error',
  };
}

export async function deliverImage(
  adapter: BaseChannelAdapter,
  image: OutboundImage,
): Promise<SendResult> {
  if (!adapter.sendImage) {
    return { ok: false, error: 'Adapter does not support image delivery' };
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await adapter.sendImage(image);
      if (result.ok) {
        debug('delivery', `Image sent successfully (attempt ${attempt})`);
        return result;
      }
      lastError = new Error(result.error || 'Image send failed');
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      error('delivery', `Image send attempt ${attempt} failed: ${lastError.message}`);
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }

  return {
    ok: false,
    error: lastError?.message || 'Unknown error',
  };
}
