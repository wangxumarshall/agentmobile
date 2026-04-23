/**
 * Activity card builders for Feishu.
 *
 * Build interactive card JSON structures for:
 * - Tool activity cards (show tool calls and results)
 * - File change cards (show edits to files)
 * - Command execution cards (show running commands)
 * - Progress indicators
 */

import { CARD_TEMPLATES } from '../constants.js';
import { truncateText } from '../utils.js';

type CardTemplate = keyof typeof CARD_TEMPLATES;

const INPUT_PREVIEW_CHARS = 220;
const RESULT_PREVIEW_CHARS = 220;

/**
 * Build a tool activity card.
 *
 * Shows a tool call in progress or completed, with input/output previews.
 */
export function buildToolActivityCard(
  toolName: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  options: {
    inputPreview?: string;
    resultPreview?: string;
    elapsedSeconds?: number;
  } = {},
): Record<string, unknown> {
  const iconMap = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  const templateMap: Record<string, CardTemplate> = {
    pending: 'wathet',
    running: 'turquoise',
    completed: 'green',
    failed: 'red',
  };

  let content = `**Tool:** ${toolName}\n`;
  content += `**Status:** ${iconMap[status]} ${status}\n`;

  if (options.inputPreview) {
    const preview = truncateText(options.inputPreview, INPUT_PREVIEW_CHARS);
    content += `\n**Input:**\n\`\`\`\n${preview}\n\`\`\`\n`;
  }

  if (options.resultPreview) {
    const preview = truncateText(options.resultPreview, RESULT_PREVIEW_CHARS);
    content += `\n**Result:**\n\`\`\`\n${preview}\n\`\`\`\n`;
  }

  if (typeof options.elapsedSeconds === 'number') {
    const elapsed = options.elapsedSeconds < 60
      ? `${options.elapsedSeconds}s`
      : `${Math.floor(options.elapsedSeconds / 60)}m ${Math.round(options.elapsedSeconds % 60)}s`;
    content += `\n**Time:** ${elapsed}`;
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[status],
      title: {
        tag: 'plain_text',
        content: `${iconMap[status]} ${toolName}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

/**
 * Build a command execution card.
 */
export function buildCommandExecutionCard(
  command: string,
  status: 'running' | 'completed' | 'failed',
  options: {
    cwd?: string;
    output?: string;
    exitCode?: number | null;
    durationMs?: number | null;
  } = {},
): Record<string, unknown> {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  const templateMap: Record<string, CardTemplate> = {
    running: 'turquoise',
    completed: 'green',
    failed: 'red',
  };

  let content = `**Command:**\n\`\`\`\n${truncateText(command, 500)}\n\`\`\`\n`;

  if (options.cwd) {
    content += `**Working Directory:** \`${options.cwd}\`\n`;
  }

  if (options.output) {
    content += `\n**Output:**\n\`\`\`\n${truncateText(options.output, RESULT_PREVIEW_CHARS)}\n\`\`\`\n`;
  }

  if (typeof options.exitCode === 'number') {
    content += `**Exit Code:** ${options.exitCode}\n`;
  }

  if (typeof options.durationMs === 'number' && options.durationMs > 0) {
    const seconds = options.durationMs / 1000;
    const elapsed = seconds < 60
      ? `${seconds.toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    content += `**Time:** ${elapsed}\n`;
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[status],
      title: {
        tag: 'plain_text',
        content: `${iconMap[status]} Command ${status}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

/**
 * Build a file change card.
 */
export function buildFileChangeCard(
  changes: Array<{ kind: string; path: string }>,
  status: 'running' | 'completed' | 'failed',
  options: {
    summary?: string;
  } = {},
): Record<string, unknown> {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  const templateMap: Record<string, CardTemplate> = {
    running: 'turquoise',
    completed: 'green',
    failed: 'red',
  };

  let content = '**File Changes:**\n\n';

  for (const change of changes) {
    const icon = {
      create: '🆕',
      update: '✏️',
      delete: '🗑️',
      rename: '📝',
    }[change.kind.toLowerCase()] || '📄';

    content += `${icon} \`${change.kind}\`: \`${truncateText(change.path, 80)}\`\n`;
  }

  if (options.summary) {
    content += `\n${options.summary}`;
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[status],
      title: {
        tag: 'plain_text',
        content: `${iconMap[status]} File Changes`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

/**
 * Build a lightweight activity card for progress/reasoning updates.
 */
export function buildLightweightActivityCard(
  text: string,
  status: 'running' | 'completed' | 'failed',
  source?: string,
): Record<string, unknown> {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  const templateMap: Record<string, CardTemplate> = {
    running: 'wathet',
    completed: 'green',
    failed: 'red',
  };

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[status],
      title: {
        tag: 'plain_text',
        content: `${iconMap[status]} Activity`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `${source ? `**${source}**\n\n` : ''}${truncateText(text, 500)}`,
      },
    ],
  };
}
