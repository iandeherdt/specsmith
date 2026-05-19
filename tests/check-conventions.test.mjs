#!/usr/bin/env node
// Smoke test for scripts/check-conventions.mjs.
// Spawns the script in temp dirs with synthetic conventions.json + source
// files and asserts exit codes / stderr content.

import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'check-conventions.mjs');

let failures = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; }
  else { console.log(`ok   ${msg}`); }
}

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'conv-test-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
  // Initialise git so the script's `git diff` calls don't error out.
  execSync('git init -q', { cwd: root });
  execSync('git config user.email test@test.test && git config user.name Test', { cwd: root });
  // First commit so HEAD~1 references exist later if needed.
  writeFileSync(join(root, '.gitkeep'), '');
  execSync('git add .gitkeep && git commit -q -m init', { cwd: root });
  return root;
}

function writeConv(root, conv) {
  writeFileSync(join(root, '.claude', 'conventions.json'), JSON.stringify(conv, null, 2));
}

function writeSrc(root, relPath, content) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  // Stage it so `git diff --cached --name-only` picks it up.
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: root });
}

function run(root, env = {}) {
  return spawnSync('node', [SCRIPT], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

// ── Case 1: no conventions.json → exit 0 (zero-config no-op) ──
{
  const root = makeProject();
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{}} />;');
  const r = run(root);
  assert(r.status === 0, 'no conventions.json → exit 0');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 2: empty rules array → exit 0 ──
{
  const root = makeProject();
  writeConv(root, { rules: [] });
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{}} />;');
  const r = run(root);
  assert(r.status === 0, 'empty rules array → exit 0');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 3: inline-style violation in tsx → exit 1, mentions rule + file ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.{tsx,jsx}',
      forbiddenPattern: '\\bstyle=\\{',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{ color: "red" }} />;');
  const r = run(root);
  assert(r.status === 1, 'inline-style triggers exit 1');
  assert(/no-inline-styles/.test(r.stderr), 'stderr names the rule');
  assert(/src\/foo\.tsx:1/.test(r.stderr), 'stderr cites file:line');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 4: same file, but in excludeGlob → exit 0 ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.{tsx,jsx}',
      excludeGlob: '**/*.test.tsx',
      forbiddenPattern: '\\bstyle=\\{',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'src/foo.test.tsx', 'export const x = <div style={{ color: "red" }} />;');
  const r = run(root);
  assert(r.status === 0, 'excludeGlob honored → exit 0');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 5: skipIfMissing (no tailwind.config) → exit 0 ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.{tsx,jsx}',
      forbiddenPattern: '\\bstyle=\\{',
      skipIfMissing: 'tailwind.config.*',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{ color: "red" }} />;');
  const r = run(root);
  assert(r.status === 0, 'skipIfMissing honored when tailwind.config absent → exit 0');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 6: skipIfMissing satisfied (tailwind.config.ts present) → exit 1 ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.{tsx,jsx}',
      forbiddenPattern: '\\bstyle=\\{',
      skipIfMissing: 'tailwind.config.*',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'tailwind.config.ts', 'export default {};');
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{ color: "red" }} />;');
  const r = run(root);
  assert(r.status === 1, 'skipIfMissing satisfied → rule fires');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 7: SVG-extract (>200 chars in non-icon file) → exit 1 ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'svg-extract',
      filesGlob: '**/*.tsx',
      excludeGlob: 'src/components/icons/**',
      forbiddenPattern: '<svg[\\s\\S]{200,}?</svg>',
      message: 'Extract long SVGs.',
    }],
  });
  const longSvg = '<svg width="24" height="24" viewBox="0 0 24 24">' + 'x'.repeat(300) + '</svg>';
  writeSrc(root, 'src/page.tsx', `export const X = () => (${longSvg});`);
  const r = run(root);
  assert(r.status === 1, 'long inline SVG triggers exit 1');
  assert(/svg-extract/.test(r.stderr), 'stderr names svg-extract rule');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 8: same long SVG inside src/components/icons/** → exit 0 ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'svg-extract',
      filesGlob: '**/*.tsx',
      excludeGlob: 'src/components/icons/**',
      forbiddenPattern: '<svg[\\s\\S]{200,}?</svg>',
      message: 'Extract long SVGs.',
    }],
  });
  const longSvg = '<svg width="24" height="24">' + 'x'.repeat(300) + '</svg>';
  writeSrc(root, 'src/components/icons/Foo.tsx', `export const Foo = () => (${longSvg});`);
  const r = run(root);
  assert(r.status === 0, 'icons dir excluded → exit 0');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 9: SPECSMITH_CONVENTIONS=0 bypass ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.tsx',
      forbiddenPattern: '\\bstyle=\\{',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'src/foo.tsx', 'export const x = <div style={{}} />;');
  const r = run(root, { SPECSMITH_CONVENTIONS: '0' });
  assert(r.status === 0, 'SPECSMITH_CONVENTIONS=0 bypasses');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 10: malformed JSON → exit 2 ──
{
  const root = makeProject();
  writeFileSync(join(root, '.claude', 'conventions.json'), '{ not json');
  writeSrc(root, 'src/foo.tsx', 'export const x = <div />;');
  const r = run(root);
  assert(r.status === 2, 'malformed conventions.json → exit 2');
  assert(/not valid JSON/.test(r.stderr), 'stderr explains parse error');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 11: rule with multiple violations in one file ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-styles',
      filesGlob: '**/*.tsx',
      forbiddenPattern: '\\bstyle=\\{',
      message: 'Inline styles forbidden.',
    }],
  });
  writeSrc(root, 'src/foo.tsx', `
export const X = () => <div style={{}}><span style={{ color: 'red' }} /></div>;
`);
  const r = run(root);
  assert(r.status === 1, 'multiple violations in one file → exit 1');
  const matches = (r.stderr.match(/no-inline-styles/g) || []).length;
  assert(matches >= 2, `stderr reports both violations (got ${matches} mentions)`);
  rmSync(root, { recursive: true, force: true });
}

