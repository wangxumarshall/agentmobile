#!/usr/bin/env node
// agentmobile automated setup script — run with: node scripts/setup.js
// Requires Node.js 20+. All other dependencies are installed by this script.
// Default service manager: systemd (PM2 fallback when systemd is unavailable)

import { spawnSync } from 'child_process';
import { existsSync, copyFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const ENV_EXAMPLE_PATH = resolve(ROOT, '.env.example');
const SYSTEMD_UNIT_PATH = resolve(ROOT, 'agentmobile.service');
const SYSTEMD_TMUX_UNIT_PATH = resolve(ROOT, 'agentmobile-tmux.service');
const PM2_CONFIG_PATH = resolve(ROOT, 'ecosystem.config.cjs');

function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
}

function capture(cmd, opts = {}) {
  return spawnSync(cmd, {
    shell: true,
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function check(cmd) {
  return spawnSync(cmd, { shell: true, stdio: 'pipe' }).status === 0;
}

function step(msg) {
  console.log(`\n\x1b[36m▶ ${msg}\x1b[0m`);
}

function ok(msg) {
  console.log(`\x1b[32m✔ ${msg}\x1b[0m`);
}

function fail(msg) {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}

function warn(msg) {
  console.log(`\x1b[33m⚠ ${msg}\x1b[0m`);
}

function readEnvValue(key) {
  const envFile = existsSync(ENV_PATH) ? ENV_PATH : ENV_EXAMPLE_PATH;
  if (!existsSync(envFile)) return '';
  const line = capture(`awk -F= '/^${key}=/{print substr($0, index($0,$2))}' ${JSON.stringify(envFile)}`);
  return (line.stdout || '').trim();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveNodeBinary() {
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  const result = capture('command -v node');
  const path = (result.stdout || '').trim();
  if (result.status === 0 && path) return path;
  fail('Could not resolve the current node binary. Ensure `node` is on PATH.');
}

function buildRuntimePath() {
  const homeDir = process.env.HOME || '/home/ubuntu';
  const dirs = [
    ...(process.env.PATH || '').split(':'),
    resolve(homeDir, '.local/bin'),
    resolve(homeDir, 'bin'),
    resolve(homeDir, '.npm-global/bin'),
    resolve(homeDir, '.local/share/pnpm'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter(Boolean);

  try {
    const prefix = capture('npm prefix -g');
    const npmPrefix = (prefix.stdout || '').trim();
    if (prefix.status === 0 && npmPrefix) dirs.push(resolve(npmPrefix, 'bin'));
  } catch {}

  return [...new Set(dirs)].join(':');
}

function detectServiceManager() {
  const hasSystemctl = check('command -v systemctl');
  const systemdActive = existsSync('/run/systemd/system') && check('systemctl show-environment >/dev/null 2>&1');
  const hasSudo = check('sudo -n true');
  return {
    hasSystemctl,
    systemdActive,
    hasSudo,
    useSystemd: hasSystemctl && systemdActive && hasSudo,
  };
}

function ensurePm2Installed(hasSudo) {
  if (check('command -v pm2')) {
    ok('PM2 available');
    return true;
  }

  step('Installing PM2 fallback');
  let install = run('npm install -g pm2');
  if (install.status !== 0 && hasSudo) {
    warn('Global PM2 install without sudo failed, retrying with sudo');
    install = run('sudo npm install -g pm2');
  }

  if (install.status !== 0 || !check('command -v pm2')) {
    warn('PM2 installation failed. Install it manually: npm install -g pm2');
    return false;
  }

  ok('PM2 installed');
  return true;
}

function extractPm2StartupCommand(output) {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => line.startsWith('sudo ') && line.includes(' pm2 startup ')) || '';
}

function configurePm2Autostart(hasSudo) {
  step('Configuring PM2 fallback auto-start');
  const startup = capture('pm2 startup');
  const combined = `${startup.stdout || ''}\n${startup.stderr || ''}`;
  const startupCmd = extractPm2StartupCommand(combined);

  if (startup.status === 0 && !startupCmd) {
    ok('PM2 auto-start configured');
    return { autostartConfigured: true, manualCommand: '' };
  }

  if (startupCmd) {
    if (hasSudo) {
      const runStartup = run(startupCmd);
      if (runStartup.status === 0) {
        ok('PM2 auto-start configured');
        return { autostartConfigured: true, manualCommand: '' };
      }
    }
    warn(`PM2 auto-start needs one manual command: ${startupCmd}`);
    return { autostartConfigured: false, manualCommand: startupCmd };
  }

  warn('PM2 auto-start could not be configured automatically. Run `pm2 startup` and follow its output.');
  return { autostartConfigured: false, manualCommand: 'pm2 startup' };
}

function createPm2Config(nodeBinary) {
  step('Creating PM2 fallback config');
  mkdirSync(resolve(ROOT, 'logs'), { recursive: true });
  const runtimePath = buildRuntimePath();
  const ecosystemContent = `module.exports = {
  apps: [{
    name: 'agentmobile',
    script: './server.js',
    cwd: ${JSON.stringify(ROOT)},
    interpreter: ${JSON.stringify(nodeBinary)},
    instances: 1,
    exec_mode: 'fork',
    env: { NODE_ENV: 'production', PATH: ${JSON.stringify(runtimePath)} },
    error_file: './logs/agentmobile-error.log',
    out_file: './logs/agentmobile-out.log',
    log_file: './logs/agentmobile-combined.log',
    time: true
  }]
};
`;
  writeFileSync(PM2_CONFIG_PATH, ecosystemContent);
  ok('ecosystem.config.cjs created');
}

function createSystemdService(nodeBinary) {
  step('Creating systemd service file');
  const runtimePath = buildRuntimePath();
  const systemdContent = `[Unit]
Description=agentmobile WebSocket tmux bridge service
Documentation=file:${ROOT}/docs/SERVICES.md
After=network.target agentmobile-tmux.service
Requires=agentmobile-tmux.service

[Service]
Type=simple
User=${process.env.USER || 'ubuntu'}
Group=${process.env.USER || 'ubuntu'}
ExecStart=${nodeBinary} ${ROOT}/server.js
WorkingDirectory=${ROOT}
Restart=on-failure
RestartSec=10
KillMode=control-group
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=PATH=${runtimePath}

[Install]
WantedBy=multi-user.target
`;
  writeFileSync(SYSTEMD_UNIT_PATH, systemdContent);
  ok('agentmobile.service created');
}

function createSystemdTmuxService() {
  step('Creating systemd tmux runtime service file');
  const runtimePath = buildRuntimePath();
  const systemdContent = `[Unit]
Description=agentmobile persistent tmux runtime
Documentation=file:${ROOT}/docs/SERVICES.md
After=network.target

[Service]
Type=simple
User=${process.env.USER || 'ubuntu'}
Group=${process.env.USER || 'ubuntu'}
ExecStart=${ROOT}/scripts/tmux-runtime.sh
WorkingDirectory=${ROOT}
Restart=always
RestartSec=10
KillMode=control-group
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=PATH=${runtimePath}

[Install]
WantedBy=multi-user.target
`;
  writeFileSync(SYSTEMD_TMUX_UNIT_PATH, systemdContent);
  ok('agentmobile-tmux.service created');
}

function installSystemdService() {
  step('Installing systemd service');
  if (run('sudo cp agentmobile-tmux.service /etc/systemd/system/').status !== 0) fail('Failed to copy agentmobile-tmux.service into /etc/systemd/system');
  if (run('sudo cp agentmobile.service /etc/systemd/system/').status !== 0) fail('Failed to copy agentmobile.service into /etc/systemd/system');
  if (run('sudo systemctl daemon-reload').status !== 0) fail('systemd daemon-reload failed');
  if (run('sudo systemctl enable agentmobile-tmux').status !== 0) fail('systemd enable failed — check: sudo systemctl status agentmobile-tmux');
  if (run('sudo systemctl enable agentmobile').status !== 0) fail('systemd enable failed — check: sudo systemctl status agentmobile');
  const tmuxStartResult = run('sudo systemctl restart agentmobile-tmux');
  if (tmuxStartResult.status !== 0) fail('systemd tmux runtime start failed — check: sudo systemctl status agentmobile-tmux');
  const startResult = run('sudo systemctl restart agentmobile');
  if (startResult.status !== 0) fail('systemd start failed — check: sudo systemctl status agentmobile');
  ok('agentmobile services started');
  return { manager: 'systemd', autostartConfigured: true, manualCommand: '' };
}

function installPm2Service(nodeBinary, hasSudo) {
  createPm2Config(nodeBinary);
  if (!ensurePm2Installed(hasSudo)) fail('PM2 is required when systemd is unavailable');

  step('Starting agentmobile via PM2 fallback');
  const startResult = run('pm2 start ecosystem.config.cjs');
  if (startResult.status !== 0) fail('PM2 start failed — check: pm2 logs agentmobile');
  ok('agentmobile started via PM2');

  step('Saving PM2 process list');
  const saveResult = run('pm2 save');
  if (saveResult.status !== 0) fail('PM2 save failed — check: pm2 save');
  ok('PM2 process list saved');

  const { autostartConfigured, manualCommand } = configurePm2Autostart(hasSudo);
  return { manager: 'pm2', autostartConfigured, manualCommand };
}

// ── 1. Node version ──────────────────────────────────────────────────────────
step('Checking Node.js version');
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) fail(`Node.js 20+ required, found ${process.version}. Install via: nvm install 20 && nvm use 20`);
ok(`Node.js ${process.version}`);
const nodeBinary = resolveNodeBinary();
ok(`Using node binary: ${nodeBinary}`);

// ── 2. tmux ──────────────────────────────────────────────────────────────────
step('Checking tmux');
if (!check('tmux -V')) {
  console.log('tmux not found — attempting install...');
  if (check('apt-get --version') && check('sudo -n true')) {
    run('sudo apt-get install -y tmux');
  } else if (check('brew --version')) {
    run('brew install tmux');
  } else {
    fail('tmux not found. Install it manually: sudo apt install tmux  OR  brew install tmux');
  }
}
ok('tmux available');

// ── 3. .env ──────────────────────────────────────────────────────────────────
step('Setting up .env');
if (!existsSync(ENV_PATH)) {
  if (!existsSync(ENV_EXAMPLE_PATH)) fail('.env.example not found — repo may be incomplete');
  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  ok('.env created from .env.example (default password: agentmobile)');
} else {
  ok('.env already exists — skipping');
}

// ── 4. Backend deps ──────────────────────────────────────────────────────────
step('Installing backend dependencies');
const r = run('npm install');
if (r.status !== 0) fail('npm install failed');
ok('Backend dependencies installed');

// ── 5. Frontend build ────────────────────────────────────────────────────────
step('Building frontend');
const fe = run('npm install && npm run build', { cwd: resolve(ROOT, 'frontend') });
if (fe.status !== 0) fail('Frontend build failed — check frontend/node_modules or run: cd frontend && npm install && npm run build');
ok('Frontend built');

// ── 6. Service manager ───────────────────────────────────────────────────────
step('Detecting service manager');
const serviceManager = detectServiceManager();
if (serviceManager.useSystemd) {
  ok('Using systemd (systemctl + active systemd + passwordless sudo detected)');
} else {
  const reasons = [];
  if (!serviceManager.hasSystemctl) reasons.push('systemctl not found');
  if (!serviceManager.systemdActive) reasons.push('systemd not active');
  if (!serviceManager.hasSudo) reasons.push('passwordless sudo unavailable');
  warn(`systemd unavailable, falling back to PM2: ${reasons.join(', ')}`);
}

let serviceStatus;
if (serviceManager.useSystemd) {
  createSystemdTmuxService();
  createSystemdService(nodeBinary);
  serviceStatus = installSystemdService();
} else {
  serviceStatus = installPm2Service(nodeBinary, serviceManager.hasSudo);
}

// ── 7. tmux session ──────────────────────────────────────────────────────────
const tmuxSession = readEnvValue('TMUX_SESSION') || 'main';
step(`Ensuring tmux session "${tmuxSession}" exists`);
if (!check(`tmux has-session -t ${shellQuote(tmuxSession)} 2>/dev/null`)) {
  run(`tmux new-session -d -s ${shellQuote(tmuxSession)}`);
  ok(`tmux session "${tmuxSession}" created`);
} else {
  ok(`tmux session "${tmuxSession}" already exists`);
}

// ── Done ─────────────────────────────────────────────────────────────────────
const port = readEnvValue('PORT') || '5000';
const password = 'agentmobile';
const successBanner = `
\x1b[32m
╔══════════════════════════════════════════╗
║  agentmobile setup complete!
║
║  URL:      http://localhost:${port}
║  Password: ${password}  (change in .env)
║  Manager:  ${serviceStatus.manager}
║
║  Service operations:
║  npm run service:status
║  npm run service:deploy:web
║  npm run service:logs
║  See docs/SERVICES.md before restarting tmux runtime.
║
║  PM2 fallback:
║  pm2 start ecosystem.config.cjs
║  pm2 logs agentmobile
╚══════════════════════════════════════════╝
\x1b[0m`;

const manualBanner = `
\x1b[33m
╔════════════════════════════════════════════════════════════╗
║  agentmobile installed, but auto-start still needs setup
║
║  URL:      http://localhost:${port}
║  Password: ${password}
║  Manager:  ${serviceStatus.manager}
║
║  Run this command to finish auto-start:
║  ${serviceStatus.manualCommand}
╚════════════════════════════════════════════════════════════╝
\x1b[0m`;

if (serviceStatus.autostartConfigured) {
  console.log(successBanner);
} else {
  console.log(manualBanner);
  process.exitCode = 1;
}
