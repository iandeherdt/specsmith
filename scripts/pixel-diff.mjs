#!/usr/bin/env node
// Visual regression check for design fidelity. For each (design HTML,
// implementation route) pair, renders both in the same headless Chromium
// at the same viewport, diffs the screenshots with pixelmatch, buckets
// the differing pixels into a grid so the model gets "where" not just
// "how much", and writes a structured JSON report.
//
// Designed to be called by the evaluator agent during Step 2b (design
// fidelity). The evaluator already starts the designs server and the
// dev server — this script reads those URLs from the marker files
// (pipeline/designs-server-url, pipeline/dev-server-url) and does not
// start its own.
//
// Config lives in .claude/conventions.json under the `pixelDiff` key.
// Runtime deps (playwright, pixelmatch, pngjs) are loaded dynamically so
// host projects without them get a graceful skip instead of a hard fail.
//
// Usage:
//   node .claude/scripts/pixel-diff.mjs [--out <dir>] [--routes <json>]
//
// Output: JSON to stdout. Exit 0 on pass or skip, 1 on fail, 2 on error.

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const CWD = process.cwd();
const CONVENTIONS_PATH = join(CWD, '.claude', 'conventions.json');
const DEFAULT_OUT_DIR = join(CWD, 'pipeline', 'feedback');
const DEV_URL_FILE = join(CWD, 'pipeline', 'dev-server-url');
const DESIGNS_URL_FILE = join(CWD, 'pipeline', 'designs-server-url');

const DEFAULTS = {
  enabled: true,
  viewport: '1280x800',
  // Default raised from 2.0 → 5.0 in v0.10.0: at 2.0 the diff against a hand-
  // written static-HTML prototype rarely converges for a real app — font
  // hinting, computed greetings/timestamps, and live data introduce ~3-6%
  // irreducible drift that no seed-tuning will remove. 5% surfaces structural
  // gaps without flagging cosmetic ones. Tune for goldenscreenshot-strict
  // regression by setting maxDiffPct lower in .claude/conventions.json.
  maxDiffPct: 5.0,
  threshold: 0.1,
  gridSize: 50,
  topRegions: 10,
  masks: [],
  waitFor: null,
  routes: null,
};

// If the same per-route diff_pct moves less than this many percentage points
// between consecutive runs, the diff is considered "stuck" and the script
// emits a `stuck: true` flag so the caller stops chasing micro-edits.
const STUCK_DELTA_PP = 0.5;

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT_DIR, routesOverride: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = resolve(CWD, argv[++i]);
    else if (a === '--routes') out.routesOverride = JSON.parse(argv[++i]);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'pixel-diff: visual regression check vs designs/<slug>.html prototypes\n' +
        'Usage: pixel-diff.mjs [--out <dir>] [--routes <json>]\n' +
        'Config: .claude/conventions.json -> pixelDiff block\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function loadConfig() {
  if (!existsSync(CONVENTIONS_PATH)) return null;
  let raw;
  try { raw = readFileSync(CONVENTIONS_PATH, 'utf8'); } catch { return null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed.pixelDiff !== 'object' || parsed.pixelDiff === null) return null;
  return { ...DEFAULTS, ...parsed.pixelDiff };
}

function parseViewport(s) {
  const m = String(s).match(/^(\d+)x(\d+)$/);
  if (!m) return { width: 1280, height: 800 };
  return { width: Number(m[1]), height: Number(m[2]) };
}

