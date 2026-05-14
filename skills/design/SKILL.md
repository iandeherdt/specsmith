---
name: design
description: Run the design/critique loop for a feature. Reads the active spec branch's prd.md and plan.md, delegates prototype generation to the designing-interfaces subagent and rubric scoring to the critiquing-designs subagent, and iterates until the critic passes. Output is HTML/CSS prototypes under designs/. Use after /plan when a feature needs visual prototypes before /build.
---

# Design

Create all design prototypes for the active spec branch. Each cycle loops through designer → critic until the critic passes.

## Configuration

Model assignment per subagent. Change these to control cost/quality tradeoffs:

| Subagent             | Model                           | Rationale |
|----------------------|---------------------------------|-----------|
| designing-interfaces | $DESIGNER_MODEL (default: sonnet) | Creative generation — sonnet balances speed and quality |
| critiquing-designs   | $CRITIC_MODEL (default: opus)     | Critical judgment — opus is more thorough at finding issues |

Override by setting these variables before invoking `/design`, or edit the defaults above.

## Prerequisites

Resolve the active spec branch first: list the `specs/` directory and pick the highest-numbered (latest) `NNN-<slug>` subfolder — that is `<latest-branch>`. All spec paths below use this root.

Verify these exist:
- `specs/<latest-branch>/prd.md`
- `specs/<latest-branch>/plan.md`

If any are missing, tell the user to run the upstream skills first (`/write-prd`, `/plan`).

## Run state cache (write once at the start of the run)

Before the first cycle, write `pipeline/run-state.md` so subagents do not re-discover what you already resolved. Overwrite any existing file:

```markdown
# Run State

**Run type**: design
**Started**: <current ISO timestamp>
**Spec branch**: specs/<latest-branch>
**Has designs/**: yes | no
**Constitution path**: .claude/constitution.md
```

Update the per-cycle line at the start of each cycle:

```markdown
**Cycle in progress**: <C>
```

Subagents will read this file before any other discovery. Do not list `specs/` or otherwise re-validate facts that already live here.

## Clean previous run artifacts (run once, before the first cycle)

`pipeline/feedback/` and `pipeline/traces/` are per-run scratch space. Stale design-review feedback files, screenshots, and JSONL traces from earlier runs are noise once a new design loop starts — they bloat trace digests with content from prior features. Run the cleanup helper once, before the first cycle:

```bash
node .claude/scripts/clean-run-artifacts.mjs
```

The script wipes `pipeline/feedback/` and `pipeline/traces/` and leaves the persistent caches untouched (`build-log.md`, `environment-facts.md`, `procedures.md`, and `run-state.md` — the last is overwritten by the next orchestrator step anyway). Pass `--dry-run` to preview without touching the disk.

If the user has a reason to preserve a prior run's feedback, they should copy `pipeline/feedback/` somewhere safe before invoking `/design`.

## Process

Max cycles: $MAX_CYCLES (default 5).

For each cycle:

### Step 1 — Designer

Call the Agent tool with `subagent_type: "designing-interfaces"` and `model: "sonnet"`. The prompt should tell it which user stories from `prd.md` need prototypes and point it at `pipeline/run-state.md` for the spec branch. On retries include the feedback file path.

### Step 2 — Critic

Call the Agent tool with `subagent_type: "critiquing-designs"` and `model: "opus"`. The prompt should only contain the cycle context — the agent file handles everything else:

```
Evaluate design prototypes, Cycle [C].
Spec branch: specs/<latest-branch>/
Run state: pipeline/run-state.md
Write feedback to: pipeline/feedback/design-review-[N]-cycle-[C].md
```

Do NOT add ToolSearch commands, browser rules, scoring rubrics, or evaluation steps to the prompt. The critic agent file has all of that.

### Step 3 — Check results

Read the critic's output:
- PERFECT → log success, stop
- COMPLETE → log success, stop
- Neither → log failure, loop back to Step 1

## Logging

Append to `pipeline/build-log.md`:

```
Design — Cycle [N] — [Timestamp]

Designer: completed
Critic: PASS/FAIL — Score X.X/10
Issues: [summary if FAIL]
```

## Failure handling

- Write unresolved issues to `pipeline/build-log.md`
- Report to the user what's blocking

## Rules

- Never design or critique yourself — always delegate
- Each subagent gets fresh context automatically
- Pass `subagent_type` to the Agent tool: `"designing-interfaces"` for designer, `"critiquing-designs"` for critic
- Keep the critic prompt minimal — only cycle context. The agent file handles browser tools, rules, and scoring
- Pass feedback file paths to the designer on retries
- If the critic's feedback references HTML line numbers or says browser tools were unavailable, treat it as invalid and retry
