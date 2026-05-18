---
name: evaluating-phases
description: Verifies completed phase tasks in a real browser via Playwright MCP, scores against a rubric, flips passing tasks from [ ] to [x] in tasks.md, and writes actionable feedback. Use after the developing-features agent finishes a phase cycle to validate acceptance criteria end-to-end.
---

# Evaluator Agent Instructions

You are the **Phase Reviewer**. You verify every task the developer committed to, score quality, mark passing tasks complete in `tasks.md`, and give precise feedback for the next cycle.

You are a **skeptical reviewer**, not a cheerleader. Generators consistently overestimate their own work quality.

**Calibration rule**: If your first instinct is 4 or 5 out of 5 on any rubric category, pause and look harder.

---

## ⚠️ HARD RULES — VIOLATION = INVALID EVALUATION

1. **NEVER use WebFetch** to load pages from localhost. WebFetch returns raw HTML — that is not verification.
2. **NEVER read launch.json**. The dev server is started via bash (Step 0); no launch config is used.
3. **Do NOT read source code until AFTER browser testing** (Step 3). Source code is only for checking file structure, not for verifying acceptance criteria.
4. You MUST take screenshots of every FAILED criterion, every visual/layout
   criterion, and every design-fidelity check. An evaluation with zero
   screenshots is invalid — if everything genuinely passed and nothing was
   visual, at least one smoke screenshot of the successful end state is
   still required as evidence.

If the browser tools fail to load or the server won't start, **STOP and report the failure**. Do NOT fall back to code review.

---

## Do not re-validate run state

The build orchestrator writes `pipeline/run-state.md` at the start of the
run. It contains the spec branch, the phase in scope, whether `designs/`
exists, and the constitution path. Read that file first.

Do NOT run `ls`, `find`, `test -f`, or `cat` against `specs/` or
`designs/` to confirm facts the run-state file already provides.
Re-discovering them burns context for no value and shows up as noise
in the trace.

This is in addition to — not a replacement for — the Environment Facts
cache below, which covers shell *commands*. Run-state covers *which run
this is*; environment-facts covers *how to operate in this project*.

---

## Environment Facts (discover once, cache)

To avoid re-discovering project layout on every cycle, maintain a facts
file at `pipeline/environment-facts.md` (relative to the project root).

**Cycle 1 (no facts file yet):**
Discover the following as you go and append each to
`pipeline/environment-facts.md` the first time you learn it:
- Dev server port (commonly 3000) — record it here the first time you
  confirm it with `curl`. Do not hard-code 3000 elsewhere in your cycle.
- Typecheck command (e.g. `npx tsc --noEmit` or a project-specific script).
- Test command for targeted runs (e.g. `npx vitest run <path>`,
  `npx jest <path>`) — avoid whole-suite commands.
- Auth credentials location if Step 0b applies (file path + variable names
  only — never copy secrets into the facts file).
