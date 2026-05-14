## Real Dev Loop

This project uses [`specsmith`](https://www.npmjs.com/package/specsmith) — a set of Claude Code skills, agents, and scripts that drive features from idea to verified implementation.

### Pipeline (per feature)

Each feature gets its own git branch and numbered folder under `specs/NNN-<slug>/`. Run these in order:

1. `/grill-me` — interrogate the idea, customer feedback, bug, or gripe (no file output, just chat)
2. `/write-prd` — synthesise the conversation into `specs/NNN-<slug>/prd.md`; allocates a fresh `NNN-` branch off your current branch
3. `/plan` — produce `plan.md` and `data-model.md` from the PRD and `.claude/constitution.md`
4. `/grill-plan` *(optional)* — pressure-test the plan: constitution rows, hidden complexity, reversibility, failure modes, ops gaps
5. `/tasks` — decompose the plan into `tasks.md` (phased markdown checkboxes the evaluator flips)

### Execution loops

- `/build` — dev/eval loop. Reads `tasks.md`, delegates to the `developer` and `evaluator` subagents, iterates per task until the evaluator passes.
- `/design` — design/critique loop. Reads `tasks.md`, delegates to `designer` and `design-critique` subagents, iterates until designs pass.

### Subagents

Invoke via the Agent tool's `subagent_type` field. The values below match each agent's `name:` in its frontmatter; the file basenames (`developer.md`, `evaluator.md`, etc.) are not the invocation names.

- **`developing-features`** (`agents/developer.md`) — implements one phase; follows `plan.md` and `data-model.md`.
- **`evaluating-phases`** (`agents/evaluator.md`) — Playwright-MCP verification against `prd.md` SC-### criteria. Flips `[ ]` → `[x]` in `tasks.md` only after passing.
- **`designing-interfaces`** (`agents/designer.md`) — generates HTML/CSS prototypes for views in the PRD.
- **`critiquing-designs`** (`agents/design-critique.md`) — Playwright-MCP critique of designer output against rubric.

Developer/evaluator and designer/design-critique run in isolated context — the verifier never sees the implementer's reasoning.

### Key directories

- `specs/NNN-<slug>/` — PRD, plan, data-model, tasks per feature
- `.claude/constitution.md` — the principles `/plan` checks against; edit to fit this project
- `pipeline/feedback/` — evaluator/critic reports per cycle
- `pipeline/traces/` — JSONL traces of build/design runs (read with `node .claude/scripts/trace-summarise.mjs pipeline/traces/<file>.jsonl`)
- `pipeline/environment-facts.md` — cached project facts (test command, dev server, DB path); written cycle 1, read first thereafter
- `pipeline/procedures.md` — cached UI flows (login, cookie consent dismissal); written on first encounter, read first thereafter
- `designs/` — designer output (self-contained HTML files)

### Updating

Re-run `npx specsmith init` to upgrade. Skill/agent/script files you have not modified locally are updated; files you have customised are skipped (a manifest at `.claude/specsmith/manifest.json` tracks the difference). Use `--force` to overwrite everything.