// ── Case 12: i18n rule catches multi-word JSX text + a11y attributes ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'i18n-strings',
      filesGlob: '**/*.{tsx,jsx}',
      forbiddenPattern: ">\\s*([A-Z][a-z]+(?:\\s+[A-Za-z\\-']+){1,})\\s*<|\\b(?:placeholder|aria-label|title|alt|label)=[\"']([A-Z][a-z]+(?:\\s+[A-Za-z\\-']+)+)[\"']",
      message: 'Use i18n.',
    }],
  });
  writeSrc(root, 'src/page.tsx', `
export const X = () => (
  <div>
    <button>Save Changes</button>
    <input placeholder="Enter your name" />
    <code>useState</code>
    <span>{t('greeting')}</span>
  </div>
);
`);
  const r = run(root);
  assert(r.status === 1, 'i18n rule fires on inline strings');
  assert(/Save Changes|Enter your name/.test(r.stderr), 'stderr names the offending strings');
  // Single-word lowercase content must NOT trigger
  assert(!/useState/.test(r.stderr), 'single-word technical content not flagged');
  assert(!/greeting/.test(r.stderr), 'i18n-wrapped content not flagged');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 12b: data-access pattern catches Drizzle, Prisma, and component callsites ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'data-access-pattern',
      filesGlob: '**/*.{ts,tsx}',
      excludeGlob: 'src/lib/**/repository.ts,src/db/**',
      forbiddenPattern: '\\b(db|drizzle)(?:\\.\\w+)?\\.(query|select|insert|update|delete|from|transaction|execute|with)\\b|\\bprisma\\.\\w+\\.(findUnique|findFirst|findMany|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\\b|\\bprisma\\.\\$transaction\\b',
      message: 'No direct DB calls outside repository.',
    }],
  });
  // Drizzle in a component: should fire
  writeSrc(root, 'app/dashboard/page.tsx', "import { db } from '@/db'; const x = await db.select().from(invoices);");
  // Prisma in a component: should fire
  writeSrc(root, 'app/users/page.tsx', "import { prisma } from '@/lib/prisma'; const u = await prisma.user.findUnique({ where: { id } });");
  // db.transaction in a route handler: should fire
  writeSrc(root, 'app/api/foo/route.ts', "await db.transaction(async (tx) => {});");
  // Two-level Drizzle pattern (db.<table>.select) in a component: should fire (v0.20.2 fix)
  writeSrc(root, 'app/properties/page.tsx', "import { db } from '@/lib/db/client'; const rows = await db.properties.select();");
  // Inside repository: should NOT fire (excluded)
  writeSrc(root, 'src/lib/users/repository.ts', "import { db } from '@/db'; export const getUser = (id: string) => db.select().from(users).where(eq(users.id, id));");
  const r = run(root);
  assert(r.status === 1, 'data-access rule fires on Drizzle/Prisma/transaction outside repository');
  assert(/app\/dashboard\/page\.tsx/.test(r.stderr), 'flags Drizzle in component');
  assert(/app\/users\/page\.tsx/.test(r.stderr), 'flags Prisma in component');
  assert(/app\/api\/foo\/route\.ts/.test(r.stderr), 'flags db.transaction in route handler');
  assert(/app\/properties\/page\.tsx/.test(r.stderr), 'flags two-level db.<table>.select in component');
  assert(!/src\/lib\/users\/repository\.ts/.test(r.stderr), 'does NOT flag inside repository');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 13: i18n rule's exclude paths honored ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'i18n-strings',
      filesGlob: '**/*.{tsx,jsx}',
      excludeGlob: '**/*.test.tsx,**/*.stories.tsx,src/components/icons/**',
      forbiddenPattern: ">\\s*([A-Z][a-z]+(?:\\s+[A-Za-z\\-']+){1,})\\s*<",
      message: 'Use i18n.',
    }],
  });
  writeSrc(root, 'src/page.test.tsx', '<div>Save Changes</div>');
  writeSrc(root, 'src/components/icons/Foo.tsx', '<title>Save Changes</title>');
  const r = run(root);
  assert(r.status === 0, 'i18n rule excludes tests + icons dir');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 14: maxLines fires above threshold ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'component-size',
      filesGlob: 'src/components/**/*.tsx',
      maxLines: 50,
      message: 'Too big. Extract.',
    }],
  });
  const big = Array.from({ length: 60 }, (_, i) => `// line ${i + 1}`).join('\n');
  writeSrc(root, 'src/components/Big.tsx', big);
  const r = run(root);
  assert(r.status === 1, 'maxLines fires when file > threshold');
  assert(/component-size/.test(r.stderr), 'stderr names the rule');
  assert(/60 lines, max 50/.test(r.stderr), 'stderr reports actual vs max');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 15: maxLines does NOT fire at or below threshold ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'component-size',
      filesGlob: 'src/components/**/*.tsx',
      maxLines: 50,
      message: 'Too big.',
    }],
  });
  const ok = Array.from({ length: 50 }, (_, i) => `// line ${i + 1}`).join('\n');
  writeSrc(root, 'src/components/Ok.tsx', ok);
  const r = run(root);
  assert(r.status === 0, 'maxLines does not fire at threshold');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 16: rule with maxLines AND no forbiddenPattern is valid ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'size-only',
      filesGlob: '**/*.tsx',
      maxLines: 10,
      message: 'Too big.',
    }],
  });
  writeSrc(root, 'foo.tsx', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n');
  const r = run(root);
  assert(r.status === 1, 'maxLines-only rule fires');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 17: rule with neither maxLines nor forbiddenPattern is rejected ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'broken',
      filesGlob: '**/*.tsx',
      message: 'Nope.',
    }],
  });
  writeSrc(root, 'foo.tsx', 'export const X = <div />;');
  const r = run(root);
  assert(r.status === 0, 'rule with no check is silently skipped (warning to stderr, but no violations)');
  assert(/must specify forbiddenPattern, maxLines, or both/.test(r.stderr), 'stderr explains why the rule was skipped');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 17b: no-inline-helpers-in-pages catches top-level helpers in page.tsx ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'no-inline-helpers-in-pages',
      filesGlob: 'app/**/page.{tsx,jsx},src/app/**/page.{tsx,jsx}',
      excludeGlob: '**/*.test.tsx,**/*.test.jsx,**/*.stories.tsx,**/*.stories.jsx',
      forbiddenPattern: '^(?:function\\s+\\w+\\s*\\(|(?:const|let|var)\\s+\\w+\\s*=\\s*(?:\\([^)]*\\)|\\w+)\\s*=>)',
      message: 'Extract helpers from page.tsx',
    }],
  });
  // FLAG: camelCase factory function returning JSX
  writeSrc(
    root,
    'app/properties/page.tsx',
    'function propertyRow(p) { return <tr><td>{p.id}</td></tr>; }\nexport default function PropertiesPage() { return <table></table>; }\n'
  );
  // FLAG: arrow assignment returning JSX
  writeSrc(
    root,
    'app/contracts/page.tsx',
    'const filterBox = (props) => <div>{props.filter}</div>;\nexport default function ContractsPage() { return <main></main>; }\n'
  );
  // FLAG: PascalCase subcomponent declared inline
  writeSrc(
    root,
    'app/dashboard/page.tsx',
    'function PropertyCard(p) { return <article>{p.name}</article>; }\nexport default function DashboardPage() { return <section></section>; }\n'
  );
  // PASS: only the default export + framework exports
  writeSrc(
    root,
    'app/clean/page.tsx',
    'export const dynamic = "force-dynamic";\nexport async function generateMetadata() { return { title: "x" }; }\nexport default async function CleanPage() {\n  const handleClick = () => alert("ok");\n  const data = await getData();\n  return <main>{data.title}</main>;\n}\n'
  );
  const r = run(root);
  assert(r.status === 1, 'rule fires when pages have inline helpers');
  assert(/app\/properties\/page\.tsx/.test(r.stderr), 'flags camelCase propertyRow factory');
  assert(/app\/contracts\/page\.tsx/.test(r.stderr), 'flags arrow filterBox');
  assert(/app\/dashboard\/page\.tsx/.test(r.stderr), 'flags PascalCase PropertyCard');
  assert(!/app\/clean\/page\.tsx/.test(r.stderr), 'does NOT flag clean page (only default export + framework exports + indented handler)');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 17c: page-size-cap fires only on page files and at a tighter cap ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'page-size-cap',
      filesGlob: 'app/**/page.{tsx,jsx},src/app/**/page.{tsx,jsx}',
      maxLines: 5,
      message: 'page too long',
    }],
  });
  // Way over the cap → fires
  writeSrc(root, 'app/big/page.tsx', Array(10).fill('// line').join('\n') + '\n');
  // Under the cap → does not fire
  writeSrc(root, 'app/small/page.tsx', 'export default function P(){return null;}\n');
  // Non-page TSX → does not fire even if oversize
  writeSrc(root, 'src/components/Card.tsx', Array(20).fill('// line').join('\n') + '\n');
  const r = run(root);
  assert(r.status === 1, 'page-size-cap fires for oversize page');
  assert(/app\/big\/page\.tsx/.test(r.stderr), 'flags oversize page');
  assert(!/app\/small\/page\.tsx/.test(r.stderr), 'does NOT flag small page');
  assert(!/src\/components\/Card\.tsx/.test(r.stderr), 'does NOT flag non-page component even if oversize');
  rmSync(root, { recursive: true, force: true });
}

// ── Case 18: maxLines + forbiddenPattern both fire ──
{
  const root = makeProject();
  writeConv(root, {
    rules: [{
      name: 'big-and-bad',
      filesGlob: '**/*.tsx',
      maxLines: 5,
      forbiddenPattern: '\\bstyle=\\{',
      message: 'Bad.',
    }],
  });
  writeSrc(root, 'foo.tsx', 'a\nb\nc\nd\ne\nf\n<div style={{}} />\n');
  const r = run(root);
  assert(r.status === 1, 'combined rule fires');
  // Should report BOTH the size violation and the regex violation
  const sizeMatch = /lines, max 5/.test(r.stderr);
  const patternMatch = /style=\{/.test(r.stderr);
  assert(sizeMatch && patternMatch, 'both checks fire on the same file');
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
