import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { log } from './utils.mjs';

/**
 * Merge launch.json configurations.
 * If target doesn't exist, copy wholesale.
 * If target exists, add missing configurations by name.
 */
export function mergeLaunchJson(projectRoot, srcPath, { dryRun, force }) {
  const dest = join(projectRoot, '.claude', 'launch.json');

  if (dryRun) {
    log.dry('.claude/launch.json');
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });

  if (!existsSync(dest)) {
    writeFileSync(dest, readFileSync(srcPath, 'utf8'));
    log.success('.claude/launch.json (created)');
    return;
  }

  let target;
  try {
    target = JSON.parse(readFileSync(dest, 'utf8'));
  } catch {
    log.error('.claude/launch.json exists but contains invalid JSON — skipping merge');
    return;
  }

  let source;
  try {
    source = JSON.parse(readFileSync(srcPath, 'utf8'));
  } catch {
    log.error('Package launch.json is invalid — this is a bug');
    return;
  }

  if (!target.configurations) target.configurations = [];
  const existingNames = new Set(target.configurations.map(c => c.name));

  let added = 0;
  for (const config of source.configurations || []) {
    if (!existingNames.has(config.name)) {
      target.configurations.push(config);
      added++;
    } else if (force) {
      const idx = target.configurations.findIndex(c => c.name === config.name);
      target.configurations[idx] = config;
      added++;
    }
  }

  if (added > 0) {
    writeFileSync(dest, JSON.stringify(target, null, 2) + '\n');
    log.success(`.claude/launch.json (${added} configuration(s) added)`);
  } else {
    log.skip('.claude/launch.json (all configurations already present)');
  }
}

/**
 * Merge settings.json permissions.
 * If target doesn't exist, create with defaults.
 * If target exists, add missing permission entries.
 */
export function mergeSettingsJson(projectRoot, { dryRun, force }) {
  const dest = join(projectRoot, '.claude', 'settings.json');

  const requiredPermissions = [
    'Bash(*)',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Agent',
    'mcp__playwright__*',
  ];

  const TRACE_HOOK_CMD = 'node .claude/scripts/trace-hook.mjs';
  const requiredHooks = {
    PreToolUse: { matcher: '.*', command: TRACE_HOOK_CMD },
    PostToolUse: { matcher: '.*', command: TRACE_HOOK_CMD },
    SubagentStop: { command: TRACE_HOOK_CMD },
    Stop: { command: TRACE_HOOK_CMD },
  };

  if (dryRun) {
    log.dry('.claude/settings.json');
    return;
  }

  mkdirSync(dirname(dest), { recursive: true });

  if (!existsSync(dest)) {
    const settings = {
      permissions: { allow: requiredPermissions },
      additionalDirectories: [
        './specs', './pipeline', './designs', './src', './tests',
        './.claude',
      ],
      hooks: buildHooksBlock(requiredHooks),
    };
    writeFileSync(dest, JSON.stringify(settings, null, 2) + '\n');
    log.success('.claude/settings.json (created)');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(readFileSync(dest, 'utf8'));
  } catch {
    log.error('.claude/settings.json exists but contains invalid JSON — skipping merge');
    return;
  }

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const existing = new Set(settings.permissions.allow);
  let added = 0;

  for (const perm of requiredPermissions) {
    if (!existing.has(perm)) {
      settings.permissions.allow.push(perm);
      added++;
    }
  }

  // Add additionalDirectories so agents can access project dirs without sandbox prompts
  const requiredDirs = [
    './specs',
    './pipeline',
    './designs',
    './src',
    './tests',
    './.claude',
  ];

  if (!settings.additionalDirectories) settings.additionalDirectories = [];
  const existingDirs = new Set(settings.additionalDirectories);
  let dirsAdded = 0;

  for (const dir of requiredDirs) {
    if (!existingDirs.has(dir)) {
      settings.additionalDirectories.push(dir);
      dirsAdded++;
    }
  }

  // Merge trace hooks. Don't clobber user-defined hooks; just ensure ours
  // are present alongside any existing entries.
  const hooksAdded = mergeHooks(settings, requiredHooks);

  if (added > 0 || dirsAdded > 0 || hooksAdded > 0) {
    writeFileSync(dest, JSON.stringify(settings, null, 2) + '\n');
    const parts = [];
    if (added > 0) parts.push(`${added} permission(s)`);
    if (dirsAdded > 0) parts.push(`${dirsAdded} directory access rule(s)`);
    if (hooksAdded > 0) parts.push(`${hooksAdded} hook(s)`);
    log.success(`.claude/settings.json (${parts.join(', ')} added)`);
  } else {
    log.skip('.claude/settings.json (all permissions and hooks already present)');
  }
}

/**
 * Build a fresh `hooks` block from the spec map. Used when creating a new
 * settings.json from scratch.
 */
function buildHooksBlock(hookSpec) {
  const out = {};
  for (const [event, entry] of Object.entries(hookSpec)) {
    const hookEntry = { hooks: [{ type: 'command', command: entry.command }] };
    if (entry.matcher) hookEntry.matcher = entry.matcher;
    out[event] = [hookEntry];
  }
  return out;
}

/**
 * Merge required hook entries into an existing settings object. Returns
 * the count of newly-added hook commands. Idempotent: re-running does not
 * duplicate entries already present (matched on event + matcher + command).
 */
function mergeHooks(settings, hookSpec) {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  let added = 0;

  for (const [event, entry] of Object.entries(hookSpec)) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    // Look for an existing group with the same matcher (or both undefined).
    const matcher = entry.matcher || undefined;
    let group = settings.hooks[event].find((g) => {
      const gMatcher = g?.matcher || undefined;
      return gMatcher === matcher;
    });

    if (!group) {
      group = matcher ? { matcher, hooks: [] } : { hooks: [] };
      settings.hooks[event].push(group);
    }
    if (!Array.isArray(group.hooks)) group.hooks = [];

    const alreadyPresent = group.hooks.some(
      (h) => h && h.type === 'command' && h.command === entry.command
    );
    if (!alreadyPresent) {
      group.hooks.push({ type: 'command', command: entry.command });
      added++;
    }
  }

  return added;
}

/**
 * Append pipeline section to CLAUDE.md.
 * If file doesn't exist, create from template.
 * If exists, append only if section not already present.
 */
export function mergeClaudeMd(projectRoot, templatePath, { dryRun }) {
  const dest = join(projectRoot, 'CLAUDE.md');
  const template = readFileSync(templatePath, 'utf8');

  if (dryRun) {
    log.dry('CLAUDE.md');
    return;
  }

  if (!existsSync(dest)) {
    writeFileSync(dest, template);
    log.success('CLAUDE.md (created)');
    return;
  }

  const content = readFileSync(dest, 'utf8');
  if (content.includes('## Real Dev Loop')) {
    log.skip('CLAUDE.md (Real Dev Loop section already present)');
    return;
  }

  writeFileSync(dest, content.trimEnd() + '\n\n' + template);
  log.success('CLAUDE.md (appended Real Dev Loop section)');
}
