// Check 3 — Prisma migration drift
//
// Runs `prisma migrate status`. Fails on:
//   - drift (schema vs. DB out of sync — typically from manual SQL or
//     forged rows in `_prisma_migrations`)
//   - pending migrations not yet applied
// Skips cleanly when:
//   - no Prisma in use
//   - Prisma CLI not installed locally
//   - the DB is unreachable (P1001) or doesn't exist yet (P1003)

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export function checkMigrationDrift({ root, pass, fail, info }) {
  const schemaPath = join(root, 'prisma', 'schema.prisma');
  if (!existsSync(schemaPath)) {
    info('No prisma/schema.prisma — skipping migration drift check');
    return;
  }

  const prismaBin = join(root, 'node_modules', '.bin', 'prisma');
  if (!existsSync(prismaBin)) {
    info('Prisma CLI not installed (node_modules/.bin/prisma missing) — skipping migration drift check');
    return;
  }

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execSync(`${JSON.stringify(prismaBin)} migrate status`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
      timeout: 15_000,
    });
  } catch (err) {
    stdout = ((err.stdout || '') + (err.stderr || '')).toString();
    exitCode = typeof err.status === 'number' ? err.status : 1;
  }

  // Connectivity / first-run conditions are not drift.
  if (/P100[13]/i.test(stdout) || /can'?t reach database server/i.test(stdout)) {
    info('Prisma cannot reach the database — skipping migration drift check');
    return;
  }

  if (exitCode === 0) {
    pass('Prisma migration state is in sync');
    return;
  }

  const lower = stdout.toLowerCase();
  if (lower.includes('drift') || lower.includes('not in sync')) {
    fail(
      'Prisma migration drift detected — DB does not match migration history',
      `${stdout.trim()}\n\n` +
        `Drift commonly arises from manual SQL applied to the DB or rows ` +
        `inserted into _prisma_migrations to mask a failed \`migrate dev\`.\n` +
        `Resolve with \`npx prisma migrate resolve\` or reset the dev DB with ` +
        `\`npx prisma migrate reset\`. Do NOT manually edit _prisma_migrations.`
    );
    return;
  }
  if (lower.includes('have not yet been applied') || lower.includes('pending')) {
    fail(
      'Prisma has pending migrations not yet applied',
      `${stdout.trim()}\n\nApply with \`npx prisma migrate deploy\` (CI) or \`npx prisma migrate dev\` (local).`
    );
    return;
  }

  fail(
    `\`prisma migrate status\` exited ${exitCode}`,
    stdout.trim() || '(no output)'
  );
}
