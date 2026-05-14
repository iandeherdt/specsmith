#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { install } from '../lib/installer.mjs';
import { update } from '../lib/update.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const HELP = `Usage: ${pkg.name} <command> [options]

Commands:
  init      Install skills, agents, scripts, constitution, and Playwright MCP into the current project
  update    Selectively update tracked files; preserves locally-modified ones (use --force to overwrite)
  help      Show this help

Options:
  --dry-run    Show what would change without writing anything
  --force      Overwrite existing files / locally-modified files
  -v, --version  Print package version

Examples:
  npx ${pkg.name} init
  npx ${pkg.name} init --dry-run
  npx ${pkg.name} update
  npx ${pkg.name} update --force
`;

function parseFlags(argv) {
  const flags = new Set(argv);
  return {
    dryRun: flags.has('--dry-run'),
    force: flags.has('--force'),
  };
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const projectRoot = process.cwd();

  switch (cmd) {
    case 'init':
      await install(projectRoot, parseFlags(rest));
      return;
    case 'update':
      await update(projectRoot, parseFlags(rest));
      return;
    case '-v':
    case '--version':
      process.stdout.write(`${pkg.name} v${pkg.version}\n`);
      return;
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(HELP);
      process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`${pkg.name}: ${err.stack || err.message}\n`);
  process.exit(2);
});
