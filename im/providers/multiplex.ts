/**
 * Multiplex LLM Provider — routes per-session to Claude or Codex SDK providers.
 */

import type { ChannelBinding } from '../bridge/types.js';
import type { LLMProvider } from '../bridge/context.js';
import { ClaudeSDKProvider } from './claude-sdk.js';
import { CodexSDKProvider } from './codex-sdk.js';
import { info } from '../config/logger.js';

export class MultiplexLLMProvider implements LLMProvider {
  private claude: ClaudeSDKProvider;
  private codex: CodexSDKProvider;

  constructor(claudeCliPath?: string) {
    this.claude = new ClaudeSDKProvider(claudeCliPath);
    this.codex = new CodexSDKProvider();
  }

  async *streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options: any = {},
  ): AsyncIterable<any> {
    const runtime = binding.runtime || 'claude';

    info('multiplex', `Routing to runtime: ${runtime} for binding ${binding.id}`);

    switch (runtime) {
      case 'claude':
        yield* this.claude.streamChat(binding, messages, options);
        break;
      case 'codex':
        yield* this.codex.streamChat(binding, messages, options);
        break;
      default:
        throw new Error(`Unknown runtime: ${runtime}`);
    }
  }
}
