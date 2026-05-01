/**
 * Abstract base class for IM channel adapters.
 *
 * The bridge supports multiple IM channels (Telegram, Feishu, etc.); this abstraction keeps
 * bridge lifecycle code decoupled from adapter-specific delivery details.
 */

import type {
  ActivityEvent,
  CardMessage,
  ChannelAddress,
  ChannelType,
  InboundMessage,
  OutboundImage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
} from './types.js';

export abstract class BaseChannelAdapter {
  /** Which channel type this adapter handles */
  abstract readonly channelType: ChannelType;

  /** Stable adapter instance identifier. */
  get adapterId(): string {
    return this.channelType;
  }

  /** Stable profile identifier, if the adapter is backed by a named profile. */
  get profileId(): string {
    return this.adapterId;
  }

  /** Human-readable adapter label for status surfaces and redirect hints. */
  get label(): string {
    return this.profileId;
  }

  /**
   * Start the adapter (connect, begin polling/websocket, etc.).
   * Must be idempotent — calling start() on an already-running adapter is a no-op.
   */
  abstract start(): Promise<void>;

  /**
   * Stop the adapter gracefully.
   * Must be idempotent — calling stop() on an already-stopped adapter is a no-op.
   */
  abstract stop(): Promise<void>;

  /** Whether the adapter is currently running and consuming messages */
  abstract isRunning(): boolean;

  /**
   * Consume the next inbound message from the internal queue.
   * Blocks until a message is available or the adapter is stopped.
   * Returns null if the adapter was stopped while waiting.
   */
  abstract consumeOne(): Promise<InboundMessage | null>;

  /**
   * Send an outbound message to the channel.
   * Handles adapter-specific formatting and API calls.
   */
  abstract send(message: OutboundMessage): Promise<SendResult>;

  /**
   * Send a local image file to the channel as a native image message.
   */
  sendImage?(_image: OutboundImage): Promise<SendResult>;

  /**
   * Answer a callback query.
   * Default implementation is a no-op.
   */
  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // No-op by default
  }

  /**
   * Patch an existing card/message in place, if supported by the channel.
   */
  patchCard?(
    _address: ChannelAddress,
    _messageId: string,
    _card: CardMessage,
  ): Promise<SendResult>;

  /**
   * Validate the adapter configuration.
   * Returns null if valid, or an error message string if invalid.
   */
  async validateConfig(): Promise<string | null> {
    return null;
  }

  /**
   * Check if a user is authorized to use this adapter.
   * Default implementation allows all users.
   */
  isAuthorized(_userId: string, _chatId: string): boolean {
    return true;
  }

  /**
   * Called when message processing starts (e.g., show typing indicator).
   */
  onMessageStart?(_address: ChannelAddress): void;

  /**
   * Called when message processing ends (e.g., remove typing indicator).
   */
  onMessageEnd?(_address: ChannelAddress): void;

  /**
   * Acknowledge that an update has been processed.
   * Used for deferred offset acknowledgement.
   */
  acknowledgeUpdate?(_updateId: number): void;

  // ── Streaming Preview ──────────────────────────────────────

  /**
   * Get streaming preview capabilities for this adapter.
   */
  getPreviewCapabilities?(_address: ChannelAddress): PreviewCapabilities | null;

  /**
   * Send a streaming preview update.
   */
  sendPreview?(
    _address: ChannelAddress,
    _text: string,
    _draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * Prime a streaming preview (create placeholder).
   */
  primePreview?(
    _address: ChannelAddress,
    _draftId: number,
  ): Promise<'sent' | 'skip' | 'degrade'>;

  /**
   * End a streaming preview.
   */
  endPreview?(_address: ChannelAddress, _draftId: number): void;

  /**
   * Finalize an existing preview in-place with the final response text.
   */
  finalizePreview?(
    _address: ChannelAddress,
    _text: string,
    _draftId: number,
  ): Promise<SendResult>;

  // ── Activity Events ────────────────────────────────────────

  /**
   * Upsert an activity event card.
   */
  upsertActivityEvent?(
    _address: ChannelAddress,
    _event: ActivityEvent,
    _replyToMessageId?: string,
  ): Promise<SendResult>;

  /**
   * Whether an activity event should be projected to the user.
   */
  shouldProjectActivityEvent?(_event: ActivityEvent): boolean;
}

// ── Adapter Registry ─────────────────────────────────────────

type AdapterFactory = () => BaseChannelAdapter;

const registry: Map<string, AdapterFactory> = new Map();

export function registerAdapterFactory(channelType: string, factory: AdapterFactory): void {
  registry.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = registry.get(channelType);
  if (!factory) return null;
  return factory();
}

export function getRegisteredTypes(): string[] {
  return Array.from(registry.keys());
}
