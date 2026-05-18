#!/usr/bin/env node
// Decide which routes pixel-diff / dom-diff should run against this cycle.
// Output is consumed by the evaluator agent:
//   - "*" (on a single line) → test all routes; pass no --only-route flags
//   - one route per line     → pass each as --only-route
//
// Inputs (all read from disk, no args):
//   - `git diff --name-only <base-ref>` + uncommitted (staged + unstaged)
//     where <base-ref> is the merge-base of the current branch and main.
//     (For a long-running feature branch, this captures every file the
//     branch has touched, not just the latest commit.)
//   - pipeline/feedback/pixel-diff.json (if exists) → failed routes
//   - pipeline/feedback/dom-diff.json (if exists)   → failed routes
//
// Output policy:
//   - Any global / shared-code change in the file diff → "*"
//   - Otherwise, union of (file-derived routes) ∪ (prior-failure routes)
//   - Empty result (no relevant changes, no prior failures) → "*"
//     The empty case happens on a fresh phase with no prior cycle and
//     no app/* edits — fall back to running everything once to
//     establish a baseline.
//
// Usage:
//   ROUTES=$(node .claude/scripts/routes-to-diff.mjs)
//   if [ "$ROUTES" = "*" ]; then
//     node .claude/scripts/pixel-diff.mjs --out pipeline/feedback &
//     node .claude/scripts/dom-diff.mjs   --out pipeline/feedback &
//   else
//     FLAGS=""
//     while IFS= read -r r; do FLAGS="$FLAGS --only-route $r"; done <<< "$ROUTES"
//     node .claude/scripts/pixel-diff.mjs --out pipeline/feedback $FLAGS &
//     node .claude/scripts/dom-diff.mjs   --out pipeline/feedback $FLAGS &
//   fi
//   wait
//
// Flags:
//   --base <ref>    override the merge-base ref (default: main).
//   --verbose       print the reasoning to stderr (which files mapped to
//                   which routes, and which routes carried over from the
//                   prior cycle).
//   --no-prior      skip the prior-failure scan (useful for a clean baseline).

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  mapFilesToRoutes,
  priorFailedRoutes,
  mergeScope,
} from './routes-to-diff-lib.mjs';

const CWD = process.cwd();

function parseArgs(argv) {
  const out = { base: 'main', verbose: false, includePrior: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--verbose') out.verbose = true;
    else if (a === '--no-prior') out.includePrior = false;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'routes-to-diff: emit the list of routes pixel-diff/dom-diff should run\n' +
        'Usage: routes-to-diff.mjs [--base <ref>] [--verbose] [--no-prior]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function runGit(args) {
  try {
    return execSync(`git ${args}`, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return null;
  }
}

function changedFiles(baseRef) {
  // Three sources:
  //   - committed delta against the merge-base of HEAD and baseRef
  //   - staged (index vs HEAD)
  //   - unstaged (working tree vs index)
  // Union deduped.
  const all = new Set();

  // merge-base diff
  const mb = runGit(`merge-base HEAD ${baseRef}`);
  if (mb) {
    const sha = mb.trim();
    const committed = runGit(`diff --name-only ${sha}..HEAD`);
    if (committed) {
      for (const line of committed.split('\n')) if (line) all.add(line);
    }
  } else {
    // No merge-base resolvable (orphan branch, missing remote): fall back
    // to "what's different from HEAD's parent". Last-cycle file scope is
    // usually a superset of what we want anyway.
    const committed = runGit('diff --name-only HEAD~1..HEAD');
    if (committed) for (const line of committed.split('\n')) if (line) all.add(line);
  }

  const staged = runGit('diff --cached --name-only');
  if (staged) for (const line of staged.split('\n')) if (line) all.add(line);

  const unstaged = runGit('diff --name-only');
  if (unstaged) for (const line of unstaged.split('\n')) if (line) all.add(line);

  return Array.from(all);
}

function loadPayload(path) {
  const abs = resolve(CWD, path);
  if (!existsSync(abs)) return null;
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const files = changedFiles(args.base);
  const fileRoutes = mapFilesToRoutes(files);

  let priorRoutes = [];
  if (args.includePrior) {
    const pixel = loadPayload('pipeline/feedback/pixel-diff.json');
    const dom = loadPayload('pipeline/feedback/dom-diff.json');
    priorRoutes = priorFailedRoutes(pixel, dom);
  }

  const merged = mergeScope(fileRoutes, priorRoutes);

  if (args.verbose) {
    process.stderr.write(`routes-to-diff: ${files.length} changed file(s) since merge-base with ${args.base}\n`);
    if (files.length) {
      for (const f of files) process.stderr.write(`  changed: ${f}\n`);
    }
    process.stderr.write(`  file-derived routes: ${fileRoutes.length ? fileRoutes.join(', ') : '(none)'}\n`);
    process.stderr.write(`  prior-failure routes: ${priorRoutes.length ? priorRoutes.join(', ') : '(none)'}\n`);
    process.stderr.write(`  merged scope: ${merged.length ? merged.join(', ') : '* (empty → fall back to test-all)'}\n`);
  }

  // Empty merged scope means: no relevant file changes AND no prior failures.
  // That's the "fresh cycle, never tested anything" case → run everything.
  if (merged.length === 0 || merged.includes('*')) {
    process.stdout.write('*\n');
    process.exit(0);
  }

  for (const r of merged) process.stdout.write(r + '\n');
}

main();
