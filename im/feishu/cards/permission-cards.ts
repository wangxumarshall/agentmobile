/**
 * Permission and action card builders for Feishu.
 *
 * Build interactive card JSON structures for:
 * - Simple informational cards
 * - Status cards with colored headers
 * - Action cards with buttons
 * - Permission request/approval cards
 */

import { CARD_TEMPLATES } from '../constants.js';

type CardTemplate = keyof typeof CARD_TEMPLATES;

/**
 * Build a simple informational card.
 */
export function buildSimpleCard(
  title: string,
  content: string,
  template: CardTemplate = 'blue',
): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
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
 * Build a status card with colored header and content.
 */
export function buildStatusCard(
  status: 'info' | 'success' | 'warning' | 'error',
  title: string,
  content: string,
): Record<string, unknown> {
  const templateMap: Record<string, CardTemplate> = {
    info: 'blue',
    success: 'green',
    warning: 'orange',
    error: 'red',
  };

  const iconMap: Record<string, string> = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
  };

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[status],
      title: {
        tag: 'plain_text',
        content: `${iconMap[status]} ${title}`,
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
 * Build an action card with buttons.
 */
export function buildActionCard(
  title: string,
  content: string,
  buttons: Array<{ text: string; type: 'primary' | 'default' | 'danger'; callbackData: string }>,
  template: CardTemplate = 'blue',
): Record<string, unknown> {
  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'action',
        actions: buttons.map((btn, i) => ({
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: btn.text,
          },
          type: btn.type,
          value: {
            callback: btn.callbackData,
          },
        })),
        layout: 'horizontal',
      },
    ],
  };
}

/**
 * Build a permission approval card.
 *
 * When an AI agent needs user permission to use a tool,
 * this card presents the request with allow/deny buttons.
 */
export function buildPermissionCard(
  toolName: string,
  toolInput: string,
  permissionId: string,
  scope: 'turn' | 'session' = 'turn',
): Record<string, unknown> {
  const title = `🔐 Permission Required`;
  const content = `**Tool:** ${toolName}\n\n${toolInput}\n\nPlease approve or deny this action.`;

  const buttons = [
    {
      text: 'Allow once',
      type: 'primary' as const,
      callbackData: `perm:${permissionId}:allow`,
    },
    {
      text: 'Allow for session',
      type: 'primary' as const,
      callbackData: `perm:${permissionId}:allow_session`,
    },
    {
      text: 'Deny',
      type: 'danger' as const,
      callbackData: `perm:${permissionId}:deny`,
    },
  ];

  return buildActionCard(title, content, buttons, scope === 'session' ? 'green' : 'orange');
}

/**
 * Build a handled permission card (displays after resolution).
 *
 * Updates the original permission card to show the outcome
 * without editable buttons.
 */
export function buildHandledPermissionCard(
  toolName: string,
  resolution: 'allow' | 'allow_session' | 'deny',
): Record<string, unknown> {
  const statusMap = {
    allow: { status: 'success' as const, label: '✅ Allowed' },
    allow_session: { status: 'success' as const, label: '✅ Allowed for session' },
    deny: { status: 'error' as const, label: '❌ Denied' },
  };

  const config = statusMap[resolution];

  return buildStatusCard(
    config.status,
    'Permission Resolved',
    `Tool: ${toolName}\n\n**${config.label}**`,
  );
}