function discoverRoutes() {
  const designsDir = join(CWD, 'designs');
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

function readUrlFile(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').trim(); } catch { return null; }
}

function emit(payload, exitCode) {
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(exitCode);
}

// Pure function — exported for tests. Compares each current route's diff_pct
// against the prior run's value (matched by route key). Mutates each route
// in `currentRoutes` to add `stuck` and `stuck_delta_pp` fields when its
// diff_pct moved less than `STUCK_DELTA_PP` percentage points. Returns an
// aggregate `{ allStuck, anyStuck, comparedRoutes, stuckRoutes }`. Used to
// flag "the loop has plateaued, stop chasing the diff" to the caller.
export function annotateStuck(currentRoutes, priorRoutes) {
  if (!priorRoutes || !priorRoutes.length) {
    return { allStuck: false, anyStuck: false, comparedRoutes: 0, stuckRoutes: 0 };
  }
  const priorByRoute = new Map(priorRoutes.map((r) => [r.route, r]));
  let stuckCount = 0;
  let compared = 0;
  for (const r of currentRoutes) {
    const prior = priorByRoute.get(r.route);
    if (!prior) continue;
    if (typeof r.diff_pct !== 'number' || typeof prior.diff_pct !== 'number') continue;
    compared++;
    const delta = Math.abs(r.diff_pct - prior.diff_pct);
    r.stuck_delta_pp = Number(delta.toFixed(2));
    if (delta < STUCK_DELTA_PP) {
      r.stuck = true;
      stuckCount++;
    }
  }
  return {
    allStuck: compared > 0 && stuckCount === compared,
    anyStuck: stuckCount > 0,
    comparedRoutes: compared,
    stuckRoutes: stuckCount,
  };
}

function loadPriorRun(outDir) {
  const path = join(outDir, 'pixel-diff.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// Pure function — exported for unit tests. Walks a pixelmatch-style
// RGBA diff buffer where each non-zero pixel is a difference, buckets
// the diff pixels into a grid of `gridSize`-px cells, returns the top
// `topN` cells by intensity (diff-pixel count / cell area).
export function bucketDiffPixels(diffBuf, width, height, gridSize, topN) {
  const cellsX = Math.ceil(width / gridSize);
  const cellsY = Math.ceil(height / gridSize);
  const counts = new Int32Array(cellsX * cellsY);
  let total = 0;
  for (let y = 0; y < height; y++) {
    const cy = Math.floor(y / gridSize);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = diffBuf[idx + 3];
      // pixelmatch writes anti-aliased pixels in yellow (255,255,0) and
      // diff pixels in red (255,0,0). Either non-transparent non-original
      // pixel counts as "different" — alpha is the most reliable signal.
      if (a === 0) continue;
      // Skip pure white (background) — pixelmatch leaves background as
      // semi-transparent grayscale when `diffMask` is false; we use the
      // default where diff pixels have full red and AA pixels are yellow.
      const r = diffBuf[idx];
      const g = diffBuf[idx + 1];
      const b = diffBuf[idx + 2];
      // Background grayscale: r === g === b and alpha < 255.
      if (r === g && g === b && a < 255) continue;
      counts[cy * cellsX + Math.floor(x / gridSize)]++;
      total++;
    }
  }
  const cells = [];
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const c = counts[cy * cellsX + cx];
      if (c === 0) continue;
      const w = Math.min(gridSize, width - cx * gridSize);
      const h = Math.min(gridSize, height - cy * gridSize);
      cells.push({
        x: cx * gridSize,
        y: cy * gridSize,
        w,
        h,
        intensity: Number((c / (w * h)).toFixed(3)),
      });
    }
  }
  cells.sort((a, b) => b.intensity - a.intensity);
  return { regions: cells.slice(0, topN), totalDiffPixels: total };
}

async function loadDeps() {
  try {
    const [{ chromium }, pixelmatchMod, pngjsMod] = await Promise.all([
      import('playwright'),
      import('pixelmatch'),
      import('pngjs'),
    ]);
    return {
      chromium,
      pixelmatch: pixelmatchMod.default ?? pixelmatchMod,
      PNG: pngjsMod.PNG ?? pngjsMod.default?.PNG,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function screenshotPage(browser, url, viewport, masks, waitFor) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Best-effort: wait for network to settle, but don't hang forever.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
    }
    // Small grace period for late-binding fonts / hydration.
    await page.waitForTimeout(300);
    const maskLocators = (masks || []).map((sel) => page.locator(sel));
    const buf = await page.screenshot({
      fullPage: true,
      mask: maskLocators,
      animations: 'disabled',
      caret: 'hide',
    });
    return buf;
  } finally {
    await ctx.close();
  }
}

function cropToCommonHeight(PNG, refBuf, actBuf) {
  const ref = PNG.sync.read(refBuf);
  const act = PNG.sync.read(actBuf);
  const width = Math.min(ref.width, act.width);
  const height = Math.min(ref.height, act.height);
  const cropOne = (img) => {
    if (img.width === width && img.height === height) return img;
    const cropped = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
      const srcStart = y * img.width * 4;
      const dstStart = y * width * 4;
      img.data.copy(cropped.data, dstStart, srcStart, srcStart + width * 4);
    }
    return cropped;
  };
  return { ref: cropOne(ref), act: cropOne(act), width, height };
}

