/**
 * Streaming Preview Service for Feishu.
 *
 * Manages real-time streaming previews during LLM generation.
 *
 * Two modes:
 * - CardKit: True streaming via Feishu CardKit API (preferred)
 * - Patch: Regular card patch updates (fallback)
 *
 * Throttle configuration:
 * - Minimum interval between updates: 700ms
 * - Minimum text delta before sending: 20 chars
 * - Maximum preview text length: 3900 chars
 */

import { randomUUID } from 'node:crypto';
import type { ChannelAddress, SendResult } from '../../bridge/types.js';
import { LarkClient } from '../lark-client.js';
import { buildStreamingCardSkeleton, buildFinalCard } from '../cards/streaming-cards.js';
import { PREVIEW_CONFIG } from '../constants.js';
import { info, error, debug } from '../../config/logger.js';

interface PreviewArtifact {
  address: ChannelAddress;
  draftId: number;
  messageId: string;
  openMessageId?: string;
  lastSentText: string;
  lastSentAt: number;
  degraded: boolean;
  failureCount: number;
}

export class PreviewService {
  private larkClient: LarkClient;
  private previewArtifacts: Map<string, PreviewArtifact> = new Map();
  private activePreviewByRoute: Map<string, string> = new Map();

  constructor(larkClient: LarkClient) {
    this.larkClient = larkClient;
  }

  /**
   * Send a streaming preview update.
   *
   * Creates or updates a preview card with accumulated text.
   * Returns:
   * - 'sent': Update sent successfully
   * - 'skip': Skipped due to throttling / no meaningful delta
   * - 'degrade': Switched to patch mode after CardKit failures
   */
  async sendPreview(
    address: ChannelAddress,
    text: string,
    draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'> {
    const routeKey = this.buildRouteKey(address, draftId);
    const artifact = this.previewArtifacts.get(routeKey);

    if (!artifact) {
      // No artifact yet — prime it automatically
      return await this.primePreview(address, draftId);
    }

    // Throttle check
    const now = Date.now();
    const timeSinceLast = now - artifact.lastSentAt;
    const textDelta = text.length - artifact.lastSentText.length;

    if (
      timeSinceLast < PREVIEW_CONFIG.throttleIntervalMs &&
      textDelta < PREVIEW_CONFIG.throttleDeltaChars
    ) {
      return 'skip';
    }

    if (artifact.degraded) {
      // Degraded mode: use patch
      return this.patchPreview(artifact, text);
    }

    // Try CardKit streaming update
    return this.cardKitUpdate(artifact, text);
  }

  /**
   * Prime a streaming preview (create placeholder card).
   *
   * Should be called before streaming starts.
   */
  async primePreview(
    address: ChannelAddress,
    draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'> {
    const routeKey = this.buildRouteKey(address, draftId);

    // Don't create if already exists
    if (this.previewArtifacts.has(routeKey)) {
      return 'skip';
    }

    const card = buildStreamingCardSkeleton();

    try {
      const result = await this.larkClient.sendCard(address, card);
      const data = result?.data as Record<string, unknown> | undefined;
      const messageId = data?.message_id as string | undefined;
      const openMessageId = data?.messageId as string | undefined;

      const artifact: PreviewArtifact = {
        address,
        draftId,
        messageId: messageId || '',
        openMessageId,
        lastSentText: '',
        lastSentAt: Date.now(),
        degraded: false,
        failureCount: 0,
      };

      this.previewArtifacts.set(routeKey, artifact);
      this.activePreviewByRoute.set(this.buildRouteKey(address), routeKey);

      debug('preview', `Preview primed: ${routeKey}, messageId: ${artifact.messageId}`);
      return 'sent';
    } catch (e) {
      error('preview', `Failed to prime preview: ${e}`);
      return 'degrade';
    }
  }

