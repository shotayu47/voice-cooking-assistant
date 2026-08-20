# Autonomous development workflow

TSUGU uses GitHub as the control plane for bounded autonomous development.
The roadmap and repository history remain the source of truth.

## Current flow

1. A push/merge to `main` triggers `Autonomous Phase Kickoff`.
2. Kickoff dispatches `Autonomous Phase Dispatcher` explicitly.
3. Dispatcher reads `docs/implementation-roadmap.md` and selects the first `NOT_STARTED` PHASE.
4. If that PHASE already has an open autonomous issue, Dispatcher exits without creating a duplicate.
5. A read-only Claude planner inspects the roadmap, relevant design docs, source, and tests and returns a structured implementation contract.
6. GitHub Actions validates the contract and classifies protected/high-risk work deterministically.
7. Safe work becomes an `autonomous-phase` + `agent-ready` issue and the implementation workflow is explicitly dispatched.
8. Claude implements only that issue, pushes a branch, and GitHub Actions creates a PR.
9. CI runs typecheck, lint, tests, and build.
10. After successful CI, an independent read-only Claude reviewer returns PASS or FAIL.
11. FAIL may enter the bounded fixer loop; every repair must return through CI and independent review.
12. PASS does not merge automatically. Human merge remains the release gate.
13. The next `main` merge starts the cycle again.

An hourly Dispatcher schedule is retained as a fallback in case a kickoff run is delayed or missed.

## Safety boundaries

Automation must stop and route to `human-required` when work requires or unexpectedly reaches:

- GitHub workflows or agent policy
- auth or middleware
- RLS or database policies
- database migrations/schema changes
- secrets or environment handling
- destructive data operations
- production infrastructure

Additional bounds:

- one roadmap PHASE at a time
- same reviewed commit SHA is not reviewed twice
- at most three automated review calls per PR
- stale repair requests are ignored
- protected-path repair attempts are not pushed
- reviewer has read-only repository access
- fixer edits files but GitHub Actions owns validation, commit, and push
- no automated merge

## Human QA boundary

Deterministic repository checks belong to CI. Real-device or empirical checks that cannot be proven in GitHub Actions remain explicit manual QA, including iPhone Safari/PWA behavior, microphone/audio behavior, and other device-specific UX observations.

The autonomous pipeline must not claim manual QA, migration application, production deployment, or external-service verification succeeded unless it was actually observed.
