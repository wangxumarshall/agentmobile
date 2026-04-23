/**
 * Simple logger for IM bridge.
 */

const levels = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof levels)[number];

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return levels.indexOf(level) >= levels.indexOf(currentLevel);
}

function format(level: LogLevel, module: string, msg: string): string {
  const ts = new Date().toISOString();
  return `[${ts}] [${level.toUpperCase()}] [${module}] ${msg}`;
}

export function debug(module: string, msg: string): void {
  if (shouldLog('debug')) console.debug(format('debug', module, msg));
}

export function info(module: string, msg: string): void {
  if (shouldLog('info')) console.info(format('info', module, msg));
}

export function warn(module: string, msg: string): void {
  if (shouldLog('warn')) console.warn(format('warn', module, msg));
}

export function error(module: string, msg: string): void {
  if (shouldLog('error')) console.error(format('error', module, msg));
}

export function setupLogger(level?: LogLevel): void {
  if (level) setLogLevel(level);
}
