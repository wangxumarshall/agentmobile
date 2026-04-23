/**
 * Plan workflow handler for Feishu.
 *
 * Handles plan-related card actions and messages:
 * - Plan request
 * - Plan confirmation
 * - Plan execution
 * - Plan exit workflow
 *
 * Note: This is a stub implementation. Full plan workflow requires
 * additional infrastructure (native session history, plan state management).
 */

import type { AdapterContext, FeishuCardActionEvent } from '../types.js';
import type { ChannelAddress } from '../../bridge/types.js';
import { info, error, debug } from '../../config/logger.js';

/**
 * Handle plan command request.
 */
export async function handlePlanCommand(
  ctx: AdapterContext,
  address: ChannelAddress,
  text: string,
): Promise<void> {
  debug('plan', `Plan command received: ${text.slice(0, 50)}`);
  await ctx.sendText(address, '📋 Plan mode: Create a plan for your task.\n\n_(Full plan workflow coming soon)_\n\nFor now, send your task description directly.');
}

/**
 * Handle plan workflow message.
 */
export async function handlePlanWorkflowMessage(
  ctx: AdapterContext,
  address: ChannelAddress,
  text: string,
): Promise<void> {
  debug('plan', `Plan workflow message: ${text.slice(0, 50)}`);
  // Pass through to normal processing for now
}

/**
 * Handle plan card action.
 */
export async function handlePlanCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  debug('plan', `Plan card action: ${callbackData}`);
  // Stub — acknowledge the action
}

/**
 * Handle Claude plan exit card action.
 */
export async function handleClaudePlanExitCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  debug('plan-exit', `Plan exit card action: ${callbackData}`);
  // Stub — acknowledge the action
}