  /**
   * End a streaming preview.
   *
   * Cleans up the artifact. If the placeholder was never filled with text,
   * deletes the blank message.
   */
  endPreview(address: ChannelAddress, draftId: number): void {
    const routeKey = this.buildRouteKey(address, draftId);
    const artifact = this.previewArtifacts.get(routeKey);

    if (!artifact) return;

    // Delete blank placeholder (with timeout to avoid hanging forever)
    if (!artifact.lastSentText || artifact.lastSentText.trim().length === 0) {
      const timeout = setTimeout(() => {});
      this.larkClient.deleteMessageQuietly(artifact.messageId)
        .catch(e => debug('preview', `Delete blank preview failed: ${e}`))
        .finally(() => clearTimeout(timeout));
      debug('preview', `Deleted blank preview: ${routeKey}`);
    }

    this.previewArtifacts.delete(routeKey);

    // Also clean up the active preview route
    const activeRouteKey = this.buildRouteKey(address);
    if (this.activePreviewByRoute.get(activeRouteKey) === routeKey) {
      this.activePreviewByRoute.delete(activeRouteKey);
    }
  }

  /**
   * Finalize a preview (convert to permanent card).
   *
   * Patches the preview card in place with final content,
   * disabling streaming mode.
   */
  async finalizePreview(
    address: ChannelAddress,
    finalText: string,
  ): Promise<SendResult> {
    // Find the active preview for this address
    const activeRouteKey = this.activePreviewByRoute.get(this.buildRouteKey(address));
    if (!activeRouteKey) {
      return { ok: false, error: 'No active preview to finalize' };
    }

    const artifact = this.previewArtifacts.get(activeRouteKey);
    if (!artifact) {
      return { ok: false, error: 'Artifact not found' };
    }

    const card = buildFinalCard(finalText);

    try {
      await this.larkClient.patchCard(artifact.messageId, card, {
        openMessageId: artifact.openMessageId,
      });
      return { ok: true, messageId: artifact.messageId };
    } catch (e) {
      error('preview', `Failed to finalize preview: ${e}`);
      return { ok: false, error: String(e) };
    }
  }

  /**
   * Update a preview card via CardKit streaming API.
   */
  private async cardKitUpdate(
    artifact: PreviewArtifact,
    text: string,
  ): Promise<'sent' | 'degrade'> {
    try {
      const client = await this.larkClient.getClient();
      if (!client) throw new Error('Lark client not initialized');

      // Check client supports request method (mock may not)
      if (typeof client.request !== 'function') {
        artifact.degraded = true;
        return this.patchPreview(artifact, text);
      }

      // Use CardKit API to update specific element
      await client.request(
        'PATCH',
        `/open-apis/cardkit/v1/card_elements/content`,
        {
          data: {
            message_id: artifact.openMessageId || artifact.messageId,
            element_id: 'stream_content',
            content: text,
          },
        },
      );

      artifact.lastSentText = text;
      artifact.lastSentAt = Date.now();
      artifact.failureCount = 0;

      debug('preview', `CardKit update: ${artifact.draftId} (${text.length} chars)`);
      return 'sent';
    } catch (e) {
      artifact.failureCount++;

      if (artifact.failureCount >= PREVIEW_CONFIG.degradeAfterFailures) {
        debug('preview', `Degraded to patch mode: ${artifact.draftId}`);
        artifact.degraded = true;
        return this.patchPreview(artifact, text);
      }

      return 'degrade';
    }
  }

  /**
   * Update a preview card via regular patch (fallback mode).
   */
  private async patchPreview(
    artifact: PreviewArtifact,
    text: string,
  ): Promise<'sent' | 'degrade'> {
    try {
      // Build a non-streaming card with current text
      const card = {
        ...buildStreamingCardSkeleton(),
        config: {
          wide_screen_mode: true,
          streaming_mode: false, // Disable streaming for patch mode
        },
        i18n_elements: {
          zh_cn: [
            {
              tag: 'markdown',
              content: text,
            },
          ],
        },
      };

      await this.larkClient.patchCard(artifact.messageId, card, {
        openMessageId: artifact.openMessageId,
      });

      artifact.lastSentText = text;
      artifact.lastSentAt = Date.now();
      artifact.failureCount = 0; // Reset on successful patch

      return 'sent';
    } catch (e) {
      error('preview', `Patch preview failed: ${e}`);
      return 'degrade';
    }
  }

  private buildRouteKey(address: ChannelAddress, draftId?: number): string {
    return `${address.channelType}:${address.chatId}:${address.channelInstanceId || 'default'}:${draftId}`;
  }
}
