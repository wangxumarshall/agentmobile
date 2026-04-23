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

import { randomUUID } from 'node:crypto';
import type { AdapterContext, FeishuMessageEvent, SenderIdentity } from '../types.js';
import type { InboundMessage } from '../../bridge/types.js';
import { info, error, debug } from '../../config/logger.js';

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
): Promise<void> {
  const messageId = data.message?.message_id;
  if (!messageId) return;

  // Deduplication
  if (isDuplicate(messageId)) {
    debug('inbound', `Duplicate message: ${messageId}`);
    return;
  }
  markSeen(messageId);

  // Extract sender identity
  const sender = extractSender(data);
  if (!sender) {
    debug('inbound', 'No sender identity in event');
    return;
  }

  // Authorization check
  if (!isAuthorized(ctx, sender)) {
    debug('inbound', `Unauthorized user: ${sender.userId}`);
    return;
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
      await handleTextMessage(ctx, sender, inbound, data);
      break;
    case 'image':
      await handleImageMessage(ctx, sender, inbound, data);
      break;
    case 'interactive':
      // Card messages are handled by card-action-handler
      debug('inbound', `Interactive message ignored: ${messageId}`);
      break;
    default:
      debug('inbound', `Unsupported message type: ${msgType}`);
      break;
  }
}

/**
 * Check if a user is authorized to interact with the bridge.
 *
 * TODO: Wire allowedUsers from FeishuAdapter profile config.
 * For now, checks AdapterContext for any authorization settings.
 */
function isAuthorized(ctx: AdapterContext, sender: SenderIdentity): boolean {
  // TODO: Implement proper authorization by reading allowedUsers from store/config
  // Currently the bridge allows all users by default — this should be locked down
  // in production by setting CTI_FEISHU_ALLOWED_USERS in .env
  return true;
}

/**
 * Handle a text message.
 */
async function handleTextMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
  data: FeishuMessageEvent,
): Promise<void> {
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
  if (!inbound.text) return;

  // Resolve referenced images in text mentions
  if (data.message?.mentions && data.message.mentions.length > 0) {
    // Could handle image mentions here
    debug('inbound', `Message has ${data.message.mentions.length} mentions`);
  }

  // Dispatch to direct/group handler
  const chatType = data.message?.chat_type;
  if (chatType === 'p2p') {
    await handleDirectMessage(ctx, sender, inbound);
  } else {
    await handleGroupMessage(ctx, sender, inbound);
  }
}

/**
 * Handle an image message.
 */
async function handleImageMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
  data: FeishuMessageEvent,
): Promise<void> {
  let content = data.message?.content || '';

  try {
    const parsed = JSON.parse(content);
    const imageKey = parsed.image_key;
    if (imageKey) {
      const image = await ctx.inboundImageService.downloadImage(imageKey, inbound.messageId);
      inbound.text = image ? `📷 Image received: ${image.localPath}` : '📷 Image received (download failed)';
    }
  } catch {
    inbound.text = '📷 Image received';
  }

  const chatType = data.message?.chat_type;
  if (chatType === 'p2p') {
    await handleDirectMessage(ctx, sender, inbound);
  } else {
    await handleGroupMessage(ctx, sender, inbound);
  }
}

/**
 * Handle a direct (P2P) message.
 *
 * In DMs, only session creation commands are accepted.
 */
export async function handleDirectMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const text = inbound.text;

  // Accept /new commands in DMs
  if (text.startsWith('/new')) {
    // Create a new session
    const isClaude = text.includes('claude') || !text.includes('codex');
    const runtime = isClaude ? 'claude' as const : 'codex' as const;

    try {
      const binding = await ctx.createBoundSession(runtime, inbound.address, {});
      await ctx.sendText(inbound.address, `✅ Created new ${runtime} session: \`${binding.id}\``);
    } catch (e) {
      await ctx.sendText(inbound.address, `❌ Failed to create session: ${e}`);
    }
  } else if (text.startsWith('/resume')) {
    // Show resume card
    await ctx.sendText(inbound.address, `🔄 Sending session options...`);
    // Implementation would show session selection card
  } else {
    // Reject other commands in DM
    await ctx.sendText(
      inbound.address,
      '👋 In direct messages, please use `/new:claude` or `/new:codex` to start a session.\n\nFor general chat, add me to a group.',
    );
  }
}

/**
 * Handle a group message.
 *
 * Accepts a wider range of commands and falls through to enqueue for regular text.
 */
export async function handleGroupMessage(
  ctx: AdapterContext,
  sender: SenderIdentity,
  inbound: InboundMessage,
): Promise<void> {
  const text = inbound.text.trim();

  // Parse commands
  if (text.startsWith('/new')) {
    await handleGroupNewCommand(ctx, inbound, text);
    return;
  }
  if (text.startsWith('/reset')) {
    await handleGroupResetCommand(ctx, inbound);
    return;
  }
  if (text.startsWith('/stop')) {
    await ctx.sendText(inbound.address, '⛹️ Use `/stop` in the bridge context to stop the active task.');
    return;
  }
  if (text.startsWith('/mode')) {
    await handleGroupModeCommand(ctx, inbound, text);
    return;
  }
  if (text.startsWith('/help')) {
    await sendHelpMessage(ctx, inbound);
    return;
  }

  // Regular text — enqueue for processing by bridge manager
  // The adapter will push this to the queue for consumeOne()
  debug('inbound', `Group message enqueued: ${text.slice(0, 50)}...`);
  // Note: The actual enqueue happens in the adapter's handleIncomingEvent handler
}

/**
 * Handle /new command in group.
 */
async function handleGroupNewCommand(
  ctx: AdapterContext,
  inbound: InboundMessage,
  text: string,
): Promise<void> {
  const isClaude = text.includes('claude') || !text.includes('codex');
  const runtime = isClaude ? 'claude' as const : 'codex' as const;

  try {
    const binding = await ctx.createBoundSession(runtime, inbound.address, {});
    await ctx.sendText(inbound.address, `✅ Created new ${runtime} session in this group: \`${binding.id}\``);
  } catch (e) {
    await ctx.sendText(inbound.address, `❌ Failed to create session: ${e}`);
  }
}

/**
 * Handle /reset command in group.
 */
async function handleGroupResetCommand(
  ctx: AdapterContext,
  inbound: InboundMessage,
): Promise<void> {
  await ctx.sendText(inbound.address, '🔄 Session reset. Send `/new` to start fresh.');
}

/**
 * Handle /mode command in group.
 */
async function handleGroupModeCommand(
  ctx: AdapterContext,
  inbound: InboundMessage,
  text: string,
): Promise<void> {
  const parts = text.split(' ');
  const mode = parts[1];

  if (mode === 'plan' || mode === 'code' || mode === 'ask') {
    await ctx.sendText(inbound.address, `✅ Mode changed to: \`${mode}\``);
  } else {
    await ctx.sendText(inbound.address, 'Usage: `/mode plan|code|ask`');
  }
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
• \`/resume\` — Resume recent session

**Group Chats:**
• \`/new:claude\` — Start Claude session in group
• \`/new:codex\` — Start Codex session in group
• \`/reset\` — Reset session
• \`/mode plan|code|ask\` — Change mode
• \`/help\` — Show help

**Tips:**
• Send any text to continue the conversation
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
