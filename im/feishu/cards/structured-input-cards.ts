/**
 * Structured input card builders for Feishu.
 *
 * Build interactive card JSON structures for:
 * - Form input requests (questions with options)
 * - Text input requests
 * - Multi-select questions
 */

/**
 * Build a structured input request card.
 *
 * When the AI agent needs user input (e.g., clarifying questions),
 * this card presents the questions with interactive options.
 */
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
): Record<string, unknown> {
  let content = '**The agent needs some information:**\n\n';

  const actions = [];

  for (const q of questions) {
    content += `### ${q.header}\n${q.question}\n\n`;

    if (q.options && q.options.length > 0) {
      for (const opt of q.options) {
        let optText = opt.label;
        if (opt.description) {
          optText += ` (${opt.description})`;
        }
        content += `• ${optText}\n`;
      }
      content += '\n';

      // Add buttons for each option
      if (q.multiSelect) {
        content += '_(Multi-select: tap multiple options)_\n\n';
      } else {
        content += '_(Tap an option to select)_\n\n';
      }

      actions.push({
        tag: 'action',
        actions: q.options.map((opt, i) => ({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: `${i + 1}. ${opt.label}`,
          },
          type: 'primary',
          value: {
            callback: `input:${requestId}:${q.id}:${i}`,
          },
        })),
        layout: q.options.length > 3 ? 'vertical' : 'horizontal',
      });
    }
  }

  // Add custom text input option
  actions.push({
    tag: 'input',
    element_id: `text_input:${requestId}`,
    placeholder: {
      tag: 'plain_text',
      content: 'Or type a custom response...',
    },
  });

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'purple',
      title: {
        tag: 'plain_text',
        content: '📝 Input Request',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      ...actions,
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: 'Tap a button to respond, or type a custom answer.',
          },
        ],
      },
    ],
  };
}

/**
 * Build a single-question card with options.
 */
export function buildSingleQuestionCard(
  requestId: string,
  questionId: string,
  header: string,
  question: string,
  options: Array<{ label: string; description?: string }>,
): Record<string, unknown> {
  let content = `### ${header}\n${question}\n\n`;

  for (const opt of options) {
    content += `• ${opt.label}${opt.description ? ` — ${opt.description}` : ''}\n`;
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '❓ Question',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'action',
        actions: options.map((opt, i) => ({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: opt.label.slice(0, 20),
          },
          type: 'primary',
          value: {
            callback: `input:${requestId}:${questionId}:${i}`,
          },
        })),
        layout: 'horizontal',
      },
    ],
  };
}
