// Tests the pure normalisation + comparison logic in dom-diff-lib.mjs.
// The browser-driven extraction is not exercised here (would require
// Playwright installed); the regex set + snapshot diff are pure.

import assert from 'node:assert';
import { normaliseText, compareSnapshots, diffOrderedLists, resolveRoutes, resolveStorageState } from '../scripts/dom-diff-lib.mjs';

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

// ─── normaliseText ────────────────────────────────────────────────────

test('normaliseText: empty / non-string → empty', () => {
  assert.strictEqual(normaliseText(''), '');
  assert.strictEqual(normaliseText(undefined), '');
  assert.strictEqual(normaliseText(null), '');
});

test('normaliseText: standalone integers → <NUMBER>', () => {
  assert.strictEqual(normaliseText('BETAALD 27'), 'BETAALD <NUMBER>');
});

test('normaliseText: decimal numbers → <NUMBER>', () => {
  assert.strictEqual(normaliseText('1.250,00'), '<NUMBER>');
});

test('normaliseText: currency prefix preserved as `€ <NUMBER>`', () => {
  assert.strictEqual(normaliseText('€ 1.480,00'), '€ <NUMBER>');
});

test('normaliseText: currency suffix preserved as `<NUMBER> €`', () => {
  assert.strictEqual(normaliseText('1.250,00 €'), '<NUMBER> €');
});

test('normaliseText: prefix vs suffix currency produce DIFFERENT normalised forms', () => {
  // The format mismatch is exactly what we want dom-diff to surface.
  assert.notStrictEqual(normaliseText('€ 1.480,00'), normaliseText('1.250,00 €'));
});

test('normaliseText: EU date → <DATE>', () => {
  assert.strictEqual(normaliseText('01/05/2026'), '<DATE>');
});

test('normaliseText: ISO date → <DATE>', () => {
  assert.strictEqual(normaliseText('2026-05-19'), '<DATE>');
});

test('normaliseText: month-name date → <DATE>', () => {
  assert.strictEqual(normaliseText('mei 2026'), '<DATE>');
  assert.strictEqual(normaliseText('Lopende periode: januari 2026'), 'Lopende periode: <DATE>');
});

test('normaliseText: OGM → <OGM>', () => {
  assert.strictEqual(normaliseText('OGM: +++090/9337/55498+++'), 'OGM: <OGM>');
});

test('normaliseText: transaction ID → <TX>', () => {
  assert.strictEqual(normaliseText('TX-2026-05-001'), '<TX>');
});

test('normaliseText: email → <EMAIL>', () => {
  assert.strictEqual(normaliseText('ian.deherdt@gmail.com'), '<EMAIL>');
});

test('normaliseText: phone → <PHONE>', () => {
  assert.strictEqual(normaliseText('+32 470 50 60 70'), '<PHONE>');
});

test('normaliseText: percentage → <NUMBER>%', () => {
  assert.strictEqual(normaliseText('6.493%'), '<NUMBER>%');
});

test('normaliseText: person name (first last) → <NAME>', () => {
  assert.strictEqual(normaliseText('Thomas De Wilde'), '<NAME>');
});

test('normaliseText: person name (last, first) → <NAME>', () => {
  assert.strictEqual(normaliseText('De Wilde, Thomas'), '<NAME>');
});

test('normaliseText: both name formats produce same normalised form', () => {
  // Names are normalised regardless of format because the format isn't a
  // style decision we want flagged. (Currency format IS — see above.)
  assert.strictEqual(normaliseText('Thomas De Wilde'), normaliseText('De Wilde, Thomas'));
});

test('normaliseText: multi-part normalisation in one string', () => {
  const text = 'Thomas De Wilde — Korte Nieuwstraat 5, Antwerpen — OGM: +++090/9337/55498+++';
  // Expectation: name normalised, OGM normalised, the address keeps its
  // structural shape (street name is a proper noun, may collapse to <NAME>
  // depending on the regex; we accept either form here — what matters is
  // that the OGM and the person name don't show up as data drift).
  const result = normaliseText(text);
  assert.ok(result.includes('<OGM>'), `expected <OGM>, got: ${result}`);
  assert.ok(result.includes('<NAME>'), `expected <NAME>, got: ${result}`);
});

// ─── compareSnapshots ─────────────────────────────────────────────────

