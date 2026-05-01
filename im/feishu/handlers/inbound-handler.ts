/**
 * Inbound message handler for Feishu.
 *
 * Handles the message processing pipeline:
 * 1. Deduplication via message_id
 * 2. Authorization check (user allowlist)
 * 3. Thread ID extraction
 * 4. Image message handling (download + cache)
 * 5. Text message parsing
 * 6. Dispatch to direct/group handler
 */

import type { AdapterContext, FeishuMessageEvent, SenderIdentity } from '../types.js';
import type { InboundMessage } from '../../bridge/types.js';
import {
  handleCreateSessionCommand,
  handleResumeSessionCommand,
  handleResetCommand,
  handleModeCommand,
} from './session-handler.js';
import { debug } from '../../config/logger.js';

// Message deduplication cache (in-memory, 5 minute TTL)
const seenMessages: Map<string, number> = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_MAP_SIZE = 10000;
let dedupLastCleanup = 0;

/**
 * Check if a message ID has been seen recently (within TTL).
 */
function isDuplicate(messageId: string): boolean {
  const seenAt = seenMessages.get(messageId);
  if (!seenAt) return false;
  return Date.now() - seenAt < DEDUP_TTL_MS;
}

/**
 * Mark a message ID as seen.
 *
 * Cleanup runs lazily: only when the map exceeds MAX_DEDUP_MAP_SIZE
 * and at least 60 seconds have passed since the last cleanup.
 * This avoids O(n) scans on every message.
 */
function markSeen(messageId: string): void {
  seenMessages.set(messageId, Date.now());

  // Lazy cleanup: only run when map is large AND enough time has passed
  const now = Date.now();
  if (
    seenMessages.size > MAX_DEDUP_MAP_SIZE &&
    now - dedupLastCleanup > 60_000
  ) {
    for (const [id, ts] of seenMessages) {
      if (now - ts > DEDUP_TTL_MS) {
        seenMessages.delete(id);
      }
    }
    dedupLastCleanup = now;
  }
}

/**
 * Handle an incoming Feishu event.
 *
 * Routes to direct/group handler after processing.
 */
export async function handleIncomingEvent(
  ctx: AdapterContext,
  data: FeishuMessageEvent,
): Promise<InboundMessage | null> {
  const messageId = data.message?.message_id;
  if (!messageId) return null;

  // Deduplication
  if (isDuplicate(messageId)) {
    debug('inbound', `Duplicate message: ${messageId}`);
    return null;
  }
  markSeen(messageId);

  // Extract sender identity
  const sender = extractSender(data);
  if (!sender) {
    debug('inbound', 'No sender identity in event');
    return null;
  }

  // Authorization check
  if (!ctx.isAuthorized(sender)) {
    debug('inbound', `Unauthorized user: ${sender.userId}`);
    return null;
  }

  // Extract thread ID
  const threadId = data.message?.root_id || data.message?.parent_id || messageId;

  // Build inbound message
  const inbound: InboundMessage = {
    messageId,
    address: {
      channelType: 'feishu',
      channelInstanceId: ctx.profileId,
      chatId: sender.chatId,
      userId: sender.userId,
      displayName: sender.displayName,
      threadId,
    },
    text: '',
    timestamp: parseInt(data.message.create_time || '0', 10),
    raw: data,
  };

  // Handle based on message type
  const msgType = data.message?.message_type;
  switch (msgType) {
    case 'text':
      return await handleTextMessage(ctx, inbound, data);
    case 'image':
      return await handleImageMessage(ctx, inbound, data);
    case 'interactive':
      // Card messages are handled by card-action-handler
      debug('inbound', `Interactive message ignored: ${messageId}`);
      return null;
    default:
      debug('inbound', `Unsupported message type: ${msgType}`);
      return null;
  }
}

/**
 * Handle a text message.
 */
async function handleTextMessage(
  ctx: AdapterContext,
  inbound: InboundMessage,
  data: FeishuMessageEvent,
): Promise<InboundMessage | null> {
  // Parse text content
  let content = data.message?.content || '';

  // Feishu wraps text in a JSON structure for text messages
  try {
    const parsed = JSON.parse(content);
    content = parsed.text || content;
  } catch {
    // Not JSON, use as-is
  }

  inbound.text = content.trim();
  if (!inbound.text) return null;

  // Resolve referenced images in text mentions
  if (data.message?.mentions && data.message.mentions.length > 0) {
    // Could handle image mentions here
    debug('inbound', `Message has ${data.message.mentions.length} mentions`);
  }

  // Dispatch to direct/group handler
  const chatType = data.message?.chat_type;
  if (chatType === 'p2p') {
    return handleDirectMessage(ctx, inbound);
  }
  return handleGroupMessage(ctx, inbound);
}

/**
 * Handle an image message.
 */
async function handleImageMessage(
  ctx: AdapterContext,
  inbound: InboundMessage,
  data: FeishuMessageEvent,
): Promise<InboundMessage | null> {
  let content = data.message?.content || '';

  try {
    const parsed = JSON.parse(content);
    const imageKey = parsed.image_key;
    if (imageKey) {
      const image = await ctx.inboundImageService.downloadImage(imageKey, inbound.messageId);
      if (image) {
        inbound.attachments = [{
          fileName: image.localPath.split('/').pop() || 'image',
          filePath: image.localPath,
          mimeType: image.mimeType,
          fileSize: image.fileSize,
        }];
        inbound.text = 'Please inspect the attached image.';
      } else {
        inbound.text = '📷 Image received (download failed)';
      }
    }
  } catch {
    inbound.text = '📷 Image received';
  }

  const chatType = data.message?.chat_type;
  if (chatType === 'p2p') {
    return handleDirectMessage(ctx, inbound);
  }
  return handleGroupMessage(ctx, inbound);
}

