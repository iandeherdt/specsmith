// Tests the pure normalisation + comparison logic in dom-diff-lib.mjs.
// The browser-driven extraction is not exercised here (would require
// Playwright installed); the regex set + snapshot diff are pure.

import assert from 'node:assert';
import { normaliseText, compareSnapshots, diffOrderedLists } from '../scripts/dom-diff-lib.mjs';

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

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
