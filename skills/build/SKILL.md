---
name: build
description: Run the dev/eval loop for an implementation. Reads the active spec branch's tasks.md, picks the next phase with unchecked items, delegates implementation to the developing-features subagent and verification to the evaluating-phases subagent, and iterates until every task in every phase is checked. Use after /tasks has produced specs/NNN-<slug>/tasks.md.
---

# Build

Implement every phase from the active spec branch's `tasks.md`. Each phase loops through developer → evaluator until the evaluator passes.

## Configuration

Model assignment per subagent. Change these to control cost/quality tradeoffs:

| Subagent              | Model                              | Rationale |
|-----------------------|------------------------------------|-----------|
| developing-features   | $DEVELOPER_MODEL (default: sonnet) | Heavy code generation — sonnet balances speed and quality |
| evaluating-phases     | $EVALUATOR_MODEL (default: sonnet) | Browser verification — sonnet balances thoroughness and token cost |

Override by setting these variables before invoking `/build`, or edit the defaults above.

## Prerequisites

Resolve the active spec branch first: list the `specs/` directory and pick the highest-numbered (latest) `NNN-<slug>` subfolder — that is `<latest-branch>`. All spec paths below use this root.

Verify these exist:
- `specs/<latest-branch>/prd.md`
- `specs/<latest-branch>/plan.md`
- `specs/<latest-branch>/data-model.md`
- `specs/<latest-branch>/tasks.md`

If any are missing, tell the user to run the upstream skills first (`/write-prd`, `/plan`, `/tasks`).

## Run state cache (write once at the start of the run)

Before the first phase, write `pipeline/run-state.md` so subagents do not re-discover what you already resolved. Overwrite any existing file:

```markdown
# Run State

**Run type**: build
**Started**: <current ISO timestamp>
**Spec branch**: specs/<latest-branch>
**Phase count**: <total phases in tasks.md>
**Has designs/**: yes | no
**Constitution path**: .claude/constitution.md
```

Update the per-phase detail at the start of each phase (append or rewrite the **Phase in progress** block):

```markdown
**Phase in progress**: Phase <N> — Cycle <C>
**Phase name**: <e.g. Persistence>
```

Subagents will read this file before any other discovery. Do not list `specs/` or otherwise re-validate facts that already live here.

## Clean previous run artifacts (run once, before the first phase)

`pipeline/feedback/` and `pipeline/traces/` are per-run scratch space. Stale phase feedback files, screenshots, and JSONL traces from earlier builds are noise once a new run starts — they confuse the orchestrator when it scans for already-completed work, and they bloat trace digests with content from prior features. Run the cleanup helper once, before the first phase:

```bash
node .claude/scripts/clean-run-artifacts.mjs
```

The script wipes `pipeline/feedback/` and `pipeline/traces/` and leaves the persistent caches untouched (`build-log.md`, `environment-facts.md`, `procedures.md`, and `run-state.md` — the last is overwritten by the next orchestrator step anyway). Pass `--dry-run` to preview without touching the disk.

If the user has a reason to preserve a prior run's feedback, they should copy `pipeline/feedback/` somewhere safe before invoking `/build`.

## Process

Walk `specs/<latest-branch>/tasks.md` in order. For each phase that contains at least one unchecked `- [ ]` item, run the loop below. Phases whose items are all `- [x]` are skipped.

Per phase, max cycles: $MAX_CYCLES (default 5).

### Step 0 — Extract the phase block

Before invoking the developer or evaluator, extract just the lines for the phase in scope. Pass this as a fenced markdown block in both subagent prompts so neither has to re-read the full `tasks.md` every cycle — `tasks.md` typically runs 20–30 KB on a non-trivial feature, and re-reading it in both subagents on every cycle is pure waste.

```bash
PHASE_NUM=2  # the phase number in scope
awk -v n="$PHASE_NUM" '
  /^## Phase / { in_target = ($0 ~ "^## Phase " n ":") }
  in_target
' specs/<latest-branch>/tasks.md
```

The output is the phase heading plus every `- [ ]` / `- [x]` task line under it, ending where the next `## ` heading starts. Hold this output as the **phase block**.

**POSIX-awk gotcha for future modifications**: `\b` word boundaries are a GNU extension and are NOT in POSIX awk. If you ever need ID-based matching here (e.g. matching `T001` but not `T0010`), match the literal trailing space (`T001 `) rather than reaching for `\b`. Mis-matched IDs silently produce empty phase blocks, which then look like "no work to do" to the developer.

### Step 1 — Developer

Call the Agent tool with `subagent_type: "developing-features"` and `model: "sonnet"`. The prompt MUST include:
- Phase number, phase name, cycle number, spec branch
- A pointer to `pipeline/run-state.md`
- The phase block extracted in Step 0, as a fenced markdown block
- On retries: the path to the prior cycle's feedback file
- On retries: the **Carryovers list** copied verbatim from the prior cycle's feedback file, embedded as a fenced markdown block

#### Carryover extraction (retries only)

The evaluator writes a `## Carryovers (must fix next cycle)` section in every feedback file. On a retry, extract that block and paste it directly into the developer prompt — do not re-narrate it, do not summarise, do not reorder. The list is the operational contract:

```bash
PRIOR_FEEDBACK="pipeline/feedback/phase-${PHASE_NUM}-cycle-$((CYCLE - 1)).md"
awk '
  /^## Carryovers \(must fix next cycle\)/ { in_block = 1; next }
  in_block && /^## / { in_block = 0 }
  in_block
' "$PRIOR_FEEDBACK"
```

