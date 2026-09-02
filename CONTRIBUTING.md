# Contributing

PatchPilot is an internal Black Iron Technology Group project — this doc is for
whoever's touching the code next (including a future Claude Code session), not
an external contributor process.

## Before you start

Read the [README](README.md) — in particular "Non-negotiables (architecture
invariants)" and "Remediation channels (core IP)". Those constraints (per-tenant
delegated auth, read-only-first, graceful licensing degradation) apply to every
change, not just the area you're touching.

## Workflow

- Branch per phase/feature, named `phase-N-short-description` (see `git branch`
  for existing examples). Work directly on `master` only for a trivial one-line fix.
- Before opening a PR or asking for review, run the full check suite from the repo
  root:

  ```bash
  npx turbo run typecheck test lint build
  ```

  CI (`.github/workflows/ci.yml`) runs the same command on every PR — a red run
  locally will be red there too.
- Keep commits scoped and descriptive (`git log --oneline` for the house style —
  short, imperative, prefixed with the phase/area when useful).
- Don't run `pnpm run seed` against a database that might hold real tenant data —
  it unconditionally wipes and reseeds demo fixtures. Check `DEMO_MODE` and the
  target database first.

## Code conventions

- No new abstractions or config flags for hypothetical future needs — match the
  codebase's existing preference for direct, explicit code over premature
  generalization.
- Every route/query that touches tenant data filters by `tenantId` at the query
  level, not after the fetch (see `apps/api/src/ai/summarize.ts`'s comments for
  the one deliberate, documented exception).
- A channel, catalog pick, or source that doesn't actually dispatch yet must
  carry the `availability: "preview"` convention (see `channels.ts`/`sources.ts`)
  and an honest UI label — never let a simulated action look identical to a real
  one.

## Testing

- Unit/component tests: `pnpm test` (Vitest) — colocated `*.test.ts(x)` files.
- End-to-end: `pnpm --filter @patchpilot/web e2e` (Playwright) — see
  `apps/web/e2e/`.
- New DB- or Redis-backed logic should get a real-service test where practical
  (see `apps/api`'s `*.integration.test.ts` files, which run against the dev
  Docker Compose stack — `pnpm infra:dev:up` then `pnpm --filter @patchpilot/api
  test:integration`) in addition to the mocked unit test, since mocks alone
  won't catch a real query/schema drift.
