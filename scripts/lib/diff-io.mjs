// Shared plumbing for the design-diff CLIs (pixel-diff.mjs, dom-diff.mjs).
// Pure helpers shared verbatim by both tools — no diff/scoring logic lives
// here (that stays in pixel-diff-lib.mjs / dom-diff-lib.mjs). Installed to
// .claude/scripts/lib/ and imported as a sibling.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Parse a "WIDTHxHEIGHT" viewport string. Falls back to 1280x800 on anything
// that doesn't match.
export function parseViewport(s) {
  const m = String(s).match(/^(\d+)x(\d+)$/);
  if (!m) return { width: 1280, height: 800 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

// Read a URL marker file (e.g. pipeline/dev-server-url), returning its trimmed
// contents or null if absent/unreadable.
export function readUrlFile(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

// Discover prototype routes from designs/*.html: index.html → /, foo.html → /foo.
// Takes the project cwd so it has no hidden module-global dependency.
export function discoverDesignRoutes(cwd) {
  const designsDir = join(cwd, 'designs');
  if (!existsSync(designsDir)) return [];
  const out = [];
  for (const entry of readdirSync(designsDir)) {
    if (!entry.endsWith('.html')) continue;
    const slug = entry.replace(/\.html$/, '');
    const route = slug === 'index' ? '/' : `/${slug}`;
    out.push({ design: `designs/${entry}`, route });
  }
  return out;
}

// Write a JSON payload to stdout and exit. The diff CLIs communicate results
// to the evaluator via stdout + exit code.
export function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
}
