// Shared helper: locate the JSONL trace file for a Claude Code session.
// Used by trace-hook.mjs (writer) and guard-repeat-commands.mjs (reader).
// Keeping a single source of truth here means the guard always reads the
// file the hook is writing — they can't drift.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

export function shortId(id) {
  if (!id || typeof id !== 'string') return 'unknown';
  return id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'unknown';
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

function safeStat(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

// Per-session sidecar marker so subsequent events for the same session
// append to the same file. Lives next to the trace file.
//
// When `createIfMissing` is false (the guard's read-path), we return null
// if no marker exists and no inheritable sibling run is fresh — the guard
// has nothing to enforce against in that case.
export function resolveTracePath(tracesDir, sessionId, { createIfMissing = true } = {}) {
  if (!existsSync(tracesDir)) {
    if (!createIfMissing) return null;
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
    const recent = candidates[0];
    if (recent && Date.now() - recent.mtime < 10 * 60 * 1000) {
      chosen = join(tracesDir, recent.f);
    }
  } catch {}
  if (!chosen) {
    if (!createIfMissing) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    chosen = join(tracesDir, `${stamp}-${sessionId}.jsonl`);
  }
  if (createIfMissing) {
    try { writeFileSync(marker, chosen); } catch {}
  }
  return chosen;
}
