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
      forbiddenPattern: '\\b(db|drizzle)\\.(query|select|insert|update|delete|from|transaction|execute|with)\\b|\\bprisma\\.\\w+\\.(findUnique|findFirst|findMany|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\\b|\\bprisma\\.\\$transaction\\b',
      message: 'No direct DB calls outside repository.',
    }],
  });
  // Drizzle in a component: should fire
  writeSrc(root, 'app/dashboard/page.tsx', "import { db } from '@/db'; const x = await db.select().from(invoices);");
  // Prisma in a component: should fire
  writeSrc(root, 'app/users/page.tsx', "import { prisma } from '@/lib/prisma'; const u = await prisma.user.findUnique({ where: { id } });");
  // db.transaction in a route handler: should fire
  writeSrc(root, 'app/api/foo/route.ts', "await db.transaction(async (tx) => {});");
  // Inside repository: should NOT fire (excluded)
  writeSrc(root, 'src/lib/users/repository.ts', "import { db } from '@/db'; export const getUser = (id: string) => db.select().from(users).where(eq(users.id, id));");
  const r = run(root);
  assert(r.status === 1, 'data-access rule fires on Drizzle/Prisma/transaction outside repository');
  assert(/app\/dashboard\/page\.tsx/.test(r.stderr), 'flags Drizzle in component');
  assert(/app\/users\/page\.tsx/.test(r.stderr), 'flags Prisma in component');
  assert(/app\/api\/foo\/route\.ts/.test(r.stderr), 'flags db.transaction in route handler');
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

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
