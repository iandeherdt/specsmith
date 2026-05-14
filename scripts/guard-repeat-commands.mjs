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

// Strip everything from the first ` | (grep|tail|head|...)` onward, plus
// any trailing `; echo …` / `&& echo …` epilogue agents tend to add.
// What's left is the "base" — the part that actually does the work.
function baseCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let b = cmd.replace(/\s*\|\s*(grep|rg|awk|sed|head|tail|wc|jq|tee|cut|sort|uniq|less|more)\b.*$/, '');
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
        `Refusing to re-run \`${base}\` — it ran ${ageS}s ago and no Edit/Write tool ` +
        `calls have happened since, so the output will be identical. Tee the output ` +
        `once and grep the file:\n` +
        `  ${base} 2>&1 | tee /tmp/last-out.txt\n` +
        `  grep -n "<pattern>" /tmp/last-out.txt\n` +
        `Set SPECSMITH_GUARD=0 to bypass.`
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
        `the bug isn't stale state. Read the underlying error (look for recurring ` +
        `runtime errors in the dev-server log) and fix the root cause. ` +
        `Set SPECSMITH_GUARD=0 to bypass.`
      );
    }
  }

  process.exit(0);
}

main();
