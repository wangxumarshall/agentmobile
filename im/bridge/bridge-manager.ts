/**
 * Bridge Manager — orchestrates channel adapters, message routing, and session management.
 * Core message processing hub for IM channels.
 */

import type { BaseChannelAdapter } from './channel-adapter.js';
import type {
  InboundMessage,
  ChannelBinding,
  BridgeStatus,
  AdapterStatus,
  CardMessage,
  ChannelAddress,
  ClaudePermissionMode,
} from './types.js';
import type { LLMProvider } from './context.js';
import { ChannelRouter } from './channel-router.js';
import { ConversationEngine } from './conversation-engine.js';
import { PermissionBroker } from './permission-broker.js';
import { JsonFileStore } from '../infra/store.js';
import {
  buildClaudeModeCard,
  buildHandledPermissionCard,
  buildNewSessionCard,
  buildResetConfirmationCard,
  buildResumeCard,
  buildSessionCreatedCard,
  buildSessionResumedCard,
} from '../telegram/cards/index.js';
import { normalizeClaudePermissionMode } from '../runtime/claude-mode.js';
import { info, error, warn, debug } from '../config/logger.js';

interface BridgeManagerState {
  adapters: Map<string, BaseChannelAdapter>;
  adapterMeta: Map<string, { connectedAt: string | null; lastMessageAt: string | null; error: string | null }>;
  running: boolean;
  startedAt: string | null;
  loopAborts: Map<string, AbortController>;
  activeTasks: Map<string, AbortController>;
  sessionLocks: Map<string, Promise<void>>;
  cleanupInterval: ReturnType<typeof setInterval> | null;
}

export interface BridgeManagerOptions {
  router?: ChannelRouter;
  permissionBroker?: PermissionBroker;
}

export class BridgeManager {
  private store: JsonFileStore;
  private llm: LLMProvider;
  private router: ChannelRouter;
  private engine: ConversationEngine;
  private permissionBroker: PermissionBroker;

  private state: BridgeManagerState = {
    adapters: new Map(),
    adapterMeta: new Map(),
    running: false,
    startedAt: null,
    loopAborts: new Map(),
    activeTasks: new Map(),
    sessionLocks: new Map(),
    cleanupInterval: null,
  };

  constructor(
    store: JsonFileStore,
    llm: LLMProvider,
    options: BridgeManagerOptions = {},
  ) {
    this.store = store;
    this.llm = llm;
    this.router = options.router || new ChannelRouter(store);
    this.engine = new ConversationEngine(llm, store);
    this.permissionBroker = options.permissionBroker || new PermissionBroker();
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    this.state.adapters.set(adapter.adapterId, adapter);
    this.state.adapterMeta.set(adapter.adapterId, {
      connectedAt: null,
      lastMessageAt: null,
      error: null,
    });
    info('bridge-manager', `Registered adapter: ${adapter.adapterId}`);
  }

  async start(): Promise<void> {
    if (this.state.running) {
      warn('bridge-manager', 'Bridge is already running');
      return;
    }

    this.state.running = true;
    this.state.startedAt = new Date().toISOString();

    info('bridge-manager', 'Starting bridge manager');

    // Start all adapters and their message loops
    for (const [adapterId, adapter] of this.state.adapters) {
      try {
        await adapter.start();
        this.state.adapterMeta.get(adapterId)!.connectedAt = new Date().toISOString();

        // Start message loop for this adapter
        const abortController = new AbortController();
        this.state.loopAborts.set(adapterId, abortController);

        this.runAdapterLoop(adapter, abortController.signal).catch(e => {
          error('bridge-manager', `Adapter ${adapterId} loop failed: ${e.message}`);
          this.state.adapterMeta.get(adapterId)!.error = e.message;
        });
      } catch (e) {
        error('bridge-manager', `Failed to start adapter ${adapterId}: ${e}`);
        this.state.adapterMeta.get(adapterId)!.error = String(e);
      }
    }

    // Start permission broker cleanup timer
    this.state.cleanupInterval = setInterval(() => this.permissionBroker.cleanup(), 60 * 1000);

    info('bridge-manager', 'Bridge manager started with adapters: ' + Array.from(this.state.adapters.keys()).join(', '));
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;

    info('bridge-manager', 'Stopping bridge manager');

    // Abort all loops
    for (const [adapterId, abortController] of this.state.loopAborts) {
      abortController.abort();
    }

    // Stop cleanup interval
    if (this.state.cleanupInterval) {
      clearInterval(this.state.cleanupInterval);
      this.state.cleanupInterval = null;
    }

    // Stop all adapters
    for (const [adapterId, adapter] of this.state.adapters) {
      try {
        await adapter.stop();
      } catch (e) {
        error('bridge-manager', `Error stopping adapter ${adapterId}: ${e}`);
      }
    }

    this.state.running = false;
    this.state.startedAt = null;
    this.state.loopAborts.clear();
    this.state.activeTasks.clear();

    info('bridge-manager', 'Bridge manager stopped');
  }

