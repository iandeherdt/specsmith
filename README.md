# specsmith

A bundle of [Claude Code](https://claude.com/code) skills, agents, and scripts that drive a feature from a vague idea to verified, browser-tested code.

You install it once into a project; from then on, building a feature is a sequence of slash commands. Each command produces a checked-in artifact (`prd.md`, `plan.md`, `data-model.md`, `tasks.md`) on its own git branch — so the work is reviewable, resumable, and version-controlled like any other code change.

## The pipeline

```
       /grill-me                  /write-prd                /plan                   /grill-plan                /tasks                  /design                /build
   (interrogate idea)        (synthesise PRD,        (Technical Context,        (pressure-test the         (decompose into          (HTML/CSS              (developer ↔
                              create branch +          Constitution Check,        plan: rows, files,         phased markdown          prototypes via         evaluator loop;
                              numbered folder)         Project Structure,         hidden complexity,         checkbox tasks)          designer ↔             evaluator
                                                       Files-to-touch)            failure modes)                                      design-critique)       checks tasks off)
                                                       + data-model.md
```

Five planning skills produce inspectable artifacts. Two execution skills (`/build`, `/design`) hand work to subagents and iterate until verification passes.

The artifacts for each feature live at `specs/NNN-<feature-slug>/` in the host project — first-class team documentation, not AI scratch.

## Requirements

- Node.js ≥ 18 (uses ESM and `fs.cpSync`)
- [Claude Code](https://claude.com/code) installed and on `PATH` (the installer uses the `claude` CLI to wire up Playwright MCP; if it's missing, the installer prints a manual snippet to add to `.mcp.json`)
- A git repository (each `/write-prd` invocation creates a new branch)

## Install

In the root of any project:

```bash
npx specsmith init
```

This:

1. Copies skills into `.claude/skills/` (one per skill, with bundled `templates/`)
2. Copies subagent definitions into `.claude/agents/`
3. Copies trace and helper scripts into `.claude/scripts/`
4. Drops a starter `.claude/constitution.md` (skipped if you already have one)
5. Merges baseline `.claude/settings.json` (permissions, additional directories, trace hooks) and `.claude/launch.json` (debug configurations) — your existing entries are preserved
6. Appends a "Real Dev Loop" section to your `CLAUDE.md` (created if missing)
7. Runs `claude mcp add --scope project playwright -- npx @playwright/mcp@latest --isolated` so the evaluator and design-critique agents can drive a real browser
8. Creates `pipeline/feedback/` and `pipeline/traces/` (runtime scratch space) and seeds `pipeline/procedures.md` with a starter overlay-handling procedure
9. Writes a checksummed manifest to `.claude/specsmith/manifest.json` so subsequent `update` runs know which files have been edited locally

Useful flags:

- `--dry-run` — preview without writing
- `--force` — overwrite locally-modified files (including `constitution.md`)

### About the permissions init grants

> **Heads up:** `init` adds `Bash(*)` to your `.claude/settings.json` allowlist (alongside `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Agent`, and `mcp__playwright__*`) so the build and design loops aren't interrupted by per-command prompts during dev-server start/stop, `pkill`, `sed`/`awk` runs, test commands, migrations, etc. If your project requires tighter permissions, hand-edit `.claude/settings.json` after install — replace `Bash(*)` with specific patterns like `Bash(npm run *)`, `Bash(npx playwright *)`, `Bash(node .claude/scripts/*)` and so on. The trade-off is you'll start seeing prompts mid-loop when something the agents need wasn't allowlisted.
>
> Existing entries in `settings.json` are preserved — `init` only *adds* missing entries, it never removes yours.

### Runtime guard against agent flailing

`init` installs `scripts/guard-repeat-commands.mjs` as a `PreToolUse` hook on every `Bash` call. It refuses two patterns mid-run rather than logging them after the fact (real /build traces showed agents falling into both, ignoring prose anti-patterns):

1. **Re-running an expensive command to re-filter output.** If `npm run test/lint/typecheck/build`, `playwright test`, `prisma migrate`, `tsc`, `jest`, `vitest`, `next build`, `cargo`, `go test`, `mvn`, or `gradle` already ran in this session and no `Edit` or `Write` tool call happened since, the second invocation is denied with a message pointing to `tee /tmp/last-out.txt` once, then grep the file. The "base" command is matched after stripping trailing `| grep/tail/head/awk/sed/wc/jq/...` pipes, so re-running with a different filter still counts as a repeat.
2. **State-wipe loops.** Three or more `rm -rf` of the same path (matching `pglite`, `.next`, `node_modules`, `data/`) within 30 minutes is denied. If the same failure persists after wiping, the bug isn't stale state.

Set `SPECSMITH_GUARD=0` in the environment to bypass both rules.

### Run the loops in an isolated environment

`Bash(*)` means a Claude Code session running in this project can execute *any* shell command the host user can run — including `git push`, reading `.env*` files, hitting your cloud provider CLIs, calling `gh` against your repos, and so on. For anything beyond a personal sandbox, run the loops in an environment with a smaller blast radius:

- **Dedicated SSH key for the agent**: generate a separate key that has push rights only to this repo, and remove the rest of your keys from `ssh-agent` while the loop runs. Limits how far an unintended `git push` can reach.
- **Docker / devcontainer**: run Claude Code inside a container with the project mounted read-write, your secrets *not* mounted, and outbound network restricted to the registries the project needs. The Playwright MCP container model handles the browser side; the agent process itself can be containerised the same way.
- **Service account on a server**: stand up a CI-style Linux user (no sudo, scoped credentials, dedicated ssh key, dedicated cloud-provider service account) and run the loops there over SSH. The agent's worst-case behaviour is bounded by what that user can do.

Whichever pattern, the rule of thumb is: assume the agent will at some point execute a command you didn't expect, and make sure that command can't reach anything you can't afford to lose.

## Edit the constitution

After install, edit `.claude/constitution.md` so it reflects this project's principles. The starter ships with seven broadly applicable principles (Test-First, Security-First, Code Quality & Complexity Control, Component Separation, Library-First, Migrations-Only, Design Fidelity); add, remove, or rewrite to fit.

`/plan` reads this file every time it generates a plan and renders one row per principle into a Constitution Check table — so vague principles produce vague checks. Be specific.

## Building a feature

```
You: /grill-me
     The customer keeps saying our checkout flow is "confusing" but won't say what.

Claude: <asks ~10 questions interactively — users, pain points, success criteria, edge cases, non-goals>

You: /write-prd
     <slug: checkout-revamp>

Claude: Allocates 003-checkout-revamp/, switches branch, writes specs/003-checkout-revamp/prd.md.

You: /plan

Claude: Inspects package.json + repo structure, reads prd.md and .claude/constitution.md,
        writes plan.md (Technical Context, Constitution Check, Project Structure,
        Files to touch) and data-model.md.

You: /grill-plan

Claude: <interrogates the plan: which constitution row is handwavy? which files-to-touch
        entry is missing? which migration looks safe but isn't? — produces punch list>

You: <hand-edits plan.md based on punch list>

You: /tasks

Claude: Writes tasks.md — phased markdown checkboxes, each implementation task paired
        with a sibling check task the evaluator runs.

You: /design     (optional, only if the feature needs visual prototypes)

Claude: Designer subagent generates HTML/CSS prototypes under designs/.
        Critique subagent scores them in a real browser. Loops until they pass.

You: /build

Claude: For each phase with unchecked tasks:
          - Developer subagent implements the phase
          - Evaluator subagent verifies via Playwright MCP, ticks off completed tasks
          - Loops until evaluator passes the phase
        Stops when every task in tasks.md is [x].
```

## Skills

| Skill | Purpose | Output |
| --- | --- | --- |
| `/grill-me` | Interrogate a fresh idea, customer feedback, bug report, or gripe | conversation only |
| `/write-prd` | Synthesise the conversation into a Product Requirements Document | new branch + `prd.md` |
| `/plan` | Translate the PRD into a technical plan and data model | `plan.md` + `data-model.md` |
| `/grill-plan` | Pressure-test an existing plan adversarially | conversation + punch list |
| `/tasks` | Decompose plan + data model into phased checkbox tasks | `tasks.md` |
| `/design` | Run designer ↔ critique loop until prototypes pass | HTML/CSS files in `designs/` |
| `/build` | Run developer ↔ evaluator loop until every task is checked off | implemented code, ticked `tasks.md` |

## Subagents

`/build` and `/design` are orchestrators — they delegate work to single-responsibility subagents that run in isolated context (the verifier never sees the implementer's reasoning):

| `subagent_type` | File | Role |
| --- | --- | --- |
| `developing-features` | `agents/developer.md` | Implements one phase; cares about clean code, tests, design fidelity |
| `evaluating-phases` | `agents/evaluator.md` | Verifies each task in a real browser via Playwright MCP; flips checkboxes only after passing |
| `designing-interfaces` | `agents/designer.md` | Generates distinctive HTML/CSS prototypes per user story |
| `critiquing-designs` | `agents/design-critique.md` | Scores prototypes against a rubric in a real browser |

The `subagent_type` values (left column) are what you pass to the Agent tool. The file basenames (`developer.md`, etc.) are not the invocation names.

## What gets installed where

In the host project after `npx specsmith init`:

```text
.claude/
├── agents/                       # subagent definitions (4 files)
├── skills/                       # one folder per skill, some with templates/
│   ├── grill-me/SKILL.md
│   ├── write-prd/{SKILL.md, templates/prd.md}
│   ├── plan/{SKILL.md, templates/{plan.md,data-model.md}}
│   ├── grill-plan/SKILL.md
│   ├── tasks/{SKILL.md, templates/tasks.md}
│   ├── design/SKILL.md
│   └── build/SKILL.md
├── scripts/                      # trace hook, env-facts verifier, dev-server helper, etc.
├── constitution.md               # principles /plan checks against — EDIT THIS
├── settings.json                 # permissions + additional directories + trace hooks
├── launch.json                   # debug configurations
└── specsmith/manifest.json   # SHA-256 of every installed file (for `update`)

specs/                            # one folder per feature, created by /write-prd
└── NNN-<feature-slug>/
    ├── prd.md
    ├── plan.md
    ├── data-model.md
    └── tasks.md

pipeline/                         # runtime scratch — created at install, written during /build and /design
├── feedback/                     # evaluator/critic reports per cycle
├── traces/                       # JSONL traces of build/design runs
├── procedures.md                 # cached UI flows (login, cookie consent dismissal)
├── environment-facts.md          # cached project facts (test command, dev server URL)
├── run-state.md                  # current orchestrator run context
└── build-log.md                  # progress log

.mcp.json                         # Playwright MCP server entry
```

`pipeline/procedures.md` and `pipeline/environment-facts.md` are **persistent caches** — they survive across runs and are never overwritten. The agents discover things once (login flow, dev-server port, test command) and write them here so future cycles skip the discovery step.

## Customising

- **Templates** for the file-writing skills live at `.claude/skills/<skill>/templates/<artifact>.md`. Edit them to change the structure of the PRD, plan, data-model, or tasks files. Your edits are preserved across `update` runs.
- **Subagent prompts** live at `.claude/agents/*.md`. Edit them to change how the developer or evaluator behaves. Edits are preserved across `update`.
- **Skill prompts** live at `.claude/skills/*/SKILL.md`. Edit similarly.
- **Constitution**: `.claude/constitution.md`. Never overwritten by `update`.

The manifest at `.claude/specsmith/manifest.json` records the SHA-256 of every file at install time. `update` compares package version vs on-disk vs manifest to decide whether each file is safe to update or has been customised — see "Updating" below.

## Updating

```bash
npx specsmith update
```

For each tracked file:

- **already current** (on-disk matches package) → skipped
- **unmodified since install** (on-disk matches manifest) → updated to package version
- **user-modified** (on-disk differs from both) → skipped, logged for manual reconciliation
- **missing on disk** → installed fresh

The constitution and your `pipeline/*.md` files are never touched.

`--dry-run` previews the diff without applying. `--force` (via `init --force`) overwrites everything including the constitution — use with care.

## Troubleshooting

**`claude: command not found` during init** — Claude Code isn't installed or isn't on PATH. The installer prints a `.mcp.json` snippet you can paste manually; everything else still installs.

**Update reports every file as user-modified on Windows** — line-ending normalisation. The package ships LF; if your repo has `core.autocrlf=true` you'll see CRLF on disk and the hashes diverge. The package ships a `.gitattributes` with `* text=auto eol=lf` to prevent this on its *own* tree, but for your host project run `git config core.autocrlf input` (or `false`) before installing.

**`/plan` complains the constitution is missing** — `.claude/constitution.md` was deleted or `init` was skipped. Run `npx specsmith init` again (it will only re-add what's missing).

**Evaluator can't drive the browser** — Playwright MCP wasn't wired. Check `.mcp.json` has the `playwright` entry; if not, run `claude mcp add --scope project playwright -- npx @playwright/mcp@latest --isolated`.

**`/grill-plan` says it can't find the plan** — you're not on a feature branch. The `^\d{3}-` branch pattern is how the post-PRD skills locate the spec folder. Either `git checkout` the right branch, or tell the skill which spec folder to use when it asks.

## Design decisions worth knowing

- **No transcript file from `/grill-me`.** The conversation context *is* the handoff, so `/write-prd` must run in the same session as `/grill-me`.
- **Plan is detailed but not SpecKit-detailed.** `/plan` produces only `plan.md` + `data-model.md` — no `research.md`, `quickstart.md`, or `contracts/`. The plan template has Technical Context, Constitution Check, Project Structure, and Files-to-touch sections.
- **Tasks are not agent-bound.** Tasks have no `(dev)` / `(design)` tags. The orchestrator routes; the evaluator decides "done".
- **Numbering is stable.** `FR-###`, `NFR-###`, `SC-###`, `OQ-###` identifiers in `prd.md` are append-only — never renumber when adding items.
- **Each feature gets its own branch.** `/write-prd` runs `git checkout -b NNN-<slug>` off whatever branch you're on, inheriting any uncommitted changes. Multiple features in flight = multiple branches.

## License

MIT. See [LICENSE](./LICENSE).
