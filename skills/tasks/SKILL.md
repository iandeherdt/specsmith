---
name: tasks
description: Generates a phased implementation task list (tasks.md) from plan.md and data-model.md. Use after /plan when ready to break the plan into individually-checkable units of work. Tasks are not bound to specific agents — the evaluator agent verifies each task when it is marked done. Produces specs/NNN-<feature-slug>/tasks.md with phases, each containing markdown checkbox items for implementation work and explicit verification checks.
---

# Write tasks

Decompose the plan into a sequenced, checkable task list.

## Resolve the spec folder

Determine `specs/NNN-<feature-slug>/` by parsing the current git branch name. The branch should match `^\d{3}-` (created by `/write-prd`); the folder name is the branch name verbatim. If the current branch does not match that pattern, ask the user which spec folder to operate in.

## Inputs

Read in this order:

1. `specs/NNN-<feature-slug>/plan.md`
2. `specs/NNN-<feature-slug>/data-model.md`
3. `specs/NNN-<feature-slug>/prd.md` (for cross-checking SC-### coverage)

If `plan.md` or `data-model.md` is missing, stop and tell the user to run `/plan` first.

## Output

Write `specs/NNN-<feature-slug>/tasks.md` in the same spec folder. If it already exists, ask whether to overwrite. Do **not** create a new branch — `/tasks` runs on the existing feature branch.

## Phases

Default phases — use these unless the plan obviously calls for something different:

1. **Foundation** — scaffolding, deps, config, env vars, base layout
2. **Persistence** — migrations, schema, seed data, repository helpers
3. **API** — route handlers, contracts, validation
4. **UI** — components, pages, styling
5. **Integration** — workers, external providers, jobs, webhooks
6. **Hardening** — error paths, observability, performance, accessibility, i18n

Drop phases that do not apply. Add a phase only when a self-contained area of the plan does not fit any of the above.

## Task rules

- Each task is one checkable item: `- [ ] <verb-led description>`
- Verb-led: "Add", "Create", "Wire", "Implement", "Cover with Playwright", "Verify"
- One task = one unit of work an evaluator can verify in one pass
- **No agent tags**. Tasks are not pre-assigned to design / develop / critique / eval agents — the orchestrator decides at runtime, and the evaluator decides when each task is "done"
- For each implementation task, include a sibling **check** task that the evaluator can use to confirm completion. Examples:
  - Implementation: `- [ ] Add Drizzle schema for ContactEmail`
  - Check: `- [ ] Verify migration runs cleanly on empty DB and schema matches data-model.md`
- Reference plan.md sections by name when context is needed: `(see plan.md → "Files to touch" → src/lib/auth/config.ts)`

## Template

Use `templates/tasks.md` (sibling to this file) as the structure. Read it first, then write `tasks.md` by:

1. Copying every applicable phase heading verbatim
2. Dropping phases the plan does not need
3. Replacing each `<task>` / `<check>` placeholder with concrete `- [ ]` lines
4. Adding more `- [ ]` lines per phase as the plan and data model require

## Marking tasks done

Tasks are completed by editing this file: change `[ ]` to `[x]`. The **evaluator agent** does this, and only after verifying the implementation against `plan.md` and `data-model.md`. Do not mark a task `[x]` based on the implementer's word alone.

## Coverage discipline

Cross-check before finalizing:

- Every file in `plan.md`'s "Files to touch" table maps to at least one task. Orphan files = missing tasks.
- Every entity in `data-model.md` maps to at least one Persistence-phase task.
- Every `SC-###` in `prd.md` maps to at least one Hardening-phase verification task.
- Every "Pass with waiver" row in the constitution table maps to a Hardening-phase task that documents or mitigates the waiver.

## After writing

Print:
1. The path to `tasks.md`
2. Total task count per phase
3. Any orphans found during the coverage check (files-to-touch, entities, or SCs that did not produce a task) so the user can fix the gap before kicking off design or build