  getStatus(): BridgeStatus {
    const adapters: AdapterStatus[] = [];

    for (const [adapterId, adapter] of this.state.adapters) {
      const meta = this.state.adapterMeta.get(adapterId);
      adapters.push({
        adapterId,
        channelType: adapter.channelType,
        profileId: adapter.profileId,
        label: adapter.label,
        running: adapter.isRunning(),
        connectedAt: meta?.connectedAt || null,
        lastMessageAt: meta?.lastMessageAt || null,
        error: meta?.error || null,
      });
    }

    return {
      running: this.state.running,
      startedAt: this.state.startedAt,
      adapters,
    };
  }

  private async runAdapterLoop(
    adapter: BaseChannelAdapter,
    abortSignal: AbortSignal,
  ): Promise<void> {
    info('bridge-manager', `Starting message loop for adapter: ${adapter.adapterId}`);

    while (!abortSignal.aborted && this.state.running) {
      try {
        const message = await adapter.consumeOne();
        if (!message) continue;

        // Update meta
        const meta = this.state.adapterMeta.get(adapter.adapterId);
        if (meta) meta.lastMessageAt = new Date().toISOString();

        // Handle callback (button presses, etc.)
        if (message.callbackData) {
          // Check if it's a permission callback
          const permissionResult = this.permissionBroker.handleCallbackWithResult(message.callbackData);
          if (permissionResult.handled) {
            debug('bridge-manager', `Resolved permission callback: ${message.callbackData}`);
            await this.handleResolvedPermissionCallback(adapter, message, permissionResult);
            continue;
          }
          await this.handleCallback(adapter, message);
          continue;
        }

        // Process regular message
        this.processMessage(adapter, message).catch(e => {
          error('bridge-manager', `Failed to process message: ${e.message}`);
        });
      } catch (e) {
        if (abortSignal.aborted) break;
        error('bridge-manager', `Loop error: ${e}`);
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    info('bridge-manager', `Message loop ended for adapter: ${adapter.adapterId}`);
  }

  private async processMessage(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
  ): Promise<void> {
    debug('bridge-manager', `Processing message: ${message.text.slice(0, 50)}...`);

    // Parse commands (/new, /reset, /stop, /mode, etc.)
    const cmd = this.parseCommand(message.text);
    if (cmd) {
      return await this.handleCommand(adapter, message, cmd);
    }

    // Regular message — route to existing binding or create new one
    let binding = this.router.resolve(message.address);

    if (!binding) {
      // No binding exists — send instructions to create one
      if (message.address.channelType === 'telegram') {
        const card = buildNewSessionCard();
        await adapter.send({
          address: message.address,
          text: card.text,
          parseMode: card.parseMode,
          inlineButtons: card.inlineButtons,
        });
      } else {
        await adapter.send({
          address: message.address,
          text: '👋 Welcome! Please send `/new:claude` or `/new:codex` to start a session.',
          parseMode: 'Markdown',
        });
      }
      return;
    }

    // Process with session lock (serialize messages to same session)
    await this.processWithSessionLock(binding.id, async () => {
      const abortController = new AbortController();
      this.state.activeTasks.set(binding.id, abortController);

      const previewCaps = adapter.getPreviewCapabilities?.(message.address) || null;
      const canPreview = Boolean(
        previewCaps?.supported &&
        adapter.primePreview &&
        adapter.sendPreview,
      );
      const draftId = canPreview ? Math.floor(Math.random() * 0x7fffffff) + 1 : null;
      let previewUpdates = Promise.resolve();
      let previewActive = false;

      if (canPreview && draftId !== null) {
        try {
          const primed = await adapter.primePreview!(message.address, draftId);
          previewActive = primed === 'sent' || primed === 'skip';
        } catch (e) {
          debug('bridge-manager', `Preview prime failed: ${e}`);
        }
      }

      const onPartialText = canPreview && draftId !== null
        ? (text: string) => {
            previewUpdates = previewUpdates
              .then(async () => {
                const outcome = await adapter.sendPreview!(message.address, text, draftId);
                if (outcome === 'sent') previewActive = true;
              })
              .catch(e => debug('bridge-manager', `Preview update failed: ${e}`));
          }
        : undefined;

      const onActivityEvent = adapter.upsertActivityEvent && adapter.shouldProjectActivityEvent
        ? (event: {
            type: 'command' | 'file_change' | 'tool_use' | 'progress';
            title: string;
            description?: string;
            metadata?: Record<string, unknown>;
          }) => {
            const activityEvent = {
              ...event,
              timestamp: Date.now(),
            };
            if (!adapter.shouldProjectActivityEvent?.(activityEvent)) return;
            void adapter.upsertActivityEvent?.(message.address, activityEvent, message.messageId);
          }
        : undefined;

      try {
        const result = await this.engine.processMessage(binding, adapter, this.renderInboundPrompt(message), {
          permissionBroker: this.permissionBroker,
          onPartialText,
          onActivityEvent,
          abortSignal: abortController.signal,
        });

        await previewUpdates;

        if (!result.ok) {
          error('bridge-manager', `Conversation failed: ${result.error}`);
          await adapter.send({
            address: message.address,
            text: `❌ ${result.error || 'Conversation failed'}`,
            parseMode: 'Markdown',
          });
        } else if (result.sdkSessionId) {
          binding.sdkSessionId = result.sdkSessionId;
        }

        binding.updatedAt = new Date().toISOString();
        this.store.saveBinding(binding);

        if (canPreview && draftId !== null) {
          if (result.ok && result.text) {
            if (previewActive) {
              const finalized = await adapter.finalizePreview?.(message.address, result.text, draftId);
              if (!finalized?.ok) {
                await adapter.send({
                  address: message.address,
                  text: result.text,
                  parseMode: 'Markdown',
                });
              }
            } else {
              await adapter.send({
                address: message.address,
                text: result.text,
                parseMode: 'Markdown',
              });
            }
          }
          adapter.endPreview?.(message.address, draftId);
        }
      } finally {
        this.state.activeTasks.delete(binding.id);
        abortController.abort();
      }
    });
  }

  private async handleCommand(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    cmd: { name: string; args: string[] },
  ): Promise<void> {
    switch (cmd.name) {
      case 'start':
      case 'help': {
        await adapter.send({
          address: message.address,
          text: this.renderHelpMessage(),
          parseMode: 'Markdown',
        });
        break;
      }

      case 'new': {
        const arg = cmd.args[0];
        if (!arg && message.address.channelType === 'telegram') {
          const card = buildNewSessionCard();
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
          break;
        }

        const runtime: 'claude' | 'codex' = arg === 'codex' ? 'codex' : 'claude';
        const binding = this.router.createBinding({
          channelType: message.address.channelType,
          channelInstanceId: message.address.channelInstanceId || 'default',
          chatId: message.address.chatId,
          agentSessionId: `session_${Date.now()}`,
          workingDirectory: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
          runtime,
          model: 'default',
          mode: 'code',
        });
        await adapter.send({
          address: message.address,
          text: `✅ Created new ${runtime} session: \`${binding.agentSessionId}\``,
          parseMode: 'Markdown',
        });
        break;
      }

      case 'reset': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          binding.updatedAt = new Date().toISOString();
          this.router.deactivateBinding(binding.id);
          if (message.address.channelType === 'telegram') {
            const card = buildResetConfirmationCard(binding.id, binding.runtime);
            await adapter.send({
              address: message.address,
              text: card.text,
              parseMode: card.parseMode,
              inlineButtons: card.inlineButtons,
            });
          } else {
            await adapter.send({
              address: message.address,
              text: '🔄 Session reset. Send `/new` to start fresh.',
              parseMode: 'Markdown',
            });
          }
        }
        break;
      }

      case 'stop': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          const task = this.state.activeTasks.get(binding.id);
          if (task) {
            task.abort();
            this.state.activeTasks.delete(binding.id);
          }
          await adapter.send({
            address: message.address,
            text: '🛑 Active task stopped.',
            parseMode: 'Markdown',
          });
        }
        break;
      }

