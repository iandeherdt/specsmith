---
name: plan
description: Generates an implementation plan (plan.md) and data model (data-model.md) from a PRD. Use after /write-prd produces specs/NNN-<feature-slug>/prd.md, when ready to translate requirements into a concrete technical plan. Reads .claude/constitution.md to render the compliance check. Output is detailed but focused — technical context, constitution check, project structure, files-to-touch — and a sibling data-model.md with schema, indexes, relationships, and state transitions. Does NOT generate research, quickstart, or contracts files.
---

# Write plan

Translate a PRD into a technical plan and data model. Detailed, but not SpecKit-detailed: only the four sections below in `plan.md`, plus a sibling `data-model.md`.

## Resolve the spec folder

Determine `specs/NNN-<feature-slug>/` by parsing the current git branch name. The branch should match `^\d{3}-` (created by `/write-prd`); the folder name is the branch name verbatim. If the current branch does not match that pattern, ask the user which spec folder to operate in and confirm before reading anything.

## Inputs

Read in this order:

1. `specs/NNN-<feature-slug>/prd.md` — the requirements
2. `.claude/constitution.md` — the principles list to check the plan against
3. `.claude/conventions.json` — machine-checkable code rules (optional; only present if the project opted in via `npx specsmith init --conventions`)
4. `specs/glossary.md` — the project's ubiquitous language (optional). Use its canonical terms throughout the plan and data model; do not coin a synonym for a concept it already names. This skill only reads the glossary — `/grill-me` is what grows it.

If `prd.md` is missing, stop and tell the user to run `/write-prd` first.
If `.claude/constitution.md` is missing, stop and ask the user to create one (or run `npx specsmith init` if they have not). Do **not** invent a constitution.

If `prd.md` has unresolved `OQ-###` items, stop and ask the user to resolve them in the PRD before planning. Planning around unknowns produces unstable plans.

## Outputs

Write two sibling files in the same spec folder:

- `specs/NNN-<feature-slug>/plan.md`
- `specs/NNN-<feature-slug>/data-model.md`

If either already exists, ask whether to overwrite. Do **not** create a new branch — `/plan` runs on the branch `/write-prd` already created.

## Before writing

Inspect the host project to ground the plan in reality:

- Read the project's existing folder structure. Match the conventions you find — do not impose a layout the project does not use.
- Read `package.json` (or equivalent) to learn the actual installed dependencies and versions. The Technical Context must reflect what is installed, not what would be nice.
- Read any existing migrations / schema files to understand the storage shape.
- **Detect convention ambiguity.** For each architectural pattern this feature touches (data access, component structure, validation, error handling, API shape), grep for at least two existing examples in the codebase. If you find competing patterns (e.g. some entities use `src/lib/<feature>/queries.ts`, others use `src/lib/<feature>/repository.ts`), AND the codebase has no `.claude/conventions.json` rule that picks one, this is an ambiguity that *will* drift further if not resolved. Surface as `OQ-###` in the plan ("Two data-access patterns coexist: queries.ts (used in X, Y) and repository.ts (used in Z). Which should this feature use? Once decided, add a rule to `.claude/conventions.json` so future features don't re-litigate."). Do **not** silently pick one — the next plan will pick the other and the codebase fragments further.

## Templates

Read both templates before writing:

- `plan.md` structure: `templates/plan.md` (sibling to this file)
- `data-model.md` structure: `templates/data-model.md` (sibling to this file)

For each, write the new file by:

1. Copying every heading verbatim, in order
2. Filling each section from the inputs (`prd.md`, `.claude/constitution.md`, project inspection)
3. Replacing each `<placeholder>` with concrete content
4. Following the inline `<!-- … -->` instructions in the template (e.g. drop sections marked optional, expand variable-length tables)
5. Removing entire sections only when the template explicitly says they may be omitted

The Constitution Check table renders one row per principle in `.claude/constitution.md` — use the principle's own numbering (Roman numeral, integer, slug — whatever the file uses) and quote the principle name verbatim.

## Discipline

- Every Technical Context value should be defensible. If you do not know it, ask the user — do not pick a default.
- "Files to touch" is a contract for `/tasks`. Be exhaustive.
- Folder structure must match the project's existing conventions. The "before writing" inspection is mandatory, not optional.
- The constitution table is rendered against `.claude/constitution.md` as it exists right now. If a principle is ambiguous, quote it verbatim in the row and ask the user how to interpret it before assigning a status.
- **Plan-time conventions are sticky.** If `.claude/conventions.json` exists, list every rule whose `filesGlob` could match files in this feature's "Files to touch" — append a "Conventions in scope" subsection under the Constitution Check table that names each rule. The developer reads `.claude/conventions.json` directly, but listing the in-scope rules in the plan reminds reviewers (and the orchestrator) what's being enforced. If you discovered a convention ambiguity in the "Before writing" step and surfaced it as an `OQ`, that OQ is a gate on `/tasks` — resolve it (and add a rule to `conventions.json`) before tasking.

## After writing

Print:
1. Both file paths
2. The row counts of the constitution table and the files-to-touch table
3. Any non-Pass constitution rows, prominently — the user may want to revise the plan or accept the waiver before running `/tasks`
4. A reminder that `/grill-plan` can pressure-test the plan before `/tasks`, and that `/tasks` is the next step once the user is satisfied
