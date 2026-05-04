/**
 * Command center cards for Telegram.
 */

import type { ChannelBinding } from '../../bridge/types.js';
import type { TelegramCard } from './types.js';
import { escapeHtml, inlineCode } from './utils.js';

export function buildCommandCenterCard(binding?: ChannelBinding): TelegramCard {
  const sessionText = binding
    ? `<b>Active Session</b>\nRuntime: ${inlineCode(binding.runtime)}\nMode: ${inlineCode(binding.mode)}\nCWD: ${inlineCode(binding.workingDirectory)}`
    : '<b>No active session</b>\nCreate or resume a session to start.';

  return {
    parseMode: 'HTML',
    text: `<b>AgentMobile Command Center</b>\n\n${sessionText}\n\nTap a button below for the common actions. Slash commands still work as a fallback.`,
    inlineButtons: [
      [
        { text: 'New Session', callbackData: 'cmd:new' },
        { text: 'Resume', callbackData: 'cmd:resume' },
      ],
      [
        { text: 'Status', callbackData: 'cmd:status' },
        { text: 'Mode', callbackData: 'cmd:mode' },
      ],
      [
        { text: 'Directory', callbackData: 'cmd:cwd' },
        { text: 'Stop', callbackData: 'cmd:stop' },
        { text: 'Reset', callbackData: 'cmd:reset' },
      ],
      [
        { text: 'Codex Controls', callbackData: 'cmd:codex-controls' },
      ],
    ],
  };
}

export function buildCommandStatusCard(text: string): TelegramCard {
  return {
    parseMode: 'Markdown',
    text,
    inlineButtons: [
      [{ text: 'Command Center', callbackData: 'cmd:help' }],
    ],
  };
}

export function buildDirectoryCard(directory: string): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Current Directory</b>\n\n${inlineCode(directory)}`,
    inlineButtons: [
      [{ text: 'Command Center', callbackData: 'cmd:help' }],
    ],
  };
}

export function buildCodexControlCard(binding?: ChannelBinding): TelegramCard {
  const suffix = binding?.runtime === 'codex'
    ? `\n\nBinding: ${inlineCode(binding.id)}`
    : '\n\nThese controls are available after creating a Telegram Codex session.';

  return {
    parseMode: 'HTML',
    text: `<b>Codex Terminal Controls</b>${suffix}`,
    inlineButtons: [
      [
        { text: 'Screen', callbackData: 'cmd:screen' },
        { text: 'Enter', callbackData: 'terminal-key:enter' },
        { text: 'Esc', callbackData: 'terminal-key:esc' },
      ],
      [
        { text: 'Tab', callbackData: 'terminal-key:tab' },
        { text: 'Backspace', callbackData: 'terminal-key:backspace' },
      ],
      [
        { text: 'Ctrl-C', callbackData: 'terminal-key:ctrlc' },
        { text: 'Ctrl-D', callbackData: 'terminal-key:ctrld' },
      ],
      [
        { text: 'Up', callbackData: 'terminal-key:up' },
        { text: 'Down', callbackData: 'terminal-key:down' },
        { text: 'Left', callbackData: 'terminal-key:left' },
        { text: 'Right', callbackData: 'terminal-key:right' },
      ],
      [
        { text: 'PageUp', callbackData: 'terminal-key:pgup' },
        { text: 'PageDown', callbackData: 'terminal-key:pgdn' },
      ],
    ],
  };
}

export function buildModeSelectionCard(binding: ChannelBinding): TelegramCard {
  const rows = binding.runtime === 'claude'
    ? [
        [{ text: 'Plan', callbackData: `mode:${binding.id}:plan` }],
        [{ text: 'Auto-Edits', callbackData: `claude-mode:${binding.id}:acceptEdits` }],
        [{ text: 'Default', callbackData: `claude-mode:${binding.id}:default` }],
      ]
    : [
        [
          { text: 'Code', callbackData: `mode:${binding.id}:code` },
          { text: 'Plan', callbackData: `mode:${binding.id}:plan` },
          { text: 'Ask', callbackData: `mode:${binding.id}:ask` },
        ],
      ];

  const claudeMode = binding.runtime === 'claude'
    ? `\nClaude permission: ${inlineCode(binding.claudePermissionMode || 'default')}`
    : '';

  return {
    parseMode: 'HTML',
    text: `<b>Mode</b>\n\nRuntime: ${inlineCode(binding.runtime)}\nCurrent mode: ${inlineCode(binding.mode)}${claudeMode}\n\nChoose the mode for this session.`,
    inlineButtons: rows,
  };
}

export function buildCallbackErrorCard(message: string): TelegramCard {
  return {
    parseMode: 'HTML',
    text: `<b>Action Failed</b>\n\n${escapeHtml(message)}`,
    inlineButtons: [
      [{ text: 'Command Center', callbackData: 'cmd:help' }],
    ],
  };
}