      case 'mode': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          const mode = cmd.args[0];
          if (!mode && message.address.channelType === 'telegram' && binding.runtime === 'claude') {
            const card = buildClaudeModeCard(binding.claudePermissionMode || 'default', binding.id);
            await adapter.send({
              address: message.address,
              text: card.text,
              parseMode: card.parseMode,
              inlineButtons: card.inlineButtons,
            });
            break;
          }

          if (mode === 'code' || mode === 'plan' || mode === 'ask') {
            binding.mode = mode;
            binding.updatedAt = new Date().toISOString();
            this.store.saveBinding(binding);
            await adapter.send({
              address: message.address,
              text: `✅ Mode changed to: \`${mode}\``,
              parseMode: 'Markdown',
            });
          }
        }
        break;
      }

      case 'resume': {
        if (message.address.channelType === 'telegram') {
          await this.sendTelegramResumeCard(adapter, message.address);
        }
        break;
      }

      default:
        await adapter.send({
          address: message.address,
          text: `❌ Unknown command: /${cmd.name}\n\nSend \`/help\` to see available commands.`,
          parseMode: 'Markdown',
        });
    }
  }

  private parseCommand(text: string): { name: string; args: string[] } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const withoutSlash = trimmed.slice(1);
    const [commandToken, ...restTokens] = withoutSlash.split(/\s+/).filter(Boolean);
    if (!commandToken) return null;

    const [name, ...inlineArgs] = commandToken.split(':').filter(Boolean);
    if (!name) return null;

    const args = [...inlineArgs, ...restTokens];

    return { name, args };
  }

  private renderHelpMessage(): string {
    return `👋 *agentmobile Bot* is ready.

Commands:
• \`/new:claude\` — start a Claude Code session
• \`/new:codex\` — start a Codex session
• \`/reset\` — reset the current session
• \`/stop\` — stop the active task
• \`/mode code|plan|ask\` — change session mode
• \`/help\` — show this help

After creating a session, send any text to continue the conversation.`;
  }

  private async handleResolvedPermissionCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    result: {
      request?: { toolName: string };
      resolution?: 'allow' | 'allow_session' | 'deny';
    },
  ): Promise<void> {
    await adapter.answerCallback(message.messageId, 'Permission recorded');
    if (!message.callbackMessageId || !adapter.patchCard) return;

    const resolution = result.resolution;
    if (!resolution) return;

    const card = buildHandledPermissionCard(result.request?.toolName || 'Requested tool', resolution);
    await adapter.patchCard(message.address, message.callbackMessageId, card);
  }

  private async handleCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
  ): Promise<void> {
    const callbackData = message.callbackData;
    if (!callbackData) return;

    try {
      if (callbackData.startsWith('new-session:')) {
        await this.handleNewSessionCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('resume:')) {
        await this.handleResumeCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('claude-mode:')) {
        await this.handleClaudeModeCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('input:')) {
        await adapter.answerCallback(message.messageId, 'Input recorded');
        return;
      }
      if (callbackData.startsWith('plan:') || callbackData.startsWith('planexit:')) {
        await adapter.answerCallback(message.messageId, 'Action recorded');
        return;
      }

      await adapter.answerCallback(message.messageId, 'Unsupported action');
    } catch (e) {
      error('bridge-manager', `Callback failed for ${callbackData}: ${e}`);
      await adapter.answerCallback(message.messageId, 'Action failed');
    }
  }

  private async handleNewSessionCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const parts = callbackData.split(':');
    if (parts.length < 3) {
      await adapter.answerCallback(message.messageId, 'Invalid session action');
      return;
    }

    const runtime = parts[1] === 'codex' ? 'codex' : 'claude';
    const mode = this.normalizeMode(parts[2]);
    const binding = this.router.createBinding({
      channelType: message.address.channelType,
      channelInstanceId: message.address.channelInstanceId || adapter.profileId || 'default',
      chatId: message.address.chatId,
      agentSessionId: `session_${Date.now()}`,
      workingDirectory: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
      runtime,
      model: 'default',
      mode,
    });

    const card = buildSessionCreatedCard(runtime, mode, binding);
    await this.patchOrSendCard(adapter, message, card);
    await adapter.answerCallback(message.messageId, 'Session created');
  }

  private async handleResumeCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const parts = callbackData.split(':');
    if (parts.length < 4) {
      await adapter.answerCallback(message.messageId, 'Invalid resume action');
      return;
    }

    const runtime = parts[2] === 'codex' ? 'codex' : 'claude';
    const bindingId = parts[3];
    const binding = this.store.getBinding(bindingId);
    if (!binding) {
      await adapter.answerCallback(message.messageId, 'Session not found');
      return;
    }

    for (const existing of this.router.listBindings(message.address.channelType)) {
      if (
        existing.id !== bindingId &&
        existing.active &&
        existing.channelInstanceId === binding.channelInstanceId &&
        existing.chatId === message.address.chatId
      ) {
        this.router.deactivateBinding(existing.id);
      }
    }

    binding.active = true;
    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);

    const card = buildSessionResumedCard(runtime, bindingId);
    await this.patchOrSendCard(adapter, message, card);
    await adapter.answerCallback(message.messageId, 'Session resumed');
  }

  private async handleClaudeModeCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const parts = callbackData.split(':');
    if (parts.length < 3) {
      await adapter.answerCallback(message.messageId, 'Invalid mode action');
      return;
    }

    const bindingId = parts[1];
    const requestedMode: ClaudePermissionMode = normalizeClaudePermissionMode(parts[2]);
    const binding = this.store.getBinding(bindingId);
    if (!binding || binding.runtime !== 'claude') {
      await adapter.answerCallback(message.messageId, 'No active Claude session found');
      return;
    }

    binding.claudePermissionMode = requestedMode;
    binding.updatedAt = new Date().toISOString();
    if (requestedMode === 'plan') {
      binding.mode = 'plan';
    } else if (binding.mode === 'plan') {
      binding.mode = 'code';
    }
    this.store.saveBinding(binding);

    const card = buildClaudeModeCard(requestedMode, bindingId);
    await this.patchOrSendCard(adapter, message, card);
    await adapter.answerCallback(message.messageId, 'Mode updated');
  }

  private async sendTelegramResumeCard(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
  ): Promise<void> {
    const sessions = this.store.listBindings()
      .sort((a, b) => {
        const sameChat = Number(
          a.channelType === address.channelType &&
          a.channelInstanceId === (address.channelInstanceId || adapter.profileId || 'default') &&
          a.chatId === address.chatId,
        ) - Number(
          b.channelType === address.channelType &&
          b.channelInstanceId === (address.channelInstanceId || adapter.profileId || 'default') &&
          b.chatId === address.chatId,
        );
        if (sameChat !== 0) return -sameChat;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      })
      .slice(0, 5)
      .map(binding => ({
        id: binding.id,
        title: `${binding.runtime} · ${binding.workingDirectory.split('/').filter(Boolean).pop() || 'session'}`,
        runtime: binding.runtime,
        updatedAt: binding.updatedAt,
      }));

    const card = buildResumeCard(sessions);
    await adapter.send({
      address,
      text: card.text,
      parseMode: card.parseMode,
      inlineButtons: card.inlineButtons,
    });
  }

  private async patchOrSendCard(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    card: CardMessage,
  ): Promise<void> {
    if (message.callbackMessageId && adapter.patchCard) {
      const result = await adapter.patchCard(message.address, message.callbackMessageId, card);
      if (result.ok) return;
    }

    await adapter.send({
      address: message.address,
      text: card.text,
      parseMode: card.parseMode,
      inlineButtons: card.inlineButtons,
    });
  }

  private normalizeMode(value: string): 'code' | 'plan' | 'ask' {
    if (value === 'plan' || value === 'ask') return value;
    return 'code';
  }

  private renderInboundPrompt(message: InboundMessage): string {
    const baseText = message.text.trim();
    if (!message.attachments || message.attachments.length === 0) {
      return baseText;
    }

    const attachmentLines = message.attachments.map(attachment =>
      `- ${attachment.fileName}: ${attachment.filePath}`,
    );

    const prefix = baseText || 'Please use the attached files as context for this request.';
    return `${prefix}\n\nAttached files:\n${attachmentLines.join('\n')}`;
  }

  private async processWithSessionLock(
    sessionId: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    // Create the lock promise FIRST, before awaiting any existing one.
    // This prevents a race where two concurrent callers both check,
    // find no lock, and enter simultaneously.
    let resolveNewLock: (() => void) | undefined;
    const newLock = new Promise<void>(resolve => {
      resolveNewLock = resolve;
    });

    const existingLock = this.state.sessionLocks.get(sessionId);
    this.state.sessionLocks.set(sessionId, newLock);

    // Wait for any previous holder
    if (existingLock) {
      await existingLock;
    }

    try {
      await fn();
    } finally {
      resolveNewLock?.();
      // Only delete if we're still the current lock holder
      if (this.state.sessionLocks.get(sessionId) === newLock) {
        this.state.sessionLocks.delete(sessionId);
      }
    }
  }
}
