/**
 * Long-running Codex terminal runtime for Telegram bridge sessions.
 *
 * This intentionally keeps Codex in its normal interactive TTY mode. Telegram
 * sends keyboard input into the PTY, while the bridge projects visible terminal
 * output back as an editable transcript and an on-demand screen snapshot.
 */

import * as pty from 'node-pty';
import type { IPty, IPtyForkOptions } from 'node-pty';
import type { ChannelBinding } from '../bridge/types.js';
import type { ActivityEventInfo } from '../bridge/context.js';
import { debug, info } from '../config/logger.js';

export type CodexTerminalKey =
  | 'enter'
  | 'esc'
  | 'tab'
  | 'backspace'
  | 'ctrlc'
  | 'ctrld'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pgup'
  | 'pgdn';

export const CODEX_TERMINAL_KEY_SEQUENCES: Record<CodexTerminalKey, string> = {
  enter: '\r',
  esc: '\x1b',
  tab: '\t',
  backspace: '\x7f',
  ctrlc: '\x03',
  ctrld: '\x04',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  pgup: '\x1b[5~',
  pgdn: '\x1b[6~',
};

export interface CodexTerminalCallbacks {
  onTranscriptUpdate?: (transcript: string) => void;
  onActivityEvent?: (event: ActivityEventInfo) => void;
}

export interface CodexTerminalRuntime {
  getOrCreate(binding: ChannelBinding, callbacks?: CodexTerminalCallbacks): CodexTerminalSession;
  hasSession(bindingId: string): boolean;
  sendInput(binding: ChannelBinding, text: string, callbacks?: CodexTerminalCallbacks): CodexTerminalSession;
  sendKey(binding: ChannelBinding, key: CodexTerminalKey, callbacks?: CodexTerminalCallbacks): CodexTerminalSession | null;
  getTranscriptSnapshot(bindingId: string, maxChars?: number): string;
  getScreenSnapshot(bindingId: string): string;
  stopSession(bindingId: string): void;
  stopAll(): void;
}

export interface PtyLike {
  readonly pid?: number;
  write(data: string): void;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

type PtyFactory = (file: string, args: string[], options: IPtyForkOptions) => PtyLike;

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MAX_TRANSCRIPT_LINES = 500;

export class CodexTerminalSessionManager implements CodexTerminalRuntime {
  private sessions = new Map<string, CodexTerminalSession>();
  private readonly ptyFactory: PtyFactory;

  constructor(ptyFactory: PtyFactory = defaultPtyFactory) {
    this.ptyFactory = ptyFactory;
  }

  getOrCreate(binding: ChannelBinding, callbacks: CodexTerminalCallbacks = {}): CodexTerminalSession {
    const existing = this.sessions.get(binding.id);
    if (existing) {
      existing.setCallbacks(callbacks);
      return existing;
    }

    const session = new CodexTerminalSession(binding, {
      ptyFactory: this.ptyFactory,
      callbacks,
      onExit: () => {
        this.sessions.delete(binding.id);
      },
    });
    this.sessions.set(binding.id, session);
    return session;
  }

  hasSession(bindingId: string): boolean {
    return this.sessions.has(bindingId);
  }

  sendInput(
    binding: ChannelBinding,
    text: string,
    callbacks: CodexTerminalCallbacks = {},
  ): CodexTerminalSession {
    const session = this.getOrCreate(binding, callbacks);
    session.writeInput(text);
    return session;
  }

  sendKey(
    binding: ChannelBinding,
    key: CodexTerminalKey,
    callbacks: CodexTerminalCallbacks = {},
  ): CodexTerminalSession | null {
    const session = this.sessions.get(binding.id);
    if (!session) return null;
    session.setCallbacks(callbacks);
    session.writeKey(key);
    return session;
  }

  getTranscriptSnapshot(bindingId: string, maxChars = 3800): string {
    return this.sessions.get(bindingId)?.getTranscriptSnapshot(maxChars) || '';
  }