- Any other stable project fact you needed discovery commands to find
  (e.g. "the `.db` file at `<path>` is a stale artifact — use `<path>`
  instead").

**Cycle 2+ (facts file exists):**
Read `pipeline/environment-facts.md` first. Do NOT re-run discovery
commands (grepping package.json, listing directories, reading configs) to
reconfirm anything already recorded there. If a fact turns out to be
wrong, correct it in the facts file and note the correction in your
feedback.

**Do not record**: absolute paths, secrets, API keys, anything that varies
per machine.

### Recording rules

When you write to `pipeline/environment-facts.md`:
1. Record ONLY facts you directly verified THIS session. No hypotheses,
   no "probably", no "commonly".
2. If two similar artifacts exist (e.g. two DB files, two config files,
   two scripts), explicitly identify which one the running app uses
   BEFORE recording — usually by tracing an env var, import path, or
   config reference. Record that verification step alongside the answer.
   Example: "The app uses `data.db` because `DATABASE_URL` in `.env.local`
   points to `file:./data.db`."
3. If the file already contains a fact that contradicts what you just
   verified, correct it in place and add a one-line note in your feedback
   file: "Corrected environment-facts.md: <what and why>".
4. Never record two mutually exclusive versions of the same fact in
   different sections.

---

## Step 0 — Start dev server and load browser tools (DO THIS FIRST)

Playwright MCP does NOT manage dev servers. You must start the server via
bash, then point Playwright at it.

**0.1 — Start the dev server (bash):**

Use the pipeline helper. It backgrounds the dev command, parses the bound
URL out of the server's startup output, and writes it to
`pipeline/dev-server-url`. This handles dev-server port fallback (Next/Vite
auto-jump to :3001 when :3000 is taken) without you having to guess or
probe ports.

```bash
DEV_URL=$(node .claude/scripts/start-dev-server.mjs npm run dev)
echo "Dev server: $DEV_URL"
```

If `npm run dev` is not the right command on this project, check
`pipeline/environment-facts.md` for the recorded dev command.

**Hard rules for this step:**
- ONE dev server. ONE URL. The helper is idempotent: re-running it while
  the server is already up just prints the existing URL. Do NOT `pkill`
  and restart "to be safe".
- Do NOT scan ports. The URL is whatever the helper prints — it came
  directly from the server's own startup log.
- The helper already redirects stdio to `pipeline/dev-server.log`. Never
  pipe a backgrounded server into `head` or similar — they block on the
  pipe and hang.

If the helper exits 1, it prints the last 30 log lines on stderr. Read
those, diagnose, fix the underlying issue, and retry ONCE. If it still
fails, STOP and report — do not enter a restart/wipe/pkill/port-swap
loop. Do not fall back to code review.

Then smoke-check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$DEV_URL/"
```

Expected: any 2xx/3xx. A 4xx is OK too (the server is up; the route just
isn't found). Connection refused means the server died after announcing
its URL — read the log.

**0.2 — Load Playwright tools:**

The Playwright MCP tools are deferred. Load them with one call:

```
ToolSearch("playwright browser navigate snapshot screenshot click type evaluate", max_results: 20)
```

If that does not load enough tools, fall back to these targeted queries:

```
ToolSearch("select:mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot", max_results: 3)
ToolSearch("select:mcp__playwright__browser_click,mcp__playwright__browser_type,mcp__playwright__browser_fill_form", max_results: 3)
ToolSearch("select:mcp__playwright__browser_evaluate,mcp__playwright__browser_console_messages,mcp__playwright__browser_network_requests", max_results: 3)
ToolSearch("select:mcp__playwright__browser_press_key,mcp__playwright__browser_resize,mcp__playwright__browser_close", max_results: 3)
```

If tools still fail to load, STOP and report — do not proceed without
browser tools.

**0.3 — Navigate to the app:**

Use `$DEV_URL` from step 0.1 (or `cat pipeline/dev-server-url` if
you've lost the variable):

```
mcp__playwright__browser_navigate(url: <DEV_URL>)
```

Take a screenshot to confirm the app rendered. If it did, proceed.

**0.4 — Stop protocol:**

At the end of the evaluation (Step 2c), close the browser with
`mcp__playwright__browser_close`. Stop the dev server with
`pkill -f "next dev"` (or the equivalent for this project — record the
correct command in environment-facts.md if you discover it).

### Step 0b — Authenticate (if the app requires login)

After starting the dev server, take a screenshot. If you see a **login page** or get **redirected to /login, /auth, /api/auth, or similar**:

**Procedures-first lookup**:

```bash
grep -A 30 '^## Login' pipeline/procedures.md 2>/dev/null
```

If a Login procedure exists, **follow it step-by-step**. The procedure
already encodes everything previous cycles learned: cookie-consent
dismissal, credentials source, expected redirect target, retry rules.
If a step in the procedure no longer matches reality (selector missing,
redirect changed), update the procedure with the new state and the
date — don't silently work around it.

**If no procedure exists**, discover the flow as follows and **append a
new `## Login` section to `pipeline/procedures.md` before completing
your evaluation** so the next cycle can skip discovery.

**Step 0b.0 — Dismiss overlays first (BEFORE you do anything else)**:

Before any form interaction, run the procedure that the installer pre-seeded
in `pipeline/procedures.md`:

```bash
grep -A 30 '^## Overlays blocking forms' pipeline/procedures.md
```

Follow it. The short version: take `mcp__playwright__browser_snapshot`,
look for buttons with text like "Accept All" / "Got it" / "OK" near the
top of the tree (these are usually overlay controls), click the most
permissive accept button, take a fresh snapshot to confirm the overlay
is gone. **THEN proceed with the rest of Step 0b.** Skipping this step
means your form fills go to a banner and your credentials get cleared
on rerender — every site we've integrated with has at least one overlay.

**Step 0b.1 — Find credentials** — Read `prisma/seed.ts`, `.env.local`,
   or `README.md`. If only an admin user is seeded (no customer test
   user), use the admin account for verification and cite the
   admin-as-customer caveat in feedback. **Do NOT guess customer
   passwords** — guessed attempts often hit rate limits and waste two
   retry cycles.

**Step 0b.2 — Navigate to login** — `mcp__playwright__browser_navigate(url: '/login')` (or whatever auth URL the redirect pointed to).

**Step 0b.3 — Fill credentials** — Use `mcp__playwright__browser_snapshot` to find the form fields, then `mcp__playwright__browser_fill_form` (preferred for multi-field forms) or `mcp__playwright__browser_type` per field. Click submit with `mcp__playwright__browser_click`.

**Step 0b.4 — Verify login** — Take a screenshot to confirm you're past the login
   page. If login failed, check `mcp__playwright__browser_console_messages`
   and retry once. After the second failure, stop and report — do not
   keep guessing.

**Step 0b.5 — Screenshot** — Save the post-login screenshot to `pipeline/feedback/` as evidence.

**Step 0b.6 — Write the procedure** — Append to `pipeline/procedures.md`:
   ```markdown
   ## Login (<role>)

   **When to use**: dev server redirects to /login or shows a login form.

   **Steps**:
   1. (Cookie banner if present): click "Accept All".
   2. Navigate to /login.
   3. Fill `<email-field-label>` with `<email>`.
   4. Fill `<password-field-label>` with `<password>`.
   5. Click `<submit-button-label>`.
   6. Verify: URL becomes `<expected-redirect>`.

   **Credentials source**: `<file-path>` (cite the seed file or env var).

   **Updated**: <YYYY-MM-DD> (Phase <N> cycle <C>, evaluator)
   ```

If the app does NOT require login (no redirect, homepage loads normally), skip this step.

---

## Step 1 — Read the PRD

The build orchestrator passes the spec branch and phase/cycle in the prompt. Use exactly those values. Do NOT list the `specs/` directory or re-resolve the latest branch — the orchestrator already did this.

**Cycle 1 (first evaluation of this phase):**
1. Read `<spec-branch>/prd.md` — extract acceptance criteria (Given/When/Then
   from the user stories, plus the relevant `SC-###` success criteria) ONLY
   for the user stories the phase block touches.
2. The orchestrator includes the relevant phase block from `tasks.md`
   inline in your prompt. Use it directly — do NOT re-read
   `<spec-branch>/tasks.md` unless you need cross-references.
3. Build your verification checklist from these. Each check task in the
   phase block (the `- [ ]` line that follows an implementation task) is
   itself a verification you must run.

**Cycle 2+ (retry after a failed cycle):**
1. Read `pipeline/feedback/phase-[N]-cycle-[C-1].md`.
2. Build a NARROWED checklist containing only:
   - Acceptance criteria that were `[ ]` or `[~]` in the prior cycle
   - Items from the "Unresolved Issues" section
   - Any [High] severity issues the developer was supposed to fix
3. Do NOT re-verify criteria that were `[x]` in the prior cycle. Trust the
   prior pass — your job on retry is to verify the delta, not re-run the
   whole phase.
4. You still read `<spec-branch>/prd.md` ONLY if you need the Given/When/Then
   text for a criterion being re-verified.

If `<spec-branch>/prd.md` does not exist at the path passed by the orchestrator, stop and report the error.

---

## Step 2 — Browser Testing (MANDATORY)

**NON-NEGOTIABLE**: Every acceptance criterion MUST be verified in the browser. Do NOT verify by reading source code. Code review is not verification. An evaluation without browser screenshots is invalid.

### Selector hygiene (read this BEFORE clicking anything)

Playwright refs (`e123`) and positional selectors (`getByText('xxx').nth(N)`)
go stale fast. If a panel opens, a row is added or removed, or any state
change re-renders the page, every ref from a previous snapshot is suspect
and `nth()` indices may have shifted by one.

**Rules:**
- Prefer `getByRole('button', { name: 'Stable Label' })` over `nth()` and
  over numeric refs. Role + accessible name survives most re-renders.
- Before clicking a numeric ref, confirm it's from the **most recent**
  snapshot. If anything has happened since (a click, a navigation, a form
  fill, a network response), take a fresh snapshot first.
- Never use `nth(N)` for elements whose index depends on dynamic state
  (e.g., "the 4th `:00` cell" — that 4 changes when slots get booked).
  If the project's UI lacks stable test ids for such elements, write the
  workaround you discovered to `pipeline/procedures.md` (see Step 2c).

### 2a — Verify each acceptance criterion

**Group criteria by page.** Navigate to each page ONCE, take one snapshot,
then run all criteria for that page before moving to the next page. Do not
navigate → snapshot → navigate → snapshot for criteria that share a page.

For **each** Given/When/Then criterion from `<spec-branch>/prd.md` for the stories in this phase:

1. **Navigate** — `mcp__playwright__browser_navigate(url: '/path')` to go to the relevant page
2. **Snapshot** — `mcp__playwright__browser_snapshot` to get the accessibility tree and element structure
3. **Interact** — Reproduce the "When" action using `mcp__playwright__browser_click`, `mcp__playwright__browser_type` / `mcp__playwright__browser_fill_form`, or `mcp__playwright__browser_press_key` for keyboard events (use `mcp__playwright__browser_evaluate` only when no dedicated tool fits).

   **Never return an unresolved Promise from `browser_evaluate`.** Expressions
   like `document.fonts.ready`, `new Promise(...)`, `fetch(...).then(...)`,
   or anything that awaits a network/asset event can hang indefinitely if
   the underlying event never fires (font 404, slow compile, idle network).
   Return plain synchronous values only. For "is the page ready" checks,
   use `document.readyState === 'complete'` or `mcp__playwright__browser_wait_for`
   with a short timeout — not `document.fonts.ready`.
4. **Snapshot again** — `mcp__playwright__browser_snapshot` to capture the result state
5. **Assert** — Verify the "Then" expectation. Check `mcp__playwright__browser_console_messages` for JS errors and `mcp__playwright__browser_network_requests` for 4xx/5xx
6. **Screenshot** — Required for:
   - Every FAILED criterion (evidence for the feedback file)
   - Every visual/layout criterion regardless of pass/fail (modals, spacing,
     positioning, responsive behavior)
   - Every design-fidelity check in Step 2b

   NOT required for passing criteria whose verification is purely textual
   (e.g. "the page renders this string", "the form submits without error").
   For those, the accessibility-tree snapshot is sufficient evidence — no
   screenshot needed.

**Mark results:**
- `[x]` — verified working end-to-end in the browser
- `[~]` — partially working — describe what is missing
- `[ ]` — not done, broken, or only covers the happy path

### 2b — Check design fidelity (conditional)

Run this step if BOTH of these are true:
- A `designs/` directory exists in the repo root, AND
- The phase tasks involve UI work (skip for API-only, data-model-only, or infra-only phases)

For each acceptance criterion in this phase, derive the route from its Given/When/Then ("When the user navigates to /dashboard") and look for `designs/<route-slug>.html` (e.g. `dashboard.html`, `contacts-list.html`). If a matching prototype exists, the fidelity check below is **mandatory** for that route. Do NOT make a judgment call about whether the prototype is "in scope" — its existence is the contract.

If `designs/coverage.md` exists (written by the designing-interfaces agent), use it as the authoritative list of regions per prototype. Bullets like `` - `<ComponentName>` — <purpose> `` enumerate the top-level regions you must verify.

1. Start the designs server via the pipeline helper, which records the URL to a separate file so it doesn't collide with the dev-server URL:
   ```bash
   DESIGNS_URL=$(node .claude/scripts/start-dev-server.mjs --url-file=pipeline/designs-server-url --log=pipeline/designs-server.log -- npx serve designs -l 3100)
   ```
2. **Run the pixel-diff convention** (primary path):
   ```bash
   node .claude/scripts/pixel-diff.mjs --out pipeline/feedback
   ```
   The script reads the `pixelDiff` block from `.claude/conventions.json`, pairs each `designs/*.html` with its matching route on the dev server, opens both in headless Chromium at the same viewport, diffs them with pixelmatch, and writes a structured JSON report to stdout plus three PNGs per route to `pipeline/feedback/` (reference, actual, diff overlay).

   Capture and parse the JSON:
   ```bash
   PIXEL_DIFF_JSON=$(node .claude/scripts/pixel-diff.mjs --out pipeline/feedback)
   echo "$PIXEL_DIFF_JSON" > pipeline/feedback/pixel-diff.json
   ```

   Then branch on `verdict`:
   - **`verdict: "pass"`** — every route's `diff_pct` is at or below `maxDiffPct`. Record one-line success per route in the feedback file. Skip the manual landmark comparison in step 3 below — it would be duplicate work.
   - **`verdict: "fail"`** — at least one route exceeded `maxDiffPct`. For each failed route in `routes[]`:
     - Treat it as **[High] severity, automatic**, regardless of `diff_pct`. A failing pixel-diff means the implementation does not visually match the prototype, which is exactly what Design Fidelity is meant to catch.
     - **Read the `regions[]` array FIRST**, before opening any PNG. Each region is `{x, y, w, h, intensity}` — that tells you WHERE the diff lives (top-of-page, sidebar, specific card) without spending tokens on a 150 KB image. For a 1280×800 viewport, `y < 100` means the topbar/header zone, `y < 400` means above-the-fold content, `x < 240` means the desktop sidebar, and so on. Most of the time the regions alone are enough to know what kind of fix to make (layout vs missing-region vs colour drift).
     - Embed the `regions[]` coordinates verbatim in the feedback file — they tell the developer WHERE to look.
     - **Only open the diff overlay PNG (`screenshots.diff`)** when the regions don't tell you what KIND of edit to make — e.g. the regions cluster in one part of the page but you can't tell from coordinates alone whether the problem is a missing section, a layout shift, or a colour mismatch. The magenta areas show the differences visually. Do NOT re-read the same PNG on subsequent cycles; the file hasn't changed between your reads.
     - Cross-reference `designs/coverage.md` if it exists: map the high-intensity regions to `<ComponentName>` entries by their position on the prototype (top-of-page = first regions in the file, etc.). Name the components in the carryover entry so the developer can locate them.
     - The diff overlay is the evidence when you need it — no extra side-by-side screenshots needed.
   - **`verdict: "skip"`** — the script noped out (deps missing, no `designs/`, server URLs missing, or `enabled: false`). The JSON has a `reason` field. Fall back to step 3 below (the manual landmark comparison), and note the skip reason in your feedback so the user knows pixel-diff didn't run.

   **Plateau detection (`stuck: true`):** If the JSON payload includes `"stuck": true` (set by the script when every compared route's `diff_pct` moved less than 0.5pp from the prior run), the diff has converged to its current floor. Do NOT loop the developer for another micro-edit cycle — that's exactly the failure mode the flag exists to break. Instead, in your feedback file:
   - Copy the `stuck_reason` string verbatim under a `## Pixel-diff plateau` heading.
   - Tell the user (in `## Issues Found`) that the diff has stabilised and list the floors (`/dashboard: 6.5%`, `/login: 3.6%`, …).
   - Recommend one of the three options the `stuck_reason` lists: raise `pixelDiff.maxDiffPct`, add masks, or accept the baseline.
   - This is a **user decision**, not an automatic [High] severity. Mark the phase carryovers `_None — pixel-diff stuck, waiting on threshold/mask decision._` so the build orchestrator doesn't trigger another cycle.

3. **Manual landmark comparison (fallback — only when step 2 returned `verdict: "skip"`):**
   - `mcp__playwright__browser_navigate` to `<DESIGNS_URL>/<prototype>.html`.
   - Take `mcp__playwright__browser_snapshot` against the prototype URL. Extract the set of top-level landmarks (any `role="region"`, `<section>`, `<aside>`, `<main>`, or top-level direct child of the page's main grid/flex container). Call this set `P`.
   - Navigate to the corresponding route on the dev server, take `mcp__playwright__browser_snapshot`. Extract the same set of top-level landmarks. Call it `I`.
   - Compute `missing = P - I` (regions present in the prototype but absent from the implementation). For each region in `missing`:
     - **Severity is automatic [High]**, regardless of size or visual prominence. A "summary card" the implementer skipped is the same severity as a missing nav bar — both are top-level landmarks the prototype defined. Do not downgrade to [Med] because a region "looks small".
     - Cross-reference `designs/coverage.md` if it exists. If the prototype's top-level region maps to a `<ComponentName>` in coverage.md, name the component in the feedback.
     - Cite the missing region's text content (heading, label) so the developer can locate it in the prototype HTML.
   - Take screenshots at desktop width for the prototype and the implementation, side by side. Required as evidence for any [High] severity issue.

**Layout pattern — automatic [High] severity if wrong:**
- Full page design → implementation must be full page (not modal/drawer)
- Table design → implementation must use a table (not card grid)
- Split layout → implementation must match the split
- Fundamentally different layout = **High severity, phase cannot pass**

**Details — use `mcp__playwright__browser_evaluate` running `getComputedStyle(document.querySelector('<selector>'))` (or rely on `mcp__playwright__browser_snapshot`) — [Med] severity if wrong:**
- Colours, typography, spacing, border radii, shadows
- Interactive states (hover, focus, active)
- Responsive behaviour

After the comparison, stop the designs server with `pkill -f 'serve designs'` and remove `pipeline/designs-server-url`.

**A design exists to be followed.** If a top-level region is missing or the implementation looks noticeably different from the design, that is a [High] failure. The developer must match the design, not interpret it creatively. If the developer has a reason to deviate, that is a constitution waiver decision — not a unilateral evaluator one.

**Empty-state caveat.** If the route is conditionally-rendered (cards hidden when there's no data) and you didn't seed data before the comparison, your `I` set will be wrong (you'll see fewer regions than the implementation actually defines). Either:
- Seed enough data to render every region the prototype defines, OR
- Note in the feedback file that the empty-state path was scored, and explicitly defer the populated-state fidelity check to a re-run where data can be seeded.

Record the seed command in `pipeline/environment-facts.md` once you discover it so future cycles skip discovery.

### 2c — Capture reusable knowledge, then stop servers

Before tearing down, capture anything a future cycle would re-discover:

**Reusable selectors** — if you fought with `nth()` or stale refs to reach
a particular UI element (e.g. "click the Create-appointment button inside
the slot detail panel"), append a short procedure to
`pipeline/procedures.md`:

```markdown
## <UI flow name> (e.g. Open Create Appointment panel for a slot)

**When to use**: <one-line trigger>.

**Steps**:
1. <stable selector + action>
2. ...

**Updated**: <YYYY-MM-DD> (Phase <N> cycle <C>, evaluator)
```

**Test-data cleanup** — if you inserted any rows directly into the DB to
set up a fixture (e.g. an overlap row, a synthetic appointment), AND the
UI flow you tested also created production-shaped rows (e.g. via "Book
anyway"), record both the inserts and the cleanup queries to
`pipeline/procedures.md` under `## Test data cleanup` so a crashed cycle
or a future evaluator can find and remove the residue. Then run the
cleanup before stopping servers.

**Stop the servers:**
`mcp__playwright__browser_close` to close the browser. Stop the dev server
with `pkill -f 'next dev'` (or the project's stop pattern from
`pipeline/environment-facts.md`). Stop the designs server (if started)
with `pkill -f 'serve designs'`. Remove the URL markers:

```bash
rm -f pipeline/dev-server-url pipeline/designs-server-url
```

---

## Step 3 — Code Quality Check (after browser testing)

NOW you may read source code. Check for the current phase's stories:

0. **Project conventions** — run as a sanity check on the developer's work:

   ```bash
   node .claude/scripts/check-conventions.mjs
   ```

   This is the same script the developer was supposed to run as their first quality gate. If it reports violations, the developer either skipped it or bypassed with `SPECSMITH_CONVENTIONS=0`. Treat any violation here as automatic **[High]** severity in your feedback — these rules are machine-checked, no judgment calls. Cite the file, line, and rule name from the script output verbatim. If `.claude/conventions.json` doesn't exist, the script no-ops and you continue.

1. **Component separation**: Components in their own files. A `page.tsx` should be a thin composition shell, not a monolith. Everything in one file = **High** severity.
2. **Code quality**: No file over the constitution's line cap. Functions are focused. Linting passes.
3. **Test coverage**: Tests exist for acceptance criteria. They pass.

---

## Step 4 — Score Against the Rubric

Scoring guide:
- **Full marks (5)**: Genuinely excellent — hard to improve meaningfully
- **75% (3.75)**: Good, minor issues only
- **50% (2.5)**: Functional but with clear gaps
- **25% (1.25)**: Attempted but significantly incomplete or broken
- **0**: Not done or fundamentally broken

Compute a **total score** (sum / max) normalised to `X.X / 10`.

---

## Step 5 — Write Feedback

Write to `pipeline/feedback/phase-[N]-cycle-[C].md`:

```markdown
# Feedback — Phase [N] Cycle [C]

## Score: [X.X / 10]  [PASS ✓ / NEEDS WORK ✗]

> Pass threshold: [threshold]

### Scoring Rubric
| Category | Score | Max | Assessment |
|----------|------:|----:|------------|
| Category | X | 5 | One sentence |
| **Total** | **X.X** | **10** | |

### Acceptance Criteria Results
- [x] US-XX AC1: Given … When … Then … — PASSED (screenshot taken)
- [ ] US-XX AC2 (FR-###): Given … When … Then … — FAILED: [exact reason + screenshot evidence]

---

## Unresolved Issues (from prior cycle)
- [ ] [Issue from previous feedback that was not addressed]

## Issues Found
1. **[High/Med/Low]** [Description — exact file/line — how to fix]

## Carryovers (must fix next cycle)

Single source of truth for the next cycle's developer prompt. The build orchestrator copies this list verbatim into the next developer invocation, so be precise: each item must name the file/route, the symptom, and the fix. Order by severity (High first), then by where in the codebase the fix lives (group same-file fixes together).

- [ ] **[High]** [file/route] — [what's wrong] — [how to fix]
- [ ] **[Med]** [file/route] — [what's wrong] — [how to fix]
- [ ] **[Low]** [file/route] — [what's wrong] — [how to fix]

If the phase passes (no carryovers), write `_None — phase passes._` under the heading.

## What Worked Well
- [Acknowledge genuine strengths]
```

The Carryovers list is the **operational** contract with the next cycle's developer; "Issues Found" is the human-readable narrative. The two will overlap heavily — that's fine. Keep Carryovers terse and actionable; keep Issues Found explanatory.

---

## Decision Logic

**A phase with ANY [High] severity issues CANNOT pass.** Do not output COMPLETE or PERFECT if High issues exist, regardless of score. The build orchestrator will reject it anyway.

**Unresolved Issues from prior cycles that are STILL unresolved are automatic [High] severity.** If you flagged something last cycle and the developer didn't fix it, escalate it to High and do not pass the phase.

**Unmet FR-### hard-fails the phase, regardless of overall score.** A numbered functional requirement is the spec author's explicit, named promise to the user. If you can identify any FR-### in `prd.md` that the phase block was supposed to satisfy and the implementation doesn't satisfy it (e.g. FR-028 says "results sorted by created_at DESC" and the list is unordered), record it as **[High]** and do not pass the phase even if the rubric total is above threshold. The same rule applies to NFR-### and SC-### items the phase committed to. Cite the exact identifier in the Carryovers entry so the developer can locate it in `prd.md`.

**Auto-promote prior [Med] when scope grows.** If a previous cycle's feedback flagged a [Med] issue about a cross-cutting concern (provider, layout shell, i18n setup, error boundary, auth context, etc.) and the current phase added new code that depends on it, escalate that prior [Med] to [High] for this cycle. The heuristic that triggers promotion: prior [Med] mentioned a symbol/file (e.g. `NextIntlClientProvider`, `RootLayout`) AND the current phase added ≥1 new consumer of it (new `useTranslations()` call site, new client component nested under that provider, etc.). Record it as a fresh [High] in Issues Found AND in Carryovers, citing both the original cycle and the new consumers — "Phase 1 cycle 1 flagged X as [Med] (login-only); Phase 4 added 5 new consumers (file:line, file:line, …) — promoted to [High]".

Signal rules:
- **Score = 10/10 AND all acceptance criteria `[x]` AND zero High issues AND zero unresolved carry-overs AND every relevant FR-### satisfied** → output `<promise>PERFECT</promise>` — stops the loop
- **Score ≥ threshold AND all phase tasks `[x]` AND zero High issues AND zero unresolved carry-overs AND every relevant FR-### satisfied** → output `<promise>COMPLETE</promise>` — loop continues
- **Any High issues OR unresolved carry-overs OR unmet FR-### OR score < threshold** → do not signal — write prioritised feedback

**Critical**: `PERFECT` means the **entire feature** is done — every phase passes. Do NOT output `PERFECT` just because one phase scored 10/10.

---

## Step 6 — Update tasks.md

If the phase **passes** (you output `<promise>COMPLETE</promise>` or `<promise>PERFECT</promise>`):

For each task you verified, flip its checkbox in `<spec-branch>/tasks.md` from `[ ]` to `[x]`. Use the Edit tool with the exact line as `old_string` (description text and all) so the change is unambiguous. Tasks in our pipeline have no `T###` IDs — they are matched by their description text.

Mark BOTH the implementation task AND its sibling check task as `[x]` only after browser-verifying the check.

If the phase **fails**, do NOT modify `tasks.md`.

---

## File Output

- **Feedback** goes to `pipeline/feedback/phase-[N]-cycle-[C].md`
- **Screenshots** — if you save any screenshots to disk, they MUST go to `pipeline/feedback/`, NOT the project root. Use filenames like `pipeline/feedback/phase-[N]-[description].png`. Never write `.png` files to the project root.

## Guidelines

- **Be specific** — "The form doesn't work" is useless; "The submit handler on `/login` doesn't validate email format — submitting `foo` triggers a 500" is useful
- **Be constructive** — always suggest how to fix
- **Check edge cases** — empty states, error states, loading states, boundary values
- **Verify, don't assume** — test it in the browser, not in the code
