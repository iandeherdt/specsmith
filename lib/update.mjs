// Selective update of installed specsmith files.
//
// Compares three checksums per tracked file:
//   - manifest hash (what we wrote during the last install/update)
//   - on-disk hash  (current file)
//   - package hash  (file shipped with the current version)
//
// Decision matrix (per file):
//   on-disk == package           → already current, skip
//   on-disk == manifest          → unmodified since last install, SAFE to update
//   on-disk != manifest          → user has customised, SKIP and warn
//   file missing on disk         → install fresh
//   file missing from manifest   → ambiguous, skip
//
// Files NEVER touched here:
//   - .claude/constitution.md          (use `init --force` to overwrite)
//   - specs/glossary.md                (ubiquitous language, grown by /grill-me)
//   - pipeline/procedures.md           (user-discovered procedures)
//   - pipeline/environment-facts.md    (cached project facts)
//   - .claude/settings.json, launch.json (merged, not replaced)
//   - CLAUDE.md (appended, not replaced)
//
// After applying updates, writes a fresh manifest:
//   - updated/installed files get the new package hash
//   - skipped (user-modified) files KEEP their old manifest hash so the next
//     run still detects them as user-modified
//   - manifest.version bumps to the current package version

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, PACKAGE_ROOT, buildInstallPlan, sha256 } from './utils.mjs';
import { MANIFEST_PATH } from './manifest.mjs';
import { mergeSettingsJson } from './merge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8')
);

export async function update(projectRoot, { dryRun }) {
  console.log('');
  const banner = `${pkg.name} v${pkg.version} (update)`;
  console.log(banner);
  console.log('='.repeat(banner.length));
  console.log('');
  console.log(`Project: ${projectRoot}`);
  console.log('');

  const manifestPath = join(projectRoot, MANIFEST_PATH);

  if (!existsSync(manifestPath)) {
    log.error(`No manifest found at ${MANIFEST_PATH}.`);
    log.error(`Run \`npx ${pkg.name} init\` first.`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    log.error(`Could not parse manifest: ${err.message}`);
    process.exit(1);
  }

  const installedVersion = manifest.version || 'unknown';
  console.log(`Installed version: ${installedVersion}`);
  console.log(`Package version:   ${pkg.version}`);
  console.log('');

  // Build per-file plan from the current install plan (dynamic — picks up
  // any new skills/agents/scripts shipped since the last install).
  const installPlan = buildInstallPlan();
  const plan = [];

  for (const item of installPlan) {
    const onDiskFull = join(projectRoot, item.dest);
    const sourceFull = join(PACKAGE_ROOT, item.src);
    const manifestHash = manifest.files?.[item.dest] ?? null;

    if (!existsSync(sourceFull)) {
      // The package no longer ships this file (rare; future-proofing).
      plan.push({ path: item.dest, action: 'noop', reason: 'removed-from-package' });
      continue;
    }

    const packageHash = sha256(readFileSync(sourceFull));

    if (!existsSync(onDiskFull)) {
      plan.push({
        path: item.dest,
        action: 'install',
        reason: 'missing-on-disk',
        source: sourceFull,
        newHash: packageHash,
      });
      continue;
    }

    const onDiskHash = sha256(readFileSync(onDiskFull));

    if (onDiskHash === packageHash) {
      plan.push({
        path: item.dest,
        action: 'noop',
        reason: 'already-current',
        newHash: packageHash,
      });
      continue;
    }

    if (manifestHash === null) {
      // We've never tracked this file — be conservative.
      plan.push({ path: item.dest, action: 'skip', reason: 'not-in-manifest' });
      continue;
    }

    if (onDiskHash === manifestHash) {
      plan.push({
        path: item.dest,
        action: 'update',
        reason: 'unmodified-since-install',
        source: sourceFull,
        newHash: packageHash,
      });
    } else {
      plan.push({ path: item.dest, action: 'skip', reason: 'user-modified' });
    }
  }

  // Print the plan as a table.
  const colWidths = { path: 0, action: 0 };
  for (const p of plan) {
    if (p.path.length > colWidths.path) colWidths.path = p.path.length;
    if (p.action.length > colWidths.action) colWidths.action = p.action.length;
  }
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

  console.log('Plan:');
  console.log(
    `  ${pad('file', colWidths.path)}  ${pad('action', colWidths.action)}  reason`
  );
  console.log(
    `  ${'-'.repeat(colWidths.path)}  ${'-'.repeat(colWidths.action)}  ${'-'.repeat(20)}`
  );
  for (const p of plan) {
    console.log(
      `  ${pad(p.path, colWidths.path)}  ${pad(p.action, colWidths.action)}  ${p.reason}`
    );
  }
  console.log('');

  const updates = plan.filter((p) => p.action === 'update');
  const installs = plan.filter((p) => p.action === 'install');
  const userModified = plan.filter(
    (p) => p.action === 'skip' && p.reason === 'user-modified'
  );

  if (dryRun) {
    console.log('Dry run — no files modified.');
    return;
  }

  if (updates.length === 0 && installs.length === 0) {
    console.log('Nothing to update.');
    if (userModified.length > 0) {
      console.log('');
      printUserModifiedHelp(userModified);
    }
    return;
  }

  // Apply.
  console.log('Applying...');
  for (const p of [...updates, ...installs]) {
    const dest = join(projectRoot, p.path);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(p.source, dest);
    log.success(`${p.action}: ${p.path}`);
  }
  console.log('');

  // Build the new manifest. Skipped (user-modified) files keep their OLD
  // manifest hash so the next run still recognises them as user-modified.
  const newFiles = { ...manifest.files };
  for (const p of plan) {
    if (p.action === 'update' || p.action === 'install') {
      newFiles[p.path] = p.newHash;
    } else if (p.action === 'noop' && p.reason === 'already-current') {
      newFiles[p.path] = p.newHash;
    }
    // skip / noop:removed-from-package / noop:not-in-manifest → leave as-is
  }

  const newManifest = {
    package: pkg.name,
    version: pkg.version,
    installed_at: new Date().toISOString(),
    files: newFiles,
  };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + '\n');
  log.success(`${MANIFEST_PATH} (updated)`);
  console.log('');

  // Re-run the settings.json hook merge so new hook entries shipped in the
  // new package version (e.g. v0.15.0's guard-scope.mjs) get wired into
  // existing installs. The merge logic is additive — it never removes the
  // user's existing hook entries. Without this call, new hooks would only
  // arrive via `init --force`, which overwrites every tracked file.
  mergeSettingsJson(projectRoot, { dryRun: false, force: false });
  console.log('');

  if (userModified.length > 0) {
    printUserModifiedHelp(userModified);
  }

  console.log(`Updated to v${pkg.version}.`);
}

function printUserModifiedHelp(userModified) {
  console.log(
    `Locally-modified files were SKIPPED (${userModified.length}). The new`
  );
  console.log(
    'package version may have changes you want — review and reconcile manually:'
  );
  for (const p of userModified) {
    console.log(`  ${p.path}`);
  }
  console.log('');
  console.log(
    `To overwrite local changes with the package version, run \`${pkg.name} init --force\``
  );
  console.log('(this overwrites EVERY tracked file including the constitution).');
  console.log('');
}
