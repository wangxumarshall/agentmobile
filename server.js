// server.js — agentmobile WebSocket tmux 桥接服务
import express from 'express';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { createServer } from 'node:http';
import { exec, execFile, spawn, execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, normalize, isAbsolute, basename } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync, rmdirSync, renameSync, cpSync, rmSync } from 'fs';
import { readdir, stat as statAsync } from 'fs/promises';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import multer from 'multer';
import QRCode from 'qrcode';

// 加载 .env 文件（如果存在）
try {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch { /* .env 不存在时忽略 */ }

function buildRuntimePath() {
  const home = process.env.HOME || '/home/ubuntu';
  const dirs = [
    ...(process.env.PATH || '').split(':'),
    join(home, '.local', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean);

  try {
    const npmPrefix = execSync('npm prefix -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (npmPrefix) dirs.push(join(npmPrefix, 'bin'));
  } catch {}

  return [...new Set(dirs)].join(':');
}

process.env.PATH = buildRuntimePath();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_FILE = join(__dirname, '.env');

// 持久化数据目录（通过 Docker volume 挂载，重建容器不丢失）
const DATA_DIR = join(__dirname, 'data');
const TOOLBAR_CONFIG_FILE = join(DATA_DIR, 'toolbar-config.json');
const CONFIGS_DIR = join(DATA_DIR, 'configs');
const TASKS_FILE = join(DATA_DIR, 'tasks.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(CONFIGS_DIR)) mkdirSync(CONFIGS_DIR, { recursive: true });

// 自动确保 anthropic.json 存在（无需用户手动创建）
// 优先级：已有文件不覆盖；API_KEY 从环境变量 ANTHROPIC_API_KEY 检测
{
  const anthropicProfile = join(CONFIGS_DIR, 'anthropic.json');
  if (!existsSync(anthropicProfile)) {
    // 检测本地 CC 是否已 login（~/.claude.json 有 oauthAccount）
    let isLoggedIn = false;
    try {
      const claudeJson = JSON.parse(readFileSync(join(process.env.HOME || '~', '.claude.json'), 'utf8'));
      isLoggedIn = !!(claudeJson.oauthAccount?.accountUuid);
    } catch { /* 未登录或文件不存在 */ }

    const apiKey = process.env.ANTHROPIC_API_KEY || '';

    if (isLoggedIn || apiKey) {
      writeFileSync(anthropicProfile, JSON.stringify({
        label: 'Anthropic Claude',
        BASE_URL: '',
        AUTH_TOKEN: '',
        API_KEY: apiKey,
        DEFAULT_MODEL: 'claude-sonnet-4-6',
        THINK_MODEL: 'claude-opus-4-6',
        LONG_CONTEXT_MODEL: 'claude-opus-4-6',
        DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001',
        API_TIMEOUT_MS: '3000000',
      }, null, 2), 'utf8');
      console.log(`[agentmobile] Auto-created anthropic profile (${isLoggedIn ? 'oauth login' : 'API key from env'})`);
    }
  }
}

// 自动确保 codex.json 存在（对标 anthropic.json 自动创建逻辑）
{
  const codexProfile = join(CONFIGS_DIR, 'codex.json');
  if (!existsSync(codexProfile)) {
    // 检测本地 codex 是否已 login（~/.codex/ 存在）
    let isCodexInstalled = false;
    try {
      execSync('command -v codex >/dev/null 2>&1');
      isCodexInstalled = true;
    } catch {}

    const apiKey = process.env.OPENAI_API_KEY || '';
    const baseUrl = process.env.OPENAI_BASE_URL || '';

    if (isCodexInstalled || apiKey) {
      writeFileSync(codexProfile, JSON.stringify({
        agent_type: 'codex',
        label: 'OpenAI Codex',
        BASE_URL: baseUrl,
        API_KEY: apiKey,
        DEFAULT_MODEL: 'gpt-5.4',
        REASONING_EFFORT: 'high',
        SANDBOX_MODE: 'danger-full-access',
      }, null, 2), 'utf8');
      console.log(`[agentmobile] Auto-created codex profile (${isCodexInstalled ? 'codex installed' : 'API key from env'})`);
    }
  }
}

const app = express();
app.use(express.json());
app.use((err, req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/')) {
    const status = err?.status || err?.statusCode || 400;
    const message = err?.type === 'entity.parse.failed' ? 'invalid JSON body' : (err?.message || 'invalid request');
    return res.status(status).json({ error: message });
  }
  next(err);
});

const {
  JWT_SECRET,
  ACC_PASSWORD_HASH,
  TMUX_SESSION = '~',
  WORKSPACE_ROOT = '/workspace',
  PORT = '3000',
  CLAUDE_PROXY = '',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_DEFAULT_SESSION = '',
  GITHUB_REPO = 'wangxumarshall/agentmobile',
} = process.env;

if (!JWT_SECRET || !ACC_PASSWORD_HASH) {
  console.error('ERROR: JWT_SECRET and ACC_PASSWORD_HASH must be set in environment');
  process.exit(1);
}

function getTelegramBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || ''
}

function getTelegramWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || ''
}

function getTelegramDefaultSession() {
  return process.env.TELEGRAM_DEFAULT_SESSION || ''
}

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd} >/dev/null 2>&1`, { env: { ...process.env, PATH: process.env.PATH } });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

const AGENT_SPECS = {
  claude: {
    label: 'Claude',
    binaries: ['claude'],
    runScript: 'agentmobile-run-claude.sh',
    interactiveArgs: ['--dangerously-skip-permissions'],
    taskArgs: (prompt, profile) => ['-p', prompt, '--dangerously-skip-permissions', ...(profile ? ['--profile', profile] : [])],
    jsonTaskOutput: false,
  },
  codex: {
    label: 'Codex',
    binaries: ['codex'],
    runScript: 'agentmobile-run-codex.sh',
    interactiveArgs: ['--yolo'],
    taskArgs: (prompt, profile) => ['exec', prompt, '--yolo', ...(profile ? ['--profile', profile] : []), '--json'],
    jsonTaskOutput: true,
  },
  trae: {
    label: 'Trae CLI',
    binaries: ['trae-cli', 'trae'],
    runScript: 'agentmobile-run-trae.sh',
    interactiveArgs: [],
    taskArgs: (prompt, profile) => ['exec', prompt, ...(profile ? ['--profile', profile] : []), '--json'],
    jsonTaskOutput: true,
  },
  opencode: {
    label: 'OpenCode',
    binaries: ['opencode'],
    runScript: 'agentmobile-run-opencode.sh',
    interactiveArgs: [],
    taskArgs: (prompt, profile) => ['exec', prompt, ...(profile ? ['--profile', profile] : []), '--json'],
    jsonTaskOutput: true,
  },
};

function resolveAgentBinary(agentType) {
  const spec = AGENT_SPECS[agentType];
  if (!spec) return null;
  for (const bin of spec.binaries) {
    try {
      const resolved = execSync(`command -v ${bin}`, { env: { ...process.env, PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (resolved) return resolved;
    } catch {}
  }
  return null;
}

function buildMissingAgentCmd(agentType, prefix = '') {
  const label = AGENT_SPECS[agentType]?.label || agentType;
  const binaries = AGENT_SPECS[agentType]?.binaries?.join(' / ') || agentType;
  return `${prefix}echo "[agentmobile] ${label} command not found: ${binaries}. Install the CLI and restart the session."; ${INTERACTIVE_SHELL_CMD}`;
}

const INTERACTIVE_SHELL = commandExists('zsh') ? 'zsh' : 'bash';
const INTERACTIVE_SHELL_CMD = `exec ${INTERACTIVE_SHELL} -i`;

function buildInteractiveShellCmd(prefix = '') {
  return `${prefix}${INTERACTIVE_SHELL_CMD}`;
}

// ─── Agent 类型检测与命令构建工具 ───

/**
 * 从 profile JSON 文件中读取 agent_type
 * @param {string} profileId - profile 文件名（不含 .json）
 * @returns {string} 'claude' | 'codex' | 'trae' | 'opencode'
 */
function getAgentTypeFromProfile(profileId) {
  const profilePath = join(CONFIGS_DIR, `${profileId}.json`)
  if (!existsSync(profilePath)) return 'claude' // 默认
  try {
    const cfg = JSON.parse(readFileSync(profilePath, 'utf8'))
    return cfg.agent_type || 'claude'
  } catch {
    return 'claude'
  }
}

function normalizeRequestedAgentType(shellType, reqAgentType, profile) {
  if (reqAgentType === 'bash') return 'bash'
  if (reqAgentType && AGENT_SPECS[reqAgentType]) return reqAgentType
  if (shellType === 'bash') return 'bash'
  if (shellType && AGENT_SPECS[shellType]) return shellType
  return profile ? getAgentTypeFromProfile(profile) : 'claude'
}

function sanitizeProfileForAgent(agentType, profile) {
  if (!profile || agentType === 'bash') return null
  return getAgentTypeFromProfile(profile) === agentType ? profile : null
}

function getAgentSlug(agentType) {
  switch (agentType) {
    case 'claude':
      return 'claude'
    case 'codex':
      return 'codex'
    case 'opencode':
      return 'opencode'
    case 'trae':
      return 'trae-cli'
    case 'bash':
      return 'bash'
    default:
      return 'project'
  }
}

function buildProjectSessionName(cwd, agentType) {
  const initials = cwd
    .split('/')
    .filter(Boolean)
    .map(segment => segment[0]?.toLowerCase() || '')
    .join('')
    .replace(/[^a-z0-9]/g, '')

  const base = `${initials || 'p'}-${getAgentSlug(agentType)}`
  return base.replace(/[^a-zA-Z0-9._~-]/g, '-').substring(0, 50) || 'project'
}

/**
 * 构建 AI Agent 的 shell 启动命令
 * @param {string} agentType - 'claude' | 'codex' | 'trae' | 'opencode' | 'bash'
 * @param {string|null} profile - profile 文件名（可选）
 * @param {string} cwd - 工作目录
 * @param {string} proxyPrefix - 代理变量导出的 shell 前缀
 * @returns {string} 完整 shell 命令
 */
function buildAgentShellCmd(agentType, profile, cwd, proxyPrefix) {
  if (agentType === 'bash') return buildInteractiveShellCmd(proxyPrefix)

  const runScriptName = AGENT_SPECS[agentType]?.runScript
  if (!runScriptName) return buildMissingAgentCmd(agentType, proxyPrefix)
  const runScript = join(__dirname, runScriptName)
  const profileArg = profile || '__none__'
  return `${proxyPrefix}bash ${shellQuote(runScript)} ${shellQuote(profileArg)} ${shellQuote(cwd)}`
}

/**
 * 收集代理环境变量（宿主机 + 覆盖）
 * @param {string|null} overrideProxy - 覆盖代理地址（如 null 则使用宿主机环境）
 * @returns {Record<string, string>}
 */
function collectProxyVars(overrideProxy = null) {
  return {
    ...(process.env.HTTP_PROXY  ? { HTTP_PROXY:  process.env.HTTP_PROXY  } : {}),
    ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    ...(process.env.ALL_PROXY   ? { ALL_PROXY:   process.env.ALL_PROXY   } : {}),
    ...(process.env.http_proxy  ? { http_proxy:  process.env.http_proxy  } : {}),
    ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
    ...(overrideProxy ? { ALL_PROXY: overrideProxy, HTTPS_PROXY: overrideProxy, HTTP_PROXY: overrideProxy, NEXUS_PROXY: overrideProxy } : {}),
  }
}

/**
 * 将代理对象转换为 shell export 前缀
 * @param {Record<string, string>} proxyVars
 * @returns {string}
 */
function proxyVarsToShellPrefix(proxyVars) {
  const exports = Object.entries(proxyVars).map(([k, v]) => `export ${k}='${v}'`).join('; ')
  return exports ? `${exports}; ` : ''
}

function listProjects() {
  try {
    const stdout = execSync('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}" 2>/dev/null').toString().trim()
    if (!stdout) return []
    const lines = stdout.split('\n').filter(Boolean)
    const projects = lines.map(line => {
      const [name, windows] = line.split('|')
      let path = ''
      try {
        const envOutput = execSync(`tmux show-environment -t ${name} NEXUS_CWD 2>/dev/null`).toString().trim()
        const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
        if (match) path = match[1]
      } catch {}
      if (!path && windows !== '0') {
        try {
          const cwdOutput = execSync(`tmux list-windows -t ${name} -F '#{pane_current_path}' 2>/dev/null | head -1`).toString().trim()
          if (cwdOutput) path = cwdOutput
        } catch {}
      }
      return {
        name,
        path: path || WORKSPACE_ROOT,
        active: name === TMUX_SESSION,
        channelCount: Number(windows) || 0,
      }
    })
    projects.reverse()
    return projects
  } catch {
    return []
  }
}

function getProjectsSnapshot() {
  return JSON.stringify(listProjects().map(project => ({
    name: project.name,
    path: project.path,
    channelCount: project.channelCount,
  })))
}

let projectRevision = 0
let lastProjectsSnapshot = getProjectsSnapshot()
const projectEventClients = new Set()

function writeProjectEvent(res, payload) {
  res.write(`event: projects_changed\ndata: ${JSON.stringify(payload)}\n\n`)
}

function broadcastProjectsChanged(source = 'server') {
  projectRevision += 1
  const payload = { revision: projectRevision, source }
  for (const res of Array.from(projectEventClients)) {
    try {
      writeProjectEvent(res, payload)
    } catch {
      projectEventClients.delete(res)
    }
  }
}

function refreshProjectsSnapshot(source = 'server') {
  lastProjectsSnapshot = getProjectsSnapshot()
  broadcastProjectsChanged(source)
}

function pollProjectChanges() {
  const snapshot = getProjectsSnapshot()
  if (snapshot === lastProjectsSnapshot) return
  lastProjectsSnapshot = snapshot
  broadcastProjectsChanged('poll')
}

const projectPollTimer = setInterval(pollProjectChanges, 2000)
projectPollTimer.unref?.()

// 静态文件：frontend/dist 和 public
app.use(express.static(join(__dirname, 'public')));
app.use(express.static(join(__dirname, 'frontend', 'dist')));

// Auth middleware
function getRequestToken(req) {
  const auth = req.headers.authorization || '';
  const headerToken = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
  return headerToken || queryToken;
}

function authMiddleware(req, res, next) {
  const token = getRequestToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
}

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  try {
    const ok = await bcrypt.compare(password, ACC_PASSWORD_HASH);
    if (!ok) return res.status(401).json({ error: 'unauthorized' });
    const token = jwt.sign({}, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/api/projects/events', authMiddleware, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  projectEventClients.add(res);
  writeProjectEvent(res, { revision: projectRevision, source: 'connect' });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
      projectEventClients.delete(res);
    }
  }, 15000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    projectEventClients.delete(res);
    res.end();
  });
});

// POST /api/windows — F-19: 项目-窗口两级结构
// body: { rel_path?, shell_type?, agent_type?, profile? }
// - agent_type: 'claude' | 'codex' | 'trae' | 'opencode' | 'bash'（默认: 'claude'，向后兼容 shell_type）
// - 提供 rel_path: 设置 NEXUS_CWD 并在此目录创建窗口（新项目）
// - 不提供 rel_path: 读取 NEXUS_CWD 并在此目录创建窗口（新窗口）
app.post('/api/windows', authMiddleware, (req, res) => {
  const { rel_path, shell_type, agent_type: reqAgentType, profile } = req.body || {};
  const tmuxSession = req.query.session || TMUX_SESSION;

  // agent_type 优先于 shell_type（向后兼容）
  const agentType = reqAgentType || (shell_type === 'bash' ? 'bash' : getAgentTypeFromProfile(profile));

  let cwd;
  if (rel_path) {
    // 新项目：设置 NEXUS_CWD
    cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
    try {
      execSync(`tmux set-environment -t ${tmuxSession} NEXUS_CWD "${cwd}"`);
    } catch (err) {
      return res.status(500).json({ error: 'failed to set NEXUS_CWD: ' + err.message });
    }
  } else {
    // 新窗口：读取 NEXUS_CWD
    try {
      const envOutput = execSync(`tmux show-environment -t ${tmuxSession} NEXUS_CWD 2>/dev/null`).toString().trim();
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/);
      cwd = match ? match[1] : WORKSPACE_ROOT;
    } catch {
      cwd = WORKSPACE_ROOT;
    }
  }

  // 构建 shell 命令（使用新 agent 抽象层）
  const proxyVars = collectProxyVars(CLAUDE_PROXY);
  const proxyPrefix = proxyVarsToShellPrefix(proxyVars);
  let shellCmd = buildAgentShellCmd(agentType, profile, cwd, proxyPrefix);

  // 确保 tmux session 存在
  try {
    execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null || tmux new-session -d -s ${tmuxSession} -n shell "${INTERACTIVE_SHELL}"`);
  } catch {}

  // 将代理变量设置到 tmux session 环境
  for (const [key, value] of Object.entries(proxyVars)) {
    try {
      execSync(`tmux set-environment -t ${tmuxSession} ${key} "${value}" 2>/dev/null`);
    } catch {}
  }

  const cmd = `tmux new-window -t ${tmuxSession} -c "${cwd}" -n "${name}" "${shellCmd}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name, cwd, agent_type: agentType, profile: profile || null, session: tmuxSession });
  });
});

// POST /api/sessions — 在 tmux 中创建新 window
// body: { rel_path, shell_type?, agent_type?, profile?, session? }
app.post('/api/sessions', authMiddleware, (req, res) => {
  const { rel_path, shell_type, agent_type: reqAgentType, profile, session } = req.body || {};
  const tmuxSession = session || TMUX_SESSION;
  if (!rel_path) return res.status(400).json({ error: 'rel_path required' });
  const cwd = rel_path.startsWith('/') ? rel_path : `${WORKSPACE_ROOT}/${rel_path}`;
  const name = cwd.replace(/^\/+|\/+$/g, '').replace(/\//g, '-') || 'session';

  // agent_type 优先于 shell_type（向后兼容）
  const agentType = normalizeRequestedAgentType(shell_type, reqAgentType, profile)
  const resolvedProfile = sanitizeProfileForAgent(agentType, profile)

  const proxyVars = collectProxyVars(CLAUDE_PROXY);
  const proxyPrefix = proxyVarsToShellPrefix(proxyVars);
  let shellCmd = buildAgentShellCmd(agentType, resolvedProfile, cwd, proxyPrefix);

  // 确保 tmux session 存在
  try {
    execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null || tmux new-session -d -s ${tmuxSession} -n shell "${INTERACTIVE_SHELL}"`);
  } catch {}

  // 将代理变量设置到 tmux session 环境，新窗口才能继承
  for (const [key, value] of Object.entries(proxyVars)) {
    try {
      execSync(`tmux set-environment -t ${tmuxSession} ${key} "${value}" 2>/dev/null`);
    } catch {}
  }

  const cmd = `tmux new-window -t ${tmuxSession} -c "${cwd}" -n "${name}" "${shellCmd}"`;
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ name, cwd, agent_type: agentType, profile: profile || null, session: tmuxSession });
  });
});

