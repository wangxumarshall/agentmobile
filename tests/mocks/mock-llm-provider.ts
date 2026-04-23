/**
 * Mock LLM Provider for testing.
 *
 * Simulates Claude SDK streaming responses with configurable events.
 */

import type { ChannelBinding } from '../../im/bridge/types.js';
import type { LLMProvider } from '../../im/bridge/context.js';

export interface MockLLMResponseConfig {
  text?: string;
  toolUses?: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  error?: string;
  delayMs?: number;
}

export class MockLLMProvider implements LLMProvider {
  private _config: MockLLMResponseConfig = {};
  private _shouldRequirePermission = false;
  private _permissionResolution: 'allow' | 'deny' = 'allow';
  private _callCount = 0;
  private _lastMessages: Array<{ role: string; content: string }> = [];
  private _lastBinding: ChannelBinding | undefined;

  set responseConfig(config: MockLLMResponseConfig) {
    this._config = config;
  }

  set shouldRequirePermission(val: boolean) {
    this._shouldRequirePermission = val;
  }

  set permissionResolution(val: 'allow' | 'deny') {
    this._permissionResolution = val;
  }

  get callCount() { return this._callCount; }
  get lastMessages() { return [...this._lastMessages]; }
  get lastBinding() { return this._lastBinding; }

  clear() {
    this._config = {};
    this._callCount = 0;
    this._lastMessages = [];
    this._lastBinding = undefined;
  }

  async *streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options?: any,
  ): AsyncIterable<any> {
    this._callCount++;
    this._lastBinding = binding;
    this._lastMessages = messages;

    const { delayMs } = this._config;

    if (delayMs) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    if (this._config.error) {
      yield { type: 'error', data: { message: this._config.error } };
      return;
    }

    // Emit tool use events first (if configured)
    if (this._config.toolUses) {
      for (const tool of this._config.toolUses) {
        if (this._shouldRequirePermission) {
          if (options?.onPermissionRequest) {
            const resolution = await options.onPermissionRequest({
              id: tool.id,
              toolName: tool.name,
              toolInput: tool.input,
              prompt: `Allow ${tool.name}?`,
            });
            if (resolution.resolution === 'deny') {
              yield { type: 'error', data: { message: `Tool ${tool.name} denied` } };
              return;
            }
          }
        }
        yield {
          type: 'tool_use',
          data: { id: tool.id, name: tool.name, input: tool.input },
        };
      }
    }

    // Emit text response
    if (this._config.text) {
      const text = this._config.text;
      // Simulate streaming by emitting in chunks
      const chunkSize = 20;
      for (let i = 0; i < text.length; i += chunkSize) {
        const chunk = text.slice(i, i + chunkSize);
        yield { type: 'text', text: chunk };
        if (options?.onPartialText) {
          const accumulated = text.slice(0, Math.min(i + chunkSize, text.length));
          options.onPartialText(accumulated);
        }
        if (delayMs) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }

    // Emit result
    yield {
      type: 'result',
      data: {
        sessionId: `session_${Date.now()}`,
        isError: false,
      },
    };
  }
}
