/**
 * Codex SDK Provider for IM bridge.
 * Simplified initial implementation.
 */

import type { ChannelBinding } from '../bridge/types.js';
import type { LLMProvider, PermissionResolution } from '../bridge/context.js';
import { info, error, debug } from '../config/logger.js';

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
}

export class CodexSDKProvider implements LLMProvider {
  async *streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options: StreamChatOptions = {},
  ): AsyncIterable<any> {
    // TODO: Implement Codex provider
    // This requires connection to Codex app server
    // For now, yield an error message
    error('codex-sdk', 'Codex provider not yet implemented');
    yield {
      type: 'error',
      data: { message: 'Codex provider not yet implemented' },
    };
  }
}