// GET /api/configs — 列出所有 AI agent 配置 profile
app.get('/api/configs', authMiddleware, (req, res) => {
  try {
    const files = readdirSync(CONFIGS_DIR, { withFileTypes: true })
      .filter(f => f.isFile() && f.name.endsWith('.json'))
      .map(f => ({
        name: f.name,
        mtime: statSync(join(CONFIGS_DIR, f.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)
      .map(f => f.name);
    const configs = files.map(f => {
      const id = f.replace('.json', '');
      try {
        const data = JSON.parse(readFileSync(join(CONFIGS_DIR, f), 'utf8'));
        return { id, label: data.label || id, ...data };
      } catch {
        return { id, label: id };
      }
    });
    res.json(configs);
  } catch {
    res.json([]);
  }
});

// POST /api/configs/:id — 创建或更新配置 profile
app.post('/api/configs/:id', authMiddleware, (req, res) => {
  const id = req.params.id.replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  if (!id) return res.status(400).json({ error: 'invalid id' });
  try {
    writeFileSync(join(CONFIGS_DIR, `${id}.json`), JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/configs/:id — 删除配置 profile
app.delete('/api/configs/:id', authMiddleware, (req, res) => {
  const file = join(CONFIGS_DIR, `${req.params.id}.json`);
  try {
    if (existsSync(file)) unlinkSync(file);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/toolbar-config — 读取工具栏配置
app.get('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    if (!existsSync(TOOLBAR_CONFIG_FILE)) return res.json(null);
    const data = readFileSync(TOOLBAR_CONFIG_FILE, 'utf8');
    res.json(JSON.parse(data));
  } catch {
    res.json(null);
  }
});

// POST /api/toolbar-config — 保存工具栏配置
app.post('/api/toolbar-config', authMiddleware, (req, res) => {
  try {
    writeFileSync(TOOLBAR_CONFIG_FILE, JSON.stringify(req.body), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/version — 当前版本号及工作区状态
app.get('/api/version', authMiddleware, (req, res) => {
  try {
    const current = execSync('git describe --tags --abbrev=0', { cwd: __dirname }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname }).toString().trim();
    res.json({ current, clean: dirty === '' });
  } catch {
    res.json({ current: 'unknown', clean: true });
  }
});

// GET /api/version/latest — 代理 GitHub Tags API 获取最新版本（兼容只有 tag 没有 Release 的 repo）
app.get('/api/version/latest', authMiddleware, (req, res) => {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${GITHUB_REPO}/tags`,
    headers: { 'User-Agent': 'agentmobile-update-check' },
  };
  https.get(options, (ghRes) => {
    let data = '';
    ghRes.on('data', chunk => { data += chunk; });
    ghRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (!Array.isArray(json) || json.length === 0) return res.status(502).json({ error: 'no tags found' });
        const latest = json[0].name;
        res.json({ latest, url: `https://github.com/${GITHUB_REPO}/releases/tag/${latest}` });
      } catch {
        res.status(502).json({ error: 'invalid response from GitHub' });
      }
    });
  }).on('error', () => {
    res.status(502).json({ error: 'cannot reach GitHub' });
  });
});

// ---- Feishu setup wizard ----
const FEISHU_SETUP_TTL_MS = 15 * 60 * 1000;
const FEISHU_SETUP_SESSIONS = new Map();

function maskValue(value, keepStart = 6, keepEnd = 4) {
  if (!value) return '';
  if (value.length <= keepStart + keepEnd) return '*'.repeat(value.length);
  return `${value.slice(0, keepStart)}${'*'.repeat(6)}${value.slice(-keepEnd)}`;
}

function parseEnvList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getFeishuSettingsSnapshot() {
  const appId = process.env.CTI_FEISHU_APP_ID || '';
  const appSecret = process.env.CTI_FEISHU_APP_SECRET || '';
  return {
    imBridgeEnabled: process.env.IM_BRIDGE_ENABLED === 'true' || process.env.IM_BRIDGE_ENABLED === '1',
    feishuEnabled: process.env.FEISHU_ENABLED === 'true' || process.env.FEISHU_ENABLED === '1',
    configured: Boolean(appId && appSecret),
    appIdMasked: maskValue(appId),
    appSecretConfigured: Boolean(appSecret),
    domain: process.env.CTI_FEISHU_DOMAIN || '',
    callbackPort: process.env.CTI_FEISHU_CALLBACK_PORT || '',
    verificationTokenConfigured: Boolean(process.env.CTI_FEISHU_VERIFICATION_TOKEN),
    encryptKeyConfigured: Boolean(process.env.CTI_FEISHU_ENCRYPT_KEY),
    allowedUsers: parseEnvList(process.env.CTI_FEISHU_ALLOWED_USERS),
  };
}

function getTelegramSettingsSnapshot(botInfo = null) {
  const botToken = getTelegramBotToken();
  return {
    imBridgeEnabled: process.env.IM_BRIDGE_ENABLED === 'true' || process.env.IM_BRIDGE_ENABLED === '1',
    telegramEnabled: process.env.TELEGRAM_ENABLED === 'true' || process.env.TELEGRAM_ENABLED === '1',
    configured: Boolean(botToken),
    botTokenMasked: maskValue(botToken),
    defaultSession: getTelegramDefaultSession(),
    webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
    botUsername: botInfo?.username || '',
    botDisplayName: botInfo?.first_name || '',
    botId: botInfo?.id ? String(botInfo.id) : '',
    botLink: botInfo?.username ? `https://t.me/${botInfo.username}` : '',
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeEnvValue(value) {
  return String(value ?? '').replace(/\r?\n/g, '').trim();
}

function updateEnvFile(updates) {
  const normalizedUpdates = Object.fromEntries(
    Object.entries(updates).map(([key, value]) => [key, normalizeEnvValue(value)]),
  );
  let lines = [];
  if (existsSync(ENV_FILE)) {
    lines = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  }

  const seen = new Set();
  lines = lines.map(line => {
    for (const [key, value] of Object.entries(normalizedUpdates)) {
      const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
      if (pattern.test(line)) {
        seen.add(key);
        return `${key}=${value}`;
      }
    }
    return line;
  });

  const missing = Object.entries(normalizedUpdates).filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    lines.push('# Feishu / Lark IM bridge setup');
    for (const [key, value] of missing) {
      lines.push(`${key}=${value}`);
    }
  }

  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n+$/, '\n'), 'utf8');
  Object.assign(process.env, normalizedUpdates);
}

function getFeishuAccountDomain(domain) {
  return domain === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
}

function getFeishuSdkDomain(requestedDomain, result) {
  if (result?.user_info?.tenant_brand === 'lark') return 'lark';
  return requestedDomain === 'lark' ? 'lark' : '';
}

async function renderFeishuQrSvg(url) {
  return QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    width: 220,
    color: {
      dark: '#111827',
      light: '#ffffff',
    },
  });
}

function touchFeishuSetupSession(session, patch = {}) {
  Object.assign(session, patch, { updatedAt: new Date().toISOString() });
}

function cleanupFeishuSetupSessions() {
  const now = Date.now();
  for (const [id, session] of FEISHU_SETUP_SESSIONS) {
    const age = now - session.startedAtMs;
    if (age > FEISHU_SETUP_TTL_MS && (session.status === 'starting' || session.status === 'waiting' || session.status === 'slow_down')) {
      session.controller.abort();
      touchFeishuSetupSession(session, {
        status: 'expired',
        error: 'QR code expired',
      });
    }
    if (age > FEISHU_SETUP_TTL_MS * 2 && ['authorized', 'saved', 'expired', 'aborted', 'error'].includes(session.status)) {
      FEISHU_SETUP_SESSIONS.delete(id);
    }
  }
}

function saveFeishuRegistration(session, result) {
  const openId = result?.user_info?.open_id || '';
  const existingAllowedUsers = parseEnvList(process.env.CTI_FEISHU_ALLOWED_USERS);
  const allowedUsers = existingAllowedUsers.length > 0
    ? existingAllowedUsers
    : openId
      ? [openId]
      : [];

  updateEnvFile({
    IM_BRIDGE_ENABLED: 'true',
    FEISHU_ENABLED: 'true',
    CTI_FEISHU_APP_ID: result.client_id,
    CTI_FEISHU_APP_SECRET: result.client_secret,
    CTI_FEISHU_DOMAIN: getFeishuSdkDomain(session.domain, result),
    ...(allowedUsers.length > 0 ? { CTI_FEISHU_ALLOWED_USERS: allowedUsers.join(',') } : {}),
  });
}

async function serializeFeishuSetupSession(session) {
  if (session.qrUrl && !session.qrSvg) {
    session.qrSvg = await renderFeishuQrSvg(session.qrUrl);
  }
  return {
    id: session.id,
    status: session.status,
    statusDetail: session.statusDetail,
    error: session.error,
    domain: session.domain,
    qrUrl: session.qrUrl,
    qrSvg: session.qrSvg,
    expiresAt: session.expiresAt,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    saved: session.saved,
    appIdMasked: session.appIdMasked,
    openId: session.openId,
    tenantBrand: session.tenantBrand,
    settings: getFeishuSettingsSnapshot(),
  };
}

function startFeishuSetupSession(domain) {
  cleanupFeishuSetupSessions();
  const id = randomUUID();
  const controller = new AbortController();
  let resolveQrReady;
  const qrReady = new Promise(resolve => { resolveQrReady = resolve; });
  const session = {
    id,
    domain,
    controller,
    qrReady,
    status: 'starting',
    statusDetail: '',
    error: '',
    qrUrl: '',
    qrSvg: '',
    expiresAt: '',
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    updatedAt: new Date().toISOString(),
    saved: false,
    appIdMasked: '',
    openId: '',
    tenantBrand: '',
  };
  FEISHU_SETUP_SESSIONS.set(id, session);

  session.promise = (async () => {
    try {
      const larkModule = await import('@larksuiteoapi/node-sdk');
      const lark = larkModule.default || larkModule;
      const result = await lark.registerApp({
        domain: getFeishuAccountDomain(domain),
        larkDomain: 'accounts.larksuite.com',
        source: 'agentmobile',
        signal: controller.signal,
        onQRCodeReady(info) {
          touchFeishuSetupSession(session, {
            status: 'waiting',
            statusDetail: 'waiting_scan',
            qrUrl: info.url,
            expiresAt: new Date(Date.now() + info.expireIn * 1000).toISOString(),
          });
          resolveQrReady();
        },
        onStatusChange(info) {
          const status = info.status === 'polling' || info.status === 'domain_switched'
            ? 'waiting'
            : info.status;
          touchFeishuSetupSession(session, {
            status,
            statusDetail: info.status,
          });
        },
      });

      saveFeishuRegistration(session, result);
      touchFeishuSetupSession(session, {
        status: 'saved',
        statusDetail: 'authorized',
        saved: true,
        appIdMasked: maskValue(result.client_id),
        openId: result.user_info?.open_id || '',
        tenantBrand: result.user_info?.tenant_brand || getFeishuSdkDomain(domain, result) || 'feishu',
      });
    } catch (err) {
      const code = err?.code || '';
      touchFeishuSetupSession(session, {
        status: code === 'abort' ? 'aborted' : 'error',
        statusDetail: code,
        error: err?.description || err?.message || String(err),
      });
      resolveQrReady();
    }
  })();

  return session;
}

async function waitForFeishuQr(session) {
  await Promise.race([
    session.qrReady,
    session.promise,
    new Promise(resolve => setTimeout(resolve, 15000)),
  ]);
}

app.get('/api/feishu/settings', authMiddleware, (req, res) => {
  res.json(getFeishuSettingsSnapshot());
});

app.post('/api/feishu/setup', authMiddleware, async (req, res) => {
  const domain = req.body?.domain === 'lark' ? 'lark' : 'feishu';
  const session = startFeishuSetupSession(domain);
  await waitForFeishuQr(session);
  if (!session.qrUrl && session.status === 'error') {
    return res.status(502).json(await serializeFeishuSetupSession(session));
  }
  res.json(await serializeFeishuSetupSession(session));
});

app.get('/api/feishu/setup/:id', authMiddleware, async (req, res) => {
  cleanupFeishuSetupSessions();
  const session = FEISHU_SETUP_SESSIONS.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'not found' });
  res.json(await serializeFeishuSetupSession(session));
});

app.delete('/api/feishu/setup/:id', authMiddleware, async (req, res) => {
  const session = FEISHU_SETUP_SESSIONS.get(req.params.id);
  if (!session) return res.json({ ok: true });
  session.controller.abort();
  touchFeishuSetupSession(session, {
    status: 'aborted',
    statusDetail: 'abort',
    error: '',
  });
  res.json({ ok: true });
});

app.get('/api/telegram/settings', authMiddleware, async (req, res) => {
  try {
    const botToken = getTelegramBotToken();
    const botInfo = botToken ? await fetchTelegramBotInfo(botToken).catch(() => null) : null;
    res.json(getTelegramSettingsSnapshot(botInfo));
  } catch (err) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.post('/api/telegram/settings', authMiddleware, async (req, res) => {
  try {
    const requestedToken = normalizeEnvValue(req.body?.botToken || '');
    const defaultSession = normalizeEnvValue(req.body?.defaultSession || '');
    const effectiveToken = requestedToken || getTelegramBotToken();
    if (!effectiveToken) {
      return res.status(400).json({ error: 'Telegram bot token is required' });
    }

    const botInfo = await fetchTelegramBotInfo(effectiveToken);

    updateEnvFile({
      IM_BRIDGE_ENABLED: 'true',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: effectiveToken,
      TELEGRAM_DEFAULT_SESSION: defaultSession,
    });

    res.json({
      ok: true,
      settings: getTelegramSettingsSnapshot(botInfo),
    });
  } catch (err) {
    res.status(400).json({ error: err?.message || String(err) });
  }
});

app.get('/api/browse', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const entries = readdirSync(p, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({ name: e.name, path: join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const parent = dirname(p) !== p ? dirname(p) : null
    res.json({ path: p, parent, dirs })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workspace/files — 浏览文件系统（支持文件和目录，任意路径）
app.get('/api/workspace/files', authMiddleware, async (req, res) => {
  try {
    let p = req.query.path || WORKSPACE_ROOT
    if (p === '~') p = WORKSPACE_ROOT
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    const dirents = await readdir(p, { withFileTypes: true })
    const visible = dirents.filter(e => !e.name.startsWith('.'))
    const entries = await Promise.all(visible.map(async e => {
      const fullPath = join(p, e.name)
      const st = await statAsync(fullPath)
      return {
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isFile() ? st.size : undefined,
        mtime: st.mtimeMs,
      }
    }))
    res.json({ path: p, entries })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 静态文件服务：工作目录文件直接访问（/workspace/相对路径）
// 支持 header 或 query string 传递 token（浏览器直接打开时用 query string）
// 支持通过 ?path=/absolute/path 访问任意路径（仍然限制在 workspaceRoot 内）
app.use('/workspace', (req, res, next) => {
  // 尝试从 query string 获取 token
  const token = req.query.token
  if (token) {
    try {
      jwt.verify(token, JWT_SECRET)
      return next()
    } catch {
      return res.status(401).send('unauthorized')
    }
  }
  // 否则使用 header auth
  return authMiddleware(req, res, next)
}, (req, res) => {
  try {
    let fullPath
    // 如果提供了 path 参数，使用它（绝对路径）
    if (req.query.path) {
      fullPath = normalize(decodeURIComponent(req.query.path))
    } else {
      // 否则使用相对路径（基于 WORKSPACE_ROOT）
      let relPath = decodeURIComponent(req.path)
      relPath = normalize(relPath).replace(/^(\.\.(\/|\|$))+/, '')
      fullPath = join(WORKSPACE_ROOT, relPath)
    }
    // 安全检查：防止路径遍历攻击（规范化后检查是否包含 ..）
    if (fullPath.includes('..')) {
      return res.status(403).send('access denied: invalid path')
    }
    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      return res.status(404).send('not found')
    }
    if (req.query.dl === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(basename(fullPath))}`)
    }
    res.sendFile(fullPath)
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// POST /api/workspace/mkdir — 创建文件夹
app.post('/api/workspace/mkdir', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const dirPath = join(targetPath, name)
    if (dirPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(dirPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    mkdirSync(dirPath, { recursive: true })
    res.json({ ok: true, path: dirPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/files — 创建新文件
app.post('/api/workspace/files', authMiddleware, (req, res) => {
  try {
    let { path: targetPath, name, content = '' } = req.body
    if (!name) return res.status(400).json({ error: 'name required' })
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    targetPath = normalize(targetPath)
    const filePath = join(targetPath, name)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (existsSync(filePath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/workspace/file — 读取文件内容
app.get('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let p = req.query.path || ''
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p) || !statSync(p).isFile()) {
      return res.status(404).json({ error: 'not found' })
    }
    const content = readFileSync(p, 'utf8')
    res.json({ path: p, content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/workspace/file — 保存文件内容
app.put('/api/workspace/file', authMiddleware, (req, res) => {
  try {
    let { path: filePath, content = '' } = req.body
    if (!filePath) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(filePath)) filePath = join(WORKSPACE_ROOT, filePath)
    filePath = normalize(filePath)
    if (filePath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    writeFileSync(filePath, content, 'utf8')
    res.json({ ok: true, path: filePath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/workspace/entry — 删除文件或目录
app.delete('/api/workspace/entry', authMiddleware, (req, res) => {
  try {
    let p = req.body?.path || req.query?.path || ''
    if (!p) return res.status(400).json({ error: 'path required' })
    if (!isAbsolute(p)) p = join(WORKSPACE_ROOT, p)
    p = normalize(p)
    if (p.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(p)) {
      return res.status(404).json({ error: 'not found' })
    }
    rmSync(p, { recursive: true, force: true })
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/rename — 重命名文件或目录
app.post('/api/workspace/rename', authMiddleware, (req, res) => {
  try {
    let { path: srcPath, newName } = req.body || {}
    if (!srcPath || !newName) return res.status(400).json({ error: 'path and newName required' })
    if (!isAbsolute(srcPath)) srcPath = join(WORKSPACE_ROOT, srcPath)
    srcPath = normalize(srcPath)
    if (srcPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(srcPath)) {
      return res.status(404).json({ error: 'not found' })
    }
    const destPath = normalize(join(dirname(srcPath), newName))
    if (destPath.includes('..')) {
      return res.status(403).json({ error: 'invalid newName' })
    }
    if (existsSync(destPath)) {
      return res.status(409).json({ error: 'already exists' })
    }
    renameSync(srcPath, destPath)
    res.json({ ok: true, path: destPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/copy — 复制文件或目录
app.post('/api/workspace/copy', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    cpSync(sourcePath, targetPath, { recursive: true })
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/workspace/move — 移动文件或目录
app.post('/api/workspace/move', authMiddleware, (req, res) => {
  try {
    let { sourcePath, targetPath } = req.body || {}
    if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required' })
    if (!isAbsolute(sourcePath)) sourcePath = join(WORKSPACE_ROOT, sourcePath)
    if (!isAbsolute(targetPath)) targetPath = join(WORKSPACE_ROOT, targetPath)
    sourcePath = normalize(sourcePath)
    targetPath = normalize(targetPath)
    if (sourcePath.includes('..') || targetPath.includes('..')) {
      return res.status(403).json({ error: 'invalid path' })
    }
    if (!existsSync(sourcePath)) {
      return res.status(404).json({ error: 'source not found' })
    }
    if (existsSync(targetPath)) {
      return res.status(409).json({ error: 'target already exists' })
    }
    try {
      renameSync(sourcePath, targetPath)
    } catch (err) {
      if (err.code === 'EXDEV') {
        cpSync(sourcePath, targetPath, { recursive: true })
        rmSync(sourcePath, { recursive: true, force: true })
      } else {
        throw err
      }
    }
    res.json({ ok: true, path: targetPath })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/upload — 上传文件到指定 session 的 cwd（F-14）
// body: multipart/form-data, fields: file, session_name (optional)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      // 找到目标 session 的 cwd，否则存 WORKSPACE_ROOT
      let cwd = WORKSPACE_ROOT
      try {
        const sessionName = req.body?.session_name || ''
        const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
        for (const line of windows) {
          const parts = line.split(':')
          const name = parts[1]
          const path = parts.slice(2).join(':')
          if (sessionName && name === sessionName) { cwd = path; break }
          // 如果没指定 session，用 active window
          if (!sessionName) {
            const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
            for (const al of activeLines) {
              const ap = al.split(':')
              if (ap[ap.length - 1]?.trim() === '1') { cwd = ap.slice(2, ap.length - 1).join(':'); break }
            }
            break
          }
        }
      } catch {}
      if (!existsSync(cwd)) cwd = WORKSPACE_ROOT
      cb(null, cwd)
    },
    filename: (req, file, cb) => {
      // 保留原始文件名，避免冲突加时间戳前缀
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, safe)
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
})

app.post('/api/upload', authMiddleware, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })
    const filePath = req.file.path
    res.json({ ok: true, path: filePath, filename: req.file.filename, size: req.file.size })
  })
})

// ---- F-21: 文件上传 API（上传到当前 workspace 的 data/uploads/）----

// 读取指定 session 的 uploads 目录（基于 tmux NEXUS_CWD 环境变量）
function getWorkspaceUploadsDir(session = TMUX_SESSION) {
  let cwd = WORKSPACE_ROOT
  try {
    const out = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const m = out.match(/^NEXUS_CWD=(.+)$/)
    if (m) cwd = m[1]
  } catch {}
  return join(cwd, 'data', 'uploads')
}

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
})

// POST /api/files/upload — 上传文件到当前 workspace/data/uploads/日期/
// Query: overwrite=1 强制覆盖已存在的文件
app.post('/api/files/upload', authMiddleware, (req, res, next) => {
  fileUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message })
    if (!req.file) return res.status(400).json({ error: 'no file' })

    const dateDir = new Date().toISOString().slice(0, 10)
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    const uploadDir = join(uploadsDir, dateDir)
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true })

    // 使用前端传递的原始文件名（避免 multer 解析编码问题）
    const originalName = req.body.originalName || req.file.originalname
    // 清理文件名：只保留合法字符，中文保留
    const safe = originalName.replace(/[<>:"|?*\\/\x00-\x1f]/g, '_')
    const filePath = join(uploadDir, safe)
    const overwrite = req.query.overwrite === '1'

    // 检查文件是否已存在
    if (!overwrite && existsSync(filePath)) {
      return res.status(409).json({
        error: 'file exists',
        filename: safe,
        message: `文件 "${safe}" 已存在`
      })
    }

    // 写入文件
    try {
      writeFileSync(filePath, req.file.buffer)
      const url = `/api/files/content?path=${encodeURIComponent(filePath)}`
      const responseData = {
        ok: true,
        filename: safe,
        url,
        fullPath: filePath,
        size: req.file.size,
        originalName: originalName
      }
      console.log('[Upload]', safe, '→', filePath)
      res.json(responseData)
    } catch (writeErr) {
      res.status(500).json({ error: writeErr.message })
    }
  })
})

// GET /api/files/content?path=... — 访问/下载已上传的文件（路径自描述，无状态）
app.get('/api/files/content', authMiddleware, (req, res) => {
  const filePath = req.query.path
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' })
  const normalized = normalize(filePath)
  if (!normalized.startsWith(WORKSPACE_ROOT)) return res.status(403).json({ error: 'access denied' })
  if (!existsSync(normalized)) return res.status(404).json({ error: 'file not found' })
  res.sendFile(normalized)
})

// GET /api/files — 列出当前 workspace 上传的文件（按日期分组）
app.get('/api/files', authMiddleware, (req, res) => {
  try {
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    const result = []
    if (!existsSync(uploadsDir)) return res.json(result)

    const dateDirs = readdirSync(uploadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a)) // 降序，最新的在前

    for (const dateDir of dateDirs) {
      const dirPath = join(uploadsDir, dateDir)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
        .map(e => {
          const fullPath = join(dirPath, e.name)
          const stat = statSync(fullPath)
          return {
            name: e.name,
            url: `/api/files/content?path=${encodeURIComponent(fullPath)}`,
            fullPath,
            size: stat.size,
            created: stat.mtimeMs,
          }
        })
        .sort((a, b) => b.created - a.created)
      if (files.length > 0) {
        result.push({ date: dateDir, files })
      }
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/all — 删除当前 workspace 所有上传的文件
app.delete('/api/files/all', authMiddleware, (req, res) => {
  try {
    const uploadsDir = getWorkspaceUploadsDir(req.query.session || TMUX_SESSION)
    if (!existsSync(uploadsDir)) return res.json({ ok: true, deletedCount: 0 })
    const dateDirs = readdirSync(uploadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
    let deletedCount = 0
    for (const dateDir of dateDirs) {
      const dirPath = join(uploadsDir, dateDir.name)
      const files = readdirSync(dirPath, { withFileTypes: true })
        .filter(e => e.isFile())
      for (const file of files) {
        const filePath = join(dirPath, file.name)
        try {
          unlinkSync(filePath)
          deletedCount++
        } catch {}
      }
      // 尝试删除空目录
      try {
        rmdirSync(dirPath)
      } catch {}
    }
    res.json({ ok: true, deletedCount })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/files/content?path=... — 删除指定文件（路径自描述）
app.delete('/api/files/content', authMiddleware, (req, res) => {
  const filePath = req.query.path
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'path required' })
  const normalized = normalize(filePath)
  if (!normalized.startsWith(WORKSPACE_ROOT)) return res.status(403).json({ error: 'access denied' })
  try {
    if (existsSync(normalized)) {
      unlinkSync(normalized)
      res.json({ ok: true })
    } else {
      res.status(404).json({ error: 'file not found' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/sessions/:id/rename — 重命名窗口
app.post('/api/sessions/:id/rename', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  const { name } = req.body || {}
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' })
  const safeName = name.trim().replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 50)
  if (!safeName) return res.status(400).json({ error: 'invalid name format' })
  execFile('tmux', ['rename-window', '-t', `${session}:${index}`, safeName], (err) => {
    if (err) return res.status(500).json({ error: err.message })
    res.json({ ok: true, name: safeName })
  })
})

// GET /api/sessions/:id/output — 获取窗口最后输出（F-15 状态卡片）
app.get('/api/sessions/:id/output', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10);
  const session = req.query.session || TMUX_SESSION;
  const entry = ptyMap.get(ptyKey(session, windowIndex));
  if (!entry) return res.json({ connected: false, output: '', clients: 0 });
  res.json({
    connected: true,
    output: entry.lastOutput.slice(-2000), // 最后 2KB
    clients: entry.clients.size,
    idleMs: Date.now() - entry.lastActivity,
  });
});

// GET /api/sessions/:id/scrollback — fetch tmux scrollback history (works in alternate screen too)
app.get('/api/sessions/:id/scrollback', authMiddleware, (req, res) => {
  const windowIndex = parseInt(req.params.id, 10)
  const session = req.query.session || TMUX_SESSION
  const lines = Math.min(parseInt(req.query.lines || '3000', 10), 10000)
  const target = `${session}:${windowIndex}`

  // Get pane height first, then capture content and dedup ghost frames
  exec(`tmux display -p -t ${target} '#{pane_height}' 2>/dev/null`, (err, phOut) => {
    const paneHeight = parseInt(phOut?.trim(), 10) || 50
    exec(`tmux capture-pane -e -p -S -${lines} -t ${target} 2>/dev/null`, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const rawLines = stdout.split('\n').map(l => l.trimEnd())
      const content = dedupScrollback(rawLines, paneHeight).join('\n')
      res.json({ content })
    })
  })
})

// Remove "ghost frame" duplicates from scrollback caused by full-screen app re-renders.
// Ghost frames are paneHeight-sized blocks pushed into scrollback when a full-screen app
// redraws without alternate screen. Detection is purely content-based: hash each line,
// compute rolling block fingerprints, and remove earlier duplicates. Zero hardcoded patterns.
function dedupScrollback(lines, paneHeight) {
  if (lines.length <= paneHeight * 2) return lines

  const stripAnsi = s => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  const scrollbackEnd = lines.length - paneHeight

  // Hash each line (stripped of ANSI), using djb2
  const lineHashes = new Int32Array(lines.length)
  for (let i = 0; i < lines.length; i++) {
    const s = stripAnsi(lines[i])
    let h = 5381
    for (let c = 0; c < s.length; c++) h = ((h << 5) + h + s.charCodeAt(c)) | 0
    lineHashes[i] = h
  }

  // Block fingerprint: XOR of weighted line hashes over paneHeight lines
  function blockFp(start) {
    let fp = 0
    for (let i = start; i < start + paneHeight && i < lines.length; i++) {
      fp = (fp * 31 + lineHashes[i]) | 0
    }
    return fp
  }

  // Build map: fingerprint → last seen position (we keep the latest occurrence)
  const seen = new Map()
  const dupes = []

  for (let i = 0; i <= scrollbackEnd - paneHeight; i += paneHeight) {
    const fp = blockFp(i)
    if (seen.has(fp)) {
      // Verify: sample 8 lines to rule out hash collision
      const prev = seen.get(fp)
      const step = Math.max(1, paneHeight >> 3)
      let match = true
      for (let s = 0; s < paneHeight; s += step) {
        if (lineHashes[prev + s] !== lineHashes[i + s]) { match = false; break }
      }
      if (match) dupes.push(prev)
    }
    seen.set(fp, i)
  }

  if (dupes.length === 0) return lines

  const keep = new Uint8Array(lines.length).fill(1)
  for (const start of dupes) {
    const end = Math.min(start + paneHeight, scrollbackEnd)
    for (let j = start; j < end; j++) keep[j] = 0
  }

  return lines.filter((_, idx) => keep[idx])
}

// GET /api/config — 服务端配置信息（供前端初始化用）
app.get('/api/config', authMiddleware, (req, res) => {
  res.json({ tmuxSession: TMUX_SESSION, workspaceRoot: WORKSPACE_ROOT })
})

// GET /api/tmux-sessions — 列出所有 tmux session（F-18）
app.get('/api/tmux-sessions', authMiddleware, (req, res) => {
  exec('tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}"', (err, stdout) => {
    if (err) return res.json([{ name: TMUX_SESSION, windows: 0, attached: false }])
    const sessions = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split('|')
      return { name, windows: Number(windows), attached: Number(attached) > 0 }
    })
    res.json(sessions)
  })
})

// ========== F-20: Project-Channel API ==========
// Project = tmux session, Channel = tmux window (within a session)

// GET /api/projects — 列出所有 Projects（tmux sessions）
app.get('/api/projects', authMiddleware, (req, res) => {
  res.json(listProjects())
})

// GET /api/session-cwd — 获取指定 session 的 NEXUS_CWD
app.get('/api/session-cwd', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  let cwd = WORKSPACE_ROOT

  // 1. 尝试读取 NEXUS_CWD（外部启动的 session 可能没有，会抛异常）
  try {
    const envOutput = execSync(`tmux show-environment -t ${session} NEXUS_CWD 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
    if (match) cwd = match[1]
  } catch { /* NEXUS_CWD 未设置 */ }

  // 2. 若 NEXUS_CWD 未设置，回退到 pane_current_path
  if (cwd === WORKSPACE_ROOT) {
    try {
      const panePath = execSync(`tmux display-message -t ${session} -p '#{pane_current_path}' 2>/dev/null`).toString().trim()
      if (panePath) cwd = panePath
    } catch { /* fallback to WORKSPACE_ROOT */ }
  }

  const relative = cwd.startsWith(WORKSPACE_ROOT) ? cwd.slice(WORKSPACE_ROOT.length).replace(/^\/+/, '') : ''
  res.json({ cwd, relative })
})

// GET /api/projects/:name/channels — 列出指定 Project 的 Channels（windows）
app.get('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  exec(
    `tmux list-windows -t ${sessionName} -F "#{window_index}|#{window_name}|#{window_active}|#{pane_current_path}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const lines = stdout.trim().split('\n').filter(Boolean)
      const channels = lines.map(line => {
        const parts = line.split('|')
        const index = Number(parts[0])
        const name = parts[1]
        const active = parts[2]?.trim() === '1'
        const cwd = parts.slice(3).join(':') || ''
        return { index, name, active, cwd }
      })
      // 新创建的频道排在上面
      channels.reverse()
      res.json({ project: sessionName, channels })
    }
  )
})

// POST /api/projects — 新建 Project（创建 tmux session）
// body: { path, shell_type?, agent_type?, profile? }
// project 名称基于路径自动生成
app.post('/api/projects', authMiddleware, (req, res) => {
  const { path, shell_type, agent_type: reqAgentType, profile } = req.body || {}
  if (!path) return res.status(400).json({ error: 'path required' })

  const cwd = path.startsWith('/') ? path : `${WORKSPACE_ROOT}/${path}`

  // agent_type 优先于 shell_type（向后兼容）
  const agentType = normalizeRequestedAgentType(shell_type, reqAgentType, profile)
  const resolvedProfile = sanitizeProfileForAgent(agentType, profile)

  // project 名称默认使用：路径各段首字母 + agent 名，例如 /home/ubuntu + claude => hu-claude
  const safeName = buildProjectSessionName(cwd, agentType)

  // 检查是否已存在同名 session，如果存在则添加序号
  let finalName = safeName
  try {
    const existing = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null').toString().trim().split('\n')
    let counter = 1
    while (existing.includes(finalName)) {
      finalName = `${safeName}-${counter++}`
    }
  } catch {}

  const proxyVars = collectProxyVars(CLAUDE_PROXY);
  const proxyPrefix = proxyVarsToShellPrefix(proxyVars);
  let shellCmd = buildAgentShellCmd(agentType, resolvedProfile, cwd, proxyPrefix);

  // 初始窗口名使用目录名[-profile名]（取路径最后一部分）
  const dirName = cwd.replace(/^\/+|\/+$/g, '').split('/').pop() || '~'
  const initialWindowName = resolvedProfile ? `${dirName}-${resolvedProfile}` : dirName

  // 创建 tmux session（如果不存在）
  try {
    execSync(`tmux new-session -d -s ${finalName} -n "${initialWindowName}" -c "${cwd}" "${shellCmd}"`)
    // 设置 NEXUS_CWD
    execSync(`tmux set-environment -t ${finalName} NEXUS_CWD "${cwd}"`)
    // 设置代理变量
    for (const [key, value] of Object.entries(proxyVars)) {
      try { execSync(`tmux set-environment -t ${finalName} ${key} "${value}" 2>/dev/null`) } catch {}
    }
  } catch (err) {
    return res.status(500).json({ error: 'failed to create project: ' + err.message })
  }

  refreshProjectsSnapshot('create_project')
  res.json({ name: finalName, path: cwd, agent_type: agentType, profile: resolvedProfile, profile_mismatch: !!profile && !resolvedProfile })
})

// POST /api/projects/:name/channels — 在指定 Project 中新建 Channel（window）
app.post('/api/projects/:name/channels', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  const { shell_type, agent_type: reqAgentType, profile, path: bodyPath } = req.body || {}

  // 优先使用前端传入的 path，其次读取 NEXUS_CWD，最后 fallback 到 WORKSPACE_ROOT
  let cwd = WORKSPACE_ROOT
  if (bodyPath) {
    cwd = bodyPath
  } else {
    try {
      const envOutput = execSync(`tmux show-environment -t ${sessionName} NEXUS_CWD 2>/dev/null`).toString().trim()
      const match = envOutput.match(/^NEXUS_CWD=(.+)$/)
      if (match) cwd = match[1]
    } catch {}
  }

  // agent_type 优先于 shell_type（向后兼容）
  const agentType = normalizeRequestedAgentType(shell_type, reqAgentType, profile)
  const resolvedProfile = sanitizeProfileForAgent(agentType, profile)

  const agentBaseName = (() => {
    switch (agentType) {
      case 'claude':
        return 'claude'
      case 'codex':
        return 'codex'
      case 'opencode':
        return 'opencode'
      case 'trae':
        return 'trae-cli'
      case 'bash':
        return INTERACTIVE_SHELL
      default:
        return 'channel'
    }
  })()

  let channelName = agentBaseName
  try {
    const existing = execSync(`tmux list-windows -t ${sessionName} -F "#{window_name}"`).toString().trim().split('\n')
    let counter = 1
    while (existing.includes(channelName)) {
      channelName = `${agentBaseName}-${counter++}`
    }
  } catch {}

  const proxyVars = collectProxyVars(CLAUDE_PROXY);
  const proxyPrefix = proxyVarsToShellPrefix(proxyVars);
  let shellCmd = buildAgentShellCmd(agentType, resolvedProfile, cwd, proxyPrefix);

  // 确保 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null || tmux new-session -d -s ${sessionName} -n shell "${INTERACTIVE_SHELL}"`)
  } catch {}

  // 创建新 window
  const cmd = `tmux new-window -t ${sessionName} -c "${cwd}" -n "${channelName}" "${shellCmd}"`
  exec(cmd, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    refreshProjectsSnapshot('create_channel')
    res.json({ name: channelName, cwd, agent_type: agentType, profile: resolvedProfile, profile_mismatch: !!profile && !resolvedProfile, project: sessionName })
  })
})

// POST /api/projects/:name/activate — 切换到指定 Project（设置为目标 session）
app.post('/api/projects/:name/activate', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 读取该 session 最后激活的 channel
  let lastChannel = null
  try {
    const envOutput = execSync(`tmux show-environment -t ${sessionName} NEXUS_LAST_CHANNEL 2>/dev/null`).toString().trim()
    const match = envOutput.match(/^NEXUS_LAST_CHANNEL=(\d+)$/)
    if (match) lastChannel = parseInt(match[1], 10)
  } catch {}
  // 验证 channel 是否存在，不存在则返回 null（前端会用第一个）
  if (lastChannel !== null) {
    try {
      const windows = execSync(`tmux list-windows -t ${sessionName} -F "#I"`).toString().trim().split('\n')
      if (!windows.includes(String(lastChannel))) {
        lastChannel = null
      }
    } catch {
      lastChannel = null
    }
  }
  // 返回 session 信息，前端据此切换 WebSocket 连接
  res.json({ active: true, project: sessionName, lastChannel })
})

// POST /api/projects/:name/rename — 重命名 Project（重命名 tmux session）
app.post('/api/projects/:name/rename', authMiddleware, (req, res) => {
  const oldName = req.params.name
  const { name: newName } = req.body || {}
  if (typeof newName !== 'string' || !newName.trim()) {
    return res.status(400).json({ error: 'new name required' })
  }
  const sanitizedNewName = newName.trim().replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!sanitizedNewName) {
    return res.status(400).json({ error: 'invalid name format' })
  }
  if (sanitizedNewName === oldName) {
    return res.json({ ok: true, oldName, newName: oldName })
  }
  // 验证旧 session 存在
  try {
    execFileSync('tmux', ['has-session', '-t', oldName])
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // 检查新名称是否已存在
  try {
    execFileSync('tmux', ['has-session', '-t', sanitizedNewName])
    return res.status(409).json({ error: 'project name already exists' })
  } catch {
    // 不存在，可以重命名
  }
  // 执行重命名
  execFile('tmux', ['rename-session', '-t', oldName, sanitizedNewName], (err) => {
    if (err) return res.status(500).json({ error: err.message })
    refreshProjectsSnapshot('rename_project')
    res.json({ ok: true, oldName, newName: sanitizedNewName })
  })
})

// DELETE /api/projects/:name — 关闭 Project（kill tmux session）
app.delete('/api/projects/:name', authMiddleware, (req, res) => {
  const sessionName = req.params.name
  // 验证 session 存在
  try {
    execSync(`tmux has-session -t ${sessionName}`)
  } catch {
    return res.status(404).json({ error: 'project not found' })
  }
  // kill session
  exec(`tmux kill-session -t ${sessionName}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    refreshProjectsSnapshot('delete_project')
    res.json({ ok: true })
  })
})

// ================================================

// GET /api/sessions — 列出 tmux 会话的所有窗口
app.get('/api/sessions', authMiddleware, (req, res) => {
  const session = req.query.session || TMUX_SESSION
  exec(
    `tmux list-windows -t ${session} -F "#{window_index}|#{window_name}|#{window_active}"`,
    (err, stdout) => {
      if (err) return res.status(500).json({ error: err.message })
      const windows = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [index, name, active] = line.split('|')
        return { index: Number(index), name, active: active?.trim() === '1' }
      })
      res.json({ session, windows })
    }
  )
})

// DELETE /api/sessions/:id — 关闭 tmux 窗口
app.delete('/api/sessions/:id', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  // Check window count first; if this is the last window, create a fallback
  // window before killing so the tmux session is not destroyed.
  exec(`tmux list-windows -t ${session} -F "#{window_index}" 2>/dev/null | wc -l`, (countErr, countOut) => {
    const windowCount = parseInt(countOut.trim()) || 0
    if (windowCount <= 1) {
      // Last window: create a new shell first to keep the session alive
      exec(`tmux new-window -t ${session} -n shell "${INTERACTIVE_SHELL}"`, () => {
        exec(`tmux kill-window -t ${session}:${index}`, (err) => {
          if (err) return res.status(500).json({ error: err.message })
          res.json({ ok: true })
        })
      })
    } else {
      exec(`tmux kill-window -t ${session}:${index}`, (err) => {
        if (err) return res.status(500).json({ error: err.message })
        res.json({ ok: true })
      })
    }
  })
})

// POST /api/sessions/:id/attach — 切换到指定 tmux 窗口
app.post('/api/sessions/:id/attach', authMiddleware, (req, res) => {
  const index = req.params.id
  const session = req.query.session || TMUX_SESSION
  exec(`tmux select-window -t ${session}:${index}`, (err) => {
    if (err) return res.status(500).json({ error: err.message })
    // 记录最后激活的 channel 到环境变量
    try {
      execSync(`tmux set-environment -t ${session} NEXUS_LAST_CHANNEL ${index}`)
    } catch {}
    res.json({ ok: true })
  })
})

// ---- Tasks API (F-13: claude -p 非交互派发) ----

function loadTasks() {
  try {
    if (existsSync(TASKS_FILE)) {
      return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
    }
  } catch {}
  return []
}

const MAX_TASKS = 200
const TASK_EVENT_BUFFER_LIMIT = 400
const TASK_OUTPUT_PREVIEW_LIMIT = 10000
const TASK_ERROR_PREVIEW_LIMIT = 1000
const TASK_PERSIST_DEBOUNCE_MS = 300
const TASK_RUNTIME_TTL_MS = 15 * 60 * 1000
const taskRuntimeMap = new Map()

function saveTasks(tasks) {
  // 保留最新的 MAX_TASKS 条，防止文件无限增长
  const trimmed = tasks.length > MAX_TASKS ? tasks.slice(-MAX_TASKS) : tasks
  writeFileSync(TASKS_FILE, JSON.stringify(trimmed, null, 2))
}

function getTask(id) {
  const tasks = loadTasks()
  return tasks.find(t => t.id === id) || null
}

function addTask(taskRecord) {
  const tasks = loadTasks()
  tasks.push(taskRecord)
  saveTasks(tasks)
  return taskRecord
}

function updateTask(id, updates) {
  const tasks = loadTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx !== -1) {
    Object.assign(tasks[idx], updates)
    if (!updates.updatedAt) tasks[idx].updatedAt = new Date().toISOString()
    saveTasks(tasks)
    return tasks[idx]
  }
  return null
}

function buildTaskRuntimeSnapshot(runtime) {
  return {
    ...runtime.record,
    status: runtime.record.status,
    output: runtime.record.output.slice(-TASK_OUTPUT_PREVIEW_LIMIT),
    error: runtime.record.error.slice(-TASK_ERROR_PREVIEW_LIMIT),
    updatedAt: runtime.record.updatedAt,
    last_seq: runtime.record.last_seq,
  }
}

function getTaskSnapshot(taskId) {
  const runtime = taskRuntimeMap.get(taskId)
  if (runtime) return buildTaskRuntimeSnapshot(runtime)
  return getTask(taskId)
}

function initSse(res) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
}

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function scheduleRuntimeCleanup(runtime) {
  if (runtime.cleanupTimer) clearTimeout(runtime.cleanupTimer)
  runtime.cleanupTimer = setTimeout(() => {
    const latest = taskRuntimeMap.get(runtime.taskId)
    if (latest === runtime && latest.finished) {
      taskRuntimeMap.delete(runtime.taskId)
    }
  }, TASK_RUNTIME_TTL_MS)
  runtime.cleanupTimer.unref?.()
}

function persistTaskRuntime(runtime, immediate = false) {
  const applyPersist = () => {
    runtime.persistTimer = null
    updateTask(runtime.taskId, buildTaskRuntimeSnapshot(runtime))
  }

  if (immediate) {
    if (runtime.persistTimer) {
      clearTimeout(runtime.persistTimer)
      runtime.persistTimer = null
    }
    applyPersist()
    return
  }

  if (runtime.persistTimer) return
  runtime.persistTimer = setTimeout(applyPersist, TASK_PERSIST_DEBOUNCE_MS)
  runtime.persistTimer.unref?.()
}

function trimTaskEvents(runtime) {
  if (runtime.events.length <= TASK_EVENT_BUFFER_LIMIT) return
  runtime.events.splice(0, runtime.events.length - TASK_EVENT_BUFFER_LIMIT)
}

function cleanupTaskSubscriber(runtime, subscriber) {
  if (!runtime || !subscriber) return
  runtime.subscribers.delete(subscriber)
  if (subscriber.heartbeat) clearInterval(subscriber.heartbeat)
}

function sendTaskEvent(runtime, subscriber, taskEvent) {
  if (taskEvent.seq <= subscriber.lastSeq) return
  try {
    writeSseEvent(subscriber.res, taskEvent.event, taskEvent.data)
    subscriber.lastSeq = taskEvent.seq
    if (taskEvent.event === 'done') {
      cleanupTaskSubscriber(runtime, subscriber)
      subscriber.res.end()
    }
  } catch {
    cleanupTaskSubscriber(runtime, subscriber)
  }
}

function flushPendingTaskEvents(runtime, subscriber) {
  if (!subscriber.pending.length) return
  subscriber.pending.sort((a, b) => a.seq - b.seq)
  const pending = subscriber.pending
  subscriber.pending = []
  for (const taskEvent of pending) {
    sendTaskEvent(runtime, subscriber, taskEvent)
  }
}

function broadcastTaskEvent(runtime, taskEvent) {
  for (const subscriber of Array.from(runtime.subscribers)) {
    if (taskEvent.seq <= subscriber.lastSeq) continue
    if (subscriber.paused) {
      subscriber.pending.push(taskEvent)
    } else {
      sendTaskEvent(runtime, subscriber, taskEvent)
    }
  }
}

function appendTaskEvent(runtime, event, payload) {
  const seq = runtime.nextSeq++
  runtime.record.last_seq = seq
  runtime.record.updatedAt = new Date().toISOString()
  const taskEvent = { event, seq, data: { taskId: runtime.taskId, seq, ...payload } }
  runtime.events.push(taskEvent)
  trimTaskEvents(runtime)
  broadcastTaskEvent(runtime, taskEvent)
  return taskEvent
}

function appendTaskChunk(runtime, chunk, isErr) {
  if (!chunk) return null
  if (isErr) {
    runtime.fullError += chunk
    runtime.record.error = runtime.fullError.slice(-TASK_ERROR_PREVIEW_LIMIT)
  } else {
    runtime.fullOutput += chunk
    runtime.record.output = runtime.fullOutput.slice(-TASK_OUTPUT_PREVIEW_LIMIT)
  }
  persistTaskRuntime(runtime)
  return appendTaskEvent(runtime, isErr ? 'error' : 'output', { chunk })
}

function finalizeTaskRuntime(runtime, status, exitCode) {
  if (runtime.finished) return
  runtime.finished = true
  runtime.record.status = status
  runtime.record.exitCode = exitCode
  runtime.record.completedAt = new Date().toISOString()
  appendTaskEvent(runtime, 'done', { status, exitCode })
  persistTaskRuntime(runtime, true)
  scheduleRuntimeCleanup(runtime)
}

function subscribeTaskStream(taskId, res, fromSeq = 0) {
  const runtime = taskRuntimeMap.get(taskId)
  if (!runtime) return null

  const replayEvents = runtime.events.filter(taskEvent => taskEvent.seq > fromSeq)
  if (runtime.finished) {
    for (const taskEvent of replayEvents) {
      writeSseEvent(res, taskEvent.event, taskEvent.data)
    }
    res.end()
    return null
  }

  const lastReplaySeq = replayEvents.length > 0 ? replayEvents[replayEvents.length - 1].seq : fromSeq
  const subscriber = {
    res,
    lastSeq: lastReplaySeq,
    paused: true,
    pending: [],
    heartbeat: setInterval(() => {
      try {
        res.write(': heartbeat\n\n')
      } catch {
        cleanupTaskSubscriber(runtime, subscriber)
      }
    }, 15000),
  }
  subscriber.heartbeat.unref?.()

  runtime.subscribers.add(subscriber)
  for (const taskEvent of replayEvents) {
    writeSseEvent(res, taskEvent.event, taskEvent.data)
  }
  subscriber.paused = false
  flushPendingTaskEvents(runtime, subscriber)

  const cleanup = () => cleanupTaskSubscriber(runtime, subscriber)
  res.on('close', cleanup)
  res.on('error', cleanup)
  return cleanup
}

function mergeTaskSnapshot(task) {
  const runtime = taskRuntimeMap.get(task.id)
  return runtime ? buildTaskRuntimeSnapshot(runtime) : task
}

function extractTaskText(parsed, fallback) {
  const fields = [parsed?.content, parsed?.output, parsed?.text, parsed?.message]
  for (const value of fields) {
    if (typeof value === 'string' && value) return value
    if (Array.isArray(value)) {
      const joined = value
        .map(item => {
          if (typeof item === 'string') return item
          if (item && typeof item.text === 'string') return item.text
          if (item && typeof item.content === 'string') return item.content
          return ''
        })
        .join('')
      if (joined) return joined
    }
  }
  if (typeof fallback === 'string') return fallback
  try {
    return JSON.stringify(parsed)
  } catch {
    return String(parsed ?? '')
  }
}

/**
 * F-17: 统一任务执行入口 — spawn claude -p 或 codex exec, 管理任务记录, 回调给各渠道
 * @param {string} prompt
 * @param {string} cwd
 * @param {{ sessionName?: string, source?: string, tmuxSession?: string, profile?: string, agentType?: string, onChunk?: (chunk:string,isErr:boolean)=>void, onDone?: (result:object)=>void }} opts
 * @returns {{ taskId: string, runtime: any, kill: () => void }}
 */
function runTask(prompt, cwd, opts = {}) {
  const { sessionName, source = 'web', tmuxSession, profile, agentType: reqAgentType, onChunk, onDone } = opts
  const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const createdAt = new Date().toISOString()

  // 确定 agent 类型：优先级 reqAgentType > profile.agent_type > 默认 'claude'
  const agentType = reqAgentType || (profile ? getAgentTypeFromProfile(profile) : 'claude')

  const taskRecord = {
    id: taskId,
    session_name: sessionName || '',
    prompt: prompt.slice(0, 1000),
    status: 'running',
    output: '',
    error: '',
    createdAt,
    updatedAt: createdAt,
    source,
    agent_type: agentType,
    last_seq: 0,
    ...(tmuxSession && tmuxSession !== TMUX_SESSION ? { tmux_session: tmuxSession } : {}),
  }
  addTask(taskRecord)

  const runtime = {
    taskId,
    record: taskRecord,
    child: null,
    finished: false,
    nextSeq: 1,
    events: [],
    subscribers: new Set(),
    fullOutput: '',
    fullError: '',
    persistTimer: null,
    cleanupTimer: null,
  }
  taskRuntimeMap.set(taskId, runtime)

  const proxyEnv = CLAUDE_PROXY ? { ALL_PROXY: CLAUDE_PROXY, HTTPS_PROXY: CLAUDE_PROXY, HTTP_PROXY: CLAUDE_PROXY } : {}

  const spec = AGENT_SPECS[agentType] || AGENT_SPECS.claude
  const binary = resolveAgentBinary(agentType)
  if (!binary) {
    const errorMessage = `${spec.label} command not found: ${spec.binaries.join(' / ')}`
    appendTaskChunk(runtime, errorMessage, true)
    persistTaskRuntime(runtime, true)
    finalizeTaskRuntime(runtime, 'error', 127)
    onChunk?.(errorMessage, true)
    onDone?.({ taskId, status: 'error', output: '', errorOutput: errorMessage, exitCode: 127 })
    return { taskId, runtime, kill: () => {} }
  }

  const child = spawn(binary, spec.taskArgs(prompt, profile), {
    cwd,
    env: { ...process.env, ...proxyEnv, PATH: process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  runtime.child = child

  // Codex --json 输出是 JSON lines 格式，需要解析后提取文本
  const isCodexJson = !!spec.jsonTaskOutput
  let jsonBuffer = ''

  function emitTaskChunk(chunk, isErr) {
    if (!chunk) return
    appendTaskChunk(runtime, chunk, isErr)
    onChunk?.(chunk, isErr)
  }

  function flushJsonBuffer(force = false) {
    if (!isCodexJson) return
    const lines = jsonBuffer.split('\n')
    jsonBuffer = lines.pop() || ''
    if (force && jsonBuffer.trim()) {
      lines.push(jsonBuffer)
      jsonBuffer = ''
    }
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        const text = extractTaskText(parsed, line)
        if (text) emitTaskChunk(text, false)
      } catch {
        emitTaskChunk(line, false)
      }
    }
  }

  child.stdout.on('data', (data) => {
    const raw = data.toString()

    if (isCodexJson) {
      jsonBuffer += raw
      flushJsonBuffer(false)
    } else {
      emitTaskChunk(raw, false)
    }
  })

  child.stderr.on('data', (data) => {
    const chunk = data.toString()
    emitTaskChunk(chunk, true)
  })

  child.on('close', (code) => {
    flushJsonBuffer(true)
    const status = code === 0 ? 'success' : 'error'
    finalizeTaskRuntime(runtime, status, code)
    onDone?.({ taskId, status, output: runtime.fullOutput, errorOutput: runtime.fullError, exitCode: code })
  })

  return { taskId, runtime, kill: () => { if (!child.killed) child.kill() } }
}

// GET /api/tasks — 获取任务历史
app.get('/api/tasks', authMiddleware, (req, res) => {
  const tasks = loadTasks()
  res.json(tasks.slice(-50).reverse().map(mergeTaskSnapshot)) // 最近50条，倒序
})

// GET /api/tasks/:id — 获取单条任务快照
app.get('/api/tasks/:id', authMiddleware, (req, res) => {
  const task = getTaskSnapshot(req.params.id)
  if (!task) return res.status(404).json({ error: 'task not found' })
  res.json(task)
})

// GET /api/tasks/:id/events — 订阅任务输出，支持断线续连
app.get('/api/tasks/:id/events', authMiddleware, (req, res) => {
  const taskId = req.params.id
  const task = getTaskSnapshot(taskId)
  if (!task) return res.status(404).json({ error: 'task not found' })

  initSse(res)
  writeSseEvent(res, 'snapshot', { task })

  const fromSeq = Math.max(0, Number.parseInt(String(req.query.from_seq || '0'), 10) || 0)
  const runtime = taskRuntimeMap.get(taskId)
  if (runtime) {
    subscribeTaskStream(taskId, res, fromSeq)
  } else {
    if (task.status !== 'running') {
      writeSseEvent(res, 'done', {
        taskId: task.id,
        seq: task.last_seq || fromSeq,
        status: task.status,
        exitCode: task.exitCode ?? null,
      })
    }
    res.end()
  }
})

// DELETE /api/tasks/:id — 删除单条任务记录
app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  const runtime = taskRuntimeMap.get(req.params.id)
  if (runtime && !runtime.finished) {
    return res.status(409).json({ error: 'task still running' })
  }
  const tasks = loadTasks()
  const filtered = tasks.filter(t => t.id !== req.params.id)
  saveTasks(filtered)
  if (runtime) taskRuntimeMap.delete(req.params.id)
  res.json({ ok: true })
})

// POST /api/tasks — 创建新任务，SSE 流式返回
app.post('/api/tasks', authMiddleware, (req, res) => {
  const { session_name, prompt, profile, tmux_session, agent_type } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt required' })

  // 找到 session 对应的 cwd
  let cwd = WORKSPACE_ROOT
  const targetSession = tmux_session || TMUX_SESSION
  try {
    const windows = execSync(`tmux list-windows -t ${targetSession} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    for (const line of windows) {
      const parts = line.split(':')
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (name === session_name && path) { cwd = path; break }
    }
  } catch {}

  initSse(res)

  const { taskId, runtime } = runTask(prompt, cwd, {
    sessionName: session_name,
    source: 'web',
    tmuxSession: targetSession,
    profile,
    agentType: agent_type,
  })

  writeSseEvent(res, 'start', {
    taskId,
    session_name,
    prompt,
    createdAt: runtime.record.createdAt,
  })
  subscribeTaskStream(taskId, res, 0)
})


// ---- Telegram Bot Webhook (F-16) ----

function telegramApiRequest(botToken, method, payload) {
  if (!botToken) return Promise.resolve(null)
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {})
    const options = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }
    const req = https.request(
      `https://api.telegram.org/bot${botToken}/${method}`,
      options,
      (res) => {
        let data = ''
        res.on('data', d => data += d)
        res.on('end', () => {
          try { resolve(JSON.parse(data || '{}')) } catch { resolve(null) }
        })
      }
    )
    req.on('error', (e) => { console.error(`Telegram ${method} error:`, e.message); resolve(null) })
    req.write(body)
    req.end()
  })
}

async function fetchTelegramBotInfo(botToken) {
  const result = await telegramApiRequest(botToken, 'getMe', {})
  if (!result?.ok || !result?.result) {
    throw new Error(result?.description || 'Failed to validate Telegram bot token')
  }
  return result.result
}

function telegramRequest(method, payload) {
  return telegramApiRequest(getTelegramBotToken(), method, payload)
}

// Returns the sent message_id (or null)
async function telegramSend(chatId, text) {
  const result = await telegramRequest('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' })
  return result?.result?.message_id ?? null
}

