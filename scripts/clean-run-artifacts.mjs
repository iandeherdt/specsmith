#!/usr/bin/env node
// Clean per-run scratch space at the start of /build or /design.
//
// The orchestrator (build SKILL.md, design SKILL.md) invokes this as the
// first action in a new run. It wipes the contents of:
//   - pipeline/feedback/  (phase feedback, design feedback, screenshots)
//   - pipeline/traces/    (JSONL traces from the trace hook)
//
// It does NOT touch persistent caches:
//   - pipeline/build-log.md
//   - pipeline/environment-facts.md
//   - pipeline/procedures.md
//   - pipeline/run-state.md (overwritten by the next orchestrator step)
//
// Flags:
//   --dry-run   Print what would be removed without touching the disk.
//
// Exit codes:
//   0  on success (including no-op when dirs are already empty)
//   1  only on unexpected I/O errors

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const TARGETS = [
  join(ROOT, 'pipeline', 'feedback'),
  join(ROOT, 'pipeline', 'traces'),
];

const dryRun = process.argv.includes('--dry-run');

process.stdout.write('clean-run-artifacts:\n');

let totalRemoved = 0;

for (const target of TARGETS) {
  const rel = relative(ROOT, target) || target;
  let entries = [];
  if (existsSync(target)) {
    try {
      entries = readdirSync(target);
    } catch (err) {
      process.stderr.write(`  ✗ Could not read ${rel}: ${err.message}\n`);
      process.exit(1);
    }
  }

  if (entries.length === 0) {
    if (!existsSync(target)) {
      if (dryRun) {
        process.stdout.write(`  · ${rel} does not exist — would create\n`);
      } else {
        mkdirSync(target, { recursive: true });
        process.stdout.write(`  · ${rel} created (was missing)\n`);
      }
    } else {
      process.stdout.write(`  · ${rel} already empty\n`);
    }
    continue;
  }

  if (dryRun) {
    process.stdout.write(
      `  [dry-run] Would remove ${entries.length} item(s) from ${rel}\n`
    );
    totalRemoved += entries.length;
    continue;
  }

  let errored = false;
  for (const entry of entries) {
    const full = join(target, entry);
    try {
      rmSync(full, { recursive: true, force: true });
    } catch (err) {
      process.stderr.write(`  ✗ Could not remove ${rel}/${entry}: ${err.message}\n`);
      errored = true;
    }
  }
  if (errored) process.exit(1);

  process.stdout.write(`  ✓ Removed ${entries.length} item(s) from ${rel}\n`);
  totalRemoved += entries.length;
}

if (dryRun) {
  process.stdout.write(`\nDry run — ${totalRemoved} item(s) would be removed.\n`);
} else if (totalRemoved === 0) {
  process.stdout.write('\nNothing to clean.\n');
} else {
  process.stdout.write(`\nCleaned ${totalRemoved} item(s).\n`);
}
