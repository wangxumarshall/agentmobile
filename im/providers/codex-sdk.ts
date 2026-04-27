/**
 * Codex SDK Provider for IM bridge.
 * Executes Codex CLI in non-interactive mode and returns the final reply.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelBinding } from '../bridge/types.js';
import type { LLMProvider, PermissionResolution, SSEEvent } from '../bridge/context.js';
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

export class CodexSDKProvider implements LLMProvider {
  async *streamChat(
    binding: ChannelBinding,
    messages: Array<{ role: string; content: string }>,
    options: StreamChatOptions = {},
  ): AsyncIterable<SSEEvent> {
    const prompt = this.buildPrompt(messages, binding.mode);
    const tempDir = mkdtempSync(join(tmpdir(), 'agentmobile-codex-'));
    const outputFile = join(tempDir, 'last-message.txt');
    let child: ReturnType<typeof spawn> | null = null;
    let stdout = '';
    let stderr = '';
    let discoveredSessionId = binding.sdkSessionId || '';

    const args = binding.sdkSessionId
      ? ['exec', 'resume', binding.sdkSessionId, '--output-last-message', outputFile, '--skip-git-repo-check', '--full-auto', '--json', prompt]
      : ['exec', '--output-last-message', outputFile, '--skip-git-repo-check', '--full-auto', '--json', prompt];

    if (binding.model && binding.model !== 'default') {
      args.splice(binding.sdkSessionId ? 3 : 1, 0, '-m', binding.model);
    }

    debug('codex-sdk', `Starting Codex CLI for binding ${binding.id}`);

    try {
      child = spawn('codex', args, {
        cwd: binding.workingDirectory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child.stdout || !child.stderr) {
        throw new Error('Codex process stdio is unavailable');
      }

      const abortListener = () => child?.kill('SIGTERM');
      options.abortSignal?.addEventListener('abort', abortListener, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        stdout += text;
        for (const line of text.split('\n')) {
          const sessionId = this.extractSessionId(line);
          if (sessionId) discoveredSessionId = sessionId;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const exitCode = await new Promise<number>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('close', code => resolve(code ?? 0));
      });

      options.abortSignal?.removeEventListener('abort', abortListener);

      if (options.abortSignal?.aborted) {
        yield { type: 'error', data: { message: 'Codex request aborted' } };
        return;
      }

      const finalText = existsSync(outputFile)
        ? readFileSync(outputFile, 'utf8').trim()
        : stdout.trim();

      if (exitCode !== 0) {
        yield {
          type: 'error',
          data: { message: (stderr || stdout || `Codex exited with code ${exitCode}`).trim() },
        };
        return;
      }

      if (finalText) {
        yield { type: 'text', text: finalText };
      }

      yield {
        type: 'result',
        data: {
          sessionId: discoveredSessionId || undefined,
          isError: false,
        },
      };
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error('codex-sdk', `Codex stream error: ${err.message}`);
      yield {
        type: 'error',
        data: { message: err.message },
      };
    } finally {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  private buildPrompt(
    messages: Array<{ role: string; content: string }>,
    mode: ChannelBinding['mode'],
  ): string {
    const transcript = messages
      .map(message => `${message.role.toUpperCase()}:\n${message.content}`)
      .join('\n\n');

    const modeInstruction = mode === 'plan'
      ? 'You are in plan mode. Produce a concrete plan only. Do not edit files or run commands.'
      : mode === 'ask'
        ? 'Answer the user directly and conservatively. Prefer explanation over making changes.'
        : 'You may inspect and modify the workspace as needed to complete the request.';

    return `${modeInstruction}\n\nConversation transcript:\n${transcript}`;
  }

  private extractSessionId(line: string): string | null {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const nested = typeof parsed.data === 'object' && parsed.data !== null
        ? parsed.data as Record<string, unknown>
        : null;
      const candidates = [
        parsed.session_id,
        parsed.sessionId,
        nested?.session_id,
        nested?.sessionId,
      ];
      return (candidates.find(value => typeof value === 'string') as string | undefined) || null;
    } catch {
      return null;
    }
  }
}
