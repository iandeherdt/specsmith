#!/usr/bin/env node
// Structural / textual diff to complement pixel-diff. Where pixel-diff says
// "X% pixels different at coord (a,b)", this says "h1 changed from Foo to
// Bar, table-column TRANSACTIE missing, nav item Afmelden missing". For
// each (designs/<slug>.html, /<route>) pair, extracts a structured snapshot
// (headings, table headers, nav labels, button labels, landmarks),
// normalises dynamic content (names, numbers, dates, UUIDs, addresses,
// OGMs, transaction IDs, emails, phones) to placeholders, then diffs the
// normalised trees and emits a flat list of structural differences.
//
// Pairs with pixel-diff in the evaluator's Step 2b: pixel-diff is for the
// visual layer (drift, plateaus); dom-diff is for the semantic layer
// (missing column, changed h1, format-conventie mismatch). Both signals
// are needed — pixel-diff under-reports semantic mismatches when layout
// is similar but content differs (anti-aliasing detection + threshold).
//
// Config lives in .claude/conventions.json under the `domDiff` key.
// Runtime dep (playwright) is loaded dynamically so projects without it
// get a graceful skip instead of a hard fail.
//
// Usage: dom-diff.mjs [--out <dir>] [--routes <json>] [--storage-state <path>]
// Output: JSON to stdout. Exit 0 on pass / skip, 1 on fail, 2 on error.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { compareSnapshots, normaliseText, resolveRoutes } from './dom-diff-lib.mjs';

const CWD = process.cwd();
const CONVENTIONS_PATH = join(CWD, '.claude', 'conventions.json');
const DEFAULT_OUT_DIR = join(CWD, 'pipeline', 'feedback');
const DEV_URL_FILE = join(CWD, 'pipeline', 'dev-server-url');
const DESIGNS_URL_FILE = join(CWD, 'pipeline', 'designs-server-url');

const DEFAULTS = {
  enabled: true,
  viewport: '1280x800',
  waitFor: null,
  routes: null,
  routeOverrides: null,
  storageStatePath: null,
  // How many diffs trip the route into `verdict: fail`. 0 means any diff
  // fails; useful when the project wants zero structural drift. Most
  // projects can absorb 1-2 nav-label or button-label diffs without it
  // being a fidelity failure (typically i18n micro-edits).
  maxDifferences: 0,
};

