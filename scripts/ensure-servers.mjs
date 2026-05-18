#!/usr/bin/env node
// Idempotent "are the servers up?" check. Reads
// `pipeline/dev-server-url` and (optionally) `pipeline/designs-server-url`,
// curls each one, and only starts what's actually missing.
//
// Why this exists: in a /build run, the evaluator subagent starts the dev
// server in its own Step 0 and (when designs/ exists) the designs server
// in its Step 2b. Both writes go to URL marker files. Between the two
// subagent invocations the orchestrator does NOT know which servers are
// up — so prior runs would `pkill && start` "to be safe", which:
//   - tears down a server the next subagent just had a working URL for,
//   - rewrites the URL file with a different port, and
//   - sometimes leaves a zombie process attached to the original port.
// This script checks before it starts. If the URL files exist and curl
// returns ANY HTTP status (including 4xx/5xx), the server is up — print
// the URL and exit. Otherwise start via `start-dev-server.mjs`.
//
// Usage:
//   node .claude/scripts/ensure-servers.mjs              # check dev server only
//   node .claude/scripts/ensure-servers.mjs --designs    # also check/start designs server
//   node .claude/scripts/ensure-servers.mjs --dev-cmd='npm run dev'
//                                                       # override the dev command
//   node .claude/scripts/ensure-servers.mjs --skip-start # check only, never start
//
// Output (always to stdout, one URL per line, prefixed for clarity):
//   dev=<url>
//   designs=<url>     (if --designs was passed)
//
// Exit code:
//   0 — every requested server is reachable
//   1 — at least one server is down AND --skip-start was passed, or starting
//       a missing server failed (start-dev-server.mjs's stderr is forwarded)
//
// Both subagents and the orchestrator may call this. Idempotent: cheap to
// invoke repeatedly. The orchestrator-discipline guard ALLOWS this script
// (it's a check, not a re-run of the diff tools).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/\S*)?$/;
const PROBE_TIMEOUT_MS = 2000;

function parseArgs(argv) {
  const out = {
    designs: false,
    skipStart: false,
    devCmd: 'npm run dev',
    designsCmd: 'npx serve designs -l 3100',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--designs') out.designs = true;
    else if (a === '--skip-start') out.skipStart = true;
    else if (a.startsWith('--dev-cmd=')) out.devCmd = a.slice('--dev-cmd='.length);
    else if (a === '--dev-cmd') out.devCmd = argv[++i];
    else if (a.startsWith('--designs-cmd=')) out.designsCmd = a.slice('--designs-cmd='.length);
    else if (a === '--designs-cmd') out.designsCmd = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: ensure-servers.mjs [--designs] [--skip-start]\n' +
        '                          [--dev-cmd=<cmd>] [--designs-cmd=<cmd>]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

async function probe(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    const r = await fetch(url, { signal: ac.signal, redirect: 'manual' });
    clearTimeout(t);
    return r.status;
  } catch {
    return null;
  }
}

function readUrlFile(path) {
  if (!existsSync(path)) return null;
  try {
    const s = readFileSync(path, 'utf8').trim();
    return URL_RE.test(s) ? s : null;
  } catch {
    return null;
  }
}

function startServer({ label, urlFile, cmd, logFile }) {
  // start-dev-server.mjs is itself idempotent (it checks the URL file +
  // probes before spawning) so this is "belt and braces" — but the layered
  // check is cheap and gives clearer error reporting when a start fails.
  const args = [resolve('.claude/scripts/start-dev-server.mjs')];
  if (urlFile) args.push(`--url-file=${urlFile}`);
  if (logFile) args.push(`--log=${logFile}`);
  args.push('--', ...cmd.split(' ').filter(Boolean));

  const r = spawnSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    process.stderr.write(
      `ensure-servers: failed to start ${label} server (exit ${r.status})\n` +
      (r.stderr || '')
    );
    return null;
  }
  return (r.stdout || '').trim();
}

async function ensure({ label, urlFile, cmd, logFile, skipStart }) {
  const existing = readUrlFile(urlFile);
  if (existing) {
    const status = await probe(existing);
    if (status !== null) return existing;
  }
  if (skipStart) {
    process.stderr.write(`ensure-servers: ${label} server is down and --skip-start was passed\n`);
    return null;
  }
  return startServer({ label, urlFile, cmd, logFile });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dev = await ensure({
    label: 'dev',
    urlFile: 'pipeline/dev-server-url',
    cmd: args.devCmd,
    logFile: 'pipeline/dev-server.log',
    skipStart: args.skipStart,
  });

  let designs = null;
  if (args.designs) {
    designs = await ensure({
      label: 'designs',
      urlFile: 'pipeline/designs-server-url',
      cmd: args.designsCmd,
      logFile: 'pipeline/designs-server.log',
      skipStart: args.skipStart,
    });
  }

  if (dev) process.stdout.write(`dev=${dev}\n`);
  if (designs) process.stdout.write(`designs=${designs}\n`);

  const allOk = dev && (!args.designs || designs);
  process.exit(allOk ? 0 : 1);
}

main();
