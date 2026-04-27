/**
 * Session command handler for Feishu.
 *
 * Handles session-related commands:
 * - Create new session
 * - Resume session
 * - Reset session
 * - Mode switching
 */

import type { AdapterContext, FeishuCardActionEvent } from '../types.js';
import type { ChannelAddress } from '../../bridge/types.js';
import {
  buildNewSessionCard,
  buildResumeCard,
  buildClaudeModeCard,
  buildResetConfirmationCard,
} from '../cards/session-cards.js';
import { normalizeClaudePermissionMode } from '../../runtime/claude-mode.js';
import { info, error, debug } from '../../config/logger.js';

/**
 * Handle create session command.
 *
 * Sends a new session card for user to choose runtime and mode.
 */
export async function handleCreateSessionCommand(
  ctx: AdapterContext,
  sender: ChannelAddress,
): Promise<void> {
  const card = buildNewSessionCard();
  await ctx.sendCard(sender, card);
}

/**
 * Handle resume session command.
 *
 * Lists recent sessions and sends a resume selection card.
 */
export async function handleResumeSessionCommand(
  ctx: AdapterContext,
  sender: ChannelAddress,
): Promise<void> {
  // Fetch recent sessions from store
  const bindings = ctx.store.listBindings();

  // Filter active, recent bindings
  const recent = bindings
    .sort((a, b) => {
      const sameChat = Number(
        a.channelType === sender.channelType &&
        a.channelInstanceId === (sender.channelInstanceId || ctx.profileId) &&
        a.chatId === sender.chatId,
      ) - Number(
        b.channelType === sender.channelType &&
        b.channelInstanceId === (sender.channelInstanceId || ctx.profileId) &&
        b.chatId === sender.chatId,
      );
      if (sameChat !== 0) return -sameChat;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    })
    .slice(0, 5)
    .map(b => ({
      id: b.id,
      title: `${b.runtime} · ${b.workingDirectory.split('/').filter(Boolean).pop() || 'session'}`,
      runtime: b.runtime,
      updatedAt: b.updatedAt,
    }));

  const card = buildResumeCard(recent);
  await ctx.sendCard(sender, card);
}

/**
 * Handle new session card action.
 *
 * Parses `new-session:runtime:mode` callback and creates the session.
 */
export async function handleNewSessionCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  const parts = callbackData.split(':');
  if (parts.length < 3) {
    error('session-handler', `Invalid new-session callback: ${callbackData}`);
    return;
  }

  const runtime = parts[1] as 'claude' | 'codex';
  const mode = parts[2] as 'code' | 'plan' | 'ask';

  // Create bound session
  const address = getCardActionAddress(ctx, event);
  if (!address) return;

  try {
    const binding = await ctx.createBoundSession(runtime, address, {
      mode,
    });

    // Update the card to show success
    await ctx.sendCard(address, {
      config: { wide_screen_mode: true },
      header: {
        template: 'green',
        title: {
          tag: 'plain_text',
          content: '✅ Session Created',
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: `Runtime: ${runtime}\nMode: ${mode}\nSession ID: \`${binding.id}\`\n\nYou can now send messages to this session.`,
        },
      ],
    });
  } catch (e) {
    error('session-handler', `Failed to create session: ${e}`);
    await ctx.sendCard(address, {
      config: { wide_screen_mode: true },
      header: {
        template: 'red',
        title: {
          tag: 'plain_text',
          content: '❌ Session Creation Failed',
        },
      },
      elements: [
        {
          tag: 'markdown',
          content: `Error: ${e}\n\nPlease try again.`,
        },
      ],
    });
  }
}

/**
 * Handle resume card action.
 *
 * Parses `resume:pick:runtime:sessionId` callback and resumes the session.
 */
export async function handleResumeCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  const parts = callbackData.split(':');
  if (parts.length < 4) {
    error('session-handler', `Invalid resume callback: ${callbackData}`);
    return;
  }

  const runtime = parts[2] as 'claude' | 'codex';
  const sessionId = parts[3];
  const address = getCardActionAddress(ctx, event);
  if (!address) return;

  // Update binding to active
  const binding = ctx.store.getBinding(sessionId);
  if (binding) {
    for (const existing of ctx.router.listBindings('feishu')) {
      if (
        existing.id !== sessionId &&
        existing.active &&
        existing.channelInstanceId === ctx.profileId &&
        existing.chatId === address.chatId
      ) {
        ctx.deactivateBinding(existing.id);
      }
    }
    binding.active = true;
    binding.updatedAt = new Date().toISOString();
    ctx.store.saveBinding(binding);
  }

  await ctx.sendCard(address, {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: '✅ Session Resumed',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `Runtime: ${runtime}\nSession ID: \`${sessionId}\`\n\nSession resumed. Send me a message to continue.`,
      },
    ],
  });
}

