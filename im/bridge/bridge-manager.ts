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
  PlanWorkflow,
} from './types.js';
import { resolveChannelInstanceId } from './types.js';
import type { ActivityEventInfo } from './context.js';
import type { LLMProvider } from './context.js';
import { ChannelRouter } from './channel-router.js';
import { ConversationEngine } from './conversation-engine.js';
import { PermissionBroker } from './permission-broker.js';
import { JsonFileStore } from '../infra/store.js';
import {
  CodexTerminalSessionManager,
  type CodexTerminalCallbacks,
  type CodexTerminalKey,
  type CodexTerminalRuntime,
  isCodexTerminalKey,
} from '../runtime/codex-terminal-session.js';
import {
  buildClaudeModeCard,
  buildCodexControlCard,
  buildCommandCenterCard,
  buildCommandStatusCard,
  buildCallbackErrorCard,
  buildDirectoryCard,
  buildModeSelectionCard,
  buildHandledPermissionCard,
  buildNewSessionCard,
  buildPlanCancelledCard,
  buildPlanCompletedCard,
  buildPlanDraftingCard,
  buildPlanExecutingCard,
  buildPlanReadyCard,
  buildPlanRevisionRequestedCard,
  buildResetConfirmationCard,
  buildResumeCard,
  buildSessionDeletedCard,
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
  codexTerminalRuntime?: CodexTerminalRuntime;
}

interface TerminalPreviewState {
  address: ChannelAddress;
  draftId: number;
  active: boolean;
}

interface PreviewRunResult {
  ok: boolean;
  text: string;
  sdkSessionId?: string;
  previewMessageId?: string;
}

interface TerminalLiveProjection {
  callbacks: CodexTerminalCallbacks;
  primePreview: () => Promise<void>;
  flushPreviewUpdates: () => Promise<void>;
  sendPreviewText: (text: string) => Promise<boolean>;
  getLatestTranscript: () => string;
  canPreview: boolean;
  draftId: number | null;
}

export class BridgeManager {
  private store: JsonFileStore;
  private llm: LLMProvider;
  private router: ChannelRouter;
  private engine: ConversationEngine;
  private permissionBroker: PermissionBroker;
  private codexTerminalRuntime: CodexTerminalRuntime;
  private terminalPreviews = new Map<string, TerminalPreviewState>();

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
    this.codexTerminalRuntime = options.codexTerminalRuntime || new CodexTerminalSessionManager();
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
    this.terminalPreviews.clear();
    this.codexTerminalRuntime.stopAll();

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

    let binding = this.router.resolve(message.address);
    const escapedCodexText = binding && this.isTelegramCodexTerminalBinding(binding, message)
      ? this.unescapeTelegramCodexSlash(message.text)
      : null;

    // Parse commands (/new, /reset, /stop, /mode, etc.)
    const cmd = escapedCodexText === null ? this.parseCommand(message.text) : null;
    if (cmd) {
      return await this.handleCommand(adapter, message, cmd);
    }

