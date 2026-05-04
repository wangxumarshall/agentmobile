/**
 * Session card builders for Telegram.
 */

import type { ChannelBinding, ClaudePermissionMode } from '../../bridge/types.js';
import { getRuntimeCapabilities } from '../../runtime/types.js';
import type { RuntimeName } from '../../runtime/types.js';
import type { TelegramCard } from './types.js';
import { escapeHtml, inlineCode, truncateText } from './utils.js';

export function buildNewSessionCard(): TelegramCard {
  const claude = getRuntimeCapabilities('claude');
  const codex = getRuntimeCapabilities('codex');

  const text = `<b>🆕 Create New Session</b>

Choose an AI agent and mode for your new session.

<b>${escapeHtml(claude.symbol)} ${escapeHtml(claude.label)}</b>
- Code mode: Full execution with permission approval
- Plan mode: Interactive planning before execution

<b>${escapeHtml(codex.symbol)} ${escapeHtml(codex.label)}</b>
- Code mode: Full execution
- Plan mode: Native plan collaboration
- Ask mode: Q&amp;A without execution

Tap a button below to create your session.`;

  return {
    parseMode: 'HTML',
    text,
    inlineButtons: [
      [
        { text: `${claude.symbol} Claude Code`, callbackData: 'new-session:claude:code' },
        { text: `${claude.symbol} Claude Plan`, callbackData: 'new-session:claude:plan' },
      ],
      [
        { text: `${codex.symbol} Codex Code`, callbackData: 'new-session:codex:code' },
        { text: `${codex.symbol} Codex Plan`, callbackData: 'new-session:codex:plan' },
        { text: `${codex.symbol} Codex Ask`, callbackData: 'new-session:codex:ask' },
      ],
    ],
  };
}

export function buildRuntimeModeCard(
  runtime: RuntimeName,
  mode: 'code' | 'plan' | 'ask',
): TelegramCard {
  const cap = getRuntimeCapabilities(runtime);
  let modeDescription = 'In code mode, the agent can read files, run commands, and execute tasks. It will ask for permission before each tool use.';
  if (mode === 'plan') {
    modeDescription = 'In plan mode, the agent will create a plan first and ask for your confirmation before executing.';
  } else if (mode === 'ask') {
    modeDescription = 'In ask mode, the agent will answer questions without executing any code.';
  }

  return {
    parseMode: 'HTML',
    text: `<b>${escapeHtml(cap.symbol)} ${escapeHtml(cap.label)}: ${escapeHtml(mode)} mode</b>\n\n<b>Runtime:</b> ${escapeHtml(cap.label)}\n<b>Mode:</b> ${escapeHtml(mode)}\n\n${escapeHtml(modeDescription)}`,
  };
}

export function buildClaudeModeCard(
  currentMode: ClaudePermissionMode = 'default',
  bindingId: string,
): TelegramCard {
  const modeDescriptions = {
    plan: '📋 Plan Mode: Claude will propose a plan first, ask for approval before executing',
    acceptEdits: '✏️ Auto-Edits: Claude can edit files without asking for permission',
    default: '🔐 Default: Claude asks for permission before each tool use',
  };

  return {
    parseMode: 'HTML',
    text: `<b>🔧 Claude Permission Mode</b>\n\n<b>Current Mode:</b> ${escapeHtml(currentMode)}\n${escapeHtml(modeDescriptions[currentMode])}\n\nChoose a permission mode for Claude. The mode will persist for this session.`,
    inlineButtons: [
      [
        { text: '📋 Plan Mode', callbackData: `claude-mode:${bindingId}:plan` },
      ],
      [
        { text: '✏️ Auto-Edits', callbackData: `claude-mode:${bindingId}:acceptEdits` },
      ],
      [
        { text: '🔐 Default', callbackData: `claude-mode:${bindingId}:default` },
      ],
    ],
  };
}

export function buildResumeCard(
  sessions: Array<{ id: string; title: string; runtime: string; updatedAt: string }>,
): TelegramCard {
  let text = '<b>🔄 Resume Session</b>\n\nChoose a recent session to resume:\n\n';

  for (const session of sessions.slice(0, 5)) {
    const updated = new Date(session.updatedAt).toLocaleString();
    text += `• <b>${escapeHtml(session.title)}</b> (${escapeHtml(session.runtime)})\n  ${escapeHtml(updated)}\n`;
  }

  if (sessions.length === 0) {
    text += '<i>No recent sessions found.</i>';
  }

  return {
    parseMode: 'HTML',
    text,
    inlineButtons: sessions.slice(0, 5).map((session, index) => [
      {
        text: `${index + 1}. ${truncateText(session.title, 42)}`,
        callbackData: `resume:pick:${session.runtime}:${session.id}`,
      },
    ]),
  };
}

export function buildSessionCreatedCard(
  runtime: RuntimeName,
  mode: 'code' | 'plan' | 'ask',
  binding: ChannelBinding,
): TelegramCard {
  const cap = getRuntimeCapabilities(runtime);
  return {
    parseMode: 'HTML',
    text: `<b>✅ Session Created</b>\n\n<b>Runtime:</b> ${escapeHtml(cap.label)}\n<b>Mode:</b> ${escapeHtml(mode)}\n<b>Session ID:</b> ${inlineCode(binding.id)}\n\nYou can now send messages to this session.`,
  };
}

export function buildSessionResumedCard(
  runtime: RuntimeName,
  sessionId: string,
): TelegramCard {
  const cap = getRuntimeCapabilities(runtime);
  return {
    parseMode: 'HTML',
    text: `<b>✅ Session Resumed</b>\n\n<b>Runtime:</b> ${escapeHtml(cap.label)}\n<b>Session ID:</b> ${inlineCode(sessionId)}\n\nSession resumed. Send me a message to continue.`,
  };
}

export function buildResetConfirmationCard(
  bindingId: string,
  runtime: RuntimeName,
): TelegramCard {
  const cap = getRuntimeCapabilities(runtime);
  return {
    parseMode: 'HTML',
    text: `<b>🔄 Session Reset</b>\n\nSession reset. The ${escapeHtml(cap.symbol)} ${escapeHtml(cap.label)} runtime is preserved.\n\nTap below to start a new session.`,
    inlineButtons: [
      [
        { text: `New ${cap.label} Session`, callbackData: `new-session:${runtime}:code` },
      ],
    ],
  };
}
