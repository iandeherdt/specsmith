#!/usr/bin/env node
// PreToolUse guard: refuse Edit/Write/MultiEdit calls that touch specsmith
// tooling paths during a feature build. Enforces Constitution Principle VIII
// (Scope Discipline) at the hook level.
//
// Protected paths (anything under these is refused without a waiver):
//   .claude/scripts/
//   .claude/agents/
//   .claude/skills/
//   .claude/specsmith/        (the manifest lives here — tampering protection)
//   templates/
//
// Waiver: a sentinel `pipeline/scope-waiver.txt` listing the specific paths
// the user has explicitly authorised. Each line is one path; comments start
// with `#`. The waiver is intentionally noisy to create — it requires the
// human to type out the full path of the file they want to allow, which is
// the right friction level for "I really do want to edit specsmith tooling
// from inside a feature build (or as a specsmith maintainer working in the
// specsmith repo itself)".
//
// Bypass for emergencies: SPECSMITH_SCOPE_OVERRIDE=<non-empty-reason>,
// ignored in hook context (same hardening as the repeat-command guard) —
// won't work for an agent dodging a block.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, sep, relative } from 'node:path';

const PROTECTED_PREFIXES = [
  '.claude/scripts/',
  '.claude/agents/',
  '.claude/skills/',
  '.claude/specsmith/',
  'templates/',
];

const WAIVER_FILE = 'pipeline/scope-waiver.txt';
const OVERRIDE_VAR = 'SPECSMITH_SCOPE_OVERRIDE';
const PROTECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Normalise a path to a project-relative POSIX form so glob-style prefix
// comparison works on both macOS/Linux and Windows.
function toRelPosix(cwd, p) {
  if (!p) return null;
  // Absolute? Make relative to cwd. Already relative? Use as-is.
  const abs = resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (rel.startsWith('..')) return null; // outside the project, not our concern
  return rel.split(sep).join('/');
}

function extractTargetPath(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    return input.file_path || input.notebook_path || null;
  }
  if (tool === 'MultiEdit') {
    // MultiEdit takes a single file_path with multiple edits — same field.
    return input.file_path || null;
  }
  return null;
}

// Returns true if `relPath` falls inside one of PROTECTED_PREFIXES.
function isProtected(relPath) {
  return PROTECTED_PREFIXES.some((prefix) => relPath === prefix.replace(/\/$/, '') || relPath.startsWith(prefix));
}

// Read the waiver file. Each non-comment, non-blank line is one waived path
// (project-relative, POSIX-style). Returns a Set of authorised paths.
function readWaiver(cwd) {
  const path = resolve(cwd, WAIVER_FILE);
  if (!existsSync(path)) return new Set();
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return new Set(); }
  const out = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    out.add(trimmed);
  }
  return out;
}

function deny(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function main() {
  const raw = readStdin();
  if (!raw) process.exit(0);
  const payload = safeJsonParse(raw);
  if (!payload || payload.hook_event_name !== 'PreToolUse') process.exit(0);
  if (!PROTECTED_TOOLS.has(payload.tool_name)) process.exit(0);

  const cwd = payload.cwd || process.cwd();
  const target = extractTargetPath(payload);
  if (!target) process.exit(0);

  const rel = toRelPosix(cwd, target);
  if (!rel || !isProtected(rel)) process.exit(0);

  // Override env-var: only honored outside hook context. Under a hook (which
  // is every Claude Code tool call) it's ignored — same pattern as the
  // repeat-command guard. The override is for manual script invocation by a
  // human operator, not for agents to dodge the block.
  // (`hook_event_name` is set, so we ARE in hook context here. Always ignore.)
  if (process.env[OVERRIDE_VAR]) {
    // We're in hook context (payload.hook_event_name is set), so the override
    // is ignored. Fall through to waiver / deny.
  }

  const waiver = readWaiver(cwd);
  if (waiver.has(rel)) process.exit(0);

  deny(
    `Refusing Edit/Write on \`${rel}\` — this path is specsmith tooling and is ` +
    `out-of-scope for feature builds (Constitution Principle VIII: Scope Discipline).\n` +
    `\n` +
    `If specsmith itself needs to change, that is its own spec in the specsmith ` +
    `repository, not a side effect of this build.\n` +
    `\n` +
    `If you (the human operator) genuinely need to edit this file from inside ` +
    `this project — e.g. you ARE working on specsmith itself, or you need a ` +
    `local patch — create a waiver:\n` +
    `  echo "${rel}" >> ${WAIVER_FILE}\n` +
    `Then re-run the edit. The waiver is per-path, so it only authorises this ` +
    `specific file. Delete the waiver line once the edit is done.\n` +
    `\n` +
    `Agents: do NOT create the waiver yourself. It exists so the user can ` +
    `make a deliberate decision. If you think you need it, say so and stop.`
  );
}

main();
