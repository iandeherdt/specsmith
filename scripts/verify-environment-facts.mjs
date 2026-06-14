#!/usr/bin/env node
// Pre-handoff sanity check on pipeline/environment-facts.md.
//
// Run by:
//   - The developer subagent before it hands off to the evaluator.
//   - The build orchestrator after the developer returns and before
//     it invokes the evaluator (defense in depth).
//
// Catches a class of real bugs we've hit:
//   1. Orphan `next dev` processes left behind by an earlier cycle's
//      developer.
//   2. Wrong DB path recorded in environment-facts.md when two `.db`
//      files exist (Prisma resolves `file:./X` relative to the schema
//      file, NOT the project root).
//   3. Source files exceeding the Constitution's 500-line ceiling
//      (Principle III). Caught pre-handoff so the evaluator doesn't
//      have to flag it post-hoc.
//   4. Prisma migration drift — schema and DB out of sync, often from
//      manual SQL or rows inserted into _prisma_migrations to mask a
//      failed `migrate dev`. Silently masks future drift if not caught.
//
// Exit 0 = all checks pass. Exit 1 = at least one failure (block handoff).

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { checkMigrationDrift } from './check-migration-drift.mjs';

const cwd = process.cwd();
const ROOT = cwd;

let failures = 0;

function pass(msg) {
  process.stdout.write(`  ✓ ${msg}\n`);
}

function fail(msg, detail) {
  failures++;
  process.stdout.write(`  ✗ ${msg}\n`);
  if (detail) {
    for (const line of String(detail).split('\n')) {
      process.stdout.write(`      ${line}\n`);
    }
  }
}

function info(msg) {
  process.stdout.write(`  · ${msg}\n`);
}

// A prominent warning that does NOT block handoff (exit code unchanged).
// Used for "you're leaving value on the table" signals — e.g. an empty facts
// cache — that shouldn't fail cycle 1 or genuinely test-less projects.
function warn(msg, detail) {
  process.stdout.write(`  ⚠ ${msg}\n`);
  if (detail) {
    for (const line of String(detail).split('\n')) {
      process.stdout.write(`      ${line}\n`);
    }
  }
}

// -----------------------------------------------------------------------
// Check 1 — No orphan dev servers
// -----------------------------------------------------------------------
//
// The pattern to match against `pgrep -f` is project-specific (Next.js
// uses `next dev`, Vite uses `vite`, Rails uses `rails server`, etc.).
// We read it from pipeline/environment-facts.md, which the developer
// agent populates on cycle 1 with a "Stop with: pkill -f '<pattern>'"
// line. If env-facts hasn't been written yet (first cycle), we skip
// this check with an info note — there's nothing to validate against.

