// Tests the pure bucketing logic in pixel-diff.mjs. The browser-driven
// path (Playwright + pixelmatch) is not exercised here — it's covered by
// real-world use in the evaluator agent and would require Playwright to be
// installed in this dev environment to test directly.

import assert from 'node:assert';
import { bucketDiffPixels, annotateStuck, effectiveMaxDiffPct } from '../scripts/pixel-diff.mjs';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// Helper: build a pixelmatch-style RGBA buffer with a red rectangle of
// diff pixels at (rx, ry) of size (rw, rh) on an otherwise-empty canvas.
function withDiffRect(width, height, rx, ry, rw, rh) {
  const buf = Buffer.alloc(width * height * 4);
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      const idx = (y * width + x) * 4;
      buf[idx] = 255;     // R
      buf[idx + 1] = 0;   // G
      buf[idx + 2] = 0;   // B
      buf[idx + 3] = 255; // A — full opacity, real diff pixel
    }
  }
  return buf;
}

test('empty buffer → no regions, no diff pixels', () => {
  const buf = Buffer.alloc(100 * 100 * 4);
  const r = bucketDiffPixels(buf, 100, 100, 50, 10);
  assert.deepStrictEqual(r.regions, []);
  assert.strictEqual(r.totalDiffPixels, 0);
});

test('single cluster → one region with correct coords and intensity', () => {
  const buf = withDiffRect(100, 100, 0, 0, 5, 5);
  const r = bucketDiffPixels(buf, 100, 100, 50, 10);
  assert.strictEqual(r.totalDiffPixels, 25);
  assert.strictEqual(r.regions.length, 1);
  assert.deepStrictEqual(r.regions[0], { x: 0, y: 0, w: 50, h: 50, intensity: 0.01 });
});

test('regions sorted by intensity desc, capped at topN', () => {
  const buf = Buffer.alloc(200 * 200 * 4);
  // High-intensity cluster at (0,0): 100 diff pixels in a 10x10 block
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const idx = (y * 200 + x) * 4;
      buf[idx] = 255; buf[idx + 3] = 255;
    }
  }
  // Lower-intensity cluster at (100,100): 4 diff pixels in a 2x2 block
  for (let y = 100; y < 102; y++) {
    for (let x = 100; x < 102; x++) {
      const idx = (y * 200 + x) * 4;
      buf[idx] = 255; buf[idx + 3] = 255;
    }
  }
  const r = bucketDiffPixels(buf, 200, 200, 50, 1);
  assert.strictEqual(r.regions.length, 1, 'capped at topN');
  assert.strictEqual(r.regions[0].x, 0, 'highest-intensity region first');
  assert.strictEqual(r.regions[0].y, 0);
});

test('grayscale background (r=g=b, alpha<255) is skipped', () => {
  const buf = Buffer.alloc(50 * 50 * 4);
  for (let i = 0; i < 50 * 50; i++) {
    const idx = i * 4;
    buf[idx] = 200; buf[idx + 1] = 200; buf[idx + 2] = 200; buf[idx + 3] = 100;
  }
  const r = bucketDiffPixels(buf, 50, 50, 50, 10);
  assert.strictEqual(r.totalDiffPixels, 0);
  assert.strictEqual(r.regions.length, 0);
});

test('edge cell at non-divisible boundary has truncated dimensions', () => {
  const buf = withDiffRect(75, 75, 50, 50, 25, 25);
  const r = bucketDiffPixels(buf, 75, 75, 50, 10);
  const corner = r.regions.find((c) => c.x === 50 && c.y === 50);
  assert.ok(corner, 'corner cell present');
  assert.strictEqual(corner.w, 25);
  assert.strictEqual(corner.h, 25);
  assert.strictEqual(corner.intensity, 1);
});

test('opaque non-red diff pixel still counted (alpha=255 trumps color)', () => {
  const buf = Buffer.alloc(50 * 50 * 4);
  // Yellow pixel (AA-like color) but full opacity — pixelmatch sometimes
  // writes opaque colored pixels for diffs other than red.
  const idx = (10 * 50 + 10) * 4;
  buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 0; buf[idx + 3] = 255;
  const r = bucketDiffPixels(buf, 50, 50, 50, 10);
  assert.strictEqual(r.totalDiffPixels, 1);
  assert.strictEqual(r.regions.length, 1);
});

// ─── annotateStuck ─────────────────────────────────────────────────────

test('annotateStuck: no prior run → not stuck', () => {
  const current = [{ route: '/a', diff_pct: 6.5 }];
  const r = annotateStuck(current, null);
  assert.strictEqual(r.allStuck, false);
  assert.strictEqual(r.comparedRoutes, 0);
  assert.strictEqual(current[0].stuck, undefined);
});

