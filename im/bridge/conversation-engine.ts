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
import { info, error, debug } from '../config/logger.js';

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

  constructor(llm: LLMProvider) {
    this.llm = llm;
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
        onPartialText: (text) => {
          accumulatedText = text;
          onPartialText?.(text);
        },
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

  private getHistory(binding: ChannelBinding): ConversationMessage[] {
    // For now, return empty history
    // Future: load from store
    return [];
  }

  private saveHistory(binding: ChannelBinding, messages: ConversationMessage[]): void {
    // For now, no-op
    // Future: persist to store
  }
}
