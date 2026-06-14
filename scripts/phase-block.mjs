#!/usr/bin/env node
// Extract a single phase block from a tasks.md file.
//
// The /build orchestrator (build SKILL.md, Step 0 / Step 0b) calls this to
// pull just the lines for the phase in scope out of specs/<branch>/tasks.md,
// so it can pass that block to the developer/evaluator subagents instead of
// making them re-read the whole 20-30 KB tasks.md on every cycle.
//
// This replaces an inline awk one-liner that the orchestrator used to retype
// by hand. In practice the model compressed and mangled that awk (dropping the
// `$0` before `~`), which threw a syntax error and silently produced an empty
// block / a count of 0 — indistinguishable from "no work to do". A script
// can't be mangled.
//
// A "phase block" is the `## Phase N: …` heading plus every line under it, up
// to (but not including) the next top-level `## ` heading.
//
// Usage:
//   node .claude/scripts/phase-block.mjs <tasks.md> <phaseNum>
//   node .claude/scripts/phase-block.mjs <tasks.md> <phaseNum> --count
//
// Without --count: prints the phase block to stdout.
// With    --count: prints only the number of unchecked `- [ ]` tasks in it.
//
// Exit codes:
//   0  phase found (block printed, or count printed)
//   1  bad arguments, file unreadable, or phase N not found

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const count = args.includes('--count');
const positional = args.filter((a) => !a.startsWith('--'));
const [tasksPath, phaseNumRaw] = positional;

if (!tasksPath || !phaseNumRaw) {
  process.stderr.write(
    'usage: phase-block.mjs <tasks.md> <phaseNum> [--count]\n'
  );
  process.exit(1);
}

const phaseNum = String(phaseNumRaw).trim();
if (!/^\d+$/.test(phaseNum)) {
  process.stderr.write(`phase-block.mjs: phaseNum must be an integer, got "${phaseNumRaw}"\n`);
  process.exit(1);
}

let text;
try {
  text = readFileSync(tasksPath, 'utf8');
} catch (err) {
  process.stderr.write(`phase-block.mjs: cannot read ${tasksPath}: ${err.message}\n`);
  process.exit(1);
}

// Match `## Phase <n>:` exactly — anchored on `:` so Phase 5 doesn't also
// match Phase 50. Leading `##` only (top-level task headings), tolerant of
// trailing whitespace before the colon.
const headingRe = /^##\s+Phase\s+(\d+)\s*:/;

const lines = text.split('\n');
const block = [];
let inTarget = false;

for (const line of lines) {
  const m = headingRe.exec(line);
  if (m) {
    // Entering a phase heading resets membership: we're inside the target
    // block iff this heading is the phase we want.
    inTarget = m[1] === phaseNum;
    if (inTarget) block.push(line);
    continue;
  }
  // Any other top-level `## ` heading ends the target block.
  if (inTarget && /^##\s/.test(line)) {
    inTarget = false;
    continue;
  }
  if (inTarget) block.push(line);
}

if (block.length === 0) {
  process.stderr.write(`phase-block.mjs: no "## Phase ${phaseNum}:" heading found in ${tasksPath}\n`);
  process.exit(1);
}

if (count) {
  const unchecked = block.filter((l) => /^- \[ \]/.test(l)).length;
  process.stdout.write(`${unchecked}\n`);
} else {
  // Trim trailing blank lines so the block ends cleanly at the last task.
  while (block.length && block[block.length - 1].trim() === '') block.pop();
  process.stdout.write(block.join('\n') + '\n');
}
