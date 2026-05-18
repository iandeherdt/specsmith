#!/usr/bin/env node
// Smoke test for scripts/guard-scope.mjs.
// Spawns the hook with synthetic PreToolUse payloads and asserts exit codes.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'guard-scope.mjs');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeCwd() {
  const cwd = mkdtempSync(join(tmpdir(), 'scope-test-'));
  mkdirSync(join(cwd, 'pipeline'), { recursive: true });
  return cwd;
}

function runHook(cwd, toolName, filePath) {
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { file_path: filePath },
    cwd,
  };
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    encoding: 'utf8',
  });
}

// ── Case 1: Edit on .claude/scripts/ refused ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'Edit', join(cwd, '.claude', 'scripts', 'pixel-diff.mjs'));
  assert(r.status === 2, 'refuses Edit on .claude/scripts/pixel-diff.mjs');
  assert(/Scope Discipline/.test(r.stderr), 'stderr cites Constitution Principle VIII');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 2: Write on .claude/agents/ refused ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'Write', join(cwd, '.claude', 'agents', 'evaluator.md'));
  assert(r.status === 2, 'refuses Write on .claude/agents/evaluator.md');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 3: Edit on .claude/specsmith/manifest.json refused ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'Edit', join(cwd, '.claude', 'specsmith', 'manifest.json'));
  assert(r.status === 2, 'refuses Edit on .claude/specsmith/manifest.json (tampering protection)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 4: Edit on a normal source file → ALLOW ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'Edit', join(cwd, 'src', 'components', 'Dashboard.tsx'));
  assert(r.status === 0, 'allows Edit on src/components/Dashboard.tsx');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 5: Bash tool call → ALLOW (not a protected tool) ──
{
  const cwd = makeCwd();
  // Bash payload has tool_input.command, not file_path; guard should noop.
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf .claude/scripts/pixel-diff.mjs' },
    cwd,
  };
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert(r.status === 0, 'noops on Bash (scope guard only matches Edit/Write/MultiEdit/NotebookEdit)');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 6: Waiver authorises a specific path ──
{
  const cwd = makeCwd();
  writeFileSync(join(cwd, 'pipeline', 'scope-waiver.txt'), '.claude/scripts/pixel-diff.mjs\n');
  const r = runHook(cwd, 'Edit', join(cwd, '.claude', 'scripts', 'pixel-diff.mjs'));
  assert(r.status === 0, 'waiver allows the listed path');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 7: Waiver does NOT authorise a sibling path ──
{
  const cwd = makeCwd();
  writeFileSync(join(cwd, 'pipeline', 'scope-waiver.txt'), '.claude/scripts/pixel-diff.mjs\n');
  const r = runHook(cwd, 'Edit', join(cwd, '.claude', 'scripts', 'guard-scope.mjs'));
  assert(r.status === 2, 'waiver is per-path; sibling file still refused');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 8: SPECSMITH_SCOPE_OVERRIDE env var IGNORED in hook context ──
{
  const cwd = makeCwd();
  const payload = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(cwd, '.claude', 'scripts', 'pixel-diff.mjs') },
    cwd,
  };
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, SPECSMITH_SCOPE_OVERRIDE: 'agent-trying-to-dodge' },
    encoding: 'utf8',
  });
  assert(r.status === 2, 'SPECSMITH_SCOPE_OVERRIDE does NOT bypass when running as a hook');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 9: Edit on templates/ refused ──
{
  const cwd = makeCwd();
  const r = runHook(cwd, 'Edit', join(cwd, 'templates', 'constitution.md'));
  assert(r.status === 2, 'refuses Edit on templates/constitution.md');
  rmSync(cwd, { recursive: true, force: true });
}

// ── Case 10: No payload on stdin → noop ──
{
  const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
  assert(r.status === 0, 'noops when no stdin payload (manual invocation)');
}

// ── Case 11: Non-PreToolUse payload → noop ──
{
  const cwd = makeCwd();
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, cwd };
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert(r.status === 0, 'noops on non-PreToolUse events');
  rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