// Edit an existing message in-place (silently ignores errors)
function telegramEdit(chatId, messageId, text) {
  if (!messageId) return
  telegramRequest('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown' })
}

// 下载 Telegram 文件到指定目录
function downloadTelegramFile(fileId, destDir, filename) {
  return new Promise((resolve, reject) => {
    const botToken = getTelegramBotToken()
    if (!botToken) return reject(new Error('Telegram not configured'))
    // 1. 获取 file_path
    const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`
    https.get(infoUrl, (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const info = JSON.parse(data)
          if (!info.ok) return reject(new Error('getFile failed: ' + info.description))
          const filePath = info.result.file_path
          const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`

          // 2. 下载文件
          https.get(fileUrl, (fres) => {
            const chunks = []
            fres.on('data', c => chunks.push(c))
            fres.on('end', () => {
              const buf = Buffer.concat(chunks)
              const destPath = join(destDir, filename)
              writeFileSync(destPath, buf)
              resolve({ path: destPath, size: buf.length })
            })
            fres.on('error', reject)
          }).on('error', reject)
        } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

// 全局变量：Telegram Bot 默认 agent 类型
let telegramAgentType = 'claude'

// POST /api/webhooks/telegram — Telegram Bot webhook
app.post('/api/webhooks/telegram', (req, res) => {
  // 验证 secret（如果配置了）
  if (getTelegramWebhookSecret()) {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (secret !== getTelegramWebhookSecret()) {
      return res.status(403).json({ error: 'forbidden' })
    }
  }

  if (!getTelegramBotToken()) return res.status(503).json({ error: 'Telegram not configured' })

  const update = req.body
  res.json({ ok: true }) // 立即返回，以避免 Telegram 重试

  const message = update.message || update.edited_message
  if (!message) return

  const chatId = message.chat.id

  // /start 欢迎消息
  if (message.text?.trim() === '/start') {
    const agentSymbol = telegramAgentType === 'codex' ? '🔷' : '⚡'
    telegramSend(chatId, `👋 *agentmobile Bot* 已就绪 (${agentSymbol} ${telegramAgentType})\n\n发送任意文字，我会用 \`${telegramAgentType}\` 在你的服务器上执行并回复结果。\n\n发送图片或文件，我会保存到当前 session 目录。\n\n\`/sessions\` — 查看 tmux 窗口列表\n\`/switch <编号>\` — 切换目标窗口\n\`/agent claude|codex\` — 切换 AI 后端`)
    return
  }

  // /agent claude|codex — 切换 Telegram Bot 默认 agent
  if (message.text?.trim().startsWith('/agent ')) {
    const agent = message.text.trim().slice('/agent '.length).trim().toLowerCase()
    if (agent === 'claude' || agent === 'codex') {
      telegramAgentType = agent
      const symbol = agent === 'codex' ? '🔷' : '⚡'
      telegramSend(chatId, `${symbol} 已切换到 *${agent.charAt(0).toUpperCase() + agent.slice(1)}*`)
    } else {
      telegramSend(chatId, '❌ 无效的参数。用法: `/agent claude` 或 `/agent codex`')
    }
    return
  }

  // /sessions 列出当前窗口
  if (message.text?.trim() === '/sessions') {
    exec(`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}|#{window_name}|#{window_active}"`, (err, stdout) => {
      if (err) {
        telegramSend(chatId, '❌ 无法获取会话列表: ' + err.message)
        return
      }
      const lines = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [idx, name, active] = line.split('|')
        return `${active?.trim() === '1' ? '▶' : '  '} \`${idx}: ${name}\``
      })
      telegramSend(chatId, '*当前 tmux 窗口:*\n' + lines.join('\n') + '\n\n用 `/switch <编号>` 切换')
    })
    return
  }

  // /switch <index|name> — 切换 active tmux 窗口
  if (message.text?.trim().startsWith('/switch ')) {
    const raw = message.text.trim().slice('/switch '.length).trim()
    const target = raw.replace(/[^a-zA-Z0-9_\-]/g, '') // 只允许安全字符
    if (!target) {
      telegramSend(chatId, '❌ 无效的窗口名称，只允许字母/数字/下划线/连字符')
      return
    }
    exec(`tmux select-window -t ${TMUX_SESSION}:${target}`, (err) => {
      if (err) {
        telegramSend(chatId, `❌ 无法切换到窗口 \`${target}\`: ${err.message}`)
      } else {
        telegramSend(chatId, `✅ 已切换到窗口 \`${target}\`\n\n后续任务将在此窗口执行。`)
      }
    })
    return
  }

  // 执行 AI agent 任务，Telegram 渠道：增量进度推送
  async function runTelegramPrompt(prompt, cwd, sessionName, agentType = telegramAgentType) {
    const agentSymbol = agentType === 'codex' ? '🔷' : '⚡'
    const msgId = await telegramSend(chatId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`, agent: ${agentSymbol} ${agentType}）\n\n_等待输出..._`)

    let currentOutput = ''
    let currentError = ''
    let currentTaskId = null

    const progressInterval = setInterval(() => {
      const preview = (currentOutput || currentError).trim()
      if (preview) {
        if (msgId) {
          const truncated = preview.length > 3000 ? '…' + preview.slice(-3000) : preview
          telegramEdit(chatId, msgId, `⏳ *执行中*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        }
        // 更新任务记录，让 Web TaskPanel 可见中间输出
        if (currentTaskId) updateTask(currentTaskId, { output: currentOutput.slice(-10000), error: currentError.slice(-1000) })
      }
    }, 5000)

    const { taskId } = runTask(prompt, cwd, {
      sessionName: sessionName || 'telegram',
      source: 'telegram',
      agentType: agentType,
      onChunk: (chunk, isErr) => {
        if (isErr) currentError += chunk; else currentOutput += chunk
      },
      onDone: ({ exitCode }) => {
        clearInterval(progressInterval)
        const result = currentOutput.trim() || currentError.trim() || '(无输出)'
        const truncated = result.length > 3800 ? result.slice(0, 3800) + '\n\n…(输出已截断)' : result
        const status = exitCode === 0 ? '✅' : '❌'
        if (msgId) {
          telegramEdit(chatId, msgId, `${status} *执行完成*（session: \`${sessionName || 'default'}\`）\n\`\`\`\n${truncated}\n\`\`\``)
        } else {
          telegramSend(chatId, `${status} *执行完成*\n\`\`\`\n${truncated}\n\`\`\``)
        }
      },
    })
    currentTaskId = taskId
  }

  // 处理文件/图片上传
  if (message.photo || message.document) {
    (async () => {
      try {
        // 确定目标目录
        let cwd = WORKSPACE_ROOT
        try {
          const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
          for (const line of activeLines) {
            const parts = line.split(':')
            if (parts[parts.length - 1]?.trim() === '1') {
              cwd = parts.slice(2, parts.length - 1).join(':')
              break
            }
          }
        } catch {}

        let fileId, filename
        if (message.photo) {
          const photo = message.photo[message.photo.length - 1]
          fileId = photo.file_id
          filename = `tg_photo_${Date.now()}.jpg`
        } else {
          fileId = message.document.file_id
          filename = message.document.file_name || `tg_file_${Date.now()}`
        }

        telegramSend(chatId, `⬇️ 正在下载文件到 \`${cwd}\`...`)
        const result = await downloadTelegramFile(fileId, cwd, filename)
        telegramSend(chatId, `✅ 文件已保存\n\`\`\`\n${result.path}\n\`\`\`\n大小: ${(result.size / 1024).toFixed(1)} KB`)

        // 如果有 caption，把 caption 作为 prompt 执行
        if (message.caption?.trim()) {
          const caption = message.caption.trim()
          runTelegramPrompt(caption, cwd, 'telegram', telegramAgentType).catch(e => console.error('runTelegramPrompt error:', e))
        }
      } catch (e) {
        telegramSend(chatId, '❌ 文件处理失败: ' + (e.message || String(e)))
      }
    })()
    return
  }

  // 普通 prompt
  const text = message.text?.trim()
  if (!text) return
  let cwd = WORKSPACE_ROOT
  let sessionName = getTelegramDefaultSession()

  try {
    const windows = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}"`).toString().trim().split('\n')
    // 优先用默认 session，否则用 active window
    for (const line of windows) {
      const parts = line.split(':')
      const idx = parts[0]
      const name = parts[1]
      const path = parts.slice(2).join(':')
      if (getTelegramDefaultSession() && name === getTelegramDefaultSession()) {
        cwd = path
        sessionName = name
        break
      }
    }
    // 如果没找到默认 session，用 active window
    if (!sessionName) {
      const activeLines = execSync(`tmux list-windows -t ${TMUX_SESSION} -F "#I:#W:#{pane_current_path}:#{window_active}"`).toString().trim().split('\n')
      for (const line of activeLines) {
        const parts = line.split(':')
        const active = parts[parts.length - 1]
        if (active?.trim() === '1') {
          sessionName = parts[1]
          cwd = parts.slice(2, parts.length - 1).join(':')
          break
        }
      }
    }
  } catch { /* ignore */ }

  runTelegramPrompt(text, cwd, sessionName, telegramAgentType).catch(e => console.error('runTelegramPrompt error:', e))
})