function parseArgs(argv) {
  const out = { outDir: DEFAULT_OUT_DIR, routesOverride: null, storageStatePath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = resolve(CWD, argv[++i]);
    else if (a === '--routes') out.routesOverride = JSON.parse(argv[++i]);
    else if (a === '--storage-state') out.storageStatePath = resolve(CWD, argv[++i]);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'dom-diff: structural / textual diff vs designs/<slug>.html prototypes\n' +
        'Usage: dom-diff.mjs [--out <dir>] [--routes <json>] [--storage-state <path>]\n' +
        'Config: .claude/conventions.json -> domDiff block\n'
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
  if (!parsed || typeof parsed.domDiff !== 'object' || parsed.domDiff === null) return null;
  // Stash pixelDiff.routes so we can fall back to it when domDiff.routes
  // is null. The two tools target the same prototype pairs; making the
  // user duplicate the array is footgun-prone.
  return {
    ...DEFAULTS,
    ...parsed.domDiff,
    _pixelDiffRoutes: parsed.pixelDiff && Array.isArray(parsed.pixelDiff.routes)
      ? parsed.pixelDiff.routes
      : null,
  };
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

async function loadDeps() {
  try {
    const { chromium } = await import('playwright');
    return { chromium };
  } catch (err) {
    return { error: err.message };
  }
}

// Run inside the page context (via page.evaluate) to extract a structured
// snapshot. Strings come back raw — normalisation happens on the Node side
// so the regex set stays in one place (dom-diff-lib.mjs).
function extractSnapshotInBrowser() {
  /* eslint-env browser */
  const visibleText = (el) => {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  const collect = (selector) =>
    Array.from(document.querySelectorAll(selector)).map(visibleText).filter(Boolean);

  // Tables: list of [columnHeader, ...] arrays, one per <table>.
  const tableColumns = Array.from(document.querySelectorAll('table')).map((table) => {
    const ths = Array.from(table.querySelectorAll('thead th, thead td'));
    if (ths.length > 0) return ths.map(visibleText).filter(Boolean);
    // Fallback: first row of any <th>s if no <thead>.
    const firstRow = table.querySelector('tr');
    if (!firstRow) return [];
    return Array.from(firstRow.querySelectorAll('th')).map(visibleText).filter(Boolean);
  });

  // Nav labels: anchors and buttons inside <nav> or [role="navigation"]
  const navLabels = Array.from(
    document.querySelectorAll('nav a, nav button, [role="navigation"] a, [role="navigation"] button')
  )
    .map(visibleText)
    .filter(Boolean);

  // Buttons: all interactive <button> and [role="button"] elements that
  // aren't inside nav (nav already covered above).
  const buttonLabels = Array.from(document.querySelectorAll('button, [role="button"]'))
    .filter((el) => !el.closest('nav, [role="navigation"]'))
    .map(visibleText)
    .filter(Boolean);

  // Landmarks: which top-level page regions exist (by ARIA role or HTML5
  // semantic element). The NAME matters more than the count — a missing
  // <aside> for a sidebar is a structural gap.
  const landmarkNames = Array.from(
    document.querySelectorAll('main, aside, header, footer, [role="region"], [role="complementary"]')
  ).map((el) => {
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    return ariaLabel || role || el.tagName.toLowerCase();
  });

  return {
    h1: collect('h1'),
    h2: collect('h2'),
    h3: collect('h3'),
    tableColumns,
    navLabels,
    buttonLabels,
    landmarkNames,
  };
}

function normaliseSnapshot(raw) {
  const normList = (list) => list.map((s) => normaliseText(s));
  return {
    h1: normList(raw.h1 || []),
    h2: normList(raw.h2 || []),
    h3: normList(raw.h3 || []),
    tableColumns: (raw.tableColumns || []).map((cols) => normList(cols)),
    navLabels: normList(raw.navLabels || []),
    buttonLabels: normList(raw.buttonLabels || []),
    landmarkNames: normList(raw.landmarkNames || []),
  };
}

async function snapshotPage(browser, url, viewport, waitFor, storageStatePath) {
  const ctx = await browser.newContext({
    viewport,
    ...(storageStatePath ? { storageState: storageStatePath } : {}),
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(300);
    return await page.evaluate(extractSnapshotInBrowser);
  } finally {
    await ctx.close();
  }
}

async function diffPair(deps, pair, cfg, viewport, browser) {
  const refUrl = pair._refUrl;
  const actUrl = pair._actUrl;
  // Reference is always loaded without auth — see same rationale as
  // pixel-diff.mjs: the designs server has no session.
  const refRaw = await snapshotPage(browser, refUrl, viewport, cfg.waitFor, null);
  const actRaw = await snapshotPage(browser, actUrl, viewport, cfg.waitFor, cfg.storageStatePath);
  const protoNorm = normaliseSnapshot(refRaw);
  const actNorm = normaliseSnapshot(actRaw);
  const differences = compareSnapshots(protoNorm, actNorm);
  const max = cfg.routeOverrides?.[pair.route]?.maxDifferences ?? cfg.maxDifferences;
  const verdict = differences.length > max ? 'fail' : 'pass';
  return {
    design: pair.design,
    route: pair.route,
    verdict,
    difference_count: differences.length,
    max_differences: max,
    differences,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const cfg = loadConfig();
  if (!cfg) {
    emit({ verdict: 'skip', reason: 'no domDiff config in .claude/conventions.json' }, 0);
  }
  if (cfg.enabled === false) {
    emit({ verdict: 'skip', reason: 'domDiff.enabled is false' }, 0);
  }

  const designsDir = join(CWD, 'designs');
  if (!existsSync(designsDir)) {
    emit({ verdict: 'skip', reason: 'no designs/ directory in repo' }, 0);
  }

  if (args.storageStatePath) cfg.storageStatePath = args.storageStatePath;
  if (cfg.storageStatePath && !existsSync(cfg.storageStatePath)) {
    emit({
      verdict: 'skip',
      reason: `storageStatePath does not exist: ${cfg.storageStatePath}.`,
    }, 0);
  }

  const deps = await loadDeps();
  if (deps.error) {
    emit({
      verdict: 'skip',
      reason: 'dom-diff requires playwright. Install: npm i -D playwright && npx playwright install chromium',
      _error: deps.error,
    }, 0);
  }

  const devUrl = readUrlFile(DEV_URL_FILE);
  const designsUrl = readUrlFile(DESIGNS_URL_FILE);
  if (!devUrl || !designsUrl) {
    emit({
      verdict: 'skip',
      reason: `dev server or designs server not running (dev=${devUrl ?? 'missing'}, designs=${designsUrl ?? 'missing'}).`,
    }, 0);
  }

  const resolved = resolveRoutes({
    override: args.routesOverride,
    domDiffRoutes: cfg.routes,
    pixelDiffRoutes: cfg._pixelDiffRoutes,
    discoveredFn: discoverRoutes,
  });
  const routes = resolved.routes;
  if (!routes.length) {
    emit({ verdict: 'skip', reason: 'no design/route pairs to compare' }, 0);
  }

  for (const p of routes) {
    p._refUrl = `${designsUrl.replace(/\/$/, '')}/${basename(p.design)}`;
    p._actUrl = `${devUrl.replace(/\/$/, '')}${p.route.startsWith('/') ? p.route : `/${p.route}`}`;
  }

  const viewport = parseViewport(cfg.viewport);
  process.stderr.write(`dom-diff: ${routes.length} route(s) via ${resolved.source}\n`);
  const browser = await deps.chromium.launch();
  const results = [];
  try {
    let i = 0;
    for (const pair of routes) {
      i++;
      const t0 = Date.now();
      try {
        const res = await diffPair(deps, pair, cfg, viewport, browser);
        results.push(res);
        const ms = Date.now() - t0;
        process.stderr.write(
          `  [${i}/${routes.length}] ${pair.route} → ${res.verdict} (${res.difference_count ?? 0} diffs, ${ms}ms)\n`
        );
      } catch (err) {
        const ms = Date.now() - t0;
        results.push({
          design: pair.design,
          route: pair.route,
          verdict: 'fail',
          error: err.message,
        });
        process.stderr.write(
          `  [${i}/${routes.length}] ${pair.route} → ERROR (${ms}ms): ${err.message}\n`
        );
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.verdict === 'fail');
  const verdict = failed.length === 0 ? 'pass' : 'fail';
  const totalDiffs = results.reduce((sum, r) => sum + (r.difference_count || 0), 0);
  const payload = {
    verdict,
    summary: `${results.length - failed.length}/${results.length} routes passed structural diff (${totalDiffs} total differences after normalisation)`,
    routes_source: resolved.source,
    routes: results,
  };

  try {
    writeFileSync(join(args.outDir, 'dom-diff.json'), JSON.stringify(payload, null, 2));
  } catch {}

  emit(payload, verdict === 'fail' ? 1 : 0);
}

const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('dom-diff.mjs');
  } catch { return false; }
})();
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`dom-diff: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}
