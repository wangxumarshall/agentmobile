/**
 * Structured input card builders for Telegram.
 */

import type { TelegramCard } from './types.js';
import type { InlineButton } from '../../bridge/types.js';
import { escapeHtml, truncateText } from './utils.js';

export function buildStructuredInputCard(
  requestId: string,
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description: string; preview?: string }>;
    multiSelect?: boolean;
    isSecret?: boolean;
  }>,
): TelegramCard {
  let text = '<b>📝 Input Request</b>\n\nThe agent needs some information:\n\n';
  const inlineButtons: InlineButton[][] = [];

  for (const question of questions) {
    text += `<b>${escapeHtml(question.header)}</b>\n${escapeHtml(question.question)}\n\n`;
    if (question.options && question.options.length > 0) {
      question.options.forEach((option, index) => {
        text += `• ${escapeHtml(option.label)}${option.description ? ` (${escapeHtml(option.description)})` : ''}\n`;
        inlineButtons.push([{
          text: `${index + 1}. ${truncateText(option.label, 40)}`,
          callbackData: `input:${requestId}:${question.id}:${index}`,
        }]);
      });
      text += question.multiSelect
        ? '\n<i>Multi-select: tap multiple options.</i>\n\n'
        : '\n<i>Tap an option to select.</i>\n\n';
    }
  }

  text += 'You can also type a custom answer as a normal message.';

  return {
    parseMode: 'HTML',
    text,
    inlineButtons,
  };
}

export function buildSingleQuestionCard(
  requestId: string,
  questionId: string,
  header: string,
  question: string,
  options: Array<{ label: string; description?: string }>,
): TelegramCard {
  return buildStructuredInputCard(requestId, [{
    id: questionId,
    header,
    question,
    options: options.map(option => ({
      label: option.label,
      description: option.description || '',
    })),
  }]);
}