test('compareSnapshots: identical → no differences', () => {
  const s = { h1: ['Foo'], h2: [], h3: [], tableColumns: [], navLabels: ['Home'], buttonLabels: [], landmarkNames: [] };
  assert.deepStrictEqual(compareSnapshots(s, s), []);
});

test('compareSnapshots: h1 changed', () => {
  const proto = { h1: ['Betalingsoverzicht'], h2: [], h3: [], tableColumns: [], navLabels: [], buttonLabels: [], landmarkNames: [] };
  const actual = { h1: ['Betalingen'], h2: [], h3: [], tableColumns: [], navLabels: [], buttonLabels: [], landmarkNames: [] };
  const diffs = compareSnapshots(proto, actual);
  assert.deepStrictEqual(diffs, [
    { type: 'h1-missing', value: 'Betalingsoverzicht' },
    { type: 'h1-extra', value: 'Betalingen' },
  ]);
});

test('compareSnapshots: table column missing + extra', () => {
  const proto = {
    h1: [], h2: [], h3: [],
    tableColumns: [['PERIODE', 'VERVALDAG', 'VERWACHT BEDRAG', 'TRANSACTIE', 'STATUS']],
    navLabels: [], buttonLabels: [], landmarkNames: [],
  };
  const actual = {
    h1: [], h2: [], h3: [],
    tableColumns: [['PERIODE', 'VERVALDATUM', 'VERWACHT BEDRAG', 'BETAALD OP', 'STATUS']],
    navLabels: [], buttonLabels: [], landmarkNames: [],
  };
  const diffs = compareSnapshots(proto, actual);
  // VERVALDAG / VERVALDATUM diff + TRANSACTIE / BETAALD OP diff = 4 entries
  assert.strictEqual(diffs.length, 4);
  const types = diffs.map((d) => d.type).sort();
  assert.deepStrictEqual(types, [
    'table-column-extra', 'table-column-extra',
    'table-column-missing', 'table-column-missing',
  ]);
});

test('compareSnapshots: nav label missing', () => {
  const proto = { h1: [], h2: [], h3: [], tableColumns: [], navLabels: ['Dashboard', 'Contracten', 'Afmelden'], buttonLabels: [], landmarkNames: [] };
  const actual = { h1: [], h2: [], h3: [], tableColumns: [], navLabels: ['Dashboard', 'Contracten'], buttonLabels: [], landmarkNames: [] };
  const diffs = compareSnapshots(proto, actual);
  assert.deepStrictEqual(diffs, [{ type: 'nav-label-missing', value: 'Afmelden' }]);
});

test('compareSnapshots: entire table missing', () => {
  const proto = { h1: [], h2: [], h3: [], tableColumns: [['A', 'B']], navLabels: [], buttonLabels: [], landmarkNames: [] };
  const actual = { h1: [], h2: [], h3: [], tableColumns: [], navLabels: [], buttonLabels: [], landmarkNames: [] };
  const diffs = compareSnapshots(proto, actual);
  assert.deepStrictEqual(diffs, [{ type: 'table-missing', tableIndex: 0, columns: ['A', 'B'] }]);
});

test('compareSnapshots: landmark missing → sidebar gap surfaces', () => {
  const proto = { h1: [], h2: [], h3: [], tableColumns: [], navLabels: [], buttonLabels: [], landmarkNames: ['sidebar', 'main'] };
  const actual = { h1: [], h2: [], h3: [], tableColumns: [], navLabels: [], buttonLabels: [], landmarkNames: ['main'] };
  const diffs = compareSnapshots(proto, actual);
  assert.deepStrictEqual(diffs, [{ type: 'landmark-missing', value: 'sidebar' }]);
});

// ─── diffOrderedLists ─────────────────────────────────────────────────

test('diffOrderedLists: identical → empty', () => {
  const r = diffOrderedLists(['a', 'b', 'c'], ['a', 'b', 'c']);
  assert.deepStrictEqual(r, { missing: [], extra: [] });
});

test('diffOrderedLists: extra in after', () => {
  const r = diffOrderedLists(['a', 'b'], ['a', 'b', 'c']);
  assert.deepStrictEqual(r, { missing: [], extra: ['c'] });
});

test('diffOrderedLists: missing in after', () => {
  const r = diffOrderedLists(['a', 'b', 'c'], ['a', 'c']);
  assert.deepStrictEqual(r, { missing: ['b'], extra: [] });
});

