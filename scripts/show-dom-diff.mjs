#!/usr/bin/env node
// Read `pipeline/feedback/dom-diff.json` (the file `dom-diff.mjs` just
// wrote) and print a human-readable summary to stdout. Pairs with
// `show-pixel-diff.mjs` — same pattern: replace inline JSON parsing with
// a versioned, grep-able helper.
//
// dom-diff is structural / textual (not visual): it normalises dynamic
// content (names, numbers, dates, UUIDs, currency shapes, …) and reports
// what's left as a flat list per route. This script prints those diffs
// in a readable form so the orchestrator can decide which structural
// gaps are real and which are noise.
//
// Usage:
//   node .claude/scripts/show-dom-diff.mjs                   # default path
//   node .claude/scripts/show-dom-diff.mjs --json            # raw JSON passthrough
//   node .claude/scripts/show-dom-diff.mjs --routes-failed   # only failed routes
//   node .claude/scripts/show-dom-diff.mjs <path>            # custom JSON file
//
// Exit code:
//   0 — verdict pass or skip
//   1 — verdict fail
//   2 — JSON missing / unreadable

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH = 'pipeline/feedback/dom-diff.json';

function parseArgs(argv) {
  const out = { path: null, json: false, onlyFailed: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--routes-failed') out.onlyFailed = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: show-dom-diff.mjs [--json] [--routes-failed] [<path>]\n' +
        '\n' +
        'Default path: pipeline/feedback/dom-diff.json\n'
      );
      process.exit(0);
    } else if (!a.startsWith('--')) {
      out.path = a;
    }
  }
  return out;
}

function loadPayload(path) {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    process.stderr.write(
      `dom-diff output not found at ${path}.\n` +
      `Run the evaluator (or \`node .claude/scripts/dom-diff.mjs\`) first.\n`
    );
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    process.stderr.write(`Failed to parse ${path}: ${err.message}\n`);
    process.exit(2);
  }
}

function fmtDifference(d) {
  // d shapes:
  //   { type: 'h1-missing', value: 'Dashboard' }
  //   { type: 'table-column-missing', tableIndex: 1, header: 'TRANSACTIE' }
  //   { type: 'table-missing', tableIndex: 2, columns: ['…'] }
  if ('value' in d) return `${d.type}: ${JSON.stringify(d.value)}`;
  if ('header' in d) return `${d.type} (table-${d.tableIndex}): ${JSON.stringify(d.header)}`;
  if ('columns' in d) return `${d.type} (table-${d.tableIndex}): ${JSON.stringify(d.columns)}`;
  return JSON.stringify(d);
}

function fmtRoute(r) {
  const verdict = r.verdict === 'pass' ? 'PASS' : 'FAIL';
  const count = typeof r.difference_count === 'number' ? r.difference_count : (r.differences?.length ?? 0);
  const max = typeof r.max_differences === 'number' ? r.max_differences : 0;
  const lines = [];
  lines.push(`${verdict}  ${r.route || '?'}  differences=${count} (max=${max})`);
  lines.push(`       design: ${r.design || '?'}`);
  if (Array.isArray(r.differences) && r.differences.length) {
    lines.push(`       differences:`);
    for (const d of r.differences.slice(0, 20)) {
      lines.push(`         - ${fmtDifference(d)}`);
    }
    if (r.differences.length > 20) {
      lines.push(`         (${r.differences.length - 20} more — re-run with --json for full list)`);
    }
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = loadPayload(args.path || DEFAULT_PATH);

  if (args.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.exit(payload.verdict === 'fail' ? 1 : 0);
  }

  const verdict = (payload.verdict || 'unknown').toUpperCase();
  process.stdout.write(`dom-diff verdict: ${verdict}\n`);
  if (payload.reason) process.stdout.write(`  reason: ${payload.reason}\n`);
  if (payload.summary) process.stdout.write(`  ${payload.summary}\n`);

  const routes = Array.isArray(payload.routes) ? payload.routes : [];
  const visible = args.onlyFailed ? routes.filter((r) => r.verdict === 'fail') : routes;

  if (visible.length === 0 && routes.length > 0 && args.onlyFailed) {
    process.stdout.write('\n(no failed routes)\n');
  } else if (visible.length > 0) {
    process.stdout.write('\n');
    for (const r of visible) process.stdout.write(fmtRoute(r) + '\n');
  }

  process.exit(payload.verdict === 'fail' ? 1 : 0);
}

main();
