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

type CodexSpawn = typeof spawn;

export class CodexSDKProvider implements LLMProvider {
  private spawnProcess: CodexSpawn;

  constructor(spawnProcess: CodexSpawn = spawn) {
    this.spawnProcess = spawnProcess;
  }

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
    let pendingStdoutLine = '';
    let streamedText = '';

    const args = binding.sdkSessionId
      ? ['exec', 'resume', binding.sdkSessionId, '--output-last-message', outputFile, '--skip-git-repo-check', '--full-auto', '--json', prompt]
      : ['exec', '--output-last-message', outputFile, '--skip-git-repo-check', '--full-auto', '--json', prompt];

    if (binding.model && binding.model !== 'default') {
      args.splice(binding.sdkSessionId ? 3 : 1, 0, '-m', binding.model);
    }

    debug('codex-sdk', `Starting Codex CLI for binding ${binding.id}`);

    try {
      options.onActivityEvent?.({
        type: 'progress',
        title: 'Codex status',
        description: 'Codex exec is starting.',
        metadata: { status: 'running', source: 'codex-sdk' },
      });

      child = this.spawnProcess('codex', args, {
        cwd: binding.workingDirectory,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (!child.stdout || !child.stderr) {
        throw new Error('Codex process stdio is unavailable');
      }

      const abortListener = () => child?.kill('SIGTERM');
      options.abortSignal?.addEventListener('abort', abortListener, { once: true });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const stdoutLines: string[] = [];
      let stdoutDone = false;
      let notifyLine: (() => void) | null = null;
      const notify = () => {
        notifyLine?.();
        notifyLine = null;
      };
      const waitForLine = async () => {
        if (stdoutLines.length > 0 || stdoutDone) return;
        await new Promise<void>(resolve => {
          notifyLine = resolve;
        });
      };

      void (async () => {
        try {
          for await (const chunk of child!.stdout!) {
            const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
            stdout += text;
            pendingStdoutLine += text;
            const lines = pendingStdoutLine.split(/\r?\n/);
            pendingStdoutLine = lines.pop() || '';
            stdoutLines.push(...lines);
            notify();
          }
          if (pendingStdoutLine.trim()) {
            stdoutLines.push(pendingStdoutLine);
            pendingStdoutLine = '';
          }
        } finally {
          stdoutDone = true;
          notify();
        }
      })();

      const exitCodePromise = new Promise<number>((resolve, reject) => {
        child?.once('error', reject);
        child?.once('close', code => resolve(code ?? 0));
      });

      while (!stdoutDone || stdoutLines.length > 0) {
        await waitForLine();
        const line = stdoutLines.shift();
        if (!line) continue;
        const event = this.parseJsonLine(line);
        if (!event) continue;
        const sessionId = this.extractSessionIdFromEvent(event);
        if (sessionId) discoveredSessionId = sessionId;
        this.projectJsonActivity(event, options.onActivityEvent);
        const delta = this.extractPublicTextDelta(event);
        if (delta) {
          streamedText += delta;
          yield { type: 'text', text: delta };
        }
      }

      const exitCode = await exitCodePromise;
      options.abortSignal?.removeEventListener('abort', abortListener);

      if (options.abortSignal?.aborted) {
        yield { type: 'error', data: { message: 'Codex request aborted' } };
        return;
      }

      const finalText = existsSync(outputFile)
        ? readFileSync(outputFile, 'utf8').trim()
        : stdout.trim();

      if (exitCode !== 0) {
        options.onActivityEvent?.({
          type: 'progress',
          title: 'Codex status',
          description: (stderr || stdout || `Codex exited with code ${exitCode}`).trim(),
          metadata: { status: 'failed', source: 'codex-sdk' },
        });
        yield {
          type: 'error',
          data: { message: (stderr || stdout || `Codex exited with code ${exitCode}`).trim() },
        };
        return;
      }

      if (finalText && !streamedText.trim()) {
        yield { type: 'text', text: finalText };
      }

      options.onActivityEvent?.({
        type: 'progress',
        title: 'Codex status',
        description: 'Codex exec finished.',
        metadata: { status: 'completed', source: 'codex-sdk' },
      });

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
      return this.extractSessionIdFromEvent(parsed);
    } catch {
      return null;
    }
  }

  private parseJsonLine(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private extractSessionIdFromEvent(event: Record<string, unknown>): string | null {
    const nested = this.asRecord(event.data) || this.asRecord(event.item);
    const candidates = [
      event.session_id,
      event.sessionId,
      event.session,
      nested?.session_id,
      nested?.sessionId,
      nested?.id,
    ];
    return (candidates.find(value => typeof value === 'string') as string | undefined) || null;
  }

  private projectJsonActivity(
    event: Record<string, unknown>,
    onActivityEvent?: StreamChatOptions['onActivityEvent'],
  ): void {
    if (!onActivityEvent) return;

    const type = this.eventType(event);
    const item = this.asRecord(event.item);
    const data = this.asRecord(event.data);
    const subject = item || data || event;
    const subjectType = this.eventType(subject);

    if (this.isHiddenReasoningEvent(event)) {
      onActivityEvent({
        type: 'progress',
        title: 'Codex status',
        description: 'Codex is reasoning internally. Hidden chain-of-thought is not shown.',
        metadata: { status: 'running', source: 'codex-sdk' },
      });
      return;
    }

    const status = this.stringField(event, 'status') || this.stringField(subject, 'status');
    if (/error|failed|failure/i.test(type) || status === 'failed') {
      onActivityEvent({
        type: 'progress',
        title: 'Codex status',
        description: this.publicDescription(event) || 'Codex reported an error.',
        metadata: { status: 'failed', source: 'codex-sdk' },
      });
      return;
    }

    const command = this.stringField(subject, 'command') || this.stringField(subject, 'cmd');
    if (command || /exec|command|shell/i.test(type) || /exec|command|shell/i.test(subjectType)) {
      onActivityEvent({
        type: 'command',
        title: command || this.stringField(subject, 'name') || 'Codex command',
        description: status || 'running',
        metadata: { commandId: command || this.stringField(subject, 'id') || type, source: 'codex-sdk' },
      });
      return;
    }

    if (/tool/i.test(type) || /tool/i.test(subjectType)) {
      onActivityEvent({
        type: 'tool_use',
        title: this.stringField(subject, 'name') || this.stringField(subject, 'tool_name') || 'Codex tool',
        description: this.truncateJson(subject, 500),
        metadata: { toolId: this.stringField(subject, 'id') || this.stringField(event, 'id') || type, source: 'codex-sdk' },
      });
      return;
    }

    if (/file.*change|patch|edit|write/i.test(type) || /file.*change|patch|edit|write/i.test(subjectType)) {
      const path = this.stringField(subject, 'path') || this.stringField(subject, 'file') || this.stringField(subject, 'filename');
      onActivityEvent({
        type: 'file_change',
        title: 'File change',
        description: path || this.publicDescription(event) || 'Codex updated files.',
        metadata: {
          changes: path ? [{ kind: 'update', path }] : undefined,
          source: 'codex-sdk',
        },
      });
      return;
    }

    if (/turn|start|progress|status|step|item/i.test(type)) {
      onActivityEvent({
        type: 'progress',
        title: 'Codex status',
        description: this.publicDescription(event) || 'Codex is working.',
        metadata: { status: status === 'completed' ? 'completed' : 'running', source: 'codex-sdk' },
      });
    }
  }

  private extractPublicTextDelta(event: Record<string, unknown>): string {
    if (this.isHiddenReasoningEvent(event)) return '';

    const type = this.eventType(event);
    const item = this.asRecord(event.item);
    const data = this.asRecord(event.data);
    const subject = item || data || event;
    const subjectType = this.eventType(subject);
    const combinedType = `${type} ${subjectType}`;

    if (!/(assistant|agent|message|output_text|response\.output_text)/i.test(combinedType)) {
      return '';
    }
    if (/(user|input|reason|thinking|tool|command)/i.test(combinedType)) {
      return '';
    }

    const directDelta = this.stringField(subject, 'delta') || this.stringField(event, 'delta');
    if (directDelta) return directDelta;
    const text = this.stringField(subject, 'text') || this.stringField(subject, 'content');
    if (text) return text;

    const content = Array.isArray(subject.content)
      ? subject.content as unknown[]
      : Array.isArray(event.content)
        ? event.content as unknown[]
        : [];
    return content
      .map(part => this.asRecord(part))
      .filter((part): part is Record<string, unknown> => Boolean(part))
      .filter(part => !this.isHiddenReasoningEvent(part))
      .map(part => this.stringField(part, 'text') || '')
      .join('');
  }

  private isHiddenReasoningEvent(event: Record<string, unknown>): boolean {
    const type = this.eventType(event);
    const nested = this.asRecord(event.item) || this.asRecord(event.data) || this.asRecord(event.delta);
    const nestedType = nested ? this.eventType(nested) : '';
    return /reason|thinking|chain_of_thought|cot/i.test(`${type} ${nestedType}`);
  }

  private publicDescription(event: Record<string, unknown>): string {
    const data = this.asRecord(event.data);
    const item = this.asRecord(event.item);
    const subject = item || data || event;
    const candidates = [
      this.stringField(event, 'message'),
      this.stringField(event, 'status'),
      this.stringField(event, 'summary'),
      this.stringField(subject, 'message'),
      this.stringField(subject, 'status'),
      this.stringField(subject, 'summary'),
      this.eventType(event),
    ].filter(Boolean);
    return (candidates[0] || '').slice(0, 500);
  }

  private eventType(event: Record<string, unknown>): string {
    return this.stringField(event, 'type') || this.stringField(event, 'event') || '';
  }

  private stringField(event: Record<string, unknown>, field: string): string {
    const value = event[field];
    return typeof value === 'string' ? value : '';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private truncateJson(value: unknown, maxChars: number): string {
    try {
      const text = JSON.stringify(value);
      return text.length <= maxChars ? text : text.slice(0, maxChars);
    } catch {
      return '[unserializable event]';
    }
  }
}