// GET /api/telegram/setup — 一键配置 Telegram webhook URL
app.get('/api/telegram/setup', authMiddleware, (req, res) => {
  const botToken = getTelegramBotToken()
  if (!botToken) return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not set' })
  const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/telegram`
  const secret = getTelegramWebhookSecret()
  const secretParam = secret ? `&secret_token=${secret}` : ''
  const setupUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}${secretParam}`

  // 调用 Telegram API 设置 webhook
  https.get(setupUrl, (r) => {
    let data = ''
    r.on('data', d => data += d)
    r.on('end', () => {
      try {
        res.json({ webhookUrl, telegramResponse: JSON.parse(data) })
      } catch {
        res.json({ webhookUrl, raw: data })
      }
    })
  }).on('error', (e) => res.status(500).json({ error: e.message }))
})

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'api route not found' });
});

// SPA fallback — 所有非 API 路由返回 index.html
app.get('*', (req, res) => {
  const indexPath = join(__dirname, 'frontend', 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run: cd frontend && npm run build');
  });
});

// PTY 多实例管理（F-11/F-18：每个 session:window 独立 PTY）
const ptyMap = new Map(); // "session:windowIndex" -> { pty, clients: Set<ws>, lastOutput, lastActivity }

function ptyKey(session, windowIndex) {
  return `${session}:${windowIndex}`;
}

