# Project Constitution

## Core Principles

### I. Test-First (NON-NEGOTIABLE)

- All functionality MUST have accompanying tests. No test, no pass.
- Every bug fix MUST include a regression test that reproduces the
  bug before the fix is applied.
- Tests MUST NOT be deleted unless the code they cover is also
  deleted. If a test fails, investigate why the test exists and fix
  the root cause — do not remove the test.
- Red-Green-Refactor: write the failing test first, then implement
  the minimum code to pass, then refactor.

### II. Security-First

- Security MUST be considered at every step of development, not
  as an afterthought.
- All user input MUST be validated and sanitized at system
  boundaries.
- Dependencies MUST be audited for known vulnerabilities before
  adoption and kept up to date.
- Authentication, authorization, and data handling MUST follow
  OWASP Top 10 guidelines.
- Secrets MUST NOT be committed to the repository under any
  circumstances.

### III. Code Quality & Complexity Control

- No file MUST exceed 500 lines of code.
- Functions MUST remain short and focused. Use SonarQube cognitive
  complexity rules as the measure — high nesting depth, long
  parameter lists, and deep indentation are violations.
- Indentation depth MUST be minimized; prefer early returns and
  guard clauses over nested conditionals.
- Code MUST pass linting and formatting checks before merge.

### IV. Component Separation & File Organization

- UI components MUST be extracted into their own files — no large
  inline JSX structures.
- Icons MUST live in dedicated icon component files.
- CSS/utility classes, business logic, and presentation MUST be
  in separate files.
- Each file MUST have a single, clear responsibility.

### V. Library-First

- If a high-quality open-source package exists for a problem (as
  measured by stars, active maintenance, and community adoption),
  it MUST be used instead of writing a custom implementation.
- "High quality" means: actively maintained (commits within the
  last 6 months), significant community adoption, no unresolved
  critical security advisories.

### VI. Database Changes via Migrations

- All database schema changes MUST be performed through migrations.
  Never modify the database directly or edit existing migration files.
- Each migration MUST be a new, sequentially versioned file that can
  be applied and rolled back independently.
- Seed data MUST be maintained in dedicated seed files, not inlined
  in migrations.
- Migration files MUST NOT be deleted or modified after they have
  been applied to any environment.

### VII. Design & Architecture Fidelity

- When a design exists (Figma, mockup, wireframe), it MUST be
  followed to the pixel. Designs are specifications, not
  suggestions.
- When an architecture has been defined (in specs, plans, or
  diagrams), it MUST be implemented exactly as specified.
- Deviations from design or architecture require explicit approval
  and documentation of the rationale.

## Development Workflow

- Every pull request MUST include tests that cover the changed
  functionality (Principle I).
- Security review MUST be part of every code review (Principle II).
- File size and complexity MUST be checked before merge
  (Principle III).
- Component structure MUST be verified — no monolithic files
  (Principle IV).
- New dependencies MUST be evaluated against existing packages
  and the Library-First principle (Principle V).
- Database changes MUST go through migrations — no direct schema
  edits (Principle VI).
- Visual diff against designs MUST be performed for any UI change
  (Principle VII).

## Governance

- This constitution supersedes all other development practices
  for this project.
- Amendments require: (1) a documented rationale, (2) review by
  at least one team member, and (3) a migration plan for any
  existing code that violates the new rules.
- Version follows semantic versioning:
  - MAJOR: principle removed or fundamentally redefined.
  - MINOR: new principle or section added, or material expansion.
  - PATCH: clarifications, wording, typo fixes.
- Compliance MUST be verified during code review. Reviewers MUST
  reference specific principles when requesting changes.
