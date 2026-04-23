/**
 * Feishu utility functions.
 *
 * Pure functions used across the Feishu adapter implementation.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { ChannelAddress } from '../bridge/types.js';

// ── Routing Keys ──────────────────────────────────────────────

/**
 * Build a composite route key from channel components.
 */
export function buildRouteKey(
  channelType: string,
  channelInstanceId: string,
  chatId: string,
): string {
  return `${channelType}:${channelInstanceId}:${chatId}`;
}

/**
 * Build a route key from a ChannelAddress.
 */
export function routeKeyForAddress(address: ChannelAddress): string {
  return buildRouteKey(
    address.channelType,
    address.channelInstanceId || 'default',
    address.chatId,
  );
}

/**
 * Build a preview key for streaming preview routing.
 */
export function previewKey(address: ChannelAddress, draftId?: number): string {
  return `preview:${routeKeyForAddress(address)}:${draftId}`;
}

/**
 * Build an activity key for activity card upsert routing.
 */
export function activityKey(address: ChannelAddress, activityId: string): string {
  return `activity:${routeKeyForAddress(address)}:${activityId}`;
}

// ── UUID Generation ──────────────────────────────────────────

/**
 * Generate a stable UUID from a seed string (for idempotent operations).
 */
export function stableMessageUuid(seed: string): string {
  return createHash('md5').update(seed).digest('hex');
}

/**
 * Generate a random UUID.
 */
export function generateUuid(): string {
  return randomUUID();
}

// ── Message Parsing ──────────────────────────────────────────

/**
 * Parse text content from Feishu message elements.
 */
export function parseTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => parseTextContent(item))
      .filter(Boolean)
      .join('');
  }
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (rec.text) return String(rec.text);
    if (rec.content) return String(rec.content);
  }
  return '';
}

/**
 * Parse an image resource key from Feishu message.
 */
export function parseImageResourceKey(content: unknown): string | null {
  if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.image_key === 'string') return rec.image_key;
    if (typeof rec.key === 'string') return rec.key;
  }
  return null;
}

// ── MIME Utilities ───────────────────────────────────────────

/**
 * Get file extension from MIME type.
 */
export function extensionForMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
  };
  return map[mimeType] || '';
}

// ── API Response Validation ──────────────────────────────────

/**
 * Assert that a Feishu API response is OK.
 * Throws if not successful.
 */
export function assertLarkOk(response: Record<string, unknown>): void {
  const code = response.code;
  if (code !== 0) {
    const msg = response.msg || 'Unknown error';
    throw new Error(`Lark API error (${code}): ${msg}`);
  }
}

/**
 * Check if a Feishu message send error is recoverable.
 *
 * Returns true for transient failures (5xx, rate limit, timeout)
 * where retrying may succeed.
 */
export function isRecoverableMessageSendError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();

  // HTTP status codes
  if (msg.includes('502') || msg.includes('503') || msg.includes('504')) return true;
  if (msg.includes('timeout') || msg.includes('timed out')) return true;
  if (msg.includes('rate limit') || msg.includes('too many requests')) return true;

  // Feishu-specific error codes
  if (msg.includes('19006')) return true; // Gateway timeout
  if (msg.includes('19029')) return true; // Rate limit
  if (msg.includes('19002')) return true; // Message already sent (idempotent)

  return false;
}

// ── Text Utilities ───────────────────────────────────────────

/**
 * Collect all text fragments from a complex Feishu content structure.
 */
export function collectTextFragments(content: unknown): string[] {
  const results: string[] = [];

  if (typeof content === 'string') {
    results.push(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      results.push(...collectTextFragments(item));
    }
  } else if (content && typeof content === 'object') {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === 'string') results.push(rec.text);
    if (typeof rec.content === 'string') results.push(rec.content);
    if (Array.isArray(rec.elements)) {
      for (const el of rec.elements) {
        results.push(...collectTextFragments(el));
      }
    }
  }

  return results;
}

/**
 * Collect all text as a single string.
 */
export function collectAllText(content: unknown): string {
  return collectTextFragments(content).filter(Boolean).join('\n');
}

// ── Truncation ───────────────────────────────────────────────

/**
 * Truncate text to a maximum length, adding ellipsis if needed.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

/**
 * Normalize a line of text (collapse whitespace, trim).
 */
export function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a path string.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/');
}