  getScreenSnapshot(bindingId: string): string {
    return this.sessions.get(bindingId)?.getScreenSnapshot() || '';
  }

  stopSession(bindingId: string): void {
    const session = this.sessions.get(bindingId);
    if (!session) return;
    session.dispose();
    this.sessions.delete(bindingId);
  }

  stopAll(): void {
    for (const bindingId of Array.from(this.sessions.keys())) {
      this.stopSession(bindingId);
    }
  }
}

interface CodexTerminalSessionOptions {
  ptyFactory: PtyFactory;
  callbacks: CodexTerminalCallbacks;
  onExit: () => void;
}

export class CodexTerminalSession {
  readonly id: string;
  readonly bindingId: string;

  private readonly proc: PtyLike;
  private readonly transcript = new TerminalTranscriptBuffer(MAX_TRANSCRIPT_LINES);
  private readonly screen = new TerminalScreenBuffer(DEFAULT_COLS, DEFAULT_ROWS);
  private callbacks: CodexTerminalCallbacks;
  private disposed = false;
  private lastActivityKey = '';
  private lastActivityAt = 0;

  constructor(binding: ChannelBinding, options: CodexTerminalSessionOptions) {
    this.id = binding.terminalSessionId || `codex_terminal_${binding.id}`;
    this.bindingId = binding.id;
    this.callbacks = options.callbacks;

    const args = buildCodexInteractiveArgs(binding);
    this.proc = options.ptyFactory('codex', args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: binding.workingDirectory,
      env: {
        ...process.env,
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TERM: 'xterm-256color',
      },
    });

    binding.terminalSessionId = this.id;
    info('codex-terminal', `Started Codex terminal ${this.id} for binding ${binding.id}`);

    this.proc.onData((data) => this.handleData(data));
    this.proc.onExit((event) => {
      if (this.disposed) return;
      this.disposed = true;
      info('codex-terminal', `Codex terminal ${this.id} exited with code ${event.exitCode}`);
      options.onExit();
    });
  }

  setCallbacks(callbacks: CodexTerminalCallbacks): void {
    this.callbacks = callbacks;
  }

  writeInput(text: string): void {
    if (this.disposed) return;
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (normalized.includes('\n')) {
      this.proc.write(`\x1b[200~${normalized}\x1b[201~\r`);
    } else {
      this.proc.write(`${normalized}\r`);
    }
  }

  writeKey(key: CodexTerminalKey): void {
    if (this.disposed) return;
    this.proc.write(CODEX_TERMINAL_KEY_SEQUENCES[key]);
  }

  getTranscriptSnapshot(maxChars = 3800): string {
    return this.transcript.snapshot(maxChars);
  }

  getScreenSnapshot(): string {
    return this.screen.snapshot();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callbacks = {};
    try {
      this.proc.kill('SIGTERM');
    } catch (e) {
      debug('codex-terminal', `Failed to terminate Codex terminal ${this.id}: ${e}`);
    }
  }

  private handleData(data: string): void {
    if (this.disposed) return;

    this.transcript.feed(data);
    this.screen.feed(data);

    const transcript = this.transcript.snapshot();
    this.callbacks.onTranscriptUpdate?.(transcript);

    for (const event of parseActivityEvents(data)) {
      const key = `${event.type}:${event.title}:${event.description || ''}`;
      const now = Date.now();
      if (key === this.lastActivityKey && now - this.lastActivityAt < 2000) {
        continue;
      }
      this.lastActivityKey = key;
      this.lastActivityAt = now;
      this.callbacks.onActivityEvent?.(event);
    }
  }
}

export function buildCodexInteractiveArgs(binding: ChannelBinding): string[] {
  const args = [
    '--no-alt-screen',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    binding.workingDirectory,
  ];

  if (binding.model && binding.model !== 'default') {
    args.push('-m', binding.model);
  }

  return args;
}

export function isCodexTerminalKey(value: string): value is CodexTerminalKey {
  return Object.prototype.hasOwnProperty.call(CODEX_TERMINAL_KEY_SEQUENCES, value);
}

