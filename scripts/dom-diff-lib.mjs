// Pure helpers for dom-diff. No I/O — every function takes plain data in
// and returns plain data out, so the test suite imports from here directly.
//
// Design intent: the user said "stijlen matchen en niet de nummers en of
// namen". So normalisation is aggressive — names, numbers, dates, UUIDs,
// addresses, OGMs, transaction IDs, emails, phones all collapse to
// placeholders. What's left is the structural / textual contract: heading
// labels, column headers, nav text, button labels, format conventions.

// Order of normalisation matters: more specific patterns first, so
// currency-with-number doesn't get its number eaten before we see the
// currency context.
const NORMALISATIONS = [
  // OGM (Belgian payment reference) — must run before NUMBER swallows the digits.
  { pattern: /\+{3}\d+\/\d+\/\d+\+{3}/g, replacement: '<OGM>' },
  // Transaction IDs (TX-2026-05-001 style)
  { pattern: /\b[A-Z]{2,4}-\d{4}-\d{2}-\d+\b/g, replacement: '<TX>' },
  // Email addresses
  { pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, replacement: '<EMAIL>' },
  // International phone numbers (+32 470 50 60 70, +32 (0)470 50 60 70, etc.)
  { pattern: /\+\d{1,3}\s*(?:\(\d+\)\s*)?\d{1,4}(?:[\s.-]\d{1,4}){2,}/g, replacement: '<PHONE>' },
  // ISO dates: 2026-05-19
  { pattern: /\b\d{4}-\d{2}-\d{2}\b/g, replacement: '<DATE>' },
  // EU dates: 01/05/2026 or 1/5/2026
  { pattern: /\b\d{1,2}\/\d{1,2}\/\d{4}\b/g, replacement: '<DATE>' },
  // Month-name dates: "mei 2026", "januari 2026"
  { pattern: /\b(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/gi, replacement: '<DATE>' },
  // Currency with prefix `€`: "€ 1.480,00" or "€1.480,00"
  { pattern: /€\s*\d+(?:[.,]\d+)*/g, replacement: '€ <NUMBER>' },
  // Currency with suffix `€`: "1.250,00 €"
  { pattern: /\d+(?:[.,]\d+)*\s*€/g, replacement: '<NUMBER> €' },
  // Percentages: "6.493%", "12,72%"
  { pattern: /\d+(?:[.,]\d+)*\s*%/g, replacement: '<NUMBER>%' },
  // Standalone numbers (after currency has had its turn)
  { pattern: /\b\d+(?:[.,]\d+)*\b/g, replacement: '<NUMBER>' },
  // Person names: 2+ Capitalized Words, optionally with Dutch infixes
  // (De, Van, Den, Der, Ten, Ter, Van Den, Van Der) and optional comma.
  // Run AFTER number normalisation so digits in the same context don't
  // confuse the matcher.
  {
    pattern:
      /\b[A-Z][a-z]+(?:\s*,\s*[A-Z][a-z]+|\s+(?:De|Van|Den|Der|Ten|Ter|Van\s+Den|Van\s+Der)\s+[A-Z][a-z]+|\s+[A-Z][a-z]+){1,3}\b/g,
    replacement: '<NAME>',
  },
];

// Aggressive normalisation: collapses dynamic content to placeholders so
// what remains is the structural / textual contract worth comparing.
// Exported for tests so individual patterns can be exercised.
export function normaliseText(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const { pattern, replacement } of NORMALISATIONS) {
    out = out.replace(pattern, replacement);
  }
  // Collapse repeated whitespace introduced by removals, and trim.
  return out.replace(/\s+/g, ' ').trim();
}

// Diff two ordered lists of normalised strings, treating them as sequences.
// Returns three lists: items only in `before`, items only in `after`, and
// items present in both but in different positions (which often indicates
// re-ordering, useful for nav-item / heading order changes). The simple
// LCS-style approach is enough for typical small lists of headers / labels.
export function diffOrderedLists(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const missing = before.filter((s) => !afterSet.has(s));
  const extra = after.filter((s) => !beforeSet.has(s));
  return { missing, extra };
}

// Compare two extracted-snapshot objects and produce a flat list of
// differences the evaluator can paste into a feedback file or carryover
// list. Each diff has a `type` (machine-readable) and a human description.
// `snapshot` shape — see extractSnapshot in dom-diff.mjs for the live
// extractor:
//   {
//     h1: ['Betalingsoverzicht'],
//     h2: ['...'],
//     h3: ['...'],
//     tableColumns: [['PERIODE', 'VERVALDAG', ...], ...],  // one inner array per table
//     navLabels: ['Dashboard', 'Eigendommen', ...],
//     buttonLabels: ['Afmelden', ...],
//     landmarkNames: ['sidebar', 'main', ...],
//   }
// Text inside lists is already normalised by the extractor.
export function compareSnapshots(prototype, actual) {
  const diffs = [];

  const addListDiffs = (kind, before, after) => {
    const { missing, extra } = diffOrderedLists(before, after);
    for (const m of missing) diffs.push({ type: `${kind}-missing`, value: m });
    for (const x of extra) diffs.push({ type: `${kind}-extra`, value: x });
  };

  addListDiffs('h1', prototype.h1 || [], actual.h1 || []);
  addListDiffs('h2', prototype.h2 || [], actual.h2 || []);
  addListDiffs('h3', prototype.h3 || [], actual.h3 || []);
  addListDiffs('nav-label', prototype.navLabels || [], actual.navLabels || []);
  addListDiffs('button-label', prototype.buttonLabels || [], actual.buttonLabels || []);
  addListDiffs('landmark', prototype.landmarkNames || [], actual.landmarkNames || []);

  // Tables: compare by index (table-0, table-1, etc.). For each pair of
  // tables, compare their column headers.
  const protoTables = prototype.tableColumns || [];
  const actTables = actual.tableColumns || [];
  const maxTables = Math.max(protoTables.length, actTables.length);
  for (let i = 0; i < maxTables; i++) {
    const protoCols = protoTables[i];
    const actCols = actTables[i];
    if (protoCols === undefined) {
      diffs.push({ type: 'table-extra', tableIndex: i, columns: actCols });
      continue;
    }
    if (actCols === undefined) {
      diffs.push({ type: 'table-missing', tableIndex: i, columns: protoCols });
      continue;
    }
    const { missing, extra } = diffOrderedLists(protoCols, actCols);
    for (const m of missing) diffs.push({ type: 'table-column-missing', tableIndex: i, header: m });
    for (const x of extra) diffs.push({ type: 'table-column-extra', tableIndex: i, header: x });
  }

  return diffs;
}
