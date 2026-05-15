#!/usr/bin/env node
// Project convention checker. Runs as a quality gate from the developer
// agent (and as a sanity check from the evaluator) to enforce
// machine-checkable code rules — the kind of thing that doesn't survive
// being prose in agents/developer.md.
//
// Reads .claude/conventions.json from the project root. If absent, exits 0
// (zero-config = nothing to check). If present, runs each rule against
// the files changed in this work cycle (staged + unstaged + last commit
// vs HEAD~1) and exits 1 if any rule fires.
//
// Schema (.claude/conventions.json):
//
// {
//   "rules": [
//     {
//       "name": "no-inline-styles",
//       "filesGlob": "**/*.{tsx,jsx}",
//       "excludeGlob": "src/components/icons/**,**/*.test.tsx",   // optional, comma-separated
//       "forbiddenPattern": "style=\\{(?!\\{)",                    // JS regex source
//       "patternFlags": "mg",                                       // optional, default "mg"
//       "skipIfMissing": "tailwind.config.*",                       // optional glob; rule no-ops if no match
//       "message": "Inline styles forbidden. Use Tailwind utilities."
//     }
//   ]
// }
//
// Bypass: SPECSMITH_CONVENTIONS=0 in the environment.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const CWD = process.cwd();
const CONVENTIONS_PATH = join(CWD, '.claude', 'conventions.json');

function loadConventions() {
  if (!existsSync(CONVENTIONS_PATH)) return null;
  let raw;
  try { raw = readFileSync(CONVENTIONS_PATH, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch (err) {
    process.stderr.write(`check-conventions: ${CONVENTIONS_PATH} is not valid JSON: ${err.message}\n`);
    process.exit(2);
  }
}

// Files changed in this work cycle: staged + unstaged + last commit vs HEAD~1.
// We deliberately cast a wide net — the developer's "what I'm about to hand
// off" includes both work in progress and stuff already committed in this
// cycle. If git fails or there's no HEAD~1, we fall back to "all tracked
// .js/.ts/.tsx/.jsx/.vue/.svelte files" so first-commit cases still work.
function changedFiles() {
  const out = new Set();
  const tryRun = (cmd) => {
    try {
      return execSync(cmd, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return ''; }
  };
  for (const cmd of [
    'git diff --cached --name-only',
    'git diff --name-only',
    'git diff HEAD~1 --name-only',
  ]) {
    for (const f of tryRun(cmd).split('\n')) {
      if (f) out.add(f);
    }
  }
  if (out.size > 0) return [...out];
  // Fallback: walk for source files in known dirs.
  const fallback = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?|vue|svelte)$/.test(entry)) fallback.push(full.slice(CWD.length + 1));
    }
  };
  for (const d of ['src', 'app', 'pages', 'components', 'lib']) walk(join(CWD, d));
  return fallback;
}

// Glob → regex. Supports `*`, `**`, `**/`, `?`, and `{a,b,c}`.
// Anchored: matches whole path.
function globToRegex(glob) {
  let r = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*' && glob[i + 2] === '/') {
      r += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (c === '*' && glob[i + 1] === '*') {
      r += '.*';
      i += 2;
      continue;
    }
    if (c === '*') { r += '[^/]*'; i++; continue; }
    if (c === '?') { r += '[^/]'; i++; continue; }
    if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { r += '\\{'; i++; continue; }
      const opts = glob.slice(i + 1, end).split(',');
      r += '(?:' + opts.map((o) => o.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
      i = end + 1;
      continue;
    }
    if ('.+^${}()|[]\\'.includes(c)) { r += '\\' + c; i++; continue; }
    r += c; i++;
  }
  return new RegExp(`^${r}$`);
}

// Split a comma-separated glob list, respecting `{a,b,c}` alternation
// braces so `**/*.{tsx,jsx}` is one entry, not two.
function splitGlobList(s) {
  const out = [];
  let buf = '';
  let depth = 0;
  for (const c of s) {
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = '';
      continue;
    }
    buf += c;
  }
  const t = buf.trim();
  if (t) out.push(t);
  return out;
}

function matchesAnyGlob(file, globs) {
  if (!globs) return false;
  const list = Array.isArray(globs) ? globs : splitGlobList(globs);
  return list.some((g) => globToRegex(g).test(file));
}

// Check whether at least one file in the project root matches a glob.
// Used for `skipIfMissing` (e.g. "tailwind.config.*") to detect whether
// a rule's prerequisite is present.
function anyFileMatching(glob) {
  const re = globToRegex(glob);
  let found = false;
  const walk = (dir, depth) => {
    if (found || depth > 3) return;
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (found) return;
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      const rel = full.slice(CWD.length + 1);
      if (re.test(rel) || re.test(entry)) { found = true; return; }
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(CWD, 0);
  return found;
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

function checkRule(rule, files) {
  if (rule.skipIfMissing && !anyFileMatching(rule.skipIfMissing)) return [];
  const flags = rule.patternFlags || 'mg';
  let re;
  try { re = new RegExp(rule.forbiddenPattern, flags); } catch (err) {
    process.stderr.write(`check-conventions: rule "${rule.name}" has invalid regex: ${err.message}\n`);
    return [];
  }
  const violations = [];
  for (const file of files) {
    if (!matchesAnyGlob(file, rule.filesGlob)) continue;
    if (matchesAnyGlob(file, rule.excludeGlob)) continue;
    const full = resolve(CWD, file);
    if (!existsSync(full)) continue;
    let content;
    try { content = readFileSync(full, 'utf8'); } catch { continue; }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      violations.push({
        file,
        line: lineOf(content, m.index),
        rule: rule.name,
        message: rule.message,
        excerpt: m[0].slice(0, 120).replace(/\s+/g, ' '),
      });
      if (!flags.includes('g')) break;
    }
  }
  return violations;
}

function main() {
  if (process.env.SPECSMITH_CONVENTIONS === '0') {
    process.stderr.write('check-conventions: SPECSMITH_CONVENTIONS=0 — skipped\n');
    process.exit(0);
  }
  const conventions = loadConventions();
  if (!conventions || !Array.isArray(conventions.rules) || conventions.rules.length === 0) {
    // Zero-config: no .claude/conventions.json, or empty rules array.
    process.exit(0);
  }
  const files = changedFiles();
  if (files.length === 0) process.exit(0);

  const violations = [];
  for (const rule of conventions.rules) {
    if (!rule.name || !rule.filesGlob || !rule.forbiddenPattern || !rule.message) {
      process.stderr.write(`check-conventions: rule is missing required field (name/filesGlob/forbiddenPattern/message): ${JSON.stringify(rule)}\n`);
      continue;
    }
    violations.push(...checkRule(rule, files));
  }

  if (violations.length === 0) {
    process.stdout.write(`check-conventions: ${files.length} changed file(s), all rules pass.\n`);
    process.exit(0);
  }

  process.stderr.write(`check-conventions: ${violations.length} violation(s) across ${new Set(violations.map((v) => v.file)).size} file(s).\n\n`);
  for (const v of violations) {
    process.stderr.write(`  ${v.file}:${v.line}  [${v.rule}]\n    ${v.message}\n    > ${v.excerpt}\n\n`);
  }
  process.stderr.write(`Bypass with SPECSMITH_CONVENTIONS=0 if a rule needs tuning. Otherwise, fix the violations and re-run.\n`);
  process.exit(1);
}

main();