    // Regular message — route to existing binding or create new one
    if (!binding) {
      // No binding exists — send instructions to create one
      if (message.address.channelType === 'telegram') {
        const card = buildCommandCenterCard();
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
      const currentBinding = this.store.getBinding(binding.id) || binding;
      const activeWorkflow = this.store.getActivePlanWorkflowByBinding(currentBinding.id);
      if (
        message.address.channelType === 'telegram' &&
        (currentBinding.mode === 'plan' || activeWorkflow?.status === 'revising')
      ) {
        await this.processTelegramPlanWorkflowMessage(
          adapter,
          message,
          currentBinding,
          this.renderInboundPrompt(message, escapedCodexText ?? undefined),
        );
        return;
      }

      if (this.isTelegramCodexTerminalBinding(binding, message)) {
        await this.processTelegramCodexInput(
          adapter,
          message,
          currentBinding,
          this.renderInboundPrompt(message, escapedCodexText ?? undefined),
        );
        return;
      }

      const result = await this.runConversationWithPreview(
        adapter,
        message,
        currentBinding,
        this.renderInboundPrompt(message),
      );

      if (result.sdkSessionId) {
        currentBinding.sdkSessionId = result.sdkSessionId;
      }
      currentBinding.updatedAt = new Date().toISOString();
      this.store.saveBinding(currentBinding);
    });
  }

  private unescapeTelegramCodexSlash(text: string): string | null {
    const leadingWhitespace = text.match(/^\s*/)?.[0] || '';
    const rest = text.slice(leadingWhitespace.length);
    if (!rest.startsWith('//')) return null;
    return leadingWhitespace + rest.slice(1);
  }

  private isTelegramCodexTerminalBinding(binding: ChannelBinding, message: InboundMessage): boolean {
    return binding.runtime === 'codex' && message.address.channelType === 'telegram';
  }

  private async processTelegramCodexInput(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
    text: string,
  ): Promise<void> {
    const projection = this.createTerminalLiveProjection(adapter, message, binding);

    try {
      await projection.primePreview();
      const previousTranscript = projection.getLatestTranscript();
      this.codexTerminalRuntime.sendInput(binding, text, projection.callbacks);
      binding.terminalSessionId ||= `codex_terminal_${binding.id}`;
      binding.updatedAt = new Date().toISOString();
      this.store.saveBinding(binding);

      if (projection.getLatestTranscript() === previousTranscript) {
        await this.waitForTerminalOutput(binding.id, projection.getLatestTranscript, previousTranscript);
      }
      await projection.flushPreviewUpdates();

      const finalText = this.renderCodexTranscript(projection.getLatestTranscript()) || 'Codex terminal session started.';
      if (projection.canPreview && projection.draftId !== null) {
        await projection.sendPreviewText(finalText);
      } else {
        await adapter.send({
          address: message.address,
          text: finalText,
          parseMode: 'plain',
        });
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('bridge-manager', `Codex terminal input failed: ${err.message}`);
      if (projection.canPreview && projection.draftId !== null) {
        await projection.flushPreviewUpdates();
        const finalText = `❌ ${err.message}`;
        await projection.sendPreviewText(finalText);
        return;
      }
      await adapter.send({
        address: message.address,
        text: `❌ ${err.message}`,
        parseMode: 'plain',
      });
    }
  }

  private createTerminalLiveProjection(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
  ): TerminalLiveProjection {
    const previewCaps = adapter.getPreviewCapabilities?.(message.address) || null;
    const canPreview = Boolean(
      previewCaps?.supported &&
      adapter.primePreview &&
      adapter.sendPreview,
    );
    const terminalPreview = canPreview
      ? this.getOrCreateTerminalPreview(binding.id, message.address)
      : null;
    const draftId = terminalPreview?.draftId ?? null;
    let previewUpdates = Promise.resolve();
    let previewActive = Boolean(terminalPreview?.active);
    let latestTranscript = this.codexTerminalRuntime.getTranscriptSnapshot(binding.id);
    let latestStatus = '';

    const sendPreviewText = async (projected: string): Promise<boolean> => {
      if (!canPreview || draftId === null || !adapter.sendPreview) return false;
      const outcome = await adapter.sendPreview(message.address, projected, draftId);
      if (outcome === 'sent') {
        previewActive = true;
        if (terminalPreview) terminalPreview.active = true;
      }
      return outcome === 'sent' || outcome === 'skip';
    };

    const onTranscriptUpdate = (transcript: string) => {
      latestTranscript = transcript;
      if (!canPreview || draftId === null) return;
      const projected = this.renderCodexLiveProgress(transcript, latestStatus);
      previewUpdates = previewUpdates
        .then(async () => {
          await sendPreviewText(projected);
        })
        .catch(e => debug('bridge-manager', `Codex terminal preview update failed: ${e}`));
    };

    const activityProjector = this.buildActivityProjector(adapter, message);
    const onActivityEvent = (event: ActivityEventInfo) => {
      activityProjector?.(event);
      latestStatus = this.describeLiveActivity(binding, event);
      if (!canPreview || draftId === null) return;
      previewUpdates = previewUpdates
        .then(async () => {
          await sendPreviewText(this.renderCodexLiveProgress(latestTranscript, latestStatus));
        })
        .catch(e => debug('bridge-manager', `Codex terminal activity preview update failed: ${e}`));
    };

    return {
      callbacks: {
        onTranscriptUpdate,
        onActivityEvent,
      },
      primePreview: async () => {
        if (!canPreview || draftId === null || previewActive || !adapter.primePreview) return;
        try {
          const primed = await adapter.primePreview(message.address, draftId);
          previewActive = primed === 'sent' || primed === 'skip';
          if (terminalPreview) terminalPreview.active = previewActive;
        } catch (e) {
          debug('bridge-manager', `Codex terminal preview prime failed: ${e}`);
        }
      },
      flushPreviewUpdates: async () => {
        await previewUpdates;
      },
      sendPreviewText,
      getLatestTranscript: () => latestTranscript,
      canPreview,
      draftId,
    };
  }

  private buildActivityProjector(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
  ): ((event: ActivityEventInfo) => void) | undefined {
    if (!adapter.upsertActivityEvent || !adapter.shouldProjectActivityEvent) return undefined;
    return (event: ActivityEventInfo) => {
      const activityEvent = {
        ...event,
        timestamp: Date.now(),
      };
      if (!adapter.shouldProjectActivityEvent?.(activityEvent)) return;
      void adapter.upsertActivityEvent?.(message.address, activityEvent, message.messageId);
    };
  }

  private renderCodexTranscript(transcript: string): string {
    const trimmed = transcript.trim();
    if (!trimmed) return '';
    const maxChars = 3800;
    return trimmed.length <= maxChars
      ? trimmed
      : `...[transcript truncated]\n${trimmed.slice(trimmed.length - maxChars)}`;
  }

  private renderCodexLiveProgress(transcript: string, status: string): string {
    const body = this.renderCodexTranscript(transcript);
    if (!status) return body;
    return body
      ? `Codex live progress\n\n${status}\n\nTerminal:\n${body}`
      : `Codex live progress\n\n${status}`;
  }

  private renderAgentLiveProgress(binding: ChannelBinding, status: string, text: string): string {
    const runtimeLabel = binding.runtime === 'codex' ? 'Codex' : 'Claude';
    const body = text.trim();
    return body
      ? `${runtimeLabel} live progress\n\n${status}\n\nResponse:\n${body}`
      : `${runtimeLabel} live progress\n\n${status}\n\nWaiting for public output...`;
  }

  private describeInitialLiveStatus(binding: ChannelBinding): string {
    const runtimeLabel = binding.runtime === 'codex' ? 'Codex' : 'Claude';
    const mode = binding.mode === 'plan' ? 'plan mode' : binding.mode === 'ask' ? 'ask mode' : 'code mode';
    return `${runtimeLabel} is working in ${mode}. Hidden chain-of-thought is not shown.`;
  }

  private describeLiveActivity(binding: ChannelBinding, event: ActivityEventInfo): string {
    const runtimeLabel = binding.runtime === 'codex' ? 'Codex' : 'Claude';
    const description = event.description?.trim();
    switch (event.type) {
      case 'tool_use':
        return `${runtimeLabel} is using tool: ${event.title}${description ? `\n${description}` : ''}`;
      case 'command':
        return `${runtimeLabel} is running command: ${event.title}${description ? `\n${description}` : ''}`;
      case 'file_change':
        return `${runtimeLabel} is updating files${description ? `\n${description}` : ''}`;
      case 'progress':
      default:
        return `${event.title}${description ? `\n${description}` : ''}`;
    }
  }

  private getOrCreateTerminalPreview(bindingId: string, address: ChannelAddress): TerminalPreviewState {
    const existing = this.terminalPreviews.get(bindingId);
    if (existing) {
      existing.address = address;
      return existing;
    }

    const created: TerminalPreviewState = {
      address,
      draftId: Math.floor(Math.random() * 0x7fffffff) + 1,
      active: false,
    };
    this.terminalPreviews.set(bindingId, created);
    return created;
  }

  private endTerminalPreview(adapter: BaseChannelAdapter, bindingId: string): void {
    const preview = this.terminalPreviews.get(bindingId);
    if (!preview) return;
    adapter.endPreview?.(preview.address, preview.draftId);
    this.terminalPreviews.delete(bindingId);
  }

  private renderScreenSnapshot(snapshot: string): string {
    const body = snapshot.trimEnd() || '(no active Codex terminal screen yet)';
    const prefix = 'Codex screen snapshot:\n\n';
    const maxChars = 4096 - prefix.length;
    if (body.length <= maxChars) {
      return prefix + body;
    }

    const marker = '[screen truncated to tail]\n';
    return prefix + marker + body.slice(body.length - maxChars + marker.length);
  }

  private async runConversationWithPreview(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
    promptText: string,
    options: {
      finalCard?: (resultText: string) => CardMessage;
      keepPreviewOpen?: boolean;
    } = {},
  ): Promise<PreviewRunResult> {
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
    let previewMessageId: string | undefined;
    let latestText = '';
    let latestStatus = this.describeInitialLiveStatus(binding);
    const useLiveProgressPreview = message.address.channelType === 'telegram';

    const queuePreviewUpdate = (projected: string) => {
      if (!canPreview || draftId === null || !adapter.sendPreview) return;
      previewUpdates = previewUpdates
        .then(async () => {
          const outcome = await adapter.sendPreview!(message.address, projected, draftId);
          if (outcome === 'sent' || outcome === 'skip') previewActive = true;
        })
        .catch(e => debug('bridge-manager', `Preview update failed: ${e}`));
    };

    if (canPreview && draftId !== null) {
      try {
        const primed = await adapter.primePreview!(message.address, draftId);
        previewActive = primed === 'sent' || primed === 'skip';
        if (useLiveProgressPreview) {
          queuePreviewUpdate(this.renderAgentLiveProgress(binding, latestStatus, latestText));
        }
      } catch (e) {
        debug('bridge-manager', `Preview prime failed: ${e}`);
      }
    }

    const onPartialText = canPreview && draftId !== null
      ? (text: string) => {
          latestText = text;
          latestStatus = `${binding.runtime === 'codex' ? 'Codex' : 'Claude'} is streaming a public response.`;
          queuePreviewUpdate(useLiveProgressPreview
            ? this.renderAgentLiveProgress(binding, latestStatus, latestText)
            : latestText);
        }
      : undefined;

    const activityProjector = this.buildActivityProjector(adapter, message);
    const onActivityEvent = (event: {
      type: 'command' | 'file_change' | 'tool_use' | 'progress';
      title: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }) => {
      latestStatus = this.describeLiveActivity(binding, event);
      if (useLiveProgressPreview) {
        queuePreviewUpdate(this.renderAgentLiveProgress(binding, latestStatus, latestText));
      }
      activityProjector?.(event);
    };

    try {
      const result = await this.engine.processMessage(binding, adapter, promptText, {
        permissionBroker: this.permissionBroker,
        onPartialText,
        onActivityEvent,
        abortSignal: abortController.signal,
      });

      await previewUpdates;

      if (!result.ok) {
        error('bridge-manager', `Conversation failed: ${result.error}`);
      }

      const finalText = result.ok
        ? result.text || 'No response text was returned.'
        : `❌ ${result.error || 'Conversation failed'}`;

      if (canPreview && draftId !== null) {
        if (previewActive) {
          const finalized = options.finalCard && adapter.patchCard
            ? await this.patchActivePreviewWithCard(adapter, message.address, draftId, options.finalCard(finalText))
            : await adapter.finalizePreview?.(message.address, finalText, draftId);
          previewMessageId = finalized?.messageId;
          if (!finalized?.ok) {
            await adapter.send({
              address: message.address,
              text: finalText,
              parseMode: 'Markdown',
            });
          }
        } else {
          const sent = await adapter.send({
            address: message.address,
            text: finalText,
            parseMode: 'Markdown',
          });
          previewMessageId = sent.messageId;
        }
        if (!options.keepPreviewOpen) {
          adapter.endPreview?.(message.address, draftId);
        }
      } else if (options.finalCard || !result.ok || !result.text) {
        const card = options.finalCard?.(finalText);
        const sent = await adapter.send({
          address: message.address,
          text: card?.text || finalText,
          parseMode: card?.parseMode || 'Markdown',
          inlineButtons: card?.inlineButtons,
        });
        previewMessageId = sent.messageId;
      }

      return {
        ok: result.ok,
        text: finalText,
        sdkSessionId: result.sdkSessionId,
        previewMessageId,
      };
    } finally {
      this.state.activeTasks.delete(binding.id);
      abortController.abort();
    }
  }

  private async patchActivePreviewWithCard(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
    draftId: number,
    card: CardMessage,
  ): Promise<{ ok: boolean; messageId?: string; error?: string } | undefined> {
    const patched = await adapter.finalizePreview?.(address, card.text, draftId);
    if (!patched?.ok || !patched.messageId || !adapter.patchCard) return patched;
    const patchedCard = await adapter.patchCard(address, patched.messageId, card);
    return patchedCard.ok ? patchedCard : patched;
  }

  private async waitForTerminalOutput(
    bindingId: string,
    getTranscript: () => string,
    before: string,
  ): Promise<void> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const current = getTranscript() || this.codexTerminalRuntime.getTranscriptSnapshot(bindingId);
      if (current && current !== before) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async handleTerminalKeyCommand(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    name: string,
  ): Promise<void> {
    const binding = this.router.resolve(message.address);
    if (!binding) {
      await this.sendNoActiveSessionMessage(adapter, message.address);
      return;
    }

    if (!this.isTelegramCodexTerminalBinding(binding, message)) {
      await adapter.send({
        address: message.address,
        text: `❌ \`/${name}\` is available for Telegram Codex terminal sessions.`,
        parseMode: 'Markdown',
      });
      return;
    }

    if (!isCodexTerminalKey(name)) {
      await adapter.send({
        address: message.address,
        text: `❌ Unsupported terminal key: /${name}`,
        parseMode: 'Markdown',
      });
      return;
    }

    const projection = this.createTerminalLiveProjection(adapter, message, binding);
    await projection.primePreview();
    const previousTranscript = projection.getLatestTranscript();
    const session = this.codexTerminalRuntime.sendKey(binding, name as CodexTerminalKey, projection.callbacks);
    if (!session) {
      await adapter.send({
        address: message.address,
        text: '❌ No active Codex terminal. Send a prompt first, or use `/new:codex` to create a session.',
        parseMode: 'Markdown',
      });
      return;
    }

    if (projection.getLatestTranscript() === previousTranscript) {
      await this.waitForTerminalOutput(binding.id, projection.getLatestTranscript, previousTranscript);
    }
    await projection.flushPreviewUpdates();
    const latestText = this.renderCodexTranscript(projection.getLatestTranscript());
    if (latestText && projection.canPreview && projection.draftId !== null) {
      await projection.sendPreviewText(latestText);
    }

    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);
  }

  private async sendCodexScreenSnapshot(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    patchMessageId?: string,
  ): Promise<void> {
    const binding = this.router.resolve(message.address);
    if (!binding) {
      await this.sendNoActiveSessionMessage(adapter, message.address);
      return;
    }
    if (!this.isTelegramCodexTerminalBinding(binding, message)) {
      const card = buildCallbackErrorCard('/screen is available for Telegram Codex terminal sessions.');
      await this.sendOrPatchTelegramCard(adapter, message.address, card, patchMessageId);
      return;
    }

    const snapshot = this.codexTerminalRuntime.getTranscriptSnapshot(binding.id) ||
      this.codexTerminalRuntime.getScreenSnapshot(binding.id);
    const card: CardMessage = {
      text: this.renderScreenSnapshot(snapshot),
      parseMode: 'plain',
    };
    await this.sendOrPatchTelegramCard(adapter, message.address, card, patchMessageId);
  }

  private async resetActiveBinding(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    patchMessageId?: string,
  ): Promise<void> {
    const binding = this.router.resolve(message.address);
    if (!binding) {
      await this.sendNoActiveSessionMessage(adapter, message.address);
      return;
    }

    this.codexTerminalRuntime.stopSession(binding.id);
    this.endTerminalPreview(adapter, binding.id);
    binding.terminalSessionId = undefined;
    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);
    this.router.deactivateBinding(binding.id);
    this.cancelActivePlanWorkflow(binding.id);

    if (message.address.channelType === 'telegram') {
      const card = buildResetConfirmationCard(binding.id, binding.runtime);
      await this.sendOrPatchTelegramCard(adapter, message.address, card, patchMessageId);
      return;
    }

    await adapter.send({
      address: message.address,
      text: '🔄 Session reset. Send `/new` to start fresh.',
      parseMode: 'Markdown',
    });
  }

  private stopActiveTask(adapter: BaseChannelAdapter, message: InboundMessage): string {
    const binding = this.router.resolve(message.address);
    if (!binding) return '❌ No active session found.';

    if (this.isTelegramCodexTerminalBinding(binding, message) && this.codexTerminalRuntime.hasSession(binding.id)) {
      this.codexTerminalRuntime.sendKey(binding, 'ctrlc', {
        onActivityEvent: this.buildActivityProjector(adapter, message),
      });
    } else {
      const task = this.state.activeTasks.get(binding.id);
      if (task) {
        task.abort();
        this.state.activeTasks.delete(binding.id);
      }
    }
    return '🛑 Active task stopped.';
  }

  private setBindingMode(
    binding: ChannelBinding,
    mode: ChannelBinding['mode'],
  ): void {
    binding.mode = mode;
    binding.updatedAt = new Date().toISOString();
    if (binding.runtime === 'claude' && mode === 'plan') {
      binding.claudePermissionMode = 'plan';
    } else if (binding.runtime === 'claude' && binding.claudePermissionMode === 'plan') {
      binding.claudePermissionMode = 'default';
    }
    this.store.saveBinding(binding);
  }

  private cancelActivePlanWorkflow(bindingId: string): void {
    const workflow = this.store.getActivePlanWorkflowByBinding(bindingId);
    if (!workflow) return;
    workflow.status = 'cancelled';
    workflow.updatedAt = new Date().toISOString();
    this.store.savePlanWorkflow(workflow);
  }

  private async deleteSessionBinding(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
    binding: ChannelBinding,
    patchMessageId?: string,
  ): Promise<void> {
    this.codexTerminalRuntime.stopSession(binding.id);
    this.endTerminalPreview(adapter, binding.id);

    const task = this.state.activeTasks.get(binding.id);
    if (task) {
      task.abort();
      this.state.activeTasks.delete(binding.id);
    }

    this.cancelActivePlanWorkflow(binding.id);
    this.store.deleteSessionState(binding.id);

    if (address.channelType === 'telegram') {
      const card = buildSessionDeletedCard(binding);
      await this.sendOrPatchTelegramCard(adapter, address, card, patchMessageId);
      return;
    }

    await adapter.send({
      address,
      text: `🗑️ Session deleted: \`${binding.id}\``,
      parseMode: 'Markdown',
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
        if (message.address.channelType === 'telegram') {
          const card = buildCommandCenterCard(this.router.resolve(message.address));
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
        } else {
          await adapter.send({
            address: message.address,
            text: this.renderHelpMessage(),
            parseMode: 'Markdown',
          });
        }
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
        const requestedMode = this.normalizeMode(cmd.args[1] || 'code');
        const binding = this.router.createBinding({
          channelType: message.address.channelType,
          channelInstanceId: message.address.channelInstanceId || 'default',
          chatId: message.address.chatId,
          agentSessionId: `session_${Date.now()}`,
          workingDirectory: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
          runtime,
          model: 'default',
          mode: requestedMode,
        });
        if (runtime === 'claude' && requestedMode === 'plan') {
          binding.claudePermissionMode = 'plan';
          this.store.saveBinding(binding);
        }
        if (message.address.channelType === 'telegram') {
          const card = buildSessionCreatedCard(runtime, requestedMode, binding);
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
        } else {
          await adapter.send({
            address: message.address,
            text: `✅ Created new ${runtime} session: \`${binding.agentSessionId}\``,
            parseMode: 'Markdown',
          });
        }
        break;
      }

      case 'reset': {
        if (this.router.resolve(message.address)) {
          await this.resetActiveBinding(adapter, message);
        } else {
          await this.sendNoActiveSessionMessage(adapter, message.address);
        }
        break;
      }

      case 'delete': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          await this.deleteSessionBinding(adapter, message.address, binding);
        } else {
          await this.sendNoActiveSessionMessage(adapter, message.address);
        }
        break;
      }

      case 'stop': {
        if (this.router.resolve(message.address)) {
          const text = this.stopActiveTask(adapter, message);
          await adapter.send({
            address: message.address,
            text,
            parseMode: 'Markdown',
          });
        } else {
          await this.sendNoActiveSessionMessage(adapter, message.address);
        }
        break;
      }

      case 'screen': {
        await this.sendCodexScreenSnapshot(adapter, message);
        break;
      }

      case 'enter':
      case 'esc':
      case 'tab':
      case 'backspace':
      case 'ctrlc':
      case 'ctrld':
      case 'up':
      case 'down':
      case 'left':
      case 'right':
      case 'pgup':
      case 'pgdn': {
        await this.handleTerminalKeyCommand(adapter, message, cmd.name);
        break;
      }

      case 'mode': {
        const binding = this.router.resolve(message.address);
        if (!binding) {
          await this.sendNoActiveSessionMessage(adapter, message.address);
          break;
        }

        const mode = cmd.args[0];
        if (!mode && message.address.channelType === 'telegram') {
          const card = buildModeSelectionCard(binding);
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
          break;
        }

        if (!mode) {
          await adapter.send({
            address: message.address,
            text: this.renderBindingStatus(binding),
            parseMode: 'Markdown',
          });
          break;
        }

        if (mode === 'code' || mode === 'plan' || mode === 'ask') {
          this.setBindingMode(binding, mode);
          await adapter.send({
            address: message.address,
            text: `✅ Mode changed to: \`${mode}\``,
            parseMode: 'Markdown',
          });
        } else {
          await adapter.send({
            address: message.address,
            text: '❌ Invalid mode. Usage: `/mode code|plan|ask`',
            parseMode: 'Markdown',
          });
        }
        break;
      }

      case 'bind':
      case 'binding': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          if (message.address.channelType === 'telegram') {
            const card = buildCommandCenterCard(binding);
            await adapter.send({
              address: message.address,
              text: card.text,
              parseMode: card.parseMode,
              inlineButtons: card.inlineButtons,
            });
          } else {
            await adapter.send({
              address: message.address,
              text: this.renderBindingStatus(binding),
              parseMode: 'Markdown',
            });
          }
        } else if (message.address.channelType === 'telegram') {
          const card = buildCommandCenterCard();
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
        } else {
          await this.sendNoActiveSessionMessage(adapter, message.address);
        }
        break;
      }

      case 'cwd':
      case 'pwd': {
        const binding = this.router.resolve(message.address);
        if (binding) {
          if (message.address.channelType === 'telegram') {
            const card = buildDirectoryCard(binding.workingDirectory);
            await adapter.send({
              address: message.address,
              text: card.text,
              parseMode: card.parseMode,
              inlineButtons: card.inlineButtons,
            });
            break;
          }
          await adapter.send({
            address: message.address,
            text: `📂 Current working directory:\n\`${binding.workingDirectory}\``,
            parseMode: 'Markdown',
          });
        } else {
          await this.sendNoActiveSessionMessage(adapter, message.address);
        }
        break;
      }

      case 'status': {
        const binding = this.router.resolve(message.address);
        const text = this.renderStatusMessage(binding);
        if (message.address.channelType === 'telegram') {
          const card = buildCommandStatusCard(text);
          await adapter.send({
            address: message.address,
            text: card.text,
            parseMode: card.parseMode,
            inlineButtons: card.inlineButtons,
          });
        } else {
          await adapter.send({
            address: message.address,
            text,
            parseMode: 'Markdown',
          });
        }
        break;
      }

      case 'resume':
      case 'sessions': {
        if (message.address.channelType === 'telegram') {
          await this.sendTelegramResumeCard(adapter, message.address);
        } else {
          await adapter.send({
            address: message.address,
            text: this.renderStatusMessage(this.router.resolve(message.address)),
            parseMode: 'Markdown',
          });
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

    const commandLine = trimmed.split(/\r?\n/, 1)[0].trim();
    const withoutSlash = commandLine.slice(1);
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
• \`/delete\` — delete the current IM bridge session
• \`/stop\` — stop the active task
• \`/screen\` — show the current Codex terminal screen
• \`/enter\`, \`/esc\`, \`/tab\`, \`/backspace\`, \`/ctrlc\`, \`/ctrld\` — send terminal keys
• \`/up\`, \`/down\`, \`/left\`, \`/right\`, \`/pgup\`, \`/pgdn\` — navigate the Codex terminal
• \`/mode code|plan|ask\` — change session mode
• \`/bind\` — show the current chat binding
• \`/cwd\` — show the current working directory
• \`/status\` — show bridge and session status
• \`/sessions\` — show recent sessions
• \`/resume\` — resume a recent session
• \`/help\` — show this help

After creating a session, send any text to continue the conversation. Use \`//model\` to send a Codex slash command such as \`/model\`.`;
  }

  private async sendNoActiveSessionMessage(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
  ): Promise<void> {
    if (address.channelType === 'telegram') {
      const card = buildCommandCenterCard();
      await adapter.send({
        address,
        text: card.text,
        parseMode: card.parseMode,
        inlineButtons: card.inlineButtons,
      });
      return;
    }

    await adapter.send({
      address,
      text: '❌ No active session found. Send `/new:claude` or `/new:codex` first.',
      parseMode: 'Markdown',
    });
  }

  private renderStatusMessage(binding: ChannelBinding | undefined): string {
    const status = this.getStatus();
    const adapters = status.adapters.length > 0
      ? status.adapters
          .map(adapter => {
            const running = adapter.running ? 'running' : 'stopped';
            const label = adapter.label || adapter.adapterId;
            const errorSuffix = adapter.error ? `, error: ${adapter.error}` : '';
            return `• \`${label}\` (${adapter.channelType}): ${running}${errorSuffix}`;
          })
          .join('\n')
      : '• No adapters registered';

    const session = binding
      ? this.renderBindingStatus(binding)
      : 'No active session bound to this chat.';

    return `📡 *Bridge Status*

Running: \`${status.running ? 'yes' : 'no'}\`
Started: \`${status.startedAt || 'not started'}\`

Adapters:
${adapters}

Current session:
${session}`;
  }

  private renderBindingStatus(binding: ChannelBinding): string {
    const sdkSession = binding.sdkSessionId || 'not established yet';
    const terminalSession = binding.terminalSessionId
      ? `\nTerminal session: \`${binding.terminalSessionId}\``
      : '';
    const claudeMode = binding.claudePermissionMode
      ? `\nClaude permission: \`${binding.claudePermissionMode}\``
      : '';

    return `🔗 *Current Binding*

Binding ID: \`${binding.id}\`
Runtime: \`${binding.runtime}\`
Mode: \`${binding.mode}\`${claudeMode}
Agent session: \`${binding.agentSessionId}\`
SDK session: \`${sdkSession}\`${terminalSession}
CWD: \`${binding.workingDirectory}\`
Active: \`${binding.active ? 'yes' : 'no'}\`
Updated: \`${binding.updatedAt}\``;
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
      if (callbackData.startsWith('cmd:')) {
        await this.handleCommandCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('new-session:')) {
        await this.handleNewSessionCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('mode:')) {
        await this.handleModeCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('terminal-key:')) {
        await this.handleTerminalKeyCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('resume:')) {
        await this.handleResumeCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('session-delete:')) {
        await this.handleSessionDeleteCallback(adapter, message, callbackData);
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
      if (callbackData.startsWith('plan:')) {
        await this.handlePlanCallback(adapter, message, callbackData);
        return;
      }
      if (callbackData.startsWith('planexit:')) {
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
      channelInstanceId: resolveChannelInstanceId(message.address),
      chatId: message.address.chatId,
      agentSessionId: `session_${Date.now()}`,
      workingDirectory: process.env.CTI_DEFAULT_WORKDIR || process.cwd(),
      runtime,
      model: 'default',
      mode,
    });
    if (runtime === 'claude' && mode === 'plan') {
      binding.claudePermissionMode = 'plan';
      this.store.saveBinding(binding);
    }

    const card = buildSessionCreatedCard(runtime, mode, binding);
    await this.patchOrSendCard(adapter, message, card);
    await adapter.answerCallback(message.messageId, 'Session created');
  }

  private async handleCommandCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const action = callbackData.split(':')[1] || 'help';
    const binding = this.router.resolve(message.address);
    const patchMessageId = message.callbackMessageId;

    switch (action) {
      case 'help': {
        const card = buildCommandCenterCard(binding);
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Command center');
        return;
      }
      case 'new': {
        const card = buildNewSessionCard();
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Choose a session');
        return;
      }
      case 'resume': {
        await this.sendTelegramResumeCard(adapter, message.address, patchMessageId);
        await adapter.answerCallback(message.messageId, 'Choose a session');
        return;
      }
      case 'status': {
        const card = buildCommandStatusCard(this.renderStatusMessage(binding));
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Status updated');
        return;
      }
      case 'mode': {
        if (!binding) {
          const card = buildCommandCenterCard();
          await this.patchOrSendCard(adapter, message, card);
          await adapter.answerCallback(message.messageId, 'No active session');
          return;
        }
        const card = buildModeSelectionCard(binding);
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Choose a mode');
        return;
      }
      case 'cwd': {
        if (!binding) {
          const card = buildCommandCenterCard();
          await this.patchOrSendCard(adapter, message, card);
          await adapter.answerCallback(message.messageId, 'No active session');
          return;
        }
        const card = buildDirectoryCard(binding.workingDirectory);
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Directory');
        return;
      }
      case 'stop': {
        const card = buildCommandStatusCard(this.stopActiveTask(adapter, message));
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Stop sent');
        return;
      }
      case 'reset': {
        await this.resetActiveBinding(adapter, message, patchMessageId);
        await adapter.answerCallback(message.messageId, 'Session reset');
        return;
      }
      case 'codex-controls': {
        const card = buildCodexControlCard(binding);
        await this.patchOrSendCard(adapter, message, card);
        await adapter.answerCallback(message.messageId, 'Codex controls');
        return;
      }
      case 'screen': {
        await this.sendCodexScreenSnapshot(adapter, message, patchMessageId);
        await adapter.answerCallback(message.messageId, 'Screen');
        return;
      }
      default:
        await adapter.answerCallback(message.messageId, 'Unsupported command');
    }
  }

  private async handleModeCallback(
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
    const mode = this.normalizeMode(parts[2]);
    const binding = this.store.getBinding(bindingId);
    if (!binding) {
      await adapter.answerCallback(message.messageId, 'Session not found');
      return;
    }

    this.setBindingMode(binding, mode);
    const card = buildModeSelectionCard(binding);
    await this.patchOrSendCard(adapter, message, card);
    await adapter.answerCallback(message.messageId, 'Mode updated');
  }

  private async handleTerminalKeyCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const name = callbackData.split(':')[1] || '';
    const binding = this.router.resolve(message.address);
    if (!binding) {
      await adapter.answerCallback(message.messageId, 'No active session');
      return;
    }
    if (!this.isTelegramCodexTerminalBinding(binding, message)) {
      await adapter.answerCallback(message.messageId, 'Codex only');
      return;
    }
    if (!isCodexTerminalKey(name)) {
      await adapter.answerCallback(message.messageId, 'Unsupported key');
      return;
    }

    const projection = this.createTerminalLiveProjection(adapter, message, binding);
    await projection.primePreview();
    const previousTranscript = projection.getLatestTranscript();
    const session = this.codexTerminalRuntime.sendKey(binding, name as CodexTerminalKey, projection.callbacks);
    if (!session) {
      await adapter.answerCallback(message.messageId, 'No active Codex terminal');
      return;
    }

    if (projection.getLatestTranscript() === previousTranscript) {
      await this.waitForTerminalOutput(binding.id, projection.getLatestTranscript, previousTranscript);
    }
    await projection.flushPreviewUpdates();
    const latestText = this.renderCodexTranscript(projection.getLatestTranscript());
    if (latestText && projection.canPreview && projection.draftId !== null) {
      await projection.sendPreviewText(latestText);
    }

    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);
    await adapter.answerCallback(message.messageId, `Sent ${name}`);
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

  private async handleSessionDeleteCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const bindingId = callbackData.slice('session-delete:'.length);
    if (!bindingId) {
      await adapter.answerCallback(message.messageId, 'Invalid delete action');
      return;
    }

    const binding = this.store.getBinding(bindingId);
    if (!binding) {
      await adapter.answerCallback(message.messageId, 'Session not found');
      const card = buildCommandCenterCard(this.router.resolve(message.address));
      await this.patchOrSendCard(adapter, message, card);
      return;
    }

    await this.deleteSessionBinding(adapter, message.address, binding, message.callbackMessageId);
    await adapter.answerCallback(message.messageId, 'Session deleted');
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

  private async handlePlanCallback(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    callbackData: string,
  ): Promise<void> {
    const parts = callbackData.split(':');
    const action = parts[1];
    const workflowId = parts[2];
    if (!action || !workflowId) {
      await adapter.answerCallback(message.messageId, 'Invalid plan action');
      return;
    }

    const workflow = this.store.getPlanWorkflow(workflowId);
    if (!workflow) {
      await adapter.answerCallback(message.messageId, 'Plan not found');
      return;
    }

    switch (action) {
      case 'exec':
        await this.executePlanWorkflow(adapter, message, workflow);
        return;
      case 'revise':
        workflow.status = 'revising';
        workflow.updatedAt = new Date().toISOString();
        this.store.savePlanWorkflow(workflow);
        await this.patchOrSendCard(adapter, message, buildPlanRevisionRequestedCard(workflow));
        await adapter.answerCallback(message.messageId, 'Send revision');
        return;
      case 'cancel':
        workflow.status = 'cancelled';
        workflow.updatedAt = new Date().toISOString();
        this.store.savePlanWorkflow(workflow);
        await this.patchOrSendCard(adapter, message, buildPlanCancelledCard(workflow));
        await adapter.answerCallback(message.messageId, 'Plan cancelled');
        return;
      default:
        await adapter.answerCallback(message.messageId, 'Unsupported plan action');
    }
  }

  private async processTelegramPlanWorkflowMessage(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
    promptText: string,
  ): Promise<void> {
    const existing = this.store.getActivePlanWorkflowByBinding(binding.id);
    const isRevision = existing?.status === 'revising';
    const workflow = isRevision && existing
      ? existing
      : this.createPlanWorkflow(binding, message, promptText);

    if (isRevision) {
      workflow.status = 'revising';
      workflow.updatedAt = new Date().toISOString();
      this.store.savePlanWorkflow(workflow);
    }

    const draftCard = buildPlanDraftingCard(workflow);
    const draftResult = workflow.previewMessageId && adapter.patchCard
      ? await adapter.patchCard(message.address, workflow.previewMessageId, draftCard)
      : await adapter.send({
          address: message.address,
          text: draftCard.text,
          parseMode: draftCard.parseMode,
          inlineButtons: draftCard.inlineButtons,
        });
    if (draftResult.ok && draftResult.messageId) {
      workflow.previewMessageId = draftResult.messageId;
      this.store.savePlanWorkflow(workflow);
    }

    const planBinding = { ...binding, mode: 'plan' as const };
    if (planBinding.runtime === 'claude') {
      planBinding.claudePermissionMode = 'plan';
    }

    const planPrompt = isRevision
      ? this.renderPlanRevisionPrompt(workflow, promptText)
      : promptText;

    const result = await this.runConversationWithoutDelivery(
      adapter,
      message,
      planBinding,
      planPrompt,
    );

    if (result.sdkSessionId) {
      binding.sdkSessionId = result.sdkSessionId;
    }
    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);

    workflow.planText = result.text;
    workflow.status = result.ok ? 'awaiting_decision' : 'drafting';
    workflow.updatedAt = new Date().toISOString();
    this.store.savePlanWorkflow(workflow);

    const card = result.ok
      ? buildPlanReadyCard(workflow)
      : buildCallbackErrorCard(result.text);
    if (workflow.previewMessageId && adapter.patchCard) {
      const patched = await adapter.patchCard(message.address, workflow.previewMessageId, card);
      if (!patched.ok) {
        await adapter.send({
          address: message.address,
          text: card.text,
          parseMode: card.parseMode,
          inlineButtons: card.inlineButtons,
        });
      }
      return;
    }

    await adapter.send({
      address: message.address,
      text: card.text,
      parseMode: card.parseMode,
      inlineButtons: card.inlineButtons,
    });
  }

  private createPlanWorkflow(
    binding: ChannelBinding,
    message: InboundMessage,
    promptText: string,
  ): PlanWorkflow {
    const now = new Date().toISOString();
    const workflow: PlanWorkflow = {
      id: `pw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      bindingId: binding.id,
      channelType: message.address.channelType,
      channelInstanceId: message.address.channelInstanceId || binding.channelInstanceId || 'default',
      chatId: message.address.chatId,
      userId: message.address.userId,
      promptText,
      planText: '',
      status: 'drafting',
      returnMode: binding.mode,
      returnClaudePermissionMode: binding.claudePermissionMode,
      createdAt: now,
      updatedAt: now,
    };
    this.store.savePlanWorkflow(workflow);
    return workflow;
  }

  private renderPlanRevisionPrompt(workflow: PlanWorkflow, revisionText: string): string {
    return `Revise the existing plan using the user's requested changes. Produce the full updated plan only.

Original task:
${workflow.promptText}

Current plan:
${workflow.planText || '(no current plan text)'}

Requested changes:
${revisionText}`;
  }

  private async executePlanWorkflow(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    workflow: PlanWorkflow,
  ): Promise<void> {
    const binding = this.store.getBinding(workflow.bindingId);
    if (!binding) {
      await adapter.answerCallback(message.messageId, 'Session not found');
      return;
    }

    workflow.status = 'executing';
    workflow.updatedAt = new Date().toISOString();
    this.store.savePlanWorkflow(workflow);
    await this.patchOrSendCard(adapter, message, buildPlanExecutingCard(workflow));
    await adapter.answerCallback(message.messageId, 'Executing');

    const originalMode = workflow.returnMode || binding.mode;
    const originalClaudeMode = workflow.returnClaudePermissionMode || binding.claudePermissionMode;
    binding.mode = 'code';
    if (binding.runtime === 'claude' && binding.claudePermissionMode === 'plan') {
      binding.claudePermissionMode = 'default';
    }
    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);

    const executionPrompt = this.renderPlanExecutionPrompt(workflow);
    const syntheticMessage: InboundMessage = {
      ...message,
      text: executionPrompt,
      callbackData: undefined,
      callbackMessageId: undefined,
      messageId: `${message.messageId}_plan_exec`,
    };

    const result = binding.runtime === 'codex' && message.address.channelType === 'telegram'
      ? await this.executeCodexPlanInTerminal(adapter, syntheticMessage, binding, executionPrompt)
      : await this.runConversationWithPreview(
          adapter,
          syntheticMessage,
          binding,
          executionPrompt,
          {
            finalCard: finalText => buildPlanCompletedCard(workflow, finalText),
          },
        );

    if (result.sdkSessionId) {
      binding.sdkSessionId = result.sdkSessionId;
    }

    workflow.status = result.ok ? 'completed' : 'awaiting_decision';
    workflow.updatedAt = new Date().toISOString();
    this.store.savePlanWorkflow(workflow);

    if (binding.runtime === 'claude') {
      binding.mode = originalMode === 'plan' ? 'plan' : originalMode;
      binding.claudePermissionMode = originalClaudeMode || (binding.mode === 'plan' ? 'plan' : 'default');
    } else {
      binding.mode = originalMode;
    }
    binding.updatedAt = new Date().toISOString();
    this.store.saveBinding(binding);
  }

  private renderPlanExecutionPrompt(workflow: PlanWorkflow): string {
    return `Execute the approved plan for the original task.

Original task:
${workflow.promptText}

Approved plan:
${workflow.planText}`;
  }

  private async executeCodexPlanInTerminal(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
    executionPrompt: string,
  ): Promise<PreviewRunResult> {
    const before = this.codexTerminalRuntime.getTranscriptSnapshot(binding.id);
    await this.processTelegramCodexInput(adapter, message, binding, executionPrompt);
    const transcript = this.codexTerminalRuntime.getTranscriptSnapshot(binding.id);
    return {
      ok: true,
      text: transcript || before || 'Plan execution started in Codex terminal.',
    };
  }

  private async runConversationWithoutDelivery(
    adapter: BaseChannelAdapter,
    message: InboundMessage,
    binding: ChannelBinding,
    promptText: string,
  ): Promise<PreviewRunResult> {
    const abortController = new AbortController();
    this.state.activeTasks.set(binding.id, abortController);
    let latestText = '';

    try {
      const result = await this.engine.processMessage(binding, adapter, promptText, {
        permissionBroker: this.permissionBroker,
        onPartialText: text => {
          latestText = text;
        },
        onActivityEvent: this.buildActivityProjector(adapter, message),
        abortSignal: abortController.signal,
      });

      const finalText = result.ok
        ? result.text || latestText || 'No response text was returned.'
        : `❌ ${result.error || 'Conversation failed'}`;
      return {
        ok: result.ok,
        text: finalText,
        sdkSessionId: result.sdkSessionId,
      };
    } finally {
      this.state.activeTasks.delete(binding.id);
      abortController.abort();
    }
  }

  private async sendTelegramResumeCard(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
    patchMessageId?: string,
  ): Promise<void> {
    const channelInstanceId = resolveChannelInstanceId(address);
    const sessions = this.store.listBindings()
      .sort((a, b) => {
        const sameChat = Number(
          a.channelType === address.channelType &&
          a.channelInstanceId === channelInstanceId &&
          a.chatId === address.chatId,
        ) - Number(
          b.channelType === address.channelType &&
          b.channelInstanceId === channelInstanceId &&
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
    await this.sendOrPatchTelegramCard(adapter, address, card, patchMessageId);
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

  private async sendOrPatchTelegramCard(
    adapter: BaseChannelAdapter,
    address: ChannelAddress,
    card: CardMessage,
    patchMessageId?: string,
  ): Promise<void> {
    if (patchMessageId && adapter.patchCard) {
      const result = await adapter.patchCard(address, patchMessageId, card);
      if (result.ok) return;
    }

    await adapter.send({
      address,
      text: card.text,
      parseMode: card.parseMode,
      inlineButtons: card.inlineButtons,
    });
  }

  private normalizeMode(value: string): 'code' | 'plan' | 'ask' {
    if (value === 'plan' || value === 'ask') return value;
    return 'code';
  }

  private renderInboundPrompt(message: InboundMessage, textOverride?: string): string {
    const baseText = (textOverride ?? message.text).trim();
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
