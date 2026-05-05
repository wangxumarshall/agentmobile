/**
 * Claude SDK Provider for IM bridge.
 * Uses @anthropic-ai/claude-agent-sdk to stream chat.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
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

    let streamedText = false;
    let assistantFallbackText = '';

    try {
      const queryOptions: Options = {
        cwd: binding.workingDirectory,
        permissionMode: binding.mode === 'plan'
          ? 'plan'
          : toSdkPermissionMode(binding.claudePermissionMode || 'default'),
        allowDangerouslySkipPermissions: false,
        includePartialMessages: true,
      };

      if (onPermissionRequest) {
        queryOptions.canUseTool = this.buildPermissionHandler(onPermissionRequest);
      }

      if (this.cliPath) {
        queryOptions.pathToClaudeCodeExecutable = this.cliPath;
      }

      if (binding.model && binding.model !== 'default') {
        queryOptions.model = binding.model;
      }

      if (binding.sdkSessionId) {
        queryOptions.resume = binding.sdkSessionId;
      }

      onActivityEvent?.({
        type: 'progress',
        title: 'Claude status',
        description: 'Claude is starting the turn.',
        metadata: { status: 'running', source: 'claude-sdk' },
      });

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
            if (event.type === 'message_start') {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: 'Claude is generating a response.',
                metadata: { status: 'running', source: 'claude-sdk' },
              });
              break;
            }

            if (event.type === 'message_delta') {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: event.delta.stop_reason
                  ? `Claude response is finishing: ${event.delta.stop_reason}`
                  : 'Claude is still working.',
                metadata: { status: 'running', source: 'claude-sdk' },
              });
              break;
            }

            if (event.type === 'content_block_start') {
              const block = event.content_block;
              if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
                onActivityEvent?.({
                  type: 'tool_use',
                  title: block.name,
                  description: this.truncateJson(block.input, 500),
                  metadata: { toolId: block.id, source: 'claude-sdk' },
                });
              } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
                onActivityEvent?.({
                  type: 'progress',
                  title: 'Claude status',
                  description: 'Claude is reasoning internally. Hidden chain-of-thought is not shown.',
                  metadata: { status: 'running', source: 'claude-sdk' },
                });
              }
              break;
            }

            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              streamedText = true;
              yield { type: 'text', text: event.delta.text };
            } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: 'Claude is preparing tool input.',
                metadata: { status: 'running', source: 'claude-sdk' },
              });
            } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: 'Claude is reasoning internally. Hidden chain-of-thought is not shown.',
                metadata: { status: 'running', source: 'claude-sdk' },
              });
            }
            break;
          }

          case 'assistant': {
            if (msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === 'text') {
                  assistantFallbackText += block.text;
                  continue;
                }

                if (block.type === 'tool_use') {
                  onActivityEvent?.({
                    type: 'tool_use',
                    title: block.name,
                    description: this.truncateJson(block.input, 500),
                    metadata: { toolId: block.id, source: 'claude-sdk' },
                  });
                }
              }
            }
            break;
          }

          case 'result': {
            if (msg.subtype === 'success') {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: msg.is_error ? 'Claude finished with an error.' : 'Claude finished the turn.',
                metadata: {
                  status: msg.is_error ? 'failed' : 'completed',
                  source: 'claude-sdk',
                  durationMs: msg.duration_ms,
                },
              });
              if (!streamedText) {
                const finalText = msg.result || assistantFallbackText;
                if (finalText) {
                  yield { type: 'text', text: finalText };
                }
              }
              yield {
                type: 'result',
                data: {
                  sessionId: msg.session_id,
                  isError: msg.is_error,
                },
              };
            } else {
              onActivityEvent?.({
                type: 'progress',
                title: 'Claude status',
                description: this.formatResultError(msg),
                metadata: { status: 'failed', source: 'claude-sdk' },
              });
              yield {
                type: 'error',
                data: { message: this.formatResultError(msg) },
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

  private buildPermissionHandler(onPermissionRequest: NonNullable<StreamChatOptions['onPermissionRequest']>): CanUseTool {
    return async (toolName, input, permissionOptions): Promise<PermissionResult> => {
      const toolInput = this.asRecord(input);
      const resolution = await onPermissionRequest({
        id: permissionOptions.toolUseID,
        toolName,
        toolInput,
        prompt: permissionOptions.title || permissionOptions.description || `Allow tool ${toolName}?`,
      });

      if (resolution.resolution === 'deny') {
        return {
          behavior: 'deny',
          message: 'Permission denied',
          toolUseID: permissionOptions.toolUseID,
        };
      }

      return {
        behavior: 'allow',
        updatedPermissions: resolution.resolution === 'allow_session'
          ? permissionOptions.suggestions
          : undefined,
        toolUseID: permissionOptions.toolUseID,
      };
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private formatResultError(msg: { errors?: string[]; subtype?: string }): string {
    const details = msg.errors?.filter(Boolean).join('\n').trim();
    return details || `SDK result error: ${msg.subtype || 'unknown'}`;
  }

  private truncateJson(value: unknown, maxChars: number): string {
    try {
      const text = JSON.stringify(value);
      return text.length <= maxChars ? text : text.slice(0, maxChars);
    } catch {
      return '[unserializable input]';
    }
  }
}
