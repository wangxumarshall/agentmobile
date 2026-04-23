/**
 * Card action handler for Feishu.
 *
 * Dispatches interactive card button/callback events to the appropriate
 * handler based on callbackData prefix:
 * - `perm:*` -> Permission broker
 * - `new-session:*` -> New session creation
 * - `claude-mode:*` -> Claude mode switching
 * - `resume:*` -> Session resume
 * - `input:*` -> Structured input response
 * - `plan:*` -> Plan workflow
 * - `planexit:*` -> Plan exit workflow
 */

import type { AdapterContext, FeishuCardActionEvent } from '../types.js';
import type { SendResult } from '../../bridge/types.js';
import { buildHandledPermissionCard } from '../cards/permission-cards.js';
import { info, error, debug } from '../../config/logger.js';

/**
 * Handle a card action/callback event.
 *
 * Returns true if the callback was processed.
 */
export async function handleCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
): Promise<boolean> {
  const callbackData = event.action?.value?.callback as string | undefined;
  if (!callbackData) {
    debug('card-action', 'No callback data in card action event');
    return false;
  }

  debug('card-action', `Card action: ${callbackData}`);

  try {
    // Route based on callback prefix
    if (callbackData.startsWith('perm:')) {
      return await handlePermissionCallback(ctx, event, callbackData);
    }
    if (callbackData.startsWith('new-session:')) {
      await ctx.handleNewSessionCardAction(event, callbackData);
      return true;
    }
    if (callbackData.startsWith('claude-mode:')) {
      await ctx.handleClaudeModeCardAction(event, callbackData);
      return true;
    }
    if (callbackData.startsWith('resume:')) {
      await ctx.handleResumeCardAction(event, callbackData);
      return true;
    }
    if (callbackData.startsWith('input:')) {
      await ctx.handleStructuredInputCardAction(event, callbackData);
      return true;
    }
    if (callbackData.startsWith('plan:')) {
      await ctx.handlePlanCardAction(event, callbackData);
      return true;
    }
    if (callbackData.startsWith('planexit:')) {
      await ctx.handleClaudePlanExitCardAction(event, callbackData);
      return true;
    }

    debug('card-action', `Unhandled callback: ${callbackData}`);
    return false;
  } catch (e) {
    error('card-action', `Handler failed for ${callbackData}: ${e}`);

    // Try to patch the action card with an error
    try {
      await patchActionCardSafely(ctx, event.open_message_id, {
        header: {
          template: 'red',
          title: {
            tag: 'plain_text',
            content: '❌ Action Failed',
          },
        },
      }, 'error', event.open_message_id);
    } catch {
      // Ignore patch failure
    }

    return false;
  }
}

/**
 * Handle a permission callback.
 */
async function handlePermissionCallback(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<boolean> {
  // Check if permission broker can resolve this
  const resolved = ctx.permissionBroker.handleCallback(callbackData);

  // Update the card to show resolution
  const parts = callbackData.split(':');
  if (parts.length >= 3) {
    const resolution = parts[2] as 'allow' | 'allow_session' | 'deny';
    const statusMap = {
      allow: '✅ Allowed',
      allow_session: '✅ Allowed for session',
      deny: '❌ Denied',
    };

    try {
      await patchActionCardSafely(ctx, event.open_message_id, {
        header: {
          template: resolution === 'deny' ? 'red' : 'green',
          title: {
            tag: 'plain_text',
            content: statusMap[resolution] || 'Resolved',
          },
        },
      }, 'permission');
    } catch {
      // Ignore patch failure
    }
  }

  return resolved;
}

/**
 * Patch an action card safely, trying open_message_id then message_id.
 */
export async function patchActionCardSafely(
  ctx: AdapterContext,
  messageId: string,
  card: Record<string, unknown>,
  kind: string,
  openMessageId?: string,
): Promise<SendResult> {
  // Try with open_message_id first
  try {
    return await ctx.patchCard(messageId, card, {
      openMessageId: openMessageId || messageId,
    });
  } catch (e) {
    debug('card-action', `Patch with open_message_id failed, trying message_id: ${e}`);
    try {
      return await ctx.patchCard(messageId, card);
    } catch (e2) {
      error('card-action', `All patch attempts failed for ${kind}: ${e2}`);
      return { ok: false, error: String(e2) };
    }
  }
}
