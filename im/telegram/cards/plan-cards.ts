/**
 * Plan workflow cards for Telegram.
 */

import type { PlanWorkflow } from '../../bridge/types.js';
import type { TelegramCard } from './types.js';
import { escapeHtml, truncateText } from './utils.js';

const PLAN_CARD_LIMIT = 3600;

export function buildPlanDraftingCard(workflow: PlanWorkflow): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Drafting Plan</b>\n\n${escapeHtml(truncateText(workflow.promptText, 1200))}`,
  };
}

export function buildPlanReadyCard(workflow: PlanWorkflow): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Plan Ready</b>\n\n${escapeHtml(truncateText(workflow.planText || '(empty plan)', PLAN_CARD_LIMIT))}`,
    inlineButtons: [
      [
        { text: 'Execute Plan', callbackData: `plan:exec:${workflow.id}` },
      ],
      [
        { text: 'Revise Plan', callbackData: `plan:revise:${workflow.id}` },
        { text: 'Cancel', callbackData: `plan:cancel:${workflow.id}` },
      ],
    ],
  };
}

export function buildPlanRevisionRequestedCard(workflow: PlanWorkflow): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Revise Plan</b>\n\nSend the changes you want. The next message will update this plan.\n\n<b>Current Plan</b>\n${escapeHtml(truncateText(workflow.planText || '(empty plan)', 2400))}`,
    inlineButtons: [
      [{ text: 'Cancel', callbackData: `plan:cancel:${workflow.id}` }],
    ],
  };
}

export function buildPlanExecutingCard(workflow: PlanWorkflow): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Executing Plan</b>\n\n${escapeHtml(truncateText(workflow.promptText, 1200))}`,
  };
}

export function buildPlanCompletedCard(workflow: PlanWorkflow, resultText: string): TelegramCard {
  return {
    parseMode: 'plain',
    text: `Plan Complete\n\n${truncateText(resultText || workflow.planText || 'Execution completed.', 3900)}`,
  };
}

export function buildPlanCancelledCard(workflow: PlanWorkflow): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Plan Cancelled</b>\n\nNo code was executed. The session stays in plan mode.`,
    inlineButtons: [
      [
        { text: 'New Plan', callbackData: `mode:${workflow.bindingId}:plan` },
        { text: 'Command Center', callbackData: 'cmd:help' },
      ],
    ],
  };
}
