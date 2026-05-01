/**
 * Activity card service for Telegram.
 *
 * Uses one editable Telegram message per activity key, matching Feishu's
 * create-or-patch activity card behavior.
 */

import type { ActivityEvent, ChannelAddress, SendResult } from '../../bridge/types.js';
import type { TelegramCard } from '../cards/types.js';
import type { TelegramCardClient } from './card-client.js';
import {
  buildCommandExecutionCard,
  buildFileChangeCard,
  buildLightweightActivityCard,
  buildToolActivityCard,
} from '../cards/activity-cards.js';
import { debug, error } from '../../config/logger.js';

interface ActivityArtifact {
  address: ChannelAddress;
  activityId: string;
  messageId: string;
  lastEvent: ActivityEvent;
  updatedAt: number;
}

export class TelegramActivityService {
  private client: TelegramCardClient;
  private activityArtifacts: Map<string, ActivityArtifact> = new Map();
  private enabled: boolean;

  constructor(client: TelegramCardClient, enabled = false) {
    this.client = client;
    this.enabled = enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  shouldProjectEvent(event: ActivityEvent): boolean {
    if (!this.enabled) return false;
    return event.type === 'tool_use' ||
      event.type === 'file_change' ||
      event.type === 'command' ||
      event.type === 'progress';
  }

  async upsertActivityEvent(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.shouldProjectEvent(event)) {
      return { ok: true };
    }

    const routeKey = this.buildRouteKey(address, event);
    const existing = this.activityArtifacts.get(routeKey);
    if (existing) {
      return this.patchActivityCard(existing, event);
    }
    return this.createActivityCard(address, event, replyToMessageId);
  }

  cleanup(): void {
    this.activityArtifacts.clear();
  }

  private async createActivityCard(
    address: ChannelAddress,
    event: ActivityEvent,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    const card = this.buildCardFromEvent(event);
    if (!card) return { ok: true };

    try {
      const result = await this.client.sendCard(address, card, replyToMessageId);
      if (!result.ok || !result.messageId) {
        return { ok: false, error: result.error || 'No message_id in Telegram send response' };
      }

      const routeKey = this.buildRouteKey(address, event);
      this.activityArtifacts.set(routeKey, {
        address,
        activityId: routeKey,
        messageId: result.messageId,
        lastEvent: event,
        updatedAt: Date.now(),
      });
      debug('telegram-activity', `Activity card created: ${routeKey}`);
      return result;
    } catch (e) {
      error('telegram-activity', `Failed to create activity card: ${e}`);
      return { ok: false, error: String(e) };
    }
  }

  private async patchActivityCard(
    artifact: ActivityArtifact,
    event: ActivityEvent,
  ): Promise<SendResult> {
    const card = this.buildCardFromEvent(event);
    if (!card) return { ok: true };

    try {
      const result = await this.client.patchCard(
        artifact.address,
        artifact.messageId,
        card,
      );
      if (result.ok) {
        artifact.lastEvent = event;
        artifact.updatedAt = Date.now();
      }
      return result;
    } catch (e) {
      error('telegram-activity', `Failed to patch activity card: ${e}`);
      return { ok: false, error: String(e) };
    }
  }

  private buildCardFromEvent(event: ActivityEvent): TelegramCard | null {
    switch (event.type) {
      case 'tool_use':
        return buildToolActivityCard(
          event.title,
          'running',
          { inputPreview: event.description },
        );
      case 'file_change':
        return buildFileChangeCard(
          (event.metadata?.changes as Array<{ kind: string; path: string }>) || [],
          'running',
          { summary: event.description },
        );
      case 'command':
        return buildCommandExecutionCard(
          event.title,
          event.description === 'completed' ? 'completed' : event.description === 'failed' ? 'failed' : 'running',
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

  private buildRouteKey(address: ChannelAddress, event: ActivityEvent): string {
    const activityId = event.metadata?.toolId ||
      event.metadata?.commandId ||
      event.title;
    return `${address.channelType}:${address.channelInstanceId || 'default'}:${address.chatId}:${String(activityId)}`;
  }
}
