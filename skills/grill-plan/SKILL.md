---
name: grill-plan
description: Pressure-tests an existing implementation plan by interrogating its constitution check, files-to-touch list, hidden complexity, reversibility, data model, sequencing, failure modes, and operational gaps. Use after /plan when the user wants to validate the plan before handing it to design or build agents. The output is the conversation plus a punch list of concrete changes to make in plan.md or data-model.md; revise the plan based on what surfaces.
---

# Grill plan

An adversarial review of an existing plan. The PRD answered the "what"; the plan claims to answer the "how". Your job is to find what the plan got wrong, missed, or papered over — before any code is written. Do not write any files.

## Resolve the spec folder

Determine `specs/NNN-<feature-slug>/` by parsing the current git branch name. The branch should match `^\d{3}-` (created by `/write-prd`); the folder name is the branch name verbatim. If the current branch does not match that pattern, ask the user which spec folder to operate in.

## Inputs

Read in this order:

1. `specs/NNN-<feature-slug>/plan.md`
2. `specs/NNN-<feature-slug>/data-model.md`
3. `specs/NNN-<feature-slug>/prd.md` (for cross-checking that the plan still serves the requirements)
4. `.claude/constitution.md` (for cross-checking the constitution table verbatim)

If `plan.md` is missing, stop and tell the user to run `/plan` first.

## Open the interview

Restate, in 3–5 short bullets:

- The plan's chosen language/runtime/storage
- The constitution rows and their statuses (just the verdict column, no rationale)
- The number of files in "Files to touch" and the number of entities in `data-model.md`
- Anything in the plan that immediately looks load-bearing or risky

Then ask the user one question: **"Which area do you want me to start grilling, or should I work through them in order?"**

## What to grill on

Cover every dimension below before declaring the review complete. For each, the goal is one of three outcomes per item: **validated** (the plan handles it correctly), **change** (a concrete edit to make in plan.md or data-model.md), or **open question** (logged for the user to resolve before build).

### Constitution rows

- For each row, is the "Pass" verdict actually justified by the rationale, or is the rationale handwavy?
- Which row would a hostile reviewer downgrade, and on what grounds?
- Are any "Pass with waiver" rows hiding something that should just be a different design?

### Files to touch

- Is anything missing? Walk the user stories from `prd.md` and ask whether each one is covered.
- Is anything listed that the plan does not actually need?
- Is any change touching more files than admitted (e.g. a "modify" that requires a new file the table doesn't list)?

### Hidden complexity

- Which task in the plan is secretly two weeks of work disguised as a bullet point?
- Which migration looks safe but is not (large table, locking, backfill)?
- Which "use library X" decision actually needs a custom adapter?

### Reversibility

- Which decisions are one-way doors (data shape, public API, schema choice)?
- Are they identified as such, or treated like any other choice?
- What would it cost to undo each one in three months?

### Data model

- Which entity is over-modeled for v1?
- Which relationship will fight us at scale (cardinality, query patterns)?
- Which state transition has no path back? Is that intentional?
- Are indexes justified by actual query patterns from the plan, or speculative?

### Sequence

- Can phase N actually start with only what phase N-1 produced, or is there a hidden dependency the phasing doesn't acknowledge?
- Where does the critical path go through a single person or a single external dependency?

### Failure modes

- What happens when the external dependency is down, slow, or returns garbage?
- Is that behavior in the plan, or is it assumed?
- For each NFR-### in `prd.md`, is there a concrete plan element that achieves it?

### Operational gaps

- Deploy story: present or absent?
- Rollback story: present or absent?
- Observability (logs, metrics, traces): present or absent?
- On-call runbook: present or absent?

## How to ask

- Ask 1–3 questions at a time. Wall-of-questions kills momentum.
- Ground every question in a specific section/file/line of the plan. Vague questions get vague answers.
- When the user says "that's fine, it's covered", make them point at where in the plan it is covered. If they can't, that's a "change", not a "validated".
- Track outcomes as you go — keep a running list in your responses so the user can see the punch list grow.

## When to stop

Stop and recommend revising the plan when:

- Every dimension above has been worked through to one of: **validated**, **change**, or **open question**
- The user has the punch list in front of them, with file and section references
- No active line of inquiry has surfaced something new in the last 2–3 turns

Hand off by printing the consolidated punch list in three sections (changes / open questions / validated) and recommending one of:

- **`/tasks`** (if the punch list is empty or only contains validated items — the plan is ready to decompose)
- Re-run **`/plan`** (if the changes are extensive or restructure the plan)
- Hand-edit `plan.md` / `data-model.md` then run `/tasks` (if the changes are localized)
- Resolve the open questions first, then re-run this skill

If the user tries to stop earlier, name what is still ungrilled in one short list before agreeing.
