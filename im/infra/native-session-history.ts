/**
 * Native session history loader.
 *
 * Loads recent AI agent sessions from native state files
 * for resume functionality.
 *
 * Note: This is a stub implementation. Full implementation
 * requires reading Claude/Codex native state directories.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { info, error, debug } from '../config/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

export interface NativeSessionSummary {
  id: string;
  title: string;
  runtime: 'claude' | 'codex';
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface NativeReplayItem {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/**
 * List recent native sessions.
 *
 * Scans Claude Code and Codex session directories
 * for recent, resumable sessions.
 */
export function listRecentNativeSessions(
  maxCount: number = 10,
): NativeSessionSummary[] {
  // TODO: Implement native session scanning
  // For now, return empty list
  // Future: Scan:
  // - ~/.claude/sessions/ for Claude sessions
  // - ~/.codex/sessions/ for Codex sessions
  debug('native-session', 'listRecentNativeSessions: stub implementation');
  return [];
}

/**
 * Load a native session transcript.
 *
 * Reads the full message history from native session files.
 */
export function loadNativeSessionTranscript(
  sessionId: string,
  runtime: 'claude' | 'codex',
): NativeReplayItem[] | null {
  // TODO: Implement session loading
  debug('native-session', `loadNativeSessionTranscript: ${sessionId} (${runtime})`);
  return null;
}

/**
 * Check if a session ID corresponds to a valid native session.
 */
export function existsNativeSession(
  sessionId: string,
  runtime: 'claude' | 'codex',
): boolean {
  // TODO: Check session existence
  return false;
}
