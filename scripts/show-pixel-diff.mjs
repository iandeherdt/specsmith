#!/usr/bin/env node
// Read `pipeline/feedback/pixel-diff.json` (the file `pixel-diff.mjs` just
// wrote) and print a human-readable summary to stdout. Replaces the
// orchestrator pattern of wrapping `JSON.parse(readFileSync(...))` inside
// `node -e '...'` or `python3 -c '...'` to extract one or two fields.
//
// Why this exists: in a /build run, the evaluator subagent runs pixel-diff
// and writes the JSON. The orchestrator then needs to decide: did it pass,
// which routes failed, and where (top regions). Doing that with an inline
// script is verbose, error-prone, and trips the long-inline-script guard.
// Doing it with this helper is one line, grep-able, and prints the fields
// the orchestrator actually needs.
//
// Usage:
//   node .claude/scripts/show-pixel-diff.mjs                   # uses pipeline/feedback/pixel-diff.json
//   node .claude/scripts/show-pixel-diff.mjs --json            # raw JSON passthrough (no formatting)
//   node .claude/scripts/show-pixel-diff.mjs --routes-failed   # only print failed routes
//   node .claude/scripts/show-pixel-diff.mjs <path>            # read a non-default JSON file
//
// Exit code:
//   0 — verdict pass or skip
//   1 — verdict fail
//   2 — JSON missing / unreadable

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_PATH = 'pipeline/feedback/pixel-diff.json';

function parseArgs(argv) {
  const out = { path: null, json: false, onlyFailed: false };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--routes-failed') out.onlyFailed = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'Usage: show-pixel-diff.mjs [--json] [--routes-failed] [<path>]\n' +
        '\n' +
        'Default path: pipeline/feedback/pixel-diff.json\n'
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
      `pixel-diff output not found at ${path}.\n` +
      `Run the evaluator (or \`node .claude/scripts/pixel-diff.mjs\`) first.\n`
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

function fmtRoute(r) {
  const verdict = r.verdict === 'pass' ? 'PASS' : 'FAIL';
  const pct = typeof r.diff_pct === 'number' ? `${r.diff_pct.toFixed(2)}%` : '—';
  const max = typeof r.max_diff_pct === 'number' ? `${r.max_diff_pct.toFixed(2)}%` : '—';
  const src = r.max_diff_pct_source ? ` [${r.max_diff_pct_source}]` : '';
  const stuck = r.stuck ? `  stuck=true (Δ=${r.stuck_delta_pp ?? '?'}pp)` : '';
  const lines = [];
  lines.push(`${verdict}  ${r.route || '?'}  ${pct} vs ${max}${src}${stuck}`);
  lines.push(`       design:   ${r.design || '?'}`);
  if (r.screenshots?.diff) lines.push(`       diff png: ${r.screenshots.diff}`);
  if (Array.isArray(r.regions) && r.regions.length) {
    lines.push(`       top regions (by intensity):`);
    for (const region of r.regions.slice(0, 5)) {
      lines.push(
        `         x=${region.x} y=${region.y} w=${region.w} h=${region.h} ` +
        `intensity=${region.intensity}`
      );
    }
    if (r.regions.length > 5) {
      lines.push(`         (${r.regions.length - 5} more — see ${r.screenshots?.diff ?? 'diff png'})`);
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
  process.stdout.write(`pixel-diff verdict: ${verdict}\n`);
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
