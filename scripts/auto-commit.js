#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function parseArgs(argv) {
  const options = {
    message: '',
    body: '',
    push: false,
    dryRun: false,
    paths: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--push') {
      options.push = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--message') {
      options.message = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--message=')) {
      options.message = arg.slice('--message='.length);
      continue;
    }
    if (arg === '--body') {
      options.body = argv[i + 1] || '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--body=')) {
      options.body = arg.slice('--body='.length);
      continue;
    }
    if (arg === '--path') {
      const value = argv[i + 1] || '';
      if (value) options.paths.push(value);
      i += 1;
      continue;
    }
    if (arg.startsWith('--path=')) {
      const value = arg.slice('--path='.length);
      if (value) options.paths.push(value);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.message.trim()) {
    throw new Error('Missing required --message');
  }

  return options;
}

function runGit(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    if (capture) {
      child.stdout.on('data', chunk => {
        stdout += chunk;
      });
      child.stderr.on('data', chunk => {
        stderr += chunk;
      });
    }

    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr || `git ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const body = options.body.trim();
  const commitText = [
    options.message.trim(),
    body ? `\n${body}` : '',
    '',
  ].join('\n');

  const addArgs = options.paths.length > 0 ? ['add', '--', ...options.paths] : ['add', '-A'];
  const statusArgs = options.paths.length > 0 ? ['status', '--short', '--', ...options.paths] : ['status', '--short'];

  if (options.dryRun) {
    console.log(`DRY RUN: git ${addArgs.join(' ')}`);
    const { stdout } = await runGit(statusArgs, { capture: true });
    const candidates = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (candidates.length === 0) {
      console.log('No matching changes to commit.');
      return;
    }
    console.log(`DRY RUN: would stage ${candidates.length} path(s)`);
    console.log(candidates.join('\n'));
    console.log(`DRY RUN: would commit ${candidates.length} file(s)`);
    console.log(commitText.trimEnd());
    if (options.push) {
      console.log('DRY RUN: git push');
    }
    return;
  }

  await runGit(addArgs);

  const diffArgs = ['diff', '--cached', '--name-only'];
  const { stdout } = await runGit(diffArgs, { capture: true });
  const stagedFiles = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (stagedFiles.length === 0) {
    console.log('No staged changes to commit.');
    return;
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agentmobile-auto-commit-'));
  const messageFile = path.join(tempDir, 'commit-message.txt');

  try {
    await writeFile(messageFile, commitText, 'utf8');
    await runGit(['commit', '-F', messageFile]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (options.push) {
    await runGit(['push']);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