export function stripTerminalAnsi(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\x1b/g, '');
}

function defaultPtyFactory(file: string, args: string[], options: IPtyForkOptions): PtyLike {
  return pty.spawn(file, args, options) as IPty;
}

class TerminalTranscriptBuffer {
  private lines: string[] = [];
  private current = '';
  private cursor = 0;

  constructor(private readonly maxLines: number) {}

  feed(raw: string): void {
    const text = stripTerminalAnsi(raw);
    for (const ch of text) {
      switch (ch) {
        case '\r':
          this.cursor = 0;
          break;
        case '\n':
          this.commitLine();
          break;
        case '\b':
        case '\x7f':
          if (this.cursor > 0) {
            this.current = this.current.slice(0, this.cursor - 1) + this.current.slice(this.cursor);
            this.cursor -= 1;
          }
          break;
        case '\t':
          this.insert(' '.repeat(4 - (this.cursor % 4)));
          break;
        default:
          if (ch >= ' ') this.insert(ch);
      }
    }
  }

  snapshot(maxChars = 3800): string {
    const rows = [...this.lines];
    if (this.current.trim()) rows.push(this.current);
    const text = rows
      .map(line => line.trimEnd())
      .filter((line, index, all) => line.trim() || index === all.length - 1)
      .join('\n')
      .trimEnd();
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
  }

  private insert(text: string): void {
    this.current = this.current.slice(0, this.cursor) + text + this.current.slice(this.cursor + text.length);
    this.cursor += text.length;
  }

  private commitLine(): void {
    this.lines.push(this.current);
    this.current = '';
    this.cursor = 0;
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }
}

class TerminalScreenBuffer {
  private rows: string[][];
  private row = 0;
  private col = 0;

  constructor(
    private readonly cols: number,
    private readonly rowCount: number,
  ) {
    this.rows = Array.from({ length: rowCount }, () => this.blankRow());
  }

  feed(raw: string): void {
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === '\x1b') {
        const parsed = this.parseEscape(raw, i);
        if (parsed) {
          this.applyEscape(parsed.sequence);
          i = parsed.end;
        }
        continue;
      }