function ensureWindowPty(session, windowIndex) {
  // Validate session exists as a real tmux session (execFileSync avoids shell expansion)
  let safeSession = session;
  try {
    execFileSync('tmux', ['has-session', '-t', session], { stdio: 'pipe' });
  } catch {
    // Requested session doesn't exist — fall back to default TMUX_SESSION
    safeSession = TMUX_SESSION;
    try {
      execFileSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'pipe' });
    } catch {
      // Default session also missing — create it
      try { execFileSync('tmux', ['new-session', '-d', '-s', TMUX_SESSION, '-n', 'shell', INTERACTIVE_SHELL], { stdio: 'pipe' }); } catch {}
    }
  }

  const key = ptyKey(safeSession, windowIndex);
  if (ptyMap.has(key)) return { key, entry: ptyMap.get(key) };

  // 检查窗口是否存在，不存在则 fallback 到第一个可用窗口
  let targetWindow = windowIndex;
  try {
    const out = execFileSync('tmux', ['list-windows', '-t', safeSession, '-F', '#I'], { encoding: 'utf8', stdio: 'pipe' });
    const windows = out.trim().split('\n');
    if (!windows.includes(String(windowIndex))) {
      if (windows.length > 0) {
        targetWindow = parseInt(windows[0], 10);
      } else {
        execFileSync('tmux', ['new-window', '-t', safeSession, '-n', 'shell', INTERACTIVE_SHELL], { stdio: 'pipe' });
        targetWindow = 0;
      }
    }
  } catch {
    targetWindow = 0;
  }

  const actualKey = ptyKey(safeSession, targetWindow);
  if (ptyMap.has(actualKey)) return { key: actualKey, entry: ptyMap.get(actualKey) }; // reuse if fallback exists

  let ptyProc;
  try {
    ptyProc = pty.spawn('tmux', ['attach-session', '-t', `${safeSession}:${targetWindow}`], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: { ...process.env, LANG: 'C.UTF-8', TERM: 'xterm-256color' },
    });
  } catch (err) {
    console.error(`pty.spawn failed for ${safeSession}:${targetWindow}:`, err.message);
    return { key: actualKey, entry: { pty: null, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() } };
  }

  const entry = { pty: ptyProc, clients: new Set(), clientSizes: new Map(), lastOutput: '', lastActivity: Date.now() };
  ptyMap.set(actualKey, entry);

  ptyProc.onData((data) => {
    const ent = ptyMap.get(actualKey);
    if (!ent) return;
    ent.lastOutput = (ent.lastOutput + data).slice(-10000);
    ent.lastActivity = Date.now();
    for (const ws of ent.clients) {
      if (ws.readyState === 1) ws.send(data);
    }
  });

  ptyProc.onExit(({ exitCode }) => {
    console.log(`PTY ${actualKey} exited with code ${exitCode}`);
    ptyMap.delete(actualKey);
    // 如果 window 还在，重新创建
    try {
      const list = execFileSync('tmux', ['list-windows', '-t', safeSession, '-F', '#I'], { encoding: 'utf8', stdio: 'pipe' }).trim().split('\n');
      if (list.includes(String(targetWindow))) {
        setTimeout(() => ensureWindowPty(safeSession, targetWindow), 100);
      }
    } catch {}
  });

  return { key: actualKey, entry };
}

