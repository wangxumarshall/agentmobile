/**
 * Claude SDK Provider for IM bridge.
 * Uses @anthropic-ai/claude-agent-sdk to stream chat.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ChannelBinding } from '../bridge/types.js';
import type { LLMProvider, PermissionResolution, SSEEvent } from '../bridge/context.js';
import { toSdkPermissionMode } from '../runtime/claude-mode.js';
import { error, debug } from '../config/logger.js';

interface StreamChatOptions {
  onPermissionRequest?: (req: {
    id: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    prompt: string;
  }) => Promise<PermissionResolution>;
  onPartialText?: (text: string) => void;
  onActivityEvent?: (event: {
    type: 'command' | 'file_change' | 'tool_use' | 'progress';
    title: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }) => void;
  abortSignal?: AbortSignal;
}

export class ClaudeSDKProvider implements LLMProvider {
  private cliPath?: string;

  constructor(cliPath?: string) {
    this.cliPath = cliPath;
  }

  async *streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options: StreamChatOptions = {},
  ): AsyncIterable<SSEEvent> {
    const { onPermissionRequest, onActivityEvent, abortSignal } = options;

    // Get last user message as prompt
    const prompt = messages.filter(m => m.role === 'user').pop()?.content || '';

    debug('claude-sdk', `Starting Claude session for binding ${binding.id}`);

    try {
      const queryOptions: Record<string, unknown> = {
        cwd: binding.workingDirectory,
        permissionMode: binding.mode === 'plan'
          ? 'plan'
          : toSdkPermissionMode(binding.claudePermissionMode || 'default'),
        allowDangerouslySkipPermissions: false,
        includePartialMessages: true,
      };

      if (this.cliPath) {
        queryOptions.pathToClaudeCodeExecutable = this.cliPath;
      }

      if (binding.model && binding.model !== 'default') {
        queryOptions.model = binding.model;
      }

      if (binding.sdkSessionId) {
        queryOptions.resume = binding.sdkSessionId;
      }

      const q = query({
        prompt,
        options: queryOptions,
      });

      for await (const msg of q) {
        if (abortSignal?.aborted) break;

        // Handle SDK messages
        switch (msg.type) {
          case 'stream_event': {
            const event = msg.event;
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text };
            }
            break;
          }

          case 'assistant': {
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'tool_use') {
                  onActivityEvent?.({
                    type: 'tool_use',
                    title: block.name,
                    description: JSON.stringify(block.input).slice(0, 500),
                    metadata: { toolId: block.id },
                  });
                  yield {
                    type: 'permission_request',
                    data: {
                      permissionRequestId: block.id,
                      toolName: block.name,
                      toolInput: block.input,
                    },
                  };

                  // Wait for permission resolution
                  if (onPermissionRequest) {
                    const resolution = await onPermissionRequest({
                      id: block.id,
                      toolName: block.name,
                      toolInput: block.input as Record<string, unknown>,
                      prompt: `Allow tool ${block.name}?`,
                    });

                    if (resolution.resolution === 'deny') {
                      yield { type: 'error', data: { message: 'Permission denied' } };
                      return;
                    }
                  }
                }
              }
            }
            break;
          }

          case 'result': {
            if (msg.subtype === 'success') {
              yield {
                type: 'result',
                data: {
                  sessionId: msg.session_id,
                  isError: msg.is_error,
                },
              };
            } else {
              yield {
                type: 'error',
                data: { message: 'SDK result error' },
              };
            }
            break;
          }
        }
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('claude-sdk', `Stream error: ${err.message}`);
      yield { type: 'error', data: { message: err.message } };
    }
  }
}
