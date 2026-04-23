/**
 * Structured input handler for Feishu.
 *
 * Handles structured input form submissions from interactive cards.
 *
 * Note: This is a stub implementation. Full structured input requires
 * additional infrastructure (input form builders, response parsing).
 */

import type { AdapterContext, FeishuCardActionEvent } from '../types.js';
import type { ChannelAddress } from '../../bridge/types.js';
import { info, error, debug } from '../../config/logger.js';

/**
 * Handle a structured input card action.
 *
 * Parses input responses and resolves pending structured input requests.
 */
export async function handleStructuredInputCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  debug('structured-input', `Structured input action: ${callbackData}`);

  // Parse callback: input:requestId:questionId:optionIndex
  const parts = callbackData.split(':');
  if (parts.length >= 4) {
    const [, requestId, questionId, optionIndex] = parts;
    debug('structured-input', `Input for ${requestId}: ${questionId}[${optionIndex}]`);
  }

  // Acknowledge the action
  // Future: resolve pending structured input via pendingStructuredInputs.resolve()
}

/**
 * Handle structured input request.
 *
 * Sends a structured input card to the user.
 */
export async function handleStructuredInputRequest(
  ctx: AdapterContext,
  address: ChannelAddress,
  input: {
    requestId: string;
    questions: Array<{
      id: string;
      header: string;
      question: string;
      options?: Array<{ label: string; description?: string }>;
    }>;
  },
): Promise<void> {
  debug('structured-input', `Input request: ${input.requestId}`);

  await ctx.sendText(address, `📝 Input requested for ${input.questions.length} question(s).\n\n_(Full structured input cards coming soon)_\n\nFor now, please provide your answer as text.`);
}
