import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, buildInstallPlan, sha256 } from './utils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

export const MANIFEST_PATH = join('.claude', 'specsmith', 'manifest.json');

/**
 * Generate manifest.json with SHA-256 checksums of installed files.
 * The manifest tracks every file the install plan touched so the updater
 * can later distinguish user-modified files from package upgrades.
 *
 * The constitution at .claude/constitution.md is intentionally NOT tracked
 * here — it is user-owned content seeded once and never overwritten.
 */
export function generateManifest(projectRoot, { dryRun }) {
  const manifestPath = join(projectRoot, MANIFEST_PATH);

  if (dryRun) {
    log.dry(MANIFEST_PATH);
    return;
  }

  const plan = buildInstallPlan();
  const files = {};

  for (const item of plan) {
    const fullPath = join(projectRoot, item.dest);
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath);
      files[item.dest] = sha256(content);
    }
  }

  const manifest = {
    package: pkg.name,
    version: pkg.version,
    installed_at: new Date().toISOString(),
    files,
  };

  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log.success(`${MANIFEST_PATH} (generated with checksums)`);
}
