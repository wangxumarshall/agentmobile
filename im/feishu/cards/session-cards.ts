/**
 * Session card builders for Feishu.
 *
 * Build interactive card JSON structures for:
 * - New session creation card (runtime + mode selection)
 * - Session resume card (list recent sessions)
 * - Mode switch card (Claude permission modes)
 * - Session status card
 */

import { getRuntimeCapabilities } from '../../runtime/types.js';
import type { RuntimeName } from '../../runtime/types.js';
import { CARD_TEMPLATES } from '../constants.js';
import type { ClaudePermissionMode } from '../../bridge/types.js';

type CardTemplate = keyof typeof CARD_TEMPLATES;

/**
 * Build a new session creation card.
 *
 * Allows user to select runtime (Claude/Codex) and mode.
 */
export function buildNewSessionCard(): Record<string, unknown> {
  const claude = getRuntimeCapabilities('claude');
  const codex = getRuntimeCapabilities('codex');

  const content = `Choose an AI agent and mode for your new session.

**${claude.symbol} ${claude.label}**
- Code mode: Full execution with permission approval
- Plan mode: Interactive planning before execution

**${codex.symbol} ${codex.label}**
- Code mode: Full execution
- Plan mode: Native plan collaboration
- Ask mode: Q&A without execution

Tap a button below to create your session.`;

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: '🆕 Create New Session',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `${claude.symbol} Claude Code` },
            type: 'primary',
            value: { callback: 'new-session:claude:code' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `${codex.symbol} Codex` },
            type: 'primary',
            value: { callback: 'new-session:codex:code' },
          },
        ],
        layout: 'horizontal',
      },
    ],
  };
}

/**
 * Build a runtime + mode selection card with more granular options.
 */
export function buildRuntimeModeCard(
  runtime: RuntimeName,
  mode: 'code' | 'plan' | 'ask',
): Record<string, unknown> {
  const cap = getRuntimeCapabilities(runtime);

  let content = `**Runtime:** ${cap.symbol} ${cap.label}\n`;
  content += `**Mode:** ${mode}\n\n`;

  if (mode === 'plan') {
    content += 'In plan mode, the agent will create a plan first and ask for your confirmation before executing.\n\n';
  } else if (mode === 'ask') {
    content += 'In ask mode, the agent will answer questions without executing any code.\n\n';
  } else {
    content += 'In code mode, the agent can read files, run commands, and execute tasks. It will ask for permission before each tool use.\n\n';
  }

  const templateMap: Record<string, CardTemplate> = {
    code: 'blue',
    plan: 'purple',
    ask: 'green',
  };

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: templateMap[mode],
      title: {
        tag: 'plain_text',
        content: `${cap.symbol} ${cap.label}: ${mode} mode`,
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
 * Build a Claude permission mode card.
 *
 * Shows Claude permission mode options (plan, acceptEdits, default).
 */
export function buildClaudeModeCard(
  currentMode: ClaudePermissionMode = 'default',
  bindingId: string,
): Record<string, unknown> {
  const modeDescriptions = {
    plan: '📋 **Plan Mode**: Claude will propose a plan first, ask for approval before executing',
    acceptEdits: '✏️ **Auto-Edits**: Claude can edit files without asking for permission',
    default: '🔐 **Default**: Claude asks for permission before each tool use',
  };

  const buttons = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '📋 Plan Mode' },
      type: currentMode === 'plan' ? 'danger' : 'primary',
      value: { callback: `claude-mode:${bindingId}:plan` },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✏️ Auto-Edits' },
      type: currentMode === 'acceptEdits' ? 'danger' : 'primary',
      value: { callback: `claude-mode:${bindingId}:acceptEdits` },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🔐 Default' },
      type: currentMode === 'default' ? 'danger' : 'primary',
      value: { callback: `claude-mode:${bindingId}:default` },
    },
  ];

  const content = `**Current Mode:** ${currentMode}\n${modeDescriptions[currentMode]}\n\nChoose a permission mode for Claude. The mode will persist for this session.`;

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: '🔧 Claude Permission Mode',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      {
        tag: 'action',
        actions: buttons,
        layout: 'vertical',
      },
    ],
  };
}

/**
 * Build a session resume card.
 *
 * Lists recent sessions for user to resume.
 */
export function buildResumeCard(
  sessions: Array<{ id: string; title: string; runtime: string; updatedAt: string }>,
  replyToMessageId?: string,
): Record<string, unknown> {
  let content = 'Choose a recent session to resume:\n\n';

  for (const session of sessions.slice(0, 5)) {
    const updated = new Date(session.updatedAt).toLocaleString();
    content += `• **${session.title}** (${session.runtime})\n  ${updated}\n`;
  }

  if (sessions.length === 0) {
    content += '_No recent sessions found._';
  }

  const buttons = sessions.slice(0, 5).map((s, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${s.title}` },
    type: 'primary' as const,
    value: { callback: `resume:pick:${s.runtime}:${s.id}` },
  }));

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'purple',
      title: {
        tag: 'plain_text',
        content: '🔄 Resume Session',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
      ...(buttons.length > 0
        ? [
            {
              tag: 'action',
              actions: buttons,
              layout: 'vertical' as const,
            },
          ]
        : []),
    ],
  };
}

/**
 * Build a session reset confirmation card.
 */
export function buildResetConfirmationCard(
  bindingId: string,
  runtime: RuntimeName,
): Record<string, unknown> {
  const cap = getRuntimeCapabilities(runtime);

  return {
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: '🔄 Session Reset',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `Session reset. The ${cap.symbol} ${cap.label} runtime is preserved.\n\nTap below to start a new session.`,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `New ${cap.label} Session` },
            type: 'primary',
            value: { callback: `new-session:${runtime}:code` },
          },
        ],
        layout: 'horizontal',
      },
    ],
  };
}
