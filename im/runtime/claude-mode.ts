/**
 * Claude permission mode management.
 *
 * Manages Claude Code permission modes:
 * - plan: Proposes a plan first, asks for approval
 * - acceptEdits: Can edit files without approval
 * - default: Asks for permission for each tool use
 */

export type ClaudePermissionMode = 'plan' | 'acceptEdits' | 'default';

export interface ClaudeModeOption {
  mode: ClaudePermissionMode;
  label: string;
  description: string;
  icon: string;
}

const MODE_OPTIONS: ClaudeModeOption[] = [
  {
    mode: 'plan',
    label: 'Plan Mode',
    description: 'Claude will propose a plan first and ask for your approval before executing',
    icon: '📋',
  },
  {
    mode: 'acceptEdits',
    label: 'Auto-Edits',
    description: 'Claude can edit files without asking for permission',
    icon: '✏️',
  },
  {
    mode: 'default',
    label: 'Default',
    description: 'Claude asks for permission before each tool use',
    icon: '🔐',
  },
];

/**
 * Get all Claude mode options.
 */
export function getClaudeModeOptions(): ClaudeModeOption[] {
  return MODE_OPTIONS;
}

/**
 * Get a Claude mode option by mode value.
 */
export function getClaudeModeOption(mode: ClaudePermissionMode): ClaudeModeOption | undefined {
  return MODE_OPTIONS.find(o => o.mode === mode);
}

/**
 * Get the human-readable label for a mode.
 */
export function getClaudeModeTitle(mode: ClaudePermissionMode): string {
  return getClaudeModeOption(mode)?.label || mode;
}

/**
 * Get the suffix/description for a mode.
 */
export function getClaudeModeSuffix(mode: ClaudePermissionMode): string {
  return getClaudeModeOption(mode)?.description || '';
}

/**
 * Normalize a permission mode string to a valid mode.
 */
export function normalizeClaudePermissionMode(
  mode?: string,
): ClaudePermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
    case 'accept-edits':
    case 'accept_edits':
      return 'acceptEdits';
    case 'default':
    case 'dontAsk':
    case 'dont-ask':
    case 'dont_ask':
    case 'bypassPermissions':
      return 'default';
    default:
      return 'default';
  }
}

/**
 * Get the SDK-compatible permission mode string.
 */
export function toSdkPermissionMode(mode: ClaudePermissionMode): 'plan' | 'acceptEdits' | 'bypassPermissions' | 'default' {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'default':
      return 'default';
    default:
      return 'default';
  }
}

/**
 * Check if a mode allows automatic execution.
 */
export function isAutoExecuteMode(mode: ClaudePermissionMode): boolean {
  return mode === 'acceptEdits' || mode === 'default';
}
