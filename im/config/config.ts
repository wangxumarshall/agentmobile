/**
 * Unified configuration loader for agentmobile.
 * Merges .env (Web channel) and IM channel config.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

export interface FeishuProfileConfig {
  id: string;
  appId?: string;
  appSecret?: string;
  domain?: 'lark';
  allowedUsers?: string[];
  showToolCallCards?: boolean;
}

export interface TelegramConfig {
  botToken?: string;
  webhookSecret?: string;
  defaultSession?: string;
}

export interface ImConfig {
  enabled: boolean;
  telegram: TelegramConfig;
  feishu: FeishuProfileConfig;
  defaultWorkDir: string;
  claudeExecutable?: string;
}

export interface WebConfig {
  port: number;
  jwtSecret: string;
  bcryptPassword: string;
  tmuxSession: string;
  workspaceRoot: string;
}

export interface AgentMobileConfig {
  web: WebConfig;
  im: ImConfig;
}

function loadEnvFile(): Record<string, string> {
  const envPath = join(rootDir, '.env');
  const env: Record<string, string> = {};
  
  if (!existsSync(envPath)) return env;
  
  try {
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      env[key] = val;
    }
  } catch {
    // Ignore
  }
  
  return env;
}

// Cache parsed .env at module load time (avoids re-reading on every getEnv call)
const cachedEnv = loadEnvFile();

function getEnv(key: string, fallback: string): string {
  return cachedEnv[key] || process.env[key] || fallback;
}

function getEnvBool(key: string, fallback: boolean): boolean {
  const val = getEnv(key, fallback ? 'true' : 'false');
  return val === 'true' || val === '1' || val === 'yes';
}

export function loadConfig(): AgentMobileConfig {
  const imEnabled = getEnvBool('IM_BRIDGE_ENABLED', false);
  const telegramEnabled = getEnvBool('TELEGRAM_ENABLED', true);
  const feishuEnabled = getEnvBool('FEISHU_ENABLED', false);
  
  const defaultWorkDir = getEnv('CTI_DEFAULT_WORKDIR', getEnv('WORKSPACE_ROOT', process.env.HOME || '/home/ubuntu'));
  
  const feishuAllowedUsers = getEnv('CTI_FEISHU_ALLOWED_USERS', '')
    .split(',')
    .map(u => u.trim())
    .filter(Boolean);
  
const jwtSecret = getEnv('JWT_SECRET', '');
  const bcryptPassword = getEnv('BCRYPT_PASSWORD', '');

  // Validate secrets are set (prevent production using defaults)
  if (!jwtSecret || jwtSecret === 'change-me') {
    throw new Error('JWT_SECRET must be set in .env — do not use the default value');
  }
  if (!bcryptPassword || bcryptPassword === 'change-me') {
    throw new Error('BCRYPT_PASSWORD must be set in .env — do not use the default value');
  }

  return {
    web: {
      port: parseInt(getEnv('PORT', '5000'), 10),
      jwtSecret,
      bcryptPassword,
      tmuxSession: getEnv('TMUX_SESSION', 'agentmobile'),
      workspaceRoot: getEnv('WORKSPACE_ROOT', '/home/ubuntu/workspace'),
    },
    im: {
      enabled: imEnabled,
      defaultWorkDir,
      claudeExecutable: getEnv('CTI_CLAUDE_CODE_EXECUTABLE', 'claude'),
      telegram: {
        botToken: telegramEnabled ? getEnv('TELEGRAM_BOT_TOKEN', '') : undefined,
        webhookSecret: telegramEnabled ? getEnv('TELEGRAM_WEBHOOK_SECRET', '') : undefined,
        defaultSession: getEnv('TELEGRAM_DEFAULT_SESSION', 'default'),
      },
      feishu: {
        id: 'default',
        appId: feishuEnabled ? getEnv('CTI_FEISHU_APP_ID', '') : undefined,
        appSecret: feishuEnabled ? getEnv('CTI_FEISHU_APP_SECRET', '') : undefined,
        domain: getEnv('CTI_FEISHU_DOMAIN', '') as 'lark' | undefined || undefined,
        allowedUsers: feishuAllowedUsers.length > 0 ? feishuAllowedUsers : undefined,
        showToolCallCards: getEnvBool('CTI_FEISHU_SHOW_TOOL_CALL_CARDS', false),
      },
    },
  };
}

export function saveConfig(_config: AgentMobileConfig): void {
  // For now, config is only loaded from .env
  // Future: allow runtime config updates persisted to a file
  throw new Error('saveConfig not implemented');
}
