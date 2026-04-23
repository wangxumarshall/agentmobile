/**
 * Runtime type definitions for AI agent providers.
 */

export type RuntimeName = 'claude' | 'codex';

export interface RuntimeCapabilities {
  name: RuntimeName;
  label: string;
  symbol: string;
  supportsPlanMode: boolean;
  supportsNativeSessions: boolean;
  supportsStructuredInput: boolean;
  defaultPermissionMode: 'default' | 'acceptEdits' | 'plan';
}

export const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  name: 'claude',
  label: 'Claude Code',
  symbol: '⚡',
  supportsPlanMode: true,
  supportsNativeSessions: true,
  supportsStructuredInput: true,
  defaultPermissionMode: 'default',
};

export const CODEX_CAPABILITIES: RuntimeCapabilities = {
  name: 'codex',
  label: 'Codex',
  symbol: '🔷',
  supportsPlanMode: true,
  supportsNativeSessions: true,
  supportsStructuredInput: true,
  defaultPermissionMode: 'default',
};

export function getRuntimeCapabilities(runtime: RuntimeName): RuntimeCapabilities {
  switch (runtime) {
    case 'claude':
      return CLAUDE_CAPABILITIES;
    case 'codex':
      return CODEX_CAPABILITIES;
    default:
      throw new Error(`Unknown runtime: ${runtime}`);
  }
}

export function isValidRuntime(name: string): name is RuntimeName {
  return name === 'claude' || name === 'codex';
}
