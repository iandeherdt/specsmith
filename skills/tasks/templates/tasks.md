# Tasks: <Feature name>

**Plan**: [plan.md](plan.md)
**Data model**: [data-model.md](data-model.md)

<!--
Drop any phase below that the plan does not need.
For each implementation task, include a sibling check task the evaluator
verifies. No agent tags — the orchestrator routes; the evaluator decides done.
-->

## Phase 1: Foundation

- [ ] <Verb-led task — scaffolding, deps, config, env vars, base layout>
- [ ] <Sibling check — what the evaluator verifies>

## Phase 2: Persistence

- [ ] <task — migration, schema, seed, repository helper>
- [ ] <check — e.g. "Verify migration runs cleanly on empty DB and schema matches data-model.md">

## Phase 3: API

- [ ] <task — route handler, contract, validation>
- [ ] <check>

## Phase 4: UI

- [ ] <task — component, page, styling>
- [ ] <check>

## Phase 5: Integration

- [ ] <task — worker, external provider, job, webhook>
- [ ] <check>

## Phase 6: Hardening

- [ ] <task — error path, observability, performance, accessibility, i18n>
- [ ] <check — e.g. "Cover SC-001 with Playwright assertion">
