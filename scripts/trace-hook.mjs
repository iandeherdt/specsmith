#!/usr/bin/env node
// Claude Code hook handler for specsmith.
// Reads one hook event from stdin and appends one JSONL line to a per-run
// trace file under pipeline/traces/. Intentionally tiny — must not slow
// down tool calls.

import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_INPUT_BYTES = 2048;
const TAIL_BYTES = 512;

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function shortId(id) {
  if (!id || typeof id !== 'string') return 'unknown';
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function truncate(s, max) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max}b]`;
}

// Strip Claude Code's autolink rendering: `[foo.sh](http://foo.sh)` → `foo.sh`.
// The hook payload contains the rendered (autolinked) form, not the literal
// command bytes that bash received. We match only Claude Code's specific
// shape: bracket text is the entire host of the URL (no path segments).
// Legitimate markdown links like `[docs](https://example.com/docs)` have
// distinct bracket text and URL — those stay untouched.
function unmangleAutolinks(s) {
  if (typeof s !== 'string') return s;
  return s.replace(
    /\[([^\]\n]+)\]\(https?:\/\/\1\)/g,
    '$1'
  );
}

// Keep small payloads, summarise big ones. Never log full file contents.
function summariseInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput ?? null;
  // Special-case Bash: keep the command verbatim, truncate description.
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return {
      command: truncate(unmangleAutolinks(toolInput.command), MAX_INPUT_BYTES),
      description: typeof toolInput.description === 'string'
        ? truncate(unmangleAutolinks(toolInput.description), 200)
        : undefined,
      run_in_background: toolInput.run_in_background || undefined,
    };
  }
  // Generic: stringify and truncate.
  const json = JSON.stringify(toolInput);
  if (json.length <= MAX_INPUT_BYTES) return toolInput;
  return { _truncated: true, preview: truncate(json, MAX_INPUT_BYTES) };
}

function looksLikeError(toolResponse) {
  // Trust only structured signals. Lexical sniffing on body text was tried
  // in v1.3.0 and produced too many false positives — any source file that
  // contained the word "error" (NextResponse error responses, error-handling
  // code, etc.) flagged on a normal Read, drowning real failures in noise.
  if (!toolResponse || typeof toolResponse !== 'object') return false;
  if (toolResponse.is_error === true) return true;
  if (typeof toolResponse.stderr === 'string' && toolResponse.stderr.trim()) return true;
  if (typeof toolResponse.error === 'string' && toolResponse.error.trim()) return true;
  if (typeof toolResponse.exit_code === 'number' && toolResponse.exit_code !== 0) return true;
  return false;
}

function summariseOutput(toolResponse) {
  if (toolResponse == null) return null;
  let text;
  if (typeof toolResponse === 'string') {
    text = toolResponse;
  } else if (typeof toolResponse === 'object') {
    try {
      text = JSON.stringify(toolResponse);
    } catch {
      text = String(toolResponse);
    }
  } else {
    text = String(toolResponse);
  }
  text = unmangleAutolinks(text);
  const len = text.length;
  const error = looksLikeError(toolResponse);
  if (len <= TAIL_BYTES * 2 + 32) {
    return { len, error, body: text };
  }
  return {
    len,
    error,
    head: text.slice(0, TAIL_BYTES),
    tail: text.slice(len - TAIL_BYTES),
  };
}

// Walk back through transcript JSONL to find the most recent message with
// a `usage` field. Returns null on any failure — token usage is best-effort.
function readUsageFromTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }
  // Parse from the bottom up. Transcripts can be large; split + reverse is
  // simpler than reverse-streaming and the cost only hits at SubagentStop/Stop.
  const lines = raw.split('\n');
  let model = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const obj = safeJsonParse(line);
    if (!obj) continue;
    // Claude Code transcript shapes vary; try a few common locations.
    const usage =
      obj?.message?.usage ||
      obj?.usage ||
      obj?.response?.usage ||
      null;
    const m =
      obj?.message?.model ||
      obj?.model ||
      null;
    if (m && !model) model = m;
    if (usage) return { model, usage };
  }
  return null;
}