      switch (ch) {
        case '\r':
          this.col = 0;
          break;
        case '\n':
          this.newLine();
          break;
        case '\b':
        case '\x7f':
          this.col = Math.max(0, this.col - 1);
          break;
        case '\t':
          this.writeText(' '.repeat(4 - (this.col % 4)));
          break;
        default:
          if (ch >= ' ') this.writeText(ch);
      }
    }
  }

  snapshot(): string {
    return this.rows
      .map(row => row.join('').trimEnd())
      .join('\n')
      .replace(/\s+$/g, '');
  }

  private parseEscape(raw: string, start: number): { sequence: string; end: number } | null {
    const introducer = raw[start + 1];
    if (introducer === '[') {
      for (let i = start + 2; i < raw.length; i += 1) {
        const code = raw.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          return { sequence: raw.slice(start, i + 1), end: i };
        }
      }
      return null;
    }
    if (introducer === ']') {
      for (let i = start + 2; i < raw.length; i += 1) {
        if (raw[i] === '\x07') return { sequence: raw.slice(start, i + 1), end: i };
        if (raw[i] === '\x1b' && raw[i + 1] === '\\') {
          return { sequence: raw.slice(start, i + 2), end: i + 1 };
        }
      }
      return null;
    }
    return { sequence: raw.slice(start, Math.min(start + 2, raw.length)), end: Math.min(start + 1, raw.length - 1) };
  }

  private applyEscape(sequence: string): void {
    if (!sequence.startsWith('\x1b[')) return;
    const final = sequence[sequence.length - 1];
    const params = sequence.slice(2, -1).replace(/[?=]/g, '');
    const nums = params
      .split(';')
      .filter(Boolean)
      .map(part => Number.parseInt(part, 10))
      .map(value => Number.isFinite(value) ? value : 0);
    const first = nums[0] ?? 0;

    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - Math.max(1, first));
        break;
      case 'B':
        this.row = Math.min(this.rowCount - 1, this.row + Math.max(1, first));
        break;
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + Math.max(1, first));
        break;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, first));
        break;
      case 'G':
        this.col = Math.min(this.cols - 1, Math.max(0, Math.max(1, first) - 1));
        break;
      case 'H':
      case 'f':
        this.row = Math.min(this.rowCount - 1, Math.max(0, (nums[0] || 1) - 1));
        this.col = Math.min(this.cols - 1, Math.max(0, (nums[1] || 1) - 1));
        break;
      case 'J':
        this.clearScreen(first);
        break;
      case 'K':
        this.clearLine(first);
        break;
      default:
        break;
    }
  }

  private writeText(text: string): void {
    for (const ch of text) {
      this.rows[this.row][this.col] = ch;
      this.col += 1;
      if (this.col >= this.cols) {
        this.newLine();
      }
    }
  }

  private newLine(): void {
    this.col = 0;
    this.row += 1;
    if (this.row >= this.rowCount) {
      this.rows.shift();
      this.rows.push(this.blankRow());
      this.row = this.rowCount - 1;
    }
  }

  private clearLine(mode: number): void {
    if (mode === 1) {
      for (let i = 0; i <= this.col; i += 1) this.rows[this.row][i] = ' ';
      return;
    }
    if (mode === 2) {
      this.rows[this.row] = this.blankRow();
      return;
    }
    for (let i = this.col; i < this.cols; i += 1) this.rows[this.row][i] = ' ';
  }

  private clearScreen(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.rows = Array.from({ length: this.rowCount }, () => this.blankRow());
      this.row = 0;
      this.col = 0;
      return;
    }

    if (mode === 1) {
      for (let r = 0; r <= this.row; r += 1) {
        const end = r === this.row ? this.col : this.cols - 1;
        for (let c = 0; c <= end; c += 1) this.rows[r][c] = ' ';
      }
      return;
    }

    for (let r = this.row; r < this.rowCount; r += 1) {
      const start = r === this.row ? this.col : 0;
      for (let c = start; c < this.cols; c += 1) this.rows[r][c] = ' ';
    }
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => ' ');
  }
}

function parseActivityEvents(raw: string): ActivityEventInfo[] {
  const clean = stripTerminalAnsi(raw);
  const events: ActivityEventInfo[] = [];
  const lines = clean.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  for (const line of lines) {
    const command = extractCommand(line);
    if (command) {
      events.push({
        type: 'command',
        title: command,
        description: 'running',
        metadata: { commandId: command },
      });
      continue;
    }

    const changedFile = extractChangedFile(line);
    if (changedFile) {
      events.push({
        type: 'file_change',
        title: 'File change',
        description: changedFile,
        metadata: { changes: [{ kind: 'update', path: changedFile }] },
      });
      continue;
    }

    if (/thinking|reasoning|working|running/i.test(line)) {
      events.push({
        type: 'progress',
        title: 'Codex status',
        description: line.slice(0, 220),
        metadata: { status: 'running', source: 'codex-terminal' },
      });
    }
  }

  return events;
}

function extractCommand(line: string): string | null {
  const patterns = [
    /^\$\s+(.+)$/,
    /^>\s+exec_command\s+(.+)$/i,
    /^running command:?\s+(.+)$/i,
    /^command:?\s+(.+)$/i,
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1].trim().slice(0, 500);
  }
  return null;
}

function extractChangedFile(line: string): string | null {
  const match = line.match(/(?:modified|created|deleted|updated|write(?:d)?|patch(?:ed)?)(?: file)?:?\s+(.+)$/i);
  if (!match?.[1]) return null;
  const candidate = match[1].trim();
  if (!candidate || /\s{2,}/.test(candidate)) return null;
  return candidate.slice(0, 240);
}
