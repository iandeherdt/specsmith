// Shared plumbing for PreToolUse guard hooks (guard-scope,
// guard-repeat-commands, guard-orchestrator-discipline). Pure I/O / string
// helpers only — no guard decision logic lives here, so a guard's behaviour is
// fully determined by its own file. Installed to .claude/scripts/lib/ and
// imported by the guards as a sibling (same pattern as trace-hook.mjs →
// trace-path.mjs).

import { readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';

// Read the entire hook payload from stdin. Returns '' if stdin is empty or
// unreadable, so callers can exit(0) (no-op) on no input.
export function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

// Parse JSON, returning null instead of throwing on malformed input.
export function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Normalise a path to a project-relative POSIX form so glob-style prefix
// comparison works on macOS/Linux and Windows alike. Returns null for paths
// outside the project (they're not our concern) or falsy input.
export function toRelPosix(cwd, p) {
  if (!p) return null;
  // Absolute? Make relative to cwd. Already relative? Use as-is.
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..')) return null; // outside the project, not our concern
  return rel.split(sep).join('/');
}
