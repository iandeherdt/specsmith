---
name: grill-me
description: Drives an interactive requirements-gathering interview for a new feature, customer feedback, bug report, or half-formed idea. Use when the user wants Claude to ask the clarifying questions that surface assumptions, constraints, success criteria, and edge cases before any PRD is written. The output is the conversation; run /write-prd next to commit it to a file. For pressure-testing an existing plan, use /grill-plan instead.
---

# Grill me

A requirements-gathering interview. Interrogate the user's input until the shape of what they want is concrete enough to write down. Do not write any files.

## Recognize the input shape

The user supplies one of:

- **Feature idea**: "We want users to be able to..."
- **Customer feedback**: a verbatim quote, support ticket, or paraphrased complaint
- **Bug report**: a description of broken behavior the fix should address
- **Vague gripe**: "X is annoying", "we need to do something about Y"

If the user instead points at an existing `plan.md`, redirect them to `/grill-plan` — that skill is purpose-built for plan review.

Open by restating what you heard in one or two sentences and confirming the input shape. For customer feedback, separately surface the **implied pain point** from the **literal request** — they are often different, and the literal request is rarely the right thing to build.

## What to grill on

Cover these dimensions before declaring the interview complete. Skip dimensions that obviously do not apply, but say so explicitly rather than silently dropping them.

- **Users**: who experiences this? primary, secondary, edge populations?
- **Job to be done**: what are they trying to accomplish, not what feature do they want?
- **Current workaround**: what do they do today, and what is wrong with it?
- **Success criteria**: how will we know this worked? observable, ideally measurable.
- **Non-goals**: what are we explicitly NOT doing in v1?
- **Constraints**: regulatory, performance, security, deadline, budget, team, data residency
- **Dependencies**: external systems, other teams, data we need
- **Edge cases**: empty state, offline, at-scale, first-run, permissions, locale
- **Open questions**: anything the user cannot answer yet — name them, do not paper over

## How to ask

- Ask 1–3 questions at a time. A wall of questions kills momentum.
- Push back on vague answers ("everyone", "fast", "soon", "better"). Demand a concrete metric, population, or threshold.
- When the user contradicts something they said earlier, surface the contradiction. Do not quietly let it pass.
- Every 5–10 turns, summarize what has been agreed in a short bullet list and ask "does this match what you mean?" Use the user's own words where possible.

## When to stop

Recommend the user run `/write-prd` when **all** of these are true:

- Each dimension above is either answered or explicitly logged as an open question
- The user's last 2–3 answers have been "yes that's right" or short clarifications, not new content
- You can imagine writing FR-001…FR-N from the conversation without inventing details

If the user tries to stop earlier, name what is still missing in one short list before agreeing.
