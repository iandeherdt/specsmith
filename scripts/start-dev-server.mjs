#!/usr/bin/env node
// Start a project's dev server in the background, parse the bound URL
// from its startup output, and write it to pipeline/dev-server-url.
//
// Why this exists: dev servers (Next, Vite, Astro, Rails, Django, etc.)
// auto-fall-back to a different port when the requested one is taken.
// Naive `npm run dev > log & ; until curl :3000` polling loops then
// hang forever (or hit Bash timeout) probing a port the server never
// claimed. This script reads the actual bound URL from the server's
// own startup output instead of guessing.
//
// Usage:
//   node .claude/scripts/start-dev-server.mjs [flags] [--] <cmd> [args...]
//
// Flags:
//   --timeout=N        seconds to wait for a URL (default: 60)
//   --log=path         where to write server stdout/stderr
//                      (default: pipeline/dev-server.log)
//   --url-file=path    where to record the discovered URL
//                      (default: pipeline/dev-server-url)
//
// Behavior:
//   - If <url-file> exists and the URL it points to responds, prints
//     that URL and exits 0 without spawning anything (idempotent).
//   - Otherwise spawns the command detached, redirects stdio to <log>,
//     and tails it for an `http://(localhost|127.0.0.1):PORT` URL.
//   - On success: writes URL to <url-file>, prints URL to stdout, exits 0.
//     The server keeps running after this script exits.
//   - On timeout or early exit: prints the last 30 log lines to stderr,
//     exits 1. The server is NOT killed — investigate manually.
//
// Examples:
//   node .claude/scripts/start-dev-server.mjs npm run dev
//   node .claude/scripts/start-dev-server.mjs --timeout=30 npx serve designs -l 3100
//   node .claude/scripts/start-dev-server.mjs --url-file=pipeline/designs-url -- bin/rails server

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = process.cwd();
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/\S*)?/;

let timeoutSeconds = 60;
let logPath = join(ROOT, 'pipeline', 'dev-server.log');
let urlFilePath = join(ROOT, 'pipeline', 'dev-server-url');
const cmdArgs = [];

{
  const argv = process.argv.slice(2);
  let captured = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (captured) {
      cmdArgs.push(a);
      continue;
    }
    if (a === '--') {
      captured = true;
      continue;
    }
    if (a.startsWith('--timeout=')) {
      timeoutSeconds = Number(a.slice('--timeout='.length));
      continue;
    }
    if (a === '--timeout') {
      timeoutSeconds = Number(argv[++i]);
      continue;
    }
    if (a.startsWith('--log=')) {
      logPath = resolve(ROOT, a.slice('--log='.length));
      continue;
    }
    if (a === '--log') {
      logPath = resolve(ROOT, argv[++i]);
      continue;
    }
    if (a.startsWith('--url-file=')) {
      urlFilePath = resolve(ROOT, a.slice('--url-file='.length));
      continue;
    }
    if (a === '--url-file') {
      urlFilePath = resolve(ROOT, argv[++i]);
      continue;
    }
    captured = true;
    cmdArgs.push(a);
  }
}

if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  process.stderr.write('--timeout must be a positive number of seconds\n');
  process.exit(2);
}

if (cmdArgs.length === 0) {
  process.stderr.write(
    'Usage: start-dev-server.mjs [--timeout=N] [--log=path] [--url-file=path] [--] <cmd> [args...]\n'
  );
  process.exit(2);
}

async function probe(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    clearTimeout(t);
    return r.status;
  } catch {
    return null;
  }
}

if (existsSync(urlFilePath)) {
  const existing = readFileSync(urlFilePath, 'utf8').trim();
  if (existing && URL_RE.test(existing)) {
    const status = await probe(existing);
    // Any HTTP response (including 4xx/5xx) means a server is up.
    if (status !== null) {
      process.stdout.write(existing + '\n');
      process.exit(0);
    }
  }
}

mkdirSync(dirname(urlFilePath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });

const logFd = openSync(logPath, 'w');
const proc = spawn(cmdArgs[0], cmdArgs.slice(1), {
  cwd: ROOT,
  stdio: ['ignore', logFd, logFd],
  detached: true,
  env: { ...process.env, FORCE_COLOR: '0' },
});
proc.unref();

let resolved = false;
let exited = false;

proc.on('error', (err) => {
  if (resolved) return;
  resolved = true;
  process.stderr.write(`Failed to start dev server: ${err.message}\n`);
  process.exit(1);
});

proc.on('exit', () => {
  exited = true;
});

const deadline = Date.now() + timeoutSeconds * 1000;
let lastSize = 0;

const tick = setInterval(() => {
  let content = '';
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    // Log not yet created — keep waiting.
  }
  if (content.length > lastSize) {
    lastSize = content.length;
    const m = content.match(URL_RE);
    if (m) {
      finish(m[0].replace(/\/+$/, ''));
      return;
    }
  }
  if (exited) {
    bail(`Dev server exited (code=${proc.exitCode}) before printing a URL`);
    return;
  }
  if (Date.now() >= deadline) {
    bail(`Dev server didn't print a URL within ${timeoutSeconds}s`);
  }
}, 250);

function finish(url) {
  if (resolved) return;
  resolved = true;
  clearInterval(tick);
  writeFileSync(urlFilePath, url + '\n');
  process.stdout.write(url + '\n');
  process.exit(0);
}

function bail(msg) {
  if (resolved) return;
  resolved = true;
  clearInterval(tick);
  process.stderr.write(msg + '\n');
  process.stderr.write('Last log lines:\n');
  try {
    const tail = readFileSync(logPath, 'utf8').split('\n').slice(-30);
    for (const line of tail) process.stderr.write('  ' + line + '\n');
  } catch {
    // No log to dump.
  }
  process.exit(1);
}