// ─── resolveRoutes ────────────────────────────────────────────────────

const PAIRS_DOM = [{ design: 'designs/a.html', route: '/from-dom' }];
const PAIRS_PIXEL = [{ design: 'designs/a.html', route: '/from-pixel' }];
const PAIRS_OVERRIDE = [{ design: 'designs/a.html', route: '/from-override' }];

test('resolveRoutes: override wins over everything', () => {
  const r = resolveRoutes({
    override: PAIRS_OVERRIDE,
    domDiffRoutes: PAIRS_DOM,
    pixelDiffRoutes: PAIRS_PIXEL,
    discoveredFn: () => [],
  });
  assert.strictEqual(r.source, 'override');
  assert.deepStrictEqual(r.routes, PAIRS_OVERRIDE);
});

test('resolveRoutes: domDiff.routes wins over pixelDiff.routes when set', () => {
  const r = resolveRoutes({
    override: null,
    domDiffRoutes: PAIRS_DOM,
    pixelDiffRoutes: PAIRS_PIXEL,
    discoveredFn: () => [],
  });
  assert.strictEqual(r.source, 'domDiff.routes');
  assert.deepStrictEqual(r.routes, PAIRS_DOM);
});

test('resolveRoutes: falls back to pixelDiff.routes when domDiff.routes is null', () => {
  const r = resolveRoutes({
    override: null,
    domDiffRoutes: null,
    pixelDiffRoutes: PAIRS_PIXEL,
    discoveredFn: () => [],
  });
  assert.strictEqual(r.source, 'pixelDiff.routes');
  assert.deepStrictEqual(r.routes, PAIRS_PIXEL);
});

test('resolveRoutes: falls back to pixelDiff.routes when domDiff.routes is empty array', () => {
  const r = resolveRoutes({
    override: null,
    domDiffRoutes: [],
    pixelDiffRoutes: PAIRS_PIXEL,
    discoveredFn: () => [],
  });
  assert.strictEqual(r.source, 'pixelDiff.routes');
});

test('resolveRoutes: discovered when both are null', () => {
  const discovered = [{ design: 'designs/d.html', route: '/d' }];
  const r = resolveRoutes({
    override: null,
    domDiffRoutes: null,
    pixelDiffRoutes: null,
    discoveredFn: () => discovered,
  });
  assert.strictEqual(r.source, 'discovered');
  assert.deepStrictEqual(r.routes, discovered);
});

test('resolveRoutes: discovered returns empty when discoveredFn returns empty', () => {
  const r = resolveRoutes({
    override: null,
    domDiffRoutes: null,
    pixelDiffRoutes: null,
    discoveredFn: () => [],
  });
  assert.strictEqual(r.source, 'discovered');
  assert.deepStrictEqual(r.routes, []);
});

// ─── resolveStorageState ──────────────────────────────────────────────

test('resolveStorageState: domDiff explicit wins', () => {
  const r = resolveStorageState({ domStorage: 'a.json', pixelStorage: 'b.json' });
  assert.strictEqual(r.source, 'domDiff');
  assert.strictEqual(r.path, 'a.json');
});

test('resolveStorageState: falls back to pixelDiff when dom is null', () => {
  const r = resolveStorageState({ domStorage: null, pixelStorage: 'pipeline/auth.json' });
  assert.strictEqual(r.source, 'pixelDiff (fallback)');
  assert.strictEqual(r.path, 'pipeline/auth.json');
});

test('resolveStorageState: falls back to pixelDiff when dom is undefined', () => {
  const r = resolveStorageState({ domStorage: undefined, pixelStorage: 'pipeline/auth.json' });
  assert.strictEqual(r.source, 'pixelDiff (fallback)');
  assert.strictEqual(r.path, 'pipeline/auth.json');
});

test('resolveStorageState: empty string treated like null (falls back)', () => {
  const r = resolveStorageState({ domStorage: '', pixelStorage: 'pipeline/auth.json' });
  assert.strictEqual(r.source, 'pixelDiff (fallback)');
});

test('resolveStorageState: both null → none', () => {
  const r = resolveStorageState({ domStorage: null, pixelStorage: null });
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(r.path, null);
});

test('resolveStorageState: pixel non-string is treated as none', () => {
  const r = resolveStorageState({ domStorage: null, pixelStorage: 42 });
  assert.strictEqual(r.source, 'none');
});

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
