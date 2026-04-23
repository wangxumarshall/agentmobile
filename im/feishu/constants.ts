/**
 * Feishu/Lark constants and configuration defaults.
 */

// Required Feishu app scopes for the bridge to function
export const FEISHU_REQUIRED_APP_SCOPES = [
  'im:message',
  'im:message.send_as_bot',
  'im:message.group_at_msg',
  'im:message.group_at_msg:readonly',
  'im:chat',
  'im:chat:readonly',
  'im:member',
  'im:member:readonly',
  'im:message:readonly',
  'im:message.message_read_v1',
  'im:chat.updated_v1',
  'im:chat.member.bot.added_v1',
  'contact:contact.base:readonly',
];

// Streaming preview configuration
export const PREVIEW_CONFIG = {
  throttleIntervalMs: 700,        // Min interval between preview updates
  throttleDeltaChars: 20,         // Min chars changed before sending
  maxChars: 3900,                 // Max chars for preview text
  primeTimeoutMs: 3000,           // Timeout for priming placeholder
  degradeAfterFailures: 3,        // Switch to patch mode after N failures
};

// Activity card configuration
export const ACTIVITY_CONFIG = {
  maxInputPreviewChars: 220,      // Max chars for tool input preview
  maxResultPreviewChars: 220,     // Max chars for tool result preview
  showToolCallCardsDefault: false,// Default: hide tool call cards
  recoverableTimeoutMs: 10000,    // Recovery window for timed-out sends
};

// Message rate limiting
export const RATE_LIMIT_CONFIG = {
  minIntervalMs: 250,             // Min time between messages per chat
  maxRetries: 3,                  // Max retries on transient failures
};

// Feishu API base URLs
export const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';
export const LARK_API_BASE = 'https://open.larksuite.com/open-apis';

// Card templates
export const CARD_TEMPLATES = {
  blue: 'blue',
  green: 'green',
  red: 'red',
  orange: 'orange',
  purple: 'purple',
  turquoise: 'turquoise',
  indigo: 'indigo',
  wathet: 'wathet',
  yellow: 'yellow',
  carmine: 'carmine',
  violet: 'violet',
  grey: 'grey',
} as const;

// Runtime defaults
export const RUNTIME_DEFAULTS = {
  claude: {
    label: 'Claude Code',
    symbol: '⚡',
    defaultPermissionMode: 'default' as const,
  },
  codex: {
    label: 'Codex',
    symbol: '🔷',
    defaultPlanModel: 'gpt-5.4',
  },
};
