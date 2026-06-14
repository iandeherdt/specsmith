// `specsmith verify` — three-way hash comparison: file on disk vs the SHA
// recorded in manifest.json vs the SHA of the same file in the installed
// npm package. Reports drift without changing anything.
//
// Catches three classes of drift that v0.14.0 and earlier could not:
//   1. Standard "user-modified" (disk ≠ manifest, manifest == package).
//   2. **Manifest tampering** — an agent edited a tooling file AND rewrote
//      the manifest entry to hide it (disk == manifest, both ≠ package).
//      Otherwise `update` would treat the corrupted state as "unmodified
//      since install" and silently accept it as the new baseline.
//   3. Stale manifest (disk == package, manifest ≠ package) — usually
//      harmless but worth surfacing.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, buildInstallPlan, PACKAGE_ROOT, sha256 } from './utils.mjs';
import { MANIFEST_PATH } from './manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

function hashFile(path) {
  if (!existsSync(path)) return null;
  try { return sha256(readFileSync(path)); } catch { return null; }
}

function classify(disk, manifest, pkgHash) {
  if (disk === null) return { status: 'missing-on-disk', concern: 'high' };
  if (disk === pkgHash && manifest === pkgHash) return { status: 'clean', concern: 'none' };
  if (disk === pkgHash && manifest !== pkgHash) return { status: 'stale-manifest', concern: 'low' };
  if (disk !== pkgHash && manifest === pkgHash) return { status: 'user-modified', concern: 'low' };
  if (disk !== pkgHash && manifest === disk && manifest !== pkgHash) {
    return { status: 'manifest-tampered', concern: 'high' };
  }
  if (disk !== pkgHash && manifest !== pkgHash && manifest !== disk) {
    return { status: 'all-three-differ', concern: 'medium' };
  }
  return { status: 'unknown', concern: 'medium' };
}

const STATUS_LABEL = {
  'clean': 'OK',
  'stale-manifest': 'STALE',
  'user-modified': 'MODIFIED',
  'manifest-tampered': 'TAMPERED',
  'all-three-differ': 'DRIFTED',
  'missing-on-disk': 'MISSING',
  'unknown': '?',
};

const STATUS_REASON = {
  'clean': 'disk matches package and manifest',
  'stale-manifest': 'disk matches package but manifest hash is stale (harmless; next install/update will refresh)',
  'user-modified': 'disk differs from package; manifest is intact — normal user edit',
  'manifest-tampered': 'disk differs from package AND manifest was rewritten to match disk — `update` would mistake this for "unmodified since install" and overwrite without warning. Likely a subagent edited the file and updated the manifest entry to hide the change. Investigate and restore from package.',
  'all-three-differ': 'disk, manifest, and package all have different hashes — user-modified after a prior version upgrade, or partial install. Manually reconcile.',
  'missing-on-disk': 'package has this file but it is not on disk — `update` will re-install.',
};

export async function verify(projectRoot) {
  const manifestPath = join(projectRoot, MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    log.error('No .claude/specsmith/manifest.json — this project does not look like a specsmith install.');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestFiles = manifest.files || {};

  process.stdout.write(`\nVerifying specsmith integrity in ${projectRoot}\n`);
  process.stdout.write(`Installed manifest version: ${manifest.version}\n`);
  process.stdout.write(`Package version (this CLI): ${pkg.version}\n`);
  if (manifest.version !== pkg.version) {
    process.stdout.write(`Note: a version mismatch is expected if you have not run \`specsmith update\` since upgrading the CLI.\n`);
  }
  process.stdout.write('\n');

  const plan = buildInstallPlan();
  const rows = [];
  let highConcern = 0;
  let mediumConcern = 0;

  for (const item of plan) {
    const diskPath = join(projectRoot, item.dest);
    const pkgPath = join(PACKAGE_ROOT, item.src);
    const disk = hashFile(diskPath);
    const pkgHash = hashFile(pkgPath);
    const manifestHash = manifestFiles[item.dest] ?? null;

    const { status, concern } = classify(disk, manifestHash, pkgHash);
    if (concern === 'high') highConcern++;
    else if (concern === 'medium') mediumConcern++;

    if (status !== 'clean') {
      rows.push({ file: item.dest, status, concern });
    }
  }

  if (rows.length === 0) {
    log.success('All tracked files match the package and the manifest. No drift.');
    process.exit(0);
  }

  // Group by concern level for readability.
  const order = { 'high': 0, 'medium': 1, 'low': 2 };
  rows.sort((a, b) => order[a.concern] - order[b.concern]);

  const colW = Math.max(...rows.map((r) => r.file.length), 30);
  for (const row of rows) {
    const label = STATUS_LABEL[row.status];
    const concernTag = row.concern === 'high' ? ' ⚠' : row.concern === 'medium' ? ' ·' : '';
    process.stdout.write(`  ${row.file.padEnd(colW)}  ${label}${concernTag}\n`);
    process.stdout.write(`  ${' '.repeat(colW)}    ${STATUS_REASON[row.status]}\n\n`);
  }

  process.stdout.write('\nLegend: TAMPERED / MISSING are high concern; DRIFTED is medium; MODIFIED / STALE are low.\n');
  if (highConcern > 0) {
    process.stdout.write(`\n⚠ ${highConcern} high-concern entry(ies). Restore from package: \`npm view specsmith@${pkg.version} dist.tarball | xargs curl -sL | tar -xzO package/<file>\` and overwrite the on-disk copy. Then run \`specsmith update\` to refresh the manifest.\n`);
    process.exit(1);
  }
  process.exit(0);
}
