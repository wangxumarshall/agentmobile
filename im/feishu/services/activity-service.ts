/**
 * Activity Card Service for Feishu.
 *
 * Manages upsert of activity event cards for:
 * - Tool calls (in progress / completed / failed)
 * - File changes (create / update / delete)
 * - Command execution (running / done)
 * - Progress indicators
 *
 * Uses idempotent requestUuid for recovery on timeout.
 * Cards are updated in-place via patchCard.
 */

import { randomUUID } from 'node:crypto';
import type { ChannelAddress, ActivityEvent, SendResult } from '../../bridge/types.js';
import { LarkClient } from '../lark-client.js';
import {
  buildToolActivityCard,
  buildCommandExecutionCard,
  buildFileChangeCard,
  buildLightweightActivityCard,
} from '../cards/activity-cards.js';
import { ACTIVITY_CONFIG } from '../constants.js';
import { info, error, debug } from '../../config/logger.js';

interface ActivityArtifact {
  address: ChannelAddress;
  activityId: string;
  messageId: string;
  openMessageId?: string;
  lastEvent: ActivityEvent;
  updatedAt: number;
}

interface PendingActivitySend {
  activityId: string;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export class ActivityService {
  private larkClient: LarkClient;
  private activityArtifacts: Map<string, ActivityArtifact> = new Map();
  private pendingActivitySends: Map<string, PendingActivitySend> = new Map();
  private enabled: boolean;

  constructor(larkClient: LarkClient, enabled = false) {
    this.larkClient = larkClient;
    this.enabled = enabled;
  }

  /**
   * Enable or disable activity cards.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Upsert an activity event card.
   *
   * Creates a new card if one doesn't exist, or patches the existing card.
   * Uses idempotent requestUuid for recovery on 504/gateway timeouts.
   */
  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.enabled) {
      return { ok: true };
    }

    const routeKey = this.buildRouteKey(address, event);
    const existing = this.activityArtifacts.get(routeKey);

    if (existing) {
      // Patch existing card
      return this.patchActivityCard(existing, event);
    }

    // Create new card
    return this.createActivityCard(address, event, replyToMessageId);
  }

  /**
   * Check if an event should be projected to the user.
   *
   * Filters based on event type and configuration.
   */
  shouldProjectEvent(event: ActivityEvent): boolean {
    if (!this.enabled) return false;

    switch (event.type) {
      case 'tool_use':
        // Tool calls are shown if configured
        return true;
      case 'file_change':
        return true;
      case 'command':
        return true;
      case 'progress':
        // Progress events are shown only if not filtered
        return true;
      default:
        return false;
    }
  }

  /**
   * Create a new activity card and save the artifact.
   */
  private async createActivityCard(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const card = this.buildCardFromEvent(event);
    if (!card) {
      return { ok: true };
    }

    const requestUuid = randomUUID();

    try {
      const result = await this.larkClient.sendCard(address, card, replyToMessageId, requestUuid);
      const data = result?.data as Record<string, unknown> | undefined;
      const messageId = data?.message_id as string | undefined;
      const openMessageId = data?.messageId as string | undefined;

      if (!messageId) {
        return { ok: false, error: 'No message_id in sendCard response' };
      }

      const routeKey = this.buildRouteKey(address, event);
      const artifact: ActivityArtifact = {
        address,
        activityId: routeKey,
        messageId,
        openMessageId,
        lastEvent: event,
        updatedAt: Date.now(),
      };

      this.activityArtifacts.set(routeKey, artifact);

      // Set up recovery timeout for transient failures
      this.setupRecoveryTimer(routeKey, artifact, requestUuid);

      debug('activity', `Activity card created: ${routeKey}`);
      return { ok: true, messageId };
    } catch (e) {
      error('activity', `Failed to create activity card: ${e}`);
      return { ok: false, error: String(e) };
    }
  }

  /**
   * Patch an existing activity card with updated event data.
   */
  private async patchActivityCard(
    artifact: ActivityArtifact,
    event: ActivityEvent,
  ): Promise<SendResult> {
    const card = this.buildCardFromEvent(event);
    if (!card) {
      return { ok: true };
    }

    try {
      await this.larkClient.patchCard(artifact.messageId, card, {
        openMessageId: artifact.openMessageId,
      });

      artifact.lastEvent = event;
      artifact.updatedAt = Date.now();

      // Clear recovery timer since we successfully updated
      const routeKey = artifact.activityId;
      this.clearRecoveryTimer(routeKey);

      debug('activity', `Activity card updated: ${artifact.activityId}`);
      return { ok: true, messageId: artifact.messageId };
    } catch (e) {
      error('activity', `Failed to patch activity card: ${e}`);
      return { ok: false, error: String(e) };
    }
  }

  /**
   * Build a Feishu card from an ActivityEvent.
   */
  private buildCardFromEvent(event: ActivityEvent): Record<string, unknown> | null {
    switch (event.type) {
      case 'tool_use':
        return buildToolActivityCard(
          event.title,
          'running' as const,
          {
            inputPreview: event.description,
          },
        );
      case 'file_change':
        return buildFileChangeCard(
          (event.metadata?.changes as Array<{ kind: string; path: string }>) || [],
          'running' as const,
          { summary: event.description },
        );
      case 'command':
        return buildCommandExecutionCard(
          event.title,
          event.description === 'completed' ? 'completed' as const : event.description === 'failed' ? 'failed' as const : 'running' as const,
          { output: event.description },
        );
      case 'progress':
        return buildLightweightActivityCard(
          event.title + (event.description ? '\n\n' + event.description : ''),
          event.metadata?.status as 'running' | 'completed' | 'failed' || 'running',
          event.metadata?.source as string,
        );
      default:
        return null;
    }
  }

  /**
   * Build a route key from address and event.
   */
  private buildRouteKey(address: ChannelAddress, event: ActivityEvent): string {
    const activityId = event.metadata?.toolId ||
      event.metadata?.commandId ||
      event.title;
    return `${address.channelType}:${address.chatId}:${activityId}`;
  }

  /**
   * Set up a recovery timer for transient failures.
   *
   * If the card send times out (504), the timer triggers a retry.
   * The timer is cleared when the artifact is updated successfully.
   */
  private setupRecoveryTimer(
    routeKey: string,
    artifact: ActivityArtifact,
    requestUuid: string,
  ): void {
    const timeout = ACTIVITY_CONFIG.recoverableTimeoutMs;

    const timer = setTimeout(async () => {
      debug('activity', `Recovery timer triggered: ${routeKey}`);

      // Try to patch the card again with the last known event
      try {
        await this.patchActivityCard(artifact, artifact.lastEvent);
      } catch (e) {
        error('activity', `Recovery failed for ${routeKey}: ${e}`);
      }

      this.pendingActivitySends.delete(routeKey);
    }, timeout);

    this.pendingActivitySends.set(routeKey, {
      activityId: routeKey,
      timeoutTimer: timer,
    });
  }

  /**
   * Clear recovery timer for a route key (called on successful update).
   */
  private clearRecoveryTimer(routeKey: string): void {
    const pending = this.pendingActivitySends.get(routeKey);
    if (pending) {
      clearTimeout(pending.timeoutTimer);
      this.pendingActivitySends.delete(routeKey);
    }
  }

  /**
   * Clean up all recovery timers.
   */
  cleanup(): void {
    for (const [key, pending] of this.pendingActivitySends) {
      clearTimeout(pending.timeoutTimer);
      this.pendingActivitySends.delete(key);
    }
  }
}
