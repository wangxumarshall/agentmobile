/**
 * Conversation engine — processes messages through LLM, consumes SSE streams.
 * Core message processing orchestration.
 */

import type { ChannelBinding, ConversationMessage, ConversationSession } from './types.js';
import type { LLMProvider, PermissionResolution, SSEEvent } from './context.js';
import type { PermissionBroker } from './permission-broker.js';
import type { OutboundMessage } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import type { JsonFileStore } from '../infra/store.js';
import { error, debug } from '../config/logger.js';

export type OnPermissionRequest = (req: {
  id: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  prompt: string;
}) => Promise<PermissionResolution>;

export type OnPartialText = (text: string) => void;
export type OnActivityEvent = (event: {
  type: 'command' | 'file_change' | 'tool_use' | 'progress';
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}) => void;

export interface ProcessMessageOptions {
  files?: Array<{ fileName: string; filePath: string }>;
  model?: string;
}

export interface ConversationResult {
  ok: boolean;
  text?: string;
  error?: string;
  sdkSessionId?: string;
}

export class ConversationEngine {
  private llm: LLMProvider;
  private store: JsonFileStore;

  constructor(llm: LLMProvider, store: JsonFileStore) {
    this.llm = llm;
    this.store = store;
  }

  /**
   * Process a message through the LLM.
   * Handles streaming, permissions, and callbacks.
   */
  async processMessage(
    binding: ChannelBinding,
    adapter: BaseChannelAdapter,
    text: string,
    options: {
      onPermissionRequest?: OnPermissionRequest;
      onPartialText?: OnPartialText;
      onActivityEvent?: OnActivityEvent;
      abortSignal?: AbortSignal;
      permissionBroker?: PermissionBroker;
    } = {},
  ): Promise<ConversationResult> {
    const { onPermissionRequest, onPartialText, onActivityEvent, abortSignal } = options;

    debug('engine', `Processing message for binding ${binding.id}: ${text.slice(0, 50)}...`);

    // Build conversation history
    const history = this.getHistory(binding);
    history.push({ role: 'user', content: text, timestamp: Date.now() });
    this.saveHistory(binding, history);

    let accumulatedText = '';
    let sdkSessionId: string | undefined;

    try {
      // Create permission wrapper that integrates with PermissionBroker
      const permissionHandler = onPermissionRequest || (async (req) => {
        if (options.permissionBroker) {
          const resolution = await options.permissionBroker.requestPermission(
            adapter,
            {
              channelType: binding.channelType,
              channelInstanceId: binding.channelInstanceId,
              chatId: binding.chatId,
            },
            {
              id: req.id,
              sessionId: binding.agentSessionId,
              toolName: req.toolName,
              toolInput: req.toolInput,
              prompt: req.prompt,
              resolved: false,
              createdAt: Date.now(),
            }
          );
          return { resolution };
        }
        return { resolution: 'allow' as const };
      });

      // Stream from LLM
      const stream = this.llm.streamChat(binding, history, {
        onPermissionRequest: permissionHandler,
        onActivityEvent,
        abortSignal,
      });

      for await (const event of stream) {
        if (abortSignal?.aborted) break;

        switch (event.type) {
          case 'text':
          case 'text_segment':
            if (event.text) {
              accumulatedText += event.text;
              onPartialText?.(accumulatedText);
            }
            break;
          case 'result':
            sdkSessionId = event.data?.sessionId as string | undefined;
            break;
          case 'error':
            error('engine', `LLM error: ${event.data?.message}`);
            return {
              ok: false,
              error: event.data?.message as string || 'Unknown error',
              sdkSessionId,
            };
        }
      }

      // Save assistant message to history
      if (accumulatedText) {
        history.push({ role: 'assistant', content: accumulatedText, timestamp: Date.now() });
        this.saveHistory(binding, history);
      }

      // Final delivery if we have accumulated text and no streaming preview
      if (accumulatedText && !onPartialText) {
        const message: OutboundMessage = {
          address: {
            channelType: binding.channelType,
            channelInstanceId: binding.channelInstanceId,
            chatId: binding.chatId,
          },
          text: accumulatedText,
          parseMode: 'Markdown',
        };
        await deliver(adapter, message);
      }

      return {
        ok: true,
        text: accumulatedText,
        sdkSessionId,
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('engine', `Processing failed: ${err.message}`);
      return {
        ok: false,
        error: err.message,
        sdkSessionId,
      };
    }
  }

  /**
   * Get conversation history for a binding.
   *
   * NOTE: Stub — in-memory only, not persisted. The bridge processes messages
   * statelessly by design; the LLM SDK manages its own session state
   * (e.g. Claude SDK session_id for resume). Full local history
   * persistence is out of scope for the initial implementation.
   */
  private getHistory(binding: ChannelBinding): ConversationMessage[] {
    return this.store.getSession(binding.id)?.messages || [];
  }

  /**
   * Save conversation history for a binding.
   *
   * NOTE: Stub — no-op. The LLM SDK handles session resume via its own
   * session identifiers (sdkSessionId). Local history replay would
   * duplicate state already managed by the provider.
   */
  private saveHistory(binding: ChannelBinding, messages: ConversationMessage[]): void {
    const existing = this.store.getSession(binding.id);
    const session: ConversationSession = {
      id: binding.id,
      bindingId: binding.id,
      messages,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    this.store.saveSession(session);
  }
}