test('annotateStuck: small delta on all routes → allStuck', () => {
  const current = [
    { route: '/a', diff_pct: 6.50 },
    { route: '/b', diff_pct: 3.61 },
  ];
  const prior = [
    { route: '/a', diff_pct: 6.49 },
    { route: '/b', diff_pct: 3.65 },
  ];
  const r = annotateStuck(current, prior);
  assert.strictEqual(r.allStuck, true);
  assert.strictEqual(r.comparedRoutes, 2);
  assert.strictEqual(r.stuckRoutes, 2);
  assert.strictEqual(current[0].stuck, true);
  assert.strictEqual(current[0].stuck_delta_pp, 0.01);
  assert.strictEqual(current[1].stuck, true);
});

test('annotateStuck: large delta on one route → not allStuck', () => {
  const current = [
    { route: '/a', diff_pct: 6.5 },
    { route: '/b', diff_pct: 1.0 },  // dropped from 5.0
  ];
  const prior = [
    { route: '/a', diff_pct: 6.4 },
    { route: '/b', diff_pct: 5.0 },
  ];
  const r = annotateStuck(current, prior);
  assert.strictEqual(r.allStuck, false);
  assert.strictEqual(r.anyStuck, true);
  assert.strictEqual(current[0].stuck, true);
  assert.strictEqual(current[1].stuck, undefined);
});

test('annotateStuck: route missing from prior is skipped, not stuck', () => {
  const current = [
    { route: '/a', diff_pct: 6.5 },
    { route: '/new', diff_pct: 4.0 },
  ];
  const prior = [{ route: '/a', diff_pct: 6.4 }];
  const r = annotateStuck(current, prior);
  assert.strictEqual(r.comparedRoutes, 1);
  assert.strictEqual(r.allStuck, true);  // every COMPARED route is stuck
  assert.strictEqual(current[1].stuck, undefined);
});

test('annotateStuck: route with error (no diff_pct) is skipped', () => {
  const current = [
    { route: '/a', diff_pct: 6.5 },
    { route: '/broken', verdict: 'fail', error: 'page.goto timeout' },
  ];
  const prior = [
    { route: '/a', diff_pct: 6.4 },
    { route: '/broken', diff_pct: 8.0 },
  ];
  const r = annotateStuck(current, prior);
  assert.strictEqual(r.comparedRoutes, 1);
  assert.strictEqual(r.allStuck, true);
});

// ─── effectiveMaxDiffPct ───────────────────────────────────────────────

test('effectiveMaxDiffPct: no overrides → global threshold', () => {
  const r = effectiveMaxDiffPct({ maxDiffPct: 7.0 }, '/dashboard');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: matching route → override threshold', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/contracts/[id]/indexation': { maxDiffPct: 11.0 } },
  }, '/contracts/[id]/indexation');
  assert.strictEqual(r, 11.0);
});

test('effectiveMaxDiffPct: non-matching route → global threshold', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/contracts/[id]/indexation': { maxDiffPct: 11.0 } },
  }, '/dashboard');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: override entry without maxDiffPct → global', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/dashboard': {} },
  }, '/dashboard');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: null routeOverrides → global', () => {
  const r = effectiveMaxDiffPct({ maxDiffPct: 7.0, routeOverrides: null }, '/dashboard');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: empty cfg → undefined fallthrough', () => {
  const r = effectiveMaxDiffPct({}, '/dashboard');
  assert.strictEqual(r, undefined);
});

// ─── effectiveMaxDiffPct: wildcard / [param] pattern matching (v0.14.0+) ───

test('effectiveMaxDiffPct: [id] pattern matches a resolved UUID', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/contracts/[id]/indexation': { maxDiffPct: 11.0 } },
  }, '/contracts/abc-123-def/indexation');
  assert.strictEqual(r, 11.0);
});

test('effectiveMaxDiffPct: pattern does not match a different suffix', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/contracts/[id]/indexation': { maxDiffPct: 11.0 } },
  }, '/contracts/abc-123/details');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: [param] matches exactly one segment (no slashes)', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/contracts/[id]': { maxDiffPct: 9.0 } },
  }, '/contracts/abc/extra');
  assert.strictEqual(r, 7.0);
});

test('effectiveMaxDiffPct: direct match wins over pattern match', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: {
      '/contracts/[id]/indexation': { maxDiffPct: 11.0 },
      '/contracts/abc-123/indexation': { maxDiffPct: 5.0 },
    },
  }, '/contracts/abc-123/indexation');
  assert.strictEqual(r, 5.0);
});

test('effectiveMaxDiffPct: more specific pattern wins (fewest [params])', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: {
      '/contracts/[id]/[child]': { maxDiffPct: 20.0 },
      '/contracts/[id]/indexation': { maxDiffPct: 11.0 },
    },
  }, '/contracts/abc/indexation');
  assert.strictEqual(r, 11.0);
});

test('effectiveMaxDiffPct: multiple [params] in one key resolve correctly', () => {
  const r = effectiveMaxDiffPct({
    maxDiffPct: 7.0,
    routeOverrides: { '/projects/[projectId]/tasks/[taskId]': { maxDiffPct: 13.0 } },
  }, '/projects/p1/tasks/t1');
  assert.strictEqual(r, 13.0);
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