function readStopPatternFromEnvFacts() {
  const envFactsPath = join(ROOT, 'pipeline', 'environment-facts.md');
  if (!existsSync(envFactsPath)) return null;
  const content = readFileSync(envFactsPath, 'utf8');
  // Match patterns like:
  //   - Stop with: `pkill -f "next dev"`
  //   - Stop the server: pkill -f 'rails server'
  //   - Use `pkill -f vite` to stop
  // Try quoted forms first (preserves multi-word patterns like "rails server"),
  // then unquoted (single token).
  const quotedRe = /pkill\s+-f\s+(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)/;
  const m = content.match(quotedRe);
  if (m) return (m[1] || m[2] || m[3]).trim();
  const unquotedRe = /pkill\s+-f\s+([^\s"'`)\n]+)/;
  const m2 = content.match(unquotedRe);
  return m2 ? m2[1].trim() : null;
}

function checkNoOrphanDevServers() {
  const pattern = readStopPatternFromEnvFacts();
  if (!pattern) {
    info(
      'No `pkill -f "<pattern>"` Stop line in pipeline/environment-facts.md — skipping orphan dev-server check'
    );
    return;
  }

  const orphans = [];
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(pattern)} || true`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const pids = out
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p && Number(p) !== process.pid);
      for (const pid of pids) {
        orphans.push({ pid, pattern });
      }
    }
  } catch {
    // pgrep returned non-zero (no match) — fine.
  }

  if (orphans.length === 0) {
    pass(`No orphan dev servers running (pattern: ${pattern})`);
    return;
  }

  const pids = orphans.map((o) => o.pid).join(' ');
  const detail =
    orphans.map((o) => `PID ${o.pid}`).join(', ') +
    `\n` +
    `Try: pkill -f ${JSON.stringify(pattern)}\n` +
    `Or kill the specific PID(s): kill ${pids}`;
  fail(
    `Orphan dev server(s) detected — must be stopped before handoff`,
    detail
  );
}

// -----------------------------------------------------------------------
// Check 2 — DB path consistency (Prisma sqlite case)
// -----------------------------------------------------------------------

function readEnvVar(envFilePath, varName) {
  if (!existsSync(envFilePath)) return null;
  const content = readFileSync(envFilePath, 'utf8');
  // Match: VARNAME=value or VARNAME="value" or VARNAME='value'
  const re = new RegExp(`^\\s*${varName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s#]*))`, 'm');
  const m = content.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function getPrismaSqliteDbPath() {
  const schemaPath = join(ROOT, 'prisma', 'schema.prisma');
  if (!existsSync(schemaPath)) return null;
  const schema = readFileSync(schemaPath, 'utf8');

  // Look for the datasource block
  const dsMatch = schema.match(/datasource\s+\w+\s*\{([\s\S]*?)\}/);
  if (!dsMatch) return null;
  const dsBody = dsMatch[1];

  const providerMatch = dsBody.match(/provider\s*=\s*"([^"]+)"/);
  const urlMatch = dsBody.match(/url\s*=\s*env\("([^"]+)"\)/);
  if (!providerMatch || !urlMatch) return null;
  if (providerMatch[1] !== 'sqlite') return null;
  const envVarName = urlMatch[1];

  // Try .env.local first, then .env
  const candidates = [join(ROOT, '.env.local'), join(ROOT, '.env')];
  let urlValue = null;
  let envFile = null;
  for (const candidate of candidates) {
    const v = readEnvVar(candidate, envVarName);
    if (v) {
      urlValue = v;
      envFile = candidate;
      break;
    }
  }
  if (!urlValue) return null;
  if (!urlValue.startsWith('file:')) {
    // Remote URL (Turso etc.) — skip.
    return { remote: true, urlValue, envFile };
  }

  // Prisma resolves `file:./X` relative to the schema directory.
  // file:/abs/path is absolute; file:./relative is relative to schema dir.
  const filePart = urlValue.slice('file:'.length);
  let resolvedPath;
  if (filePart.startsWith('/')) {
    resolvedPath = filePart;
  } else {
    resolvedPath = resolve(dirname(schemaPath), filePart);
  }
  return {
    remote: false,
    urlValue,
    envFile,
    schemaDir: dirname(schemaPath),
    resolvedPath,
  };
}

function findDbFiles() {
  const found = [];
  const seen = new Set();
  const dirs = [ROOT, join(ROOT, 'prisma')];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.db')) continue;
      const full = join(dir, entry);
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      if (seen.has(full)) continue;
      seen.add(full);
      found.push(full);
    }
  }
  return found;
}

function checkDbPathConsistency() {
  const prisma = getPrismaSqliteDbPath();
  if (!prisma) {
    info('No Prisma sqlite datasource detected — skipping DB path check');
    return;
  }
  if (prisma.remote) {
    info(`Remote DATABASE_URL (${prisma.urlValue.slice(0, 20)}…) — skipping path check`);
    return;
  }

  const dbFiles = findDbFiles();
  if (dbFiles.length === 0) {
    info('Prisma resolves to a sqlite path but no .db files exist yet — first migration will create it');
    return;
  }

  // The resolvedPath is what the running app uses.
  const liveDb = prisma.resolvedPath;

  // Verify the resolved file actually exists (or could exist).
  const liveDbExists = existsSync(liveDb);
  if (!liveDbExists) {
    info(
      `Prisma resolves DATABASE_URL=${prisma.urlValue} to ${rel(liveDb)} ` +
        `but that file doesn't exist yet — migrations will create it`
    );
  }

  // If only one .db file exists, no ambiguity.
  if (dbFiles.length === 1) {
    if (resolve(dbFiles[0]) === resolve(liveDb)) {
      pass(`Single .db file matches Prisma's resolution: ${rel(liveDb)}`);
    } else {
      fail(
        `The only .db file (${rel(dbFiles[0])}) is not what Prisma uses (${rel(liveDb)})`,
        `DATABASE_URL=${prisma.urlValue} in ${rel(prisma.envFile)}\n` +
          `Prisma resolves relative to the schema dir: ${rel(prisma.schemaDir)}/`
      );
    }
    return;
  }

  // Multiple .db files — env-facts.md must disambiguate.
  const envFactsPath = join(ROOT, 'pipeline', 'environment-facts.md');
  if (!existsSync(envFactsPath)) {
    fail(
      `Multiple .db files exist (${dbFiles.map(rel).join(', ')}) but pipeline/environment-facts.md doesn't exist yet to record which is live`,
      `Prisma resolves to: ${rel(liveDb)}\n` +
        `Record this in pipeline/environment-facts.md before handoff.`
    );
    return;
  }

  const envFacts = readFileSync(envFactsPath, 'utf8');
  const lines = envFacts.split('\n');

  const livePattern = /(live|actual|real|the\s+app\s+uses|prisma\s+uses|running\s+app)/i;
  const liveRel = rel(liveDb);

  // For each line that asserts a "live" db, take the FIRST .db path
  // mentioned on that line as the asserted-live path. This avoids
  // false positives from explanatory parentheticals like
  // "(Prisma resolves file:./dev.db relative to schema dir)".
  const claims = [];
  for (const line of lines) {
    if (!livePattern.test(line)) continue;
    const first = firstDbPathOnLine(line, dbFiles);
    if (first) claims.push({ line: line.trim(), path: first });
  }

  if (claims.length === 0) {
    fail(
      `Multiple .db files exist but pipeline/environment-facts.md doesn't identify which one is live`,
      `Prisma's resolved path: ${liveRel}\n` +
        `Found .db files: ${dbFiles.map(rel).join(', ')}\n` +
        `Add a line like: "The live app database is ${liveRel}".`
    );
    return;
  }

  for (const claim of claims) {
    if (resolve(claim.path) !== resolve(liveDb)) {
      fail(
        `pipeline/environment-facts.md contradicts Prisma's resolution`,
        `Claimed live: ${rel(claim.path)}\n` +
          `Prisma resolves to: ${liveRel}\n` +
          `DATABASE_URL=${prisma.urlValue} from ${rel(prisma.envFile)}\n` +
          `Resolved relative to: ${rel(prisma.schemaDir)}/\n` +
          `Offending line: ${claim.line}`
      );
      return;
    }
  }

  pass(
    `Multiple .db files disambiguated correctly — live: ${liveRel}`
  );
}

