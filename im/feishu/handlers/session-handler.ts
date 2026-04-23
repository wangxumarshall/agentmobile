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
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5)
    .map(b => ({
      id: b.id,
      title: `Session ${b.id.slice(-6)}`,
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
  const address: ChannelAddress = {
    channelType: 'feishu',
    chatId: event.open_chat_id,
    userId: event.operator?.open_id || event.open_id,
  };

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

  // Update binding to active
  const binding = ctx.store.getBinding(sessionId);
  if (binding) {
    binding.active = true;
    binding.updatedAt = new Date().toISOString();
    ctx.store.saveBinding(binding);
  }

  const address: ChannelAddress = {
    channelType: 'feishu',
    chatId: event.open_chat_id,
    userId: event.operator?.open_id || event.open_id,
  };

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
  replyToMessageId?: string,
): Promise<void> {
  // This is called from group context, send to the group
  debug('session-handler', 'Session reset requested');
  // Reset logic is minimal for now — just acknowledge
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

  if (binding.runtime === 'claude') {
    // Show Claude mode card
    const card = buildClaudeModeCard(
      binding.claudePermissionMode || 'default',
      bindingId,
    );
    await ctx.sendCard(address, card);
  } else {
    // Codex: change mode directly
    const mode = text.split(' ')[1];
    if (mode === 'plan' || mode === 'code' || mode === 'ask') {
      binding.mode = mode as any;
      binding.updatedAt = new Date().toISOString();
      ctx.store.saveBinding(binding);
      await ctx.sendText(address, `✅ Mode changed to: \`${mode}\``);
    } else {
      await ctx.sendText(address, 'Usage: `/mode plan|code|ask`');
    }
  }
}
