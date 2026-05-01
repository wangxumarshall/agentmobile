/**
 * Streaming preview service for Telegram.
 *
 * Mirrors Feishu preview behavior using Telegram message edits.
 */

import type { ChannelAddress, SendResult } from '../../bridge/types.js';
import type { TelegramCardClient } from './card-client.js';
import {
  buildFinalCard,
  buildStreamingCardSkeleton,
  buildStreamingPreviewCard,
} from '../cards/streaming-cards.js';
import { debug, error } from '../../config/logger.js';

const THROTTLE_INTERVAL_MS = 700;
const THROTTLE_DELTA_CHARS = 20;
const DEGRADE_AFTER_FAILURES = 3;

interface PreviewArtifact {
  address: ChannelAddress;
  draftId: number;
  messageId: string;
  lastSentText: string;
  lastSentAt: number;
  degraded: boolean;
  failureCount: number;
}

export class TelegramPreviewService {
  private client: TelegramCardClient;
  private previewArtifacts: Map<string, PreviewArtifact> = new Map();
  private activePreviewByRoute: Map<string, string> = new Map();

  constructor(client: TelegramCardClient) {
    this.client = client;
  }

  async primePreview(
    address: ChannelAddress,
    draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'> {
    const routeKey = this.buildRouteKey(address, draftId);
    if (this.previewArtifacts.has(routeKey)) {
      return 'skip';
    }

    try {
      const result = await this.client.sendCard(address, buildStreamingCardSkeleton());
      if (!result.ok || !result.messageId) {
        return 'degrade';
      }

      this.previewArtifacts.set(routeKey, {
        address,
        draftId,
        messageId: result.messageId,
        lastSentText: '',
        lastSentAt: Date.now(),
        degraded: false,
        failureCount: 0,
      });
      this.activePreviewByRoute.set(this.buildRouteKey(address), routeKey);
      return 'sent';
    } catch (e) {
      error('telegram-preview', `Failed to prime preview: ${e}`);
      return 'degrade';
    }
  }

  async sendPreview(
    address: ChannelAddress,
    text: string,
    draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'> {
    const routeKey = this.buildRouteKey(address, draftId);
    const artifact = this.previewArtifacts.get(routeKey);
    if (!artifact) {
      return this.primePreview(address, draftId);
    }
    if (artifact.degraded) {
      return 'degrade';
    }

    const now = Date.now();
    const timeSinceLast = now - artifact.lastSentAt;
    const textDelta = text.length - artifact.lastSentText.length;
    if (timeSinceLast < THROTTLE_INTERVAL_MS && textDelta < THROTTLE_DELTA_CHARS) {
      return 'skip';
    }

    try {
      const result = await this.client.patchCard(
        artifact.address,
        artifact.messageId,
        buildStreamingPreviewCard(text),
      );
      if (!result.ok) {
        throw new Error(result.error || 'Preview edit failed');
      }

      artifact.lastSentText = text;
      artifact.lastSentAt = Date.now();
      artifact.failureCount = 0;
      return 'sent';
    } catch (e) {
      artifact.failureCount += 1;
      debug('telegram-preview', `Preview edit failed: ${e}`);
      if (artifact.failureCount >= DEGRADE_AFTER_FAILURES) {
        artifact.degraded = true;
      }
      return 'degrade';
    }
  }

  async finalizePreview(
    address: ChannelAddress,
    finalText: string,
  ): Promise<SendResult> {
    const activeRouteKey = this.activePreviewByRoute.get(this.buildRouteKey(address));
    if (!activeRouteKey) {
      return { ok: false, error: 'No active preview to finalize' };
    }

    const artifact = this.previewArtifacts.get(activeRouteKey);
    if (!artifact) {
      return { ok: false, error: 'Preview artifact not found' };
    }

    return this.client.patchCard(
      artifact.address,
      artifact.messageId,
      buildFinalCard(finalText),
    );
  }

  endPreview(address: ChannelAddress, draftId: number): void {
    const routeKey = this.buildRouteKey(address, draftId);
    const artifact = this.previewArtifacts.get(routeKey);
    if (!artifact) return;

    if (!artifact.lastSentText.trim()) {
      void this.client.deleteCard?.(artifact.address, artifact.messageId)
        .catch(e => debug('telegram-preview', `Delete blank preview failed: ${e}`));
    }

    this.previewArtifacts.delete(routeKey);
    const activeRouteKey = this.buildRouteKey(address);
    if (this.activePreviewByRoute.get(activeRouteKey) === routeKey) {
      this.activePreviewByRoute.delete(activeRouteKey);
    }
  }

  private buildRouteKey(address: ChannelAddress, draftId?: number): string {
    return `${address.channelType}:${address.channelInstanceId || 'default'}:${address.chatId}:${draftId || ''}`;
  }
}
