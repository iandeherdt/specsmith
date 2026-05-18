// Pure helpers for pixel-diff. Extracted from pixel-diff.mjs so the main
// CLI script stays under the constitution's 500-line cap. No I/O here:
// every function in this file takes plain data in and returns plain data
// out, which is also why the test suite imports from this module rather
// than from the CLI script.

// If the same per-route diff_pct moves less than this many percentage points
// between consecutive runs, the diff is considered "stuck" and the script
// emits a `stuck: true` flag so the caller stops chasing micro-edits.
export const STUCK_DELTA_PP = 0.5;

// Compares each current route's diff_pct against the prior run's value
// (matched by route key). Mutates each route in `currentRoutes` to add
// `stuck` and `stuck_delta_pp` fields when its diff_pct moved less than
// STUCK_DELTA_PP percentage points. Returns an aggregate
// `{ allStuck, anyStuck, comparedRoutes, stuckRoutes }`. Used to flag
// "the loop has plateaued, stop chasing the diff" to the caller.
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

// Match a routeOverrides key with `[param]` placeholders against a concrete
// route. Each `[anything]` segment consumes exactly one path segment (no
// slashes). Returns false for keys without any `[...]` (those should be
// tried as direct-match by the caller, which is more efficient).
function routeKeyMatches(pattern, route) {
  if (!pattern.includes('[')) return false;
  const escaped = pattern.replace(/[.+*?^${}()|\\]/g, '\\$&');
  const regexSource = '^' + escaped.replace(/\[[^\]]+\]/g, '[^/]+') + '$';
  return new RegExp(regexSource).test(route);
}

// Resolves the per-route maxDiffPct, falling back to the global cfg.maxDiffPct
// when no override is defined. Lets a project tighten the global threshold
// for the routes that converge cleanly while accepting a higher floor on
// one or two structurally noisy pages — instead of loosening the global for
// everyone.
//
// Override key matching:
// 1. Direct string match wins over any pattern (most specific).
// 2. Pattern match: keys containing `[name]` segments behave as wildcards;
//    each `[name]` consumes one path segment. Among multiple matching
//    patterns, the one with the FEWEST `[name]` segments wins (most literal
//    segments = most specific); ties broken alphabetically.
// This means a wrapper that resolves `/contracts/[id]/indexation` to a
// concrete UUID at runtime no longer needs to mutate the conventions.json
// override key — the parametric form matches the resolved route directly.
export function effectiveMaxDiffPct(cfg, routeKey) {
  const overrides = cfg?.routeOverrides;
  if (!overrides) return cfg?.maxDiffPct;

  const direct = overrides[routeKey];
  if (direct && typeof direct.maxDiffPct === 'number') return direct.maxDiffPct;

  let best = null;
  for (const key of Object.keys(overrides)) {
    if (!key.includes('[')) continue;
    const v = overrides[key];
    if (!v || typeof v.maxDiffPct !== 'number') continue;
    if (!routeKeyMatches(key, routeKey)) continue;
    const params = (key.match(/\[[^\]]+\]/g) || []).length;
    if (!best || params < best.params || (params === best.params && key.localeCompare(best.key) < 0)) {
      best = { key, params, maxDiffPct: v.maxDiffPct };
    }
  }
  if (best) return best.maxDiffPct;

  return cfg.maxDiffPct;
}

// Walks a pixelmatch-style RGBA diff buffer where each non-zero pixel is a
// difference, buckets the diff pixels into a grid of `gridSize`-px cells,
// returns the top `topN` cells by intensity (diff-pixel count / cell area).
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
      if (a === 0) continue;
      const r = diffBuf[idx];
      const g = diffBuf[idx + 1];
      const b = diffBuf[idx + 2];
      // pixelmatch background is grayscale with alpha < 255; diff pixels are
      // red (255,0,0) and AA pixels (filtered upstream with includeAA:false)
      // would be yellow. Skip grayscale background.
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
