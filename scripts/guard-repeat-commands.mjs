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
// Bypass: see README under "Runtime guard". Bypasses are restricted to
// non-hook invocations (e.g. manual testing of this script) and any
// attempt under a hook context is logged to pipeline/traces/.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { resolveTracePath, shortId } from './trace-path.mjs';
import { readStdin, safeJsonParse } from './lib/hook-io.mjs';

const OVERRIDE_VAR = 'SPECSMITH_GUARD_OVERRIDE';

const EXPENSIVE_RE = /\b(npm (run )?(test|lint|typecheck|build)|pnpm (run )?(test|lint|typecheck|build)|yarn (test|lint|typecheck|build)|tsc(\s|$)|jest(\s|$)|vitest(\s|$)|playwright test|next build|prisma migrate|cargo (test|build)|go test|mvn |gradle)\b/;
const STATE_WIPE_RE = /\brm\s+-rf?\s+\S*(pglite|\.next|node_modules|data\/)/;
const STATE_WIPE_WINDOW_MS = 30 * 60 * 1000;
const STATE_WIPE_THRESHOLD = 2; // i.e. this would be the 3rd

// Long inline scripts in ANY interpreter. Agents reach for `python3 -c '...'`,
// `perl -e '...'`, `ruby -e '...'`, `php -r '...'` to dodge guards and to
// "just one more parse" their way through diff output instead of writing a
// proper helper script. The threshold (LONG_INLINE_CHARS) is a heuristic:
// short one-liners (`python3 -c 'import sys; print(sys.argv)'`) are fine.
// Anything that wraps into a 200-char blob of JSON-parsing or AST-walking
// belongs in a `.mjs` / `.py` / `.pl` file the user can read, version, and
// re-run. Caught in audit 2026-05-19T02-31: orchestrator pasted a 1.2 KB
// Python script as `python3 -c '...'` to read pixel-diff.json, when a
// 30-line helper script already existed for that purpose.
const LONG_INLINE_RE = /\b(python3?|node|perl|ruby|php|deno|bun)\s+(?:-[a-zA-Z]\s+)*-(?:e|c|r)\s+(["'])([\s\S]+?)\2/;
const LONG_INLINE_CHARS = 200;

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

function logBypassAttempt(cwd, payload, reason) {
  try {
    const dir = resolve(cwd, 'pipeline', 'traces');
    mkdirSync(dir, { recursive: true });
    const cmd = String(payload?.tool_input?.command || '').slice(0, 200).replace(/\s+/g, ' ');
    const line = `${new Date().toISOString()}\t${OVERRIDE_VAR} set in hook context (IGNORED)\treason=${reason}\tcmd=${cmd}\n`;
    writeFileSync(resolve(dir, 'guard-bypass-attempts.log'), line, { flag: 'a' });
  } catch {}
}

function main() {
  const raw = readStdin();
  if (!raw) {
    // Manual invocation with no stdin payload — honor the override env var
    // so this script remains testable from a shell. There is no agent here.
    if (process.env[OVERRIDE_VAR]) process.exit(0);
    process.exit(0);
  }
  const payload = safeJsonParse(raw);
  const isHook = !!(payload && payload.hook_event_name);

  // Bypass: SPECSMITH_GUARD_OVERRIDE=<non-empty-reason>. Honored only when
  // the script was NOT invoked as a hook (e.g. manual testing). Under a hook
  // context — which is every Claude Code Bash tool call — the override is
  // ignored and the attempt is logged. This closes the env-var bypass loop
  // that earlier versions of the guard left open.
  const override = process.env[OVERRIDE_VAR];
  if (override && !isHook) process.exit(0);
  if (override && isHook) {
    logBypassAttempt(payload.cwd || process.cwd(), payload, override);
  }

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
        `  - Setting any env var that claims to disable this guard — the guard ignores all such overrides in hook context and logs the attempt to \`pipeline/traces/guard-bypass-attempts.log\` for the user to see\n` +
        `\n` +
        `The guard is telling you to stop and diagnose, not to find a new way to run the same command.`
      );
    }
  }

  // Rule 2: a long inline script in any interpreter. Wrapping a 1 KB Python
  // parse into `python3 -c '...'` reaches the same "I'm doing work that
  // belongs in a helper" failure mode as the node -e bypass we already
  // unwrap above — but in a language the unwrap regex doesn't speak. Treat
  // length, not language, as the signal.
  {
    const m = cmd.match(LONG_INLINE_RE);
    if (m && m[3] && m[3].length >= LONG_INLINE_CHARS) {
      const interp = m[1];
      const inner = m[3];
      deny(
        `Refusing this command — long inline ${interp} script (${inner.length} chars).\n` +
        `\n` +
        `Inline scripts that long should be a versioned helper file, not\n` +
        `a one-shot \`${interp} -e/-c '...'\` blob. Reasons:\n` +
        `  - You can't read it back in two days when something breaks.\n` +
        `  - There's no way to test it before running it.\n` +
        `  - Subagents and humans both write more careful code into a file.\n` +
        `  - In /build runs, this pattern is how orchestrators end up doing\n` +
        `    the developer's work inline — see Constitution Principle VIII.\n` +
        `\n` +
        `Do this instead:\n` +
        `  1. Save the script to \`.claude/scripts/<name>.mjs\` (or .py / .pl /\n` +
        `     .rb depending on interpreter). If the work is ad-hoc and you\n` +
        `     don't want to keep it, put it under \`pipeline/scratch/\` —\n` +
        `     gitignored by default in specsmith projects.\n` +
        `  2. Run it with \`${interp} <path>\`. The output is identical, the\n` +
        `     intent is grep-able, and the next session can re-use it.\n` +
        `\n` +
        `For reading pixel-diff / dom-diff output specifically, the helpers\n` +
        `already exist — don't re-implement them inline:\n` +
        `  node .claude/scripts/show-pixel-diff.mjs\n` +
        `  node .claude/scripts/show-dom-diff.mjs\n` +
        `\n` +
        `If you genuinely need a long inline script (rare), split it into\n` +
        `discrete short Bash steps the user can audit one at a time.`
      );
    }
  }

  // Rule 3: repeated state wipes of the same path.
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
        `targeting the same path with a different glob, or by setting an env var ` +
        `that claims to disable this guard — bypass attempts in hook context are ` +
        `logged and ignored. The guard exists because repeated wipes have ` +
        `historically masked the real bug.`
      );
    }
  }

  process.exit(0);
}

main();
