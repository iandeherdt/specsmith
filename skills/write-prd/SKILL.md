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

- Pull every requirement from something the user said in the conversation.
- Do **not** invent requirements to fill template gaps. Log them as open questions instead.
- If the user has not specified a success criterion for a goal, that is an `OQ`, not an `SC`.
- If the user gave a vague target ("fast", "soon", "lots of users"), either ask one last clarifying question or log it as an OQ — do not pick a number for them.

## After writing

Print:
1. The new branch name and the path to the created file
2. A one-line summary of what it contains (counts: FRs, NFRs, SCs, OQs)
3. Any unresolved `OQ-###` items, listed verbatim — these are gates for `/plan` and the user should resolve them before planning
4. The next step: `/plan` if no OQs remain, otherwise resolve OQs first (by editing `prd.md` directly) then run `/plan`
