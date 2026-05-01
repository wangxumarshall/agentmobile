/**
 * Activity card builders for Telegram.
 */

import type { TelegramCard } from './types.js';
import { codeBlock, escapeHtml, inlineCode, truncateText } from './utils.js';

const INPUT_PREVIEW_CHARS = 220;
const RESULT_PREVIEW_CHARS = 220;

export function buildToolActivityCard(
  toolName: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  options: {
    inputPreview?: string;
    resultPreview?: string;
    elapsedSeconds?: number;
  } = {},
): TelegramCard {
  const iconMap = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  let text = `<b>${iconMap[status]} ${escapeHtml(toolName)}</b>\n\n<b>Tool:</b> ${escapeHtml(toolName)}\n<b>Status:</b> ${iconMap[status]} ${escapeHtml(status)}\n`;

  if (options.inputPreview) {
    text += `\n<b>Input:</b>\n${codeBlock(options.inputPreview, INPUT_PREVIEW_CHARS)}\n`;
  }
  if (options.resultPreview) {
    text += `\n<b>Result:</b>\n${codeBlock(options.resultPreview, RESULT_PREVIEW_CHARS)}\n`;
  }
  if (typeof options.elapsedSeconds === 'number') {
    const elapsed = options.elapsedSeconds < 60
      ? `${options.elapsedSeconds}s`
      : `${Math.floor(options.elapsedSeconds / 60)}m ${Math.round(options.elapsedSeconds % 60)}s`;
    text += `\n<b>Time:</b> ${escapeHtml(elapsed)}`;
  }

  return { parseMode: 'HTML', text };
}

export function buildCommandExecutionCard(
  command: string,
  status: 'running' | 'completed' | 'failed',
  options: {
    cwd?: string;
    output?: string;
    exitCode?: number | null;
    durationMs?: number | null;
  } = {},
): TelegramCard {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  let text = `<b>${iconMap[status]} Command ${escapeHtml(status)}</b>\n\n<b>Command:</b>\n${codeBlock(command, 500)}\n`;
  if (options.cwd) {
    text += `<b>Working Directory:</b> ${inlineCode(options.cwd)}\n`;
  }
  if (options.output) {
    text += `\n<b>Output:</b>\n${codeBlock(options.output, RESULT_PREVIEW_CHARS)}\n`;
  }
  if (typeof options.exitCode === 'number') {
    text += `<b>Exit Code:</b> ${options.exitCode}\n`;
  }
  if (typeof options.durationMs === 'number' && options.durationMs > 0) {
    const seconds = options.durationMs / 1000;
    const elapsed = seconds < 60
      ? `${seconds.toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    text += `<b>Time:</b> ${escapeHtml(elapsed)}\n`;
  }

  return { parseMode: 'HTML', text };
}

export function buildFileChangeCard(
  changes: Array<{ kind: string; path: string }>,
  status: 'running' | 'completed' | 'failed',
  options: { summary?: string } = {},
): TelegramCard {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  let text = `<b>${iconMap[status]} File Changes</b>\n\n`;
  for (const change of changes) {
    const icon = {
      create: '🆕',
      update: '✏️',
      delete: '🗑️',
      rename: '📝',
    }[change.kind.toLowerCase()] || '📄';
    text += `${icon} ${inlineCode(change.kind)}: ${inlineCode(truncateText(change.path, 80))}\n`;
  }
  if (options.summary) {
    text += `\n${escapeHtml(options.summary)}`;
  }

  return { parseMode: 'HTML', text };
}

export function buildLightweightActivityCard(
  text: string,
  status: 'running' | 'completed' | 'failed',
  source?: string,
): TelegramCard {
  const iconMap = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
  };

  return {
    parseMode: 'HTML',
    text: `<b>${iconMap[status]} Activity</b>\n\n${source ? `<b>${escapeHtml(source)}</b>\n\n` : ''}${escapeHtml(truncateText(text, 500))}`,
  };
}
