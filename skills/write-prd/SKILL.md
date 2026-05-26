---
name: write-prd
description: Writes a Product Requirements Document (prd.md) using the current conversation as the source. Use after /grill-me has gathered enough context, or after the user has otherwise discussed a feature in detail in this session and is ready to commit the requirements to a durable file. Allocates the next numbered slot under specs/, creates a matching git branch off the current branch, and produces specs/NNN-<feature-slug>/prd.md.
---

# Write PRD

Synthesize the current conversation into a Product Requirements Document. The conversation context **is** the source — do not invent requirements that were not discussed; log them as open questions instead.

## Before writing

1. **Verify git.** Run `git rev-parse --is-inside-work-tree`. If not in a git repo, stop and tell the user — this skill expects a versioned tree because each PRD gets its own branch.
2. **Get the feature slug.** Ask the user for a kebab-case slug (e.g. `unified-comm-crm`) if it is not already obvious from the conversation. Confirm it before continuing.
3. **Allocate the next number.** List `specs/` (creating it if absent). Find the highest existing `NNN-` prefix among directories that match `^\d{3}-`. The new number is `max + 1`, zero-padded to 3 digits (start at `001` if `specs/` is empty).
4. **Create the branch.** From the *current* branch (do not switch to main first), run `git checkout -b NNN-<feature-slug>`. Do not stash or commit any pending changes — let the branch inherit them.
5. **Create the folder.** `mkdir -p specs/NNN-<feature-slug>/`. The PRD will be written to `specs/NNN-<feature-slug>/prd.md`.

Each `/write-prd` invocation allocates a fresh number and a fresh branch — there is no "file already exists" path. If the user wants to amend an existing PRD, they edit it directly on its branch.

## Template

Use `templates/prd.md` (sibling to this file) as the literal structure. Read it first, then write `prd.md` by:

1. Copying every heading verbatim, in order
2. Filling each section from the conversation context
3. Replacing each `<placeholder>` with concrete content
4. Adding more `FR-###` / `NFR-###` / `SC-###` / `OQ-###` lines as needed (sequential numbering)
5. Removing rows from any table that has no relevant data — do not leave empty placeholder rows
6. Removing entire sections only if they genuinely do not apply (e.g. a prototype with no NFRs)

## Numbering rules

- `FR-###` functional requirements
- `NFR-###` non-functional requirements
- `SC-###` success criteria
- `OQ-###` open questions

Numbers are stable identifiers. Once assigned, do not renumber when adding items — append at the next free number.

## Sourcing discipline

- **Use the project's vocabulary.** Read `specs/glossary.md` if it exists and phrase requirements with its canonical terms. Do not introduce a synonym for a concept the glossary already names — the glossary is the project's ubiquitous language, and the PRD is downstream of it. (Writing new terms is `/grill-me`'s job, not this skill's; here you only consume them.)
- Pull every requirement from something the user said in the conversation.
- Do **not** invent requirements to fill template gaps. Log them as open questions instead.
- If the user has not specified a success criterion for a goal, that is an `OQ`, not an `SC`.
- If the user gave a vague target ("fast", "soon", "lots of users"), either ask one last clarifying question or log it as an OQ — do not pick a number for them.

## Split free-text enumerations into discrete FRs

When the user describes a feature with a comma-separated list — "the dashboard shows cashflow, new leases starting, and next expected payments", "the form has email, password, and remember-me", "the report exports to PDF, CSV, and JSON" — each item becomes its own `FR-###`. Do NOT collapse them into a single FR with a free-text bullet list.

This rule exists because of a real failure (Phase 4 of `002-landlord-dashboard`, 2026-05-15): the PRD had a single FR-025 that read "always-on baseline of cashflow, new leases starting, next expected payments". The `/plan` skill enumerated 6 cards in its files-to-touch table; the `/design` skill produced 7+ cards (interpreting the requirement more richly); the `/build` skill implemented 6; the missing card was deferred as "scope creep" because the plan didn't enumerate it. Discrete FRs would have removed the interpretation drift — every consumer downstream sees the same enumerated items.

Procedure:

- A comma-separated list of nouns or noun-phrases inside a single requirement → split each item into its own FR. Use sequential numbering (`FR-N`, `FR-N+1`, `FR-N+2`).
- A list of conditions/qualifiers on the same noun is NOT a split case ("save when valid, complete, and within rate limits" is one FR with three conditions).
- If the user explicitly asks for the items grouped ("treat these as one bundle, ship together"), keep them in one FR — but note the grouping decision in the FR text so downstream knows it was intentional.
- When in doubt, split. Two narrow FRs are easier to plan, design, and verify than one wide one.

## After writing

Print:
1. The new branch name and the path to the created file
2. A one-line summary of what it contains (counts: FRs, NFRs, SCs, OQs)
3. Any unresolved `OQ-###` items, listed verbatim — these are gates for `/plan` and the user should resolve them before planning
4. The next step: `/plan` if no OQs remain, otherwise resolve OQs first (by editing `prd.md` directly) then run `/plan`
