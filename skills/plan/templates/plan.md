# Plan: <Feature name>

**Slug**: `<feature-slug>`
**PRD**: [prd.md](prd.md)
**Data model**: [data-model.md](data-model.md)

## Technical Context

- **Language/Version**: <e.g. TypeScript 5.x on Node.js 22 LTS>
- **Primary Dependencies**: <comma-separated list with versions, taken from package.json>
- **Storage**: <database + extensions; file storage strategy>
- **Testing**: <unit, integration, E2E tools>
- **Target Platform**: <runtime, deployment shape>
- **Project Type**: <single web app, monorepo, library, CLI, worker, etc.>
- **Performance Goals**: <cross-reference SC-### from prd.md>
- **Constraints**: <cross-reference NFR-### and any FR-### that imply infra constraints>
- **Scale/Scope**: <expected volume, 12-month projection, UI/feature surface>

## Constitution Check

*GATE: must pass before implementation. Re-check after Project Structure and Files to touch are written; if anything regressed, update statuses.*

| # | Principle | v1 plan compliance | Status |
| --- | --- | --- | --- |
| <number> | <principle name from .claude/constitution.md> | <one paragraph: how this plan complies, citing concrete plan elements — files, libraries, tests> | Pass / Pass with waiver / Fail |

<!--
If any row is "Pass with waiver" or "Fail", add a Complexity Tracking subsection
below this table that names the waiver, the reason it was unavoidable, and the
simpler alternative considered and rejected. Otherwise leave Complexity Tracking
out entirely.
-->

## Project Structure

Show only what this feature creates or modifies. Do not enumerate the entire repo.

### Documentation (this feature)

```text
specs/NNN-<feature-slug>/
├── prd.md
├── plan.md         # this file
├── data-model.md
└── tasks.md        # produced later by /tasks
```

### Source Code (repository root)

```text
<tree of folders/files this feature touches, with one-line annotations>
```

## Files to touch

Exhaustive. If a route handler needs a Zod schema, list both files. The `/tasks` skill consumes this table — orphans here become orphan tasks later.

| File | Action | Purpose |
| --- | --- | --- |
| `src/...` | create / modify / delete | <one-line reason> |
