#!/usr/bin/env node
// PreToolUse guard: refuse to re-run expensive Bash commands when nothing
// has changed since the last run, and refuse state-wipe loops on the same
// path. Pairs with trace-hook.mjs — reads the same per-session JSONL file
// that hook is writing.
//
// A PreToolUse hook denies a tool call by exiting non-zero (we use exit 2)
// and writing a message to stderr. Claude Code surfaces stderr back to the
// model as feedback, so the agent sees why the call was blocked.
//
// Bypass with `SPECSMITH_GUARD=0` in the environment.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveTracePath, shortId } from './trace-path.mjs';

const EXPENSIVE_RE = /\b(npm (run )?(test|lint|typecheck|build)|pnpm (run )?(test|lint|typecheck|build)|yarn (test|lint|typecheck|build)|tsc(\s|$)|jest(\s|$)|vitest(\s|$)|playwright test|next build|prisma migrate|cargo (test|build)|go test|mvn |gradle)\b/;
const STATE_WIPE_RE = /\brm\s+-rf?\s+\S*(pglite|\.next|node_modules|data\/)/;
const STATE_WIPE_WINDOW_MS = 30 * 60 * 1000;
const STATE_WIPE_THRESHOLD = 2; // i.e. this would be the 3rd

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// If the command is wrapped in `node -e "..."` / `bash -c "..."` / `sh -c "..."`,
// pull the inner code out. Agents reach for these wrappers when the guard
// blocks the direct form, so we collapse the wrapped variant to the same
// base as the unwrapped one.
function unwrapShell(cmd) {
  const nodeE = cmd.match(/^\s*node(?:\s+--[^\s]+)*\s+-e\s+(["'])([\s\S]+)\1\s*$/);
  if (nodeE) {
    const inner = nodeE[2];
    // node -e wrappers typically call execSync('shell command here', ...) —
    // pull out that first string argument so we can compare it to a prior
    // direct shell invocation.
    const exec = inner.match(/(?:exec|spawn)Sync\s*\(\s*(["'`])([\s\S]+?)\1/);
    if (exec) return exec[2];
    return inner;
  }
  const shellC = cmd.match(/^\s*(?:bash|sh|zsh)\s+-c\s+(["'])([\s\S]+)\1\s*$/);
  if (shellC) return shellC[2];
  return cmd;
}

// Strip everything from the first ` | (grep|tail|head|...)` onward, any
// trailing `; echo …` / `&& echo …` epilogue, and any leading env-var
// prefix (`SKIP_ENV=1 NODE_ENV=test <cmd>`). What's left is the "base" —
// the part that actually does the work. Wrapped forms (`node -e "..."`,
// `bash -c "..."`) are unwrapped first.
function baseCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let b = unwrapShell(cmd);
  b = b.replace(/^(?:\s*[A-Z_][A-Z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  b = b.replace(/\s*\|\s*(grep|rg|awk|sed|head|tail|wc|jq|tee|cut|sort|uniq|less|more)\b.*$/, '');
  b = b.replace(/\s*(;|&&)\s*echo\b.*$/, '');
  return b.trim();
}

function readTrace(tracePath) {
  if (!tracePath || !existsSync(tracePath)) return [];
  let raw;
  try { raw = readFileSync(tracePath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const e = safeJsonParse(line);
    if (e) out.push(e);
  }
  return out;
}

// Walk the trace backwards. Return:
//   - lastBaseAt: timestamp of the most recent prior PreToolUse Bash event
//                 whose base command matches `base`, or null
//   - editsBetween: count of Edit/Write PreToolUse events that occurred
//                   strictly after lastBaseAt (i.e. between then and now)
function analyseRepeat(events, base) {
  let lastBaseIdx = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.phase !== 'pre' || e.tool !== 'Bash') continue;
    const cmd = e.input?.command;
    if (!cmd) continue;
    if (baseCommand(cmd) === base) { lastBaseIdx = i; break; }
  }
  if (lastBaseIdx === -1) return { lastBaseAt: null, editsBetween: 0 };

  let edits = 0;
  for (let i = lastBaseIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.phase !== 'pre') continue;
    if (e.tool === 'Edit' || e.tool === 'Write') edits++;
  }
  return { lastBaseAt: events[lastBaseIdx].ts, editsBetween: edits };
}

function countRecentWipes(events, cmd) {
  // Pull the path-ish argument out of `rm -rf <path>`.
  const m = cmd.match(/rm\s+-rf?\s+(\S+)/);
  if (!m) return 0;
  const target = m[1].replace(/['"]/g, '');
  const cutoff = Date.now() - STATE_WIPE_WINDOW_MS;
  let n = 0;
  for (const e of events) {
    if (e.phase !== 'pre' || e.tool !== 'Bash') continue;
    const c = e.input?.command;
    if (typeof c !== 'string') continue;
    if (!STATE_WIPE_RE.test(c)) continue;
    if (!c.includes(target)) continue;
    const t = Date.parse(e.ts || '');
    if (Number.isNaN(t) || t < cutoff) continue;
    n++;
  }
  return n;
}

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function main() {
  if (process.env.SPECSMITH_GUARD === '0') process.exit(0);

  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);
  if (payload.tool_name !== 'Bash') process.exit(0);

  const cmd = payload.tool_input?.command;
  if (typeof cmd !== 'string' || !cmd.trim()) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const sessionId = shortId(payload.session_id || '');
  const tracePath = resolveTracePath(tracesDir, sessionId, { createIfMissing: false });
  const events = readTrace(tracePath);

  // Rule 1: re-running an expensive command with no edits in between.
  const base = baseCommand(cmd);
  if (EXPENSIVE_RE.test(base)) {
    const { lastBaseAt, editsBetween } = analyseRepeat(events, base);
    if (lastBaseAt && editsBetween === 0) {
      const ageS = Math.max(0, Math.round((Date.now() - Date.parse(lastBaseAt)) / 1000));
      deny(
        `Refusing to re-run \`${base}\` — it ran ${ageS}s ago and no Edit/Write ` +
        `tool calls have happened since, so the output will be identical. ` +
        `You are looping.\n` +
        `\n` +
        `Do this instead:\n` +
        `  1. Open the output you already have (your scrollback, or the tee file from the prior run — try \`ls /tmp/*-out.txt\`).\n` +
        `  2. Pick ONE failure. Read it carefully.\n` +
        `  3. Edit code to fix it. Once an Edit/Write happens, the guard allows a re-run.\n` +
        `\n` +
        `Do NOT try to bypass this block — every variant below is detected and will also be refused:\n` +
        `  - Wrapping the command in \`node -e "…"\`, \`bash -c "…"\`, \`sh -c "…"\`, etc.\n` +
        `  - Prefixing env vars (\`SKIP_ENV_VALIDATION=1\`, \`NODE_ENV=test\`, \`CI=1\`, …)\n` +
        `  - Varying --reporter / --bail / tee filenames / output redirection\n` +
        `  - Setting \`SPECSMITH_GUARD=0\` — that escape hatch is for a human operator who knows the guard is wrong, not for you to dodge a block\n` +
        `\n` +
        `The guard is telling you to stop and diagnose, not to find a new way to run the same command.`
      );
    }
  }

  // Rule 2: repeated state wipes of the same path.
  if (STATE_WIPE_RE.test(cmd)) {
    const prior = countRecentWipes(events, cmd);
    if (prior >= STATE_WIPE_THRESHOLD) {
      deny(
        `Refusing this state wipe — the same path has been removed ${prior} time(s) ` +
        `in the last 30 minutes. If the same failure keeps coming back after a wipe, ` +
        `the bug isn't stale state. Read the underlying error (the dev-server log, ` +
        `the last failing test output) and fix the root cause.\n` +
        `\n` +
        `Do NOT try to bypass by wrapping the rm in \`node -e\` / \`bash -c\`, by ` +
        `targeting the same path with a different glob, or by setting ` +
        `\`SPECSMITH_GUARD=0\` — the guard exists because repeated wipes have ` +
        `historically masked the real bug.`
      );
    }
  }

  process.exit(0);
}

main();
