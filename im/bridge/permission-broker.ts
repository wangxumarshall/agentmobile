/**
 * Permission broker — forwards AI agent tool approval requests to IM.
 * Manages async permission resolution via interactive buttons.
 */

import type { ChannelAddress, InlineButton, OutboundMessage, PermissionRequest, SendResult } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { buildPermissionCard } from '../telegram/cards/index.js';
import { info } from '../config/logger.js';

interface PendingPermission {
  request: PermissionRequest;
  address: ChannelAddress;
  messageId?: string;
  resolve: (resolution: 'allow' | 'deny' | 'allow_session') => void;
  createdAt: number;
  resolved: boolean;
  timeoutTimer: ReturnType<typeof setTimeout>;
}

export interface PermissionCallbackResult {
  handled: boolean;
  request?: PermissionRequest;
  resolution?: 'allow' | 'deny' | 'allow_session';
}

export class PermissionBroker {
  private pending: Map<string, PendingPermission> = new Map();

  /**
   * Request permission from user via IM.
   * Blocks until permission is resolved.
   */
  async requestPermission(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
    request: PermissionRequest,
  ): Promise<'allow' | 'deny' | 'allow_session'> {
    const buttons: InlineButton[][] = [
      [
        { text: 'Allow once', callbackData: `perm:${request.id}:allow` },
        { text: 'Allow session', callbackData: `perm:${request.id}:allow_session` },
      ],
      [
        { text: 'Deny', callbackData: `perm:${request.id}:deny` },
      ],
    ];

    const message: OutboundMessage = address.channelType === 'telegram'
      ? {
          address,
          ...buildPermissionCard(
            request.toolName,
            JSON.stringify(request.toolInput, null, 2) || request.prompt,
            request.id,
          ),
        }
      : {
          address,
          text: `🔐 *Permission Required*\n\n**Tool:** ${request.toolName}\n\n${request.prompt}`,
          parseMode: 'Markdown',
          inlineButtons: buttons,
        };

    const result = await deliver(adapter, message);
    if (!result.ok) {
      info('permission', `Failed to send permission request: ${result.error}`);
      return 'deny';
    }

    return new Promise((resolve) => {
      const timeoutTimer = setTimeout(() => {
        this.resolvePermission(request.id, 'deny');
      }, 5 * 60 * 1000);

      this.pending.set(request.id, {
        request,
        address,
        messageId: result.messageId,
        resolve,
        createdAt: Date.now(),
        resolved: false,
        timeoutTimer,
      });
    });
  }

  /**
   * Resolve a pending permission (internal, idempotent).
   */
  private resolvePermission(requestId: string, resolution: 'allow' | 'deny' | 'allow_session'): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.resolved) return;
    pending.resolved = true;
    clearTimeout(pending.timeoutTimer);
    pending.resolve(resolution);
    this.pending.delete(requestId);
  }

  /**
   * Handle a permission callback (button press).
   * Returns true if the callback was resolved.
   */
  handleCallback(callbackData: string): boolean {
    return this.handleCallbackWithResult(callbackData).handled;
  }

  /**
   * Handle a permission callback and return the resolved request metadata.
   */
  handleCallbackWithResult(callbackData: string): PermissionCallbackResult {
    if (!callbackData.startsWith('perm:')) return { handled: false };

    const parts = callbackData.split(':');
    if (parts.length !== 3) return { handled: false };

    const [, requestId, resolution] = parts;
    const pending = this.pending.get(requestId);

    if (!pending) {
      info('permission', `Callback for unknown permission: ${requestId}`);
      return { handled: false };
    }

    const resolvedAs = resolution as 'allow' | 'deny' | 'allow_session';
    const request = pending.request;
    this.resolvePermission(requestId, resolvedAs);
    return {
      handled: true,
      request,
      resolution: resolvedAs,
    };
  }

  /**
   * Check if a permission request is still pending.
   */
  isPending(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    return pending !== undefined && !pending.resolved;
  }

  /**
   * Clean up expired pending permissions.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending) {
      if (!pending.resolved && now - pending.createdAt > 10 * 60 * 1000) {
        this.resolvePermission(id, 'deny');
      }
    }
  }
}