/**
 * Find the earliest .db file mention on a line. Returns the absolute path
 * from `candidates`, or null. Distinguishes `prisma/dev.db` from `./dev.db`
 * even though they share the same basename.
 */
function firstDbPathOnLine(line, candidates) {
  let bestIdx = Infinity;
  let bestPath = null;
  for (const candidate of candidates) {
    const r = rel(candidate);
    let idx;
    if (r.includes('/')) {
      idx = line.indexOf(r);
    } else {
      const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?:^|[^/\\w])(?:\\.\\/)?${escaped}\\b`);
      const m = re.exec(line);
      idx = m ? m.index : -1;
    }
    if (idx >= 0 && idx < bestIdx) {
      bestIdx = idx;
      bestPath = candidate;
    }
  }
  return bestPath;
}

function rel(absPath) {
  if (absPath.startsWith(ROOT + '/')) return absPath.slice(ROOT.length + 1);
  if (absPath === ROOT) return '.';
  return absPath;
}

// -----------------------------------------------------------------------
// Check 3 — Prisma migration drift (in ./check-migration-drift.mjs)
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// Check 4 — File size ceiling (Constitution Principle III)
// -----------------------------------------------------------------------
//
// Looks at source files the developer just touched (working tree changes,
// untracked files, and the most recent commit) and fails if any exceed
// 500 lines. Project-agnostic: skips test files, type declarations, and
// generated/vendored output.

const MAX_LINES = 500;

const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|scala|ex|exs)$/i;

const TEST_PATH_RE = /(?:^|\/)(?:__tests__|__mocks__|tests?|e2e|fixtures?)\//;
const TEST_FILE_RE = /\.(?:test|spec)\.[a-z]+$/i;
const GENERATED_RE =
  /(?:^|\/)(?:node_modules|\.next|\.nuxt|\.svelte-kit|dist|build|out|coverage|\.turbo|\.vercel|vendor|\.git)\//;
const GENERATED_FILE_RE = /(?:\.generated\.|\.gen\.|\.d\.ts$)/i;
// Vendored tooling: paths managed by specsmith (`init` / `update`), not by
// feature work. They live in the host repo for convenience but are not the
// project's code — they are read as documentation. Skipping them here is
// the logical extension of Constitution Principle VIII (Scope Discipline):
// if you can't edit these files as part of a feature build, your project's
// quality gates also don't apply to them.
const VENDORED_TOOLING_RE = /^\.claude\/(scripts|agents|skills|specsmith)\//;

function gitChangedFiles() {
  const files = new Set();
  const run = (cmd) => {
    try {
      return execSync(cmd, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        cwd: ROOT,
      });
    } catch {
      return '';
    }
  };

  // Working-tree + staged changes vs HEAD.
  for (const line of run('git diff --name-only HEAD').split('\n')) {
    if (line) files.add(line);
  }
  // Untracked files the developer just created.
  for (const line of run('git ls-files --others --exclude-standard').split('\n')) {
    if (line) files.add(line);
  }
  // Files in the most recent commit (in case the developer committed already).
  for (const line of run('git diff --name-only HEAD~1 HEAD').split('\n')) {
    if (line) files.add(line);
  }
  return [...files];
}

function checkFileSizes() {
  let changed;
  try {
    changed = gitChangedFiles();
  } catch {
    info('Not a git repository (or git unavailable) — skipping file-size check');
    return;
  }

  const candidates = changed.filter((f) => {
    if (!SOURCE_EXT_RE.test(f)) return false;
    if (TEST_PATH_RE.test(f)) return false;
    if (TEST_FILE_RE.test(f)) return false;
    if (GENERATED_RE.test(f)) return false;
    if (GENERATED_FILE_RE.test(f)) return false;
    if (VENDORED_TOOLING_RE.test(f)) return false;
    return true;
  });

  if (candidates.length === 0) {
    info('No changed source files to size-check');
    return;
  }

  const violations = [];
  for (const file of candidates) {
    const full = join(ROOT, file);
    if (!existsSync(full)) continue; // deleted file in the diff
    let content;
    try {
      content = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lineCount = content.split('\n').length;
    if (lineCount > MAX_LINES) {
      violations.push({ file, lineCount });
    }
  }

  if (violations.length === 0) {
    pass(`All ${candidates.length} changed source file(s) within ${MAX_LINES}-line limit`);
    return;
  }

  const detail =
    violations
      .sort((a, b) => b.lineCount - a.lineCount)
      .map((v) => `${v.file}: ${v.lineCount} lines`)
      .join('\n') +
    `\n` +
    `Constitution Principle III caps source files at ${MAX_LINES} lines. ` +
    `Refactor before handoff: extract subcomponents, split helpers into separate modules, or move types to a dedicated file.`;
  fail(
    `${violations.length} source file(s) exceed the ${MAX_LINES}-line limit`,
    detail
  );
}

// -----------------------------------------------------------------------
// Check 5 — Facts cache is actually being populated
// -----------------------------------------------------------------------
//
// The whole point of environment-facts.md is "discover once, cache". A
// recurring failure mode (caught in the 2026-06-14 build trace) is that the
// cache is NEVER written across a whole multi-cycle run, so every cycle
// re-derives the test/typecheck/e2e commands — re-reading playwright.config.ts,
// trying alternate invocation styles, even parsing pipeline/traces/*.jsonl as
// a memory substitute. We can't tell from here whether a cycle "ran tests",
// so this is a loud WARNING, not a failure: it never blocks cycle 1 or a
// genuinely test-less project, but it nags when the cache is empty or has no
// command recorded.

const COMMAND_TOKENS_RE = /\b(vitest|jest|playwright|test:e2e|npm test|tsc|mocha|pytest|go test|cargo test)\b/i;

function checkEnvFactsPopulated() {
  const envFactsPath = join(ROOT, 'pipeline', 'environment-facts.md');
  if (!existsSync(envFactsPath)) {
    warn(
      'pipeline/environment-facts.md does not exist yet',
      'Record the resolved typecheck / test / e2e commands (verbatim, with flags)\n' +
      'the first time each one passes, so the next cycle and the evaluator reuse\n' +
      'them instead of re-deriving. Never parse pipeline/traces/*.jsonl as memory.'
    );
    return;
  }
  let content = '';
  try { content = readFileSync(envFactsPath, 'utf8'); } catch { /* ignore */ }
  if (content.trim() === '') {
    warn(
      'pipeline/environment-facts.md is empty',
      'Nothing has been cached. Record the resolved typecheck / test / e2e\n' +
      'commands (verbatim, with flags) so future cycles skip rediscovery.'
    );
    return;
  }
  if (!COMMAND_TOKENS_RE.test(content)) {
    warn(
      'pipeline/environment-facts.md records no test/typecheck command',
      'No recognizable test runner (vitest/jest/playwright/tsc/test:e2e/…) is\n' +
      'recorded. If this project runs tests, record the exact working command —\n' +
      'including any --project flag or env-var prefix — so it is not re-derived.'
    );
    return;
  }
  pass('environment-facts.md records test/typecheck command(s)');
}

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

process.stdout.write('verify-environment-facts:\n');
checkNoOrphanDevServers();
checkDbPathConsistency();
checkMigrationDrift({ root: ROOT, pass, fail, info });
checkFileSizes();
checkEnvFactsPopulated();

if (failures > 0) {
  process.stdout.write(`\n${failures} check(s) failed — fix before handoff.\n`);
  process.exit(1);
}
process.stdout.write('\nAll checks passed.\n');
process.exit(0);
