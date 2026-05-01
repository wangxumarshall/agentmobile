/**
 * Permission and action card builders for Telegram.
 */

import type { TelegramCard } from './types.js';
import { codeBlock, escapeHtml } from './utils.js';

export function buildSimpleCard(
  title: string,
  content: string,
): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(content)}`,
  };
}

export function buildStatusCard(
  status: 'info' | 'success' | 'warning' | 'error',
  title: string,
  content: string,
): TelegramCard {
  const iconMap = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
  };

  return {
    parseMode: 'HTML',
    text: `<b>${iconMap[status]} ${escapeHtml(title)}</b>\n\n${escapeHtml(content)}`,
  };
}

export function buildActionCard(
  title: string,
  content: string,
  buttons: Array<{ text: string; callbackData: string }>,
): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(content)}`,
    inlineButtons: [buttons.map(btn => ({
      text: btn.text,
      callbackData: btn.callbackData,
    }))],
  };
}

export function buildPermissionCard(
  toolName: string,
  toolInput: string,
  permissionId: string,
): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>🔐 Permission Required</b>\n\n<b>Tool:</b> ${escapeHtml(toolName)}\n\n${codeBlock(toolInput)}\n\nPlease approve or deny this action.`,
    inlineButtons: [
      [
        { text: 'Allow once', callbackData: `perm:${permissionId}:allow` },
        { text: 'Allow session', callbackData: `perm:${permissionId}:allow_session` },
      ],
      [
        { text: 'Deny', callbackData: `perm:${permissionId}:deny` },
      ],
    ],
  };
}

export function buildHandledPermissionCard(
  toolName: string,
  resolution: 'allow' | 'allow_session' | 'deny',
): TelegramCard {
  const statusMap = {
    allow: { status: 'success' as const, label: '✅ Allowed' },
    allow_session: { status: 'success' as const, label: '✅ Allowed for session' },
    deny: { status: 'error' as const, label: '❌ Denied' },
  };
  const config = statusMap[resolution];

  return buildStatusCard(
    config.status,
    'Permission Resolved',
    `Tool: ${toolName}\n\n${config.label}`,
  );
}