/**
 * Handle reset command.
 *
 * Deactivates current binding and creates a fresh one.
 */
export async function handleResetCommand(
  ctx: AdapterContext,
  address: ChannelAddress,
): Promise<void> {
  const binding = ctx.getActiveBinding(address);
  if (!binding) {
    await ctx.sendText(address, '❌ No active session found.');
    return;
  }

  ctx.deactivateBinding(binding.id);
  await ctx.sendCard(address, buildResetConfirmationCard(binding.id, binding.runtime));
}

/**
 * Handle mode command.
 *
 * For Claude: Shows mode card
 * For Codex: Changes mode directly
 */
export async function handleModeCommand(
  ctx: AdapterContext,
  bindingId: string,
  text: string,
  address: ChannelAddress,
  replyToMessageId?: string,
): Promise<void> {
  const binding = ctx.store.getBinding(bindingId);
  if (!binding) {
    await ctx.sendText(address, '❌ No active session found.');
    return;
  }

  const requestedMode = text.trim().split(/\s+/)[1];
  if (!requestedMode && binding.runtime === 'claude') {
    const card = buildClaudeModeCard(
      binding.claudePermissionMode || 'default',
      bindingId,
    );
    await ctx.sendCard(address, card);
    return;
  }

  if (requestedMode !== 'plan' && requestedMode !== 'code' && requestedMode !== 'ask') {
    await ctx.sendText(address, 'Usage: `/mode plan|code|ask`');
    return;
  }

  binding.mode = requestedMode;
  binding.updatedAt = new Date().toISOString();
  if (binding.runtime === 'claude' && requestedMode === 'plan') {
    binding.claudePermissionMode = 'plan';
  } else if (binding.runtime === 'claude' && binding.claudePermissionMode === 'plan') {
    binding.claudePermissionMode = 'default';
  }
  ctx.store.saveBinding(binding);
  await ctx.sendText(address, `✅ Mode changed to: \`${requestedMode}\``);
}

/**
 * Handle Claude mode card action.
 *
 * Parses `claude-mode:bindingId:mode` callback and persists it on the binding.
 */
export async function handleClaudeModeCardAction(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
  callbackData: string,
): Promise<void> {
  const parts = callbackData.split(':');
  if (parts.length < 3) {
    error('session-handler', `Invalid Claude mode callback: ${callbackData}`);
    return;
  }

  const bindingId = parts[1];
  const requestedMode = normalizeClaudePermissionMode(parts[2]);
  const binding = ctx.store.getBinding(bindingId);
  if (!binding || binding.runtime !== 'claude') {
    const address = getCardActionAddress(ctx, event);
    if (address) {
      await ctx.sendText(address, '❌ No active Claude session found.');
    }
    return;
  }

  binding.claudePermissionMode = requestedMode;
  binding.updatedAt = new Date().toISOString();
  if (requestedMode === 'plan') {
    binding.mode = 'plan';
  } else if (binding.mode === 'plan') {
    binding.mode = 'code';
  }
  ctx.store.saveBinding(binding);

  await ctx.patchCard(event.open_message_id, buildClaudeModeCard(requestedMode, bindingId), {
    openMessageId: event.open_message_id,
  });
}

function getCardActionAddress(
  ctx: AdapterContext,
  event: FeishuCardActionEvent,
): ChannelAddress | null {
  const chatId = getCardActionChatId(event);
  if (!chatId) {
    error('session-handler', 'Card action missing chat id');
    return null;
  }

  return {
    channelType: 'feishu',
    channelInstanceId: ctx.profileId,
    chatId,
    userId: event.operator?.open_id || event.open_id || getStringActionValue(event, 'user_id'),
  };
}

function getCardActionChatId(event: FeishuCardActionEvent): string | undefined {
  return event.open_chat_id ||
    getStringActionValue(event, 'chat_id') ||
    getStringActionValue(event, 'chatId');
}

function getStringActionValue(
  event: FeishuCardActionEvent,
  key: string,
): string | undefined {
  const value = event.action?.value?.[key];
  return typeof value === 'string' && value ? value : undefined;
}