Embed the result in the developer prompt as:

```
## Carryovers from Phase [N] Cycle [C-1] (must fix BEFORE new tasks)

```
[paste carryover block here]
```

Fix every box above before any new phase task. Each box must be checked when you hand off — the next evaluator cycle will reject the phase if any are still open.
```

If the carryover block is empty (`_None — phase passes._`) but the orchestrator still scheduled a retry (e.g. score below threshold without High issues — uncommon but possible), fall back to passing the full feedback file path and let the developer infer.

### Step 1b — Verify environment facts gate

After the developer subagent returns and **before** invoking the evaluator, run:

```bash
node .claude/scripts/verify-environment-facts.mjs
```

This catches orphan dev-server processes the developer's `pkill` may have missed (commonly `next dev`, but the same pattern shows up with Vite, Remix, etc.) and wrong DB-path recordings in `pipeline/environment-facts.md`. **If it exits non-zero, do NOT invoke the evaluator** — log the failure and loop back to Step 1 with feedback to the developer. The developer should also have run this script in their own Step 4, but doing it here is defense in depth.

### Step 2 — Evaluator

Call the Agent tool with `subagent_type: "evaluating-phases"` and `model: "sonnet"`. The prompt should include the phase context AND the phase block — the agent file handles everything else:

```
Evaluate Phase [N] (<phase name>), Cycle [C].
Spec branch: specs/<latest-branch>/
Run state: pipeline/run-state.md
Procedures (login etc.): pipeline/procedures.md
Write feedback to: pipeline/feedback/phase-[N]-cycle-[C].md

Phase block (do not re-read tasks.md):
```
[paste the phase block here]
```
```

Do NOT add ToolSearch commands, browser rules, scoring rubrics, or verification steps to the prompt. The evaluator agent file has all of that.

### Step 3 — Check results

Read the evaluator's feedback file and output:
- Check for `<promise>COMPLETE</promise>` or `<promise>PERFECT</promise>` signals
- **Also read the feedback file** — do NOT just check the signal:
  - If there are any **[High]** severity issues, the phase does NOT pass regardless of score. Loop back to Step 1.
  - If **Unresolved Issues** from a prior cycle are still listed, the phase does NOT pass. Loop back to Step 1.
- PASS (signal present, no High issues, no unresolved carry-overs) → log success, move to next phase
- FAIL → log failure with specific issues, loop back to Step 1

## Logging

Append to `pipeline/build-log.md`:

```
Phase [N] — Cycle [C] — [Timestamp]

Developer: completed
Evaluator: PASS/FAIL — Score X.X/10
High issues: [list any High severity items, or "none"]
Unresolved from prior: [list any, or "none"]
Verdict: [PASS — moving to next phase / FAIL — retrying with feedback]
```

## Failure handling

- After max cycles, write unresolved issues to `pipeline/build-log.md`
- Report to the user what's blocking and which issues could not be resolved

## Rules

- Never implement or evaluate yourself — always delegate
- Each subagent gets fresh context automatically
- Pass `subagent_type` to the Agent tool: `"developing-features"` for developer, `"evaluating-phases"` for evaluator
- Keep the evaluator prompt minimal — only phase context. The agent file handles browser tools, rules, and scoring
- Pass the full feedback file path to the developer on retries
- A phase with unresolved High-severity issues NEVER passes, even if the score is above threshold
- If the evaluator's feedback has zero screenshots or says browser tools were unavailable, treat it as invalid and retry

## Design-fidelity issues are NEVER scope creep

This rule exists because of a real failure mode (Phase 4 of `002-landlord-dashboard`, 2026-05-15): the cycle-1 evaluator flagged a missing prototype region (a Portefeuille summary card present in `designs/dashboard.html` but absent from the implementation), and the orchestrator told the cycle-2 developer "do NOT add it — plan.md only enumerates 6 cards, this is scope creep." The phase then passed at 9.0/10 with the visual gap intact.

That was wrong. The prototype is the contract per the constitution's Design Fidelity principle. When `plan.md` and `designs/*.html` disagree about scope, the design wins for visual structure.

When you write the cycle-N+1 developer prompt:

- **NEVER** add an "explicitly out of scope" / "do NOT add" instruction for any item the evaluator flagged as a **design-fidelity gap** (missing prototype region, layout mismatch, structurally absent section). These are, by definition, in scope — the prototype defined the scope at `/design` time.
- If the evaluator flagged a missing region but the corresponding task is not in `tasks.md`, you have two options:
  1. **Preferred**: stop the loop, print "Design fidelity gap detected — `tasks.md` is missing tasks for prototype region(s) [...]. Re-run `/tasks` to merge in the missing regions, then re-invoke `/build`." Then exit without invoking another developer cycle. The user re-runs `/tasks` (which will merge in the orphan regions from `designs/coverage.md`) and re-invokes `/build`, which then continues the phase with the merged scope.
  2. **Acceptable** (when the gap is one or two items and re-running `/tasks` would be heavyweight): include the missing region in the next cycle's fix list AND in the same turn append the corresponding task(s) to `tasks.md` yourself with the Edit tool, so the evaluator's bookkeeping stays accurate.

The wrong move is the third option — telling the developer "don't bother, it's scope creep". Plan-vs-design tension is real, but it is resolved by updating the plan/tasks, not by ignoring the design.

The constitution's Design Fidelity principle is the tiebreaker, not `plan.md`'s files-to-touch table.