// WebSocket 服务 — 支持 /ws?token=xxx&window=<index>
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const token = url.searchParams.get('token');
  const windowParam = url.searchParams.get('window') || '0';
  const windowIndex = parseInt(windowParam, 10) || 0;
  const session = url.searchParams.get('session') || TMUX_SESSION;

  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    ws.close(4001, 'unauthorized');
    return;
  }

  const { key, entry } = ensureWindowPty(session, windowIndex);
  entry.clients.add(ws);
  console.log(`Client connected to ${key} (clients: ${entry.clients.size})`);

  // Send recent output so the screen isn't blank while waiting for the first repaint.
  if (entry.lastOutput) {
    ws.send(entry.lastOutput.slice(-2000));
  }

  ws.on('message', (msg) => {
    const ent = ptyMap.get(key);
    if (!ent) return;
    const str = typeof msg === 'string' ? msg : msg.toString();
    let isResize = false;
    try {
      const data = JSON.parse(str);
      if (data && data.type === 'resize' && data.cols && data.rows) {
        isResize = true;
        const newCols = Number(data.cols);
        const newRows = Number(data.rows);
        ent.clientSizes.set(ws, { cols: newCols, rows: newRows });
        // 直接使用当前客户端的尺寸，而不是所有客户端的最小值
        // 避免多个客户端/窗口切换时的尺寸混乱
        ent.pty.resize(Math.max(newCols, 10), Math.max(newRows, 5));
      }
    } catch { /* not JSON — fall through to pty.write */ }
    // Write for all non-resize messages. Previously only the catch branch wrote,
    // which silently dropped single-digit strings ('1'..'9','0') since
    // JSON.parse('1') succeeds without throwing.
    if (!isResize) ent.pty.write(str);
  });

  ws.on('close', () => {
    const ent = ptyMap.get(key);
    if (ent) {
      ent.clients.delete(ws);
      ent.clientSizes.delete(ws);
      console.log(`Client disconnected from ${key} (clients: ${ent.clients.size})`);
      // Recompute minimum size if other clients remain
      if (ent.clients.size > 0 && ent.clientSizes.size > 0) {
        let minCols = Infinity, minRows = Infinity;
        for (const [, size] of ent.clientSizes) {
          if (size.cols < minCols) minCols = size.cols;
          if (size.rows < minRows) minRows = size.rows;
        }
        if (minCols !== Infinity) ent.pty.resize(Math.max(minCols, 10), Math.max(minRows, 5));
      }
      // 如果 5 分钟后没有客户端，清理 PTY 节省资源
      setTimeout(() => {
        const e = ptyMap.get(key);
        if (e && e.clients.size === 0 && Date.now() - e.lastActivity > 300000) {
          e.pty.kill();
          ptyMap.delete(key);
          console.log(`PTY ${key} cleaned up (idle)`);
        }
      }, 300000);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    const ent = ptyMap.get(key);
    if (ent) { ent.clients.delete(ws); ent.clientSizes.delete(ws); }
  });
});

// 启动时清理残留的 running 状态（服务重启导致的孤儿任务）
try {
  const staleTasks = loadTasks()
  let changed = false
  for (const t of staleTasks) {
    if (t.status === 'running') {
      t.status = 'error'
      t.error = '(服务重启，任务中断)'
      t.completedAt = new Date().toISOString()
      changed = true
    }
  }
  if (changed) saveTasks(staleTasks)
} catch {}

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`agentmobile listening on :${PORT}`);
  console.log(`tmux session: ${TMUX_SESSION}`);
  console.log(`workspace: ${WORKSPACE_ROOT}`);
  // 启动时确保默认 tmux session 存在，窗口名使用 WORKSPACE_ROOT 的目录名
  try {
    const defaultWindowName = WORKSPACE_ROOT.replace(/^\/+|\/+$/, '').split('/').pop() || '~'
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${TMUX_SESSION} -n "${defaultWindowName}" -c "${WORKSPACE_ROOT}" "${INTERACTIVE_SHELL}"`);
    console.log(`tmux session '${TMUX_SESSION}' ready`);
  } catch (e) { console.warn('tmux session init failed:', e.message); }
});