// Per-session sidecar marker so subsequent events for the same session
// append to the same file. Lives next to the trace file.
function resolveTracePath(tracesDir, sessionId) {
  if (!existsSync(tracesDir)) {
    try { mkdirSync(tracesDir, { recursive: true }); } catch { return null; }
  }
  const marker = join(tracesDir, `.session-${sessionId}.path`);
  if (existsSync(marker)) {
    try {
      const cached = readFileSync(marker, 'utf8').trim();
      if (cached) return cached;
    } catch {}
  }
  // First event for this session: try to inherit a parent run's file by
  // picking the most recently modified existing run file from today, if
  // any. This groups subagent sessions into the parent /build run.
  let chosen = null;
  try {
    const today = isoDate();
    const candidates = readdirSync(tracesDir)
      .filter((f) => f.startsWith(today) && f.endsWith('.jsonl'))
      .map((f) => ({ f, mtime: safeStat(join(tracesDir, f)) }))
      .filter((x) => x.mtime != null)
      .sort((a, b) => b.mtime - a.mtime);
    // Inherit only if a sibling run was touched within the last 10 minutes;
    // otherwise it's a stale file from an earlier run.
    const recent = candidates[0];
    if (recent && Date.now() - recent.mtime < 10 * 60 * 1000) {
      chosen = join(tracesDir, recent.f);
    }
  } catch {}
  if (!chosen) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chosen = join(tracesDir, `${stamp}-${sessionId}.jsonl`);
  }
  try { writeFileSync(marker, chosen); } catch {}
  return chosen;
}

function safeStat(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function buildEvent(payload) {
  const ts = new Date().toISOString();
  const sessionFull = payload.session_id || '';
  const session = shortId(sessionFull);
  const base = { ts, session, hook: payload.hook_event_name };

  switch (payload.hook_event_name) {
    case 'PreToolUse':
      return {
        ...base,
        event: 'tool_call',
        phase: 'pre',
        tool: payload.tool_name,
        input: summariseInput(payload.tool_name, payload.tool_input),
      };
    case 'PostToolUse':
      return {
        ...base,
        event: 'tool_call',
        phase: 'post',
        tool: payload.tool_name,
        output: summariseOutput(payload.tool_response),
      };
    case 'SubagentStop': {
      const u = readUsageFromTranscript(payload.transcript_path);
      return {
        ...base,
        event: 'subagent_end',
        model: u?.model || null,
        usage: u?.usage || null,
      };
    }
    case 'Stop': {
      const u = readUsageFromTranscript(payload.transcript_path);
      return {
        ...base,
        event: 'session_end',
        model: u?.model || null,
        usage: u?.usage || null,
      };
    }
    case 'UserPromptSubmit':
      return {
        ...base,
        event: 'prompt',
        prompt: typeof payload.prompt === 'string'
          ? truncate(payload.prompt, 400)
          : null,
      };
    default:
      return { ...base, event: 'other' };
  }
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  if (!payload || typeof payload !== 'object') process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const tracesDir = resolve(cwd, 'pipeline', 'traces');
  const sessionId = shortId(payload.session_id || '');

  const tracePath = resolveTracePath(tracesDir, sessionId);
  if (!tracePath) process.exit(0);

  const event = buildEvent(payload);
  try {
    appendFileSync(tracePath, JSON.stringify(event) + '\n');
  } catch (err) {
    // Best-effort: write to a fallback under $HOME so we don't lose the
    // event entirely if the project tree is read-only or the path failed.
    try {
      const fallback = join(homedir(), '.specsmith-trace.jsonl');
      appendFileSync(fallback, JSON.stringify({ ...event, _fallback: true, error: String(err) }) + '\n');
    } catch {}
  }
  // Hook stdout/stderr is surfaced to the user — keep silent.
  process.exit(0);
}

main();