/**
 * Handle a direct (P2P) message.
 *
 * In DMs, only session creation commands are accepted.
 */
export async function handleDirectMessage(
  ctx: AdapterContext,
  inbound: InboundMessage,
): Promise<InboundMessage | null> {
  const text = inbound.text.trim();

  if (text.startsWith('/new')) {
    return handleNewCommand(ctx, inbound, text);
  }
  if (text.startsWith('/resume') || text.startsWith('/sessions')) {
    await handleResumeSessionCommand(ctx, inbound.address);
    return null;
  }
  if (text.startsWith('/reset')) {
    await handleResetCommand(ctx, inbound.address);
    return null;
  }
  if (text.startsWith('/mode')) {
    const binding = ctx.getActiveBinding(inbound.address);
    if (!binding) {
      await ctx.sendText(inbound.address, '❌ No active session found. Send `/new` first.');
      return null;
    }
    await handleModeCommand(ctx, binding.id, text, inbound.address);
    return null;
  }
  if (text.startsWith('/help')) {
    await sendHelpMessage(ctx, inbound);
    return null;
  }

  if (!ctx.getActiveBinding(inbound.address)) {
    await handleCreateSessionCommand(ctx, inbound.address);
    await ctx.sendText(
      inbound.address,
      '👋 No active session in this DM yet. Tap a card button or send `/new:claude` / `/new:codex` first.',
    );
    return null;
  }

  return inbound;
}

/**
 * Handle a group message.
 *
 * Accepts a wider range of commands and falls through to enqueue for regular text.
 */
export async function handleGroupMessage(
  ctx: AdapterContext,
  inbound: InboundMessage,
): Promise<InboundMessage | null> {
  const text = inbound.text.trim();

  // Parse commands
  if (text.startsWith('/new')) {
    return handleNewCommand(ctx, inbound, text);
  }
  if (text.startsWith('/resume') || text.startsWith('/sessions')) {
    await handleResumeSessionCommand(ctx, inbound.address);
    return null;
  }
  if (text.startsWith('/reset')) {
    await handleResetCommand(ctx, inbound.address);
    return null;
  }
  if (text.startsWith('/stop')) {
    await ctx.sendText(inbound.address, '⛹️ Use `/stop` in the bridge context to stop the active task.');
    return null;
  }
  if (text.startsWith('/mode')) {
    const binding = ctx.getActiveBinding(inbound.address);
    if (!binding) {
      await ctx.sendText(inbound.address, '❌ No active session found. Send `/new` first.');
      return null;
    }
    await handleModeCommand(ctx, binding.id, text, inbound.address);
    return null;
  }
  if (text.startsWith('/help')) {
    await sendHelpMessage(ctx, inbound);
    return null;
  }

  if (!ctx.getActiveBinding(inbound.address)) {
    await handleCreateSessionCommand(ctx, inbound.address);
    await ctx.sendText(
      inbound.address,
      '👋 This group does not have an active session yet. Use `/new:claude` or `/new:codex`, or tap a card button to create one.',
    );
    return null;
  }

  debug('inbound', `Group message enqueued: ${text.slice(0, 50)}...`);
  return inbound;
}

/**
 * Handle /new command in group.
 */
async function handleNewCommand(
  ctx: AdapterContext,
  inbound: InboundMessage,
  text: string,
): Promise<null> {
  const runtime = parseRuntime(text);
  if (!runtime) {
    await handleCreateSessionCommand(ctx, inbound.address);
    return null;
  }

  try {
    const binding = await ctx.createBoundSession(runtime, inbound.address, {});
    await ctx.sendText(inbound.address, `✅ Created new ${runtime} session: \`${binding.id}\``);
  } catch (e) {
    await ctx.sendText(inbound.address, `❌ Failed to create session: ${e}`);
  }
  return null;
}

/**
 * Send help message.
 */
async function sendHelpMessage(
  ctx: AdapterContext,
  inbound: InboundMessage,
): Promise<void> {
  const help = `**🤖 AgentMobile Bot Commands**

**Direct Messages:**
• \`/new:claude\` — Start Claude Code session
• \`/new:codex\` — Start Codex session
• \`/sessions\` — Show recent sessions
• \`/resume\` — Resume recent session

**Group Chats:**
• \`/new:claude\` — Start Claude session in group
• \`/new:codex\` — Start Codex session in group
• \`/sessions\` — Show recent sessions
• \`/resume\` — Resume recent session
• \`/reset\` — Reset session
• \`/mode plan|code|ask\` — Change mode
• \`/help\` — Show help

**Tips:**
• Send any text to continue the conversation
• Send an image to upload it into the active session context
• The bot will ask for permission before using tools
• Use \`/stop\` in the bridge context to cancel tasks`;

  await ctx.sendText(inbound.address, help);
}

// ── Sender Extraction ──────────────────────────────────────────

function extractSender(data: FeishuMessageEvent): SenderIdentity | null {
  const sender = data.sender;
  const message = data.message;
  if (!sender || !message) return null;

  const senderId = sender.sender_id;
  return {
    userId: senderId?.open_id || senderId?.user_id || '',
    chatId: message.chat_id,
    displayName: message.mentions?.[0]?.name,
    unionId: senderId?.union_id,
    openId: senderId?.open_id,
  };
}

function parseRuntime(text: string): 'claude' | 'codex' | null {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith('/new:claude') || /\bclaude\b/.test(normalized)) return 'claude';
  if (normalized.startsWith('/new:codex') || /\bcodex\b/.test(normalized)) return 'codex';
  return null;
}