async function diffPair(deps, pair, cfg, viewport, outDir, browser) {
  const refUrl = pair._refUrl;
  const actUrl = pair._actUrl;
  const refBuf = await screenshotPage(browser, refUrl, viewport, cfg.masks, cfg.waitFor);
  const actBuf = await screenshotPage(browser, actUrl, viewport, cfg.masks, cfg.waitFor);
  const { PNG, pixelmatch } = deps;
  const { ref, act, width, height } = cropToCommonHeight(PNG, refBuf, actBuf);
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(ref.data, act.data, diff.data, width, height, {
    threshold: cfg.threshold,
    includeAA: false,
  });
  const diffPct = Number(((diffPixels / (width * height)) * 100).toFixed(3));

  const slug = basename(pair.design).replace(/\.html$/, '') || 'index';
  const paths = {
    reference: join(outDir, `pixel-diff-${slug}-reference.png`),
    actual: join(outDir, `pixel-diff-${slug}-actual.png`),
    diff: join(outDir, `pixel-diff-${slug}-diff.png`),
  };
  writeFileSync(paths.reference, PNG.sync.write(ref));
  writeFileSync(paths.actual, PNG.sync.write(act));
  writeFileSync(paths.diff, PNG.sync.write(diff));

  const { regions } = bucketDiffPixels(diff.data, width, height, cfg.gridSize, cfg.topRegions);
  const verdict = diffPct > cfg.maxDiffPct ? 'fail' : 'pass';

  return {
    design: pair.design,
    route: pair.route,
    verdict,
    diff_pct: diffPct,
    max_diff_pct: cfg.maxDiffPct,
    viewport: `${width}x${height}`,
    regions,
    screenshots: {
      reference: paths.reference.replace(CWD + '/', ''),
      actual: paths.actual.replace(CWD + '/', ''),
      diff: paths.diff.replace(CWD + '/', ''),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  // Read the prior run's payload (if any) BEFORE writing this run's screenshots
  // — once we start writing, the on-disk PNG names collide with whatever the
  // last run left behind, so we have to capture the prior diff_pct first.
  const prior = loadPriorRun(args.outDir);

  const cfg = loadConfig();
  if (!cfg) {
    emit({ verdict: 'skip', reason: 'no pixelDiff config in .claude/conventions.json' }, 0);
  }
  if (cfg.enabled === false) {
    emit({ verdict: 'skip', reason: 'pixelDiff.enabled is false' }, 0);
  }

  const designsDir = join(CWD, 'designs');
  if (!existsSync(designsDir)) {
    emit({ verdict: 'skip', reason: 'no designs/ directory in repo' }, 0);
  }

  const deps = await loadDeps();
  if (deps.error) {
    emit({
      verdict: 'skip',
      reason: 'pixel-diff requires playwright + pixelmatch + pngjs. Install: npm i -D playwright pixelmatch pngjs && npx playwright install chromium',
      _error: deps.error,
    }, 0);
  }

  const devUrl = readUrlFile(DEV_URL_FILE);
  const designsUrl = readUrlFile(DESIGNS_URL_FILE);
  if (!devUrl || !designsUrl) {
    emit({
      verdict: 'skip',
      reason: `dev server or designs server not running (dev=${devUrl ?? 'missing'}, designs=${designsUrl ?? 'missing'}). Start them via .claude/scripts/start-dev-server.mjs before running pixel-diff.`,
    }, 0);
  }

  const routes = args.routesOverride ?? cfg.routes ?? discoverRoutes();
  if (!routes.length) {
    emit({ verdict: 'skip', reason: 'no design/route pairs to compare (no designs/*.html and no explicit routes)' }, 0);
  }

  // Resolve URLs for each pair up front so the loop below is just I/O.
  for (const p of routes) {
    p._refUrl = `${designsUrl.replace(/\/$/, '')}/${basename(p.design)}`;
    p._actUrl = `${devUrl.replace(/\/$/, '')}${p.route.startsWith('/') ? p.route : `/${p.route}`}`;
  }

  const viewport = parseViewport(cfg.viewport);
  const browser = await deps.chromium.launch();
  const results = [];
  try {
    for (const pair of routes) {
      try {
        const res = await diffPair(deps, pair, cfg, viewport, args.outDir, browser);
        results.push(res);
      } catch (err) {
        results.push({
          design: pair.design,
          route: pair.route,
          verdict: 'fail',
          error: err.message,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.verdict === 'fail');
  const verdict = failed.length === 0 ? 'pass' : 'fail';

  // Compare against the prior run (if any) to detect a plateaued diff. The
  // prior payload is on disk from this script's previous invocation; we
  // mutated `results` in-place to add per-route `stuck` / `stuck_delta_pp`.
  const stuckInfo = annotateStuck(results, prior?.routes);

  const payload = {
    verdict,
    summary: `${results.length - failed.length}/${results.length} routes passed (maxDiffPct=${cfg.maxDiffPct}%)`,
    ...(stuckInfo.allStuck
      ? {
          stuck: true,
          stuck_reason:
            `diff_pct has stabilised on every compared route ` +
            `(${stuckInfo.stuckRoutes}/${stuckInfo.comparedRoutes}, all within ${STUCK_DELTA_PP}pp of the prior run). ` +
            `Further micro-edits are unlikely to lower the diff. Options:\n` +
            `  - Raise \`pixelDiff.maxDiffPct\` in .claude/conventions.json if the current floor is acceptable for this view.\n` +
            `  - Add CSS-selector masks to \`pixelDiff.masks\` for the irreducible regions (timestamps, computed greetings, dynamic counts).\n` +
            `  - Accept the current diff_pct as the baseline and move on to other tasks.`,
        }
      : {}),
    routes: results,
  };

  // Persist the payload so the next run can detect plateaus. Independent of
  // whether the caller redirects stdout; the file always lands here.
  try {
    writeFileSync(join(args.outDir, 'pixel-diff.json'), JSON.stringify(payload, null, 2));
  } catch {}

  emit(payload, verdict === 'fail' ? 1 : 0);
}

// Only run main() when invoked as a CLI — leave the module importable for tests.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('pixel-diff.mjs');
  } catch { return false; }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`pixel-diff: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
