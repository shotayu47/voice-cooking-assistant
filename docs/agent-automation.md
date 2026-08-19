# Agent automation workflow (`agent-ready`)

This is a developer-facing guide to how the `agent-ready` label automates
Claude Code against an Issue in this repository. It describes what actually
happens today, based on `.github/workflows/claude-agent-ready.yml`.

## 1. Trigger

Adding the `agent-ready` label to an **open** Issue starts a GitHub Actions
job (`Claude Agent Ready`) that runs Claude Code against that Issue. The job
does nothing on closed Issues or for any other label.

## 2. What Claude reads first

Before making any change, Claude is instructed to read, in order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/implementation-roadmap.md`

The Issue body is treated as the complete task specification. Claude follows
the repository's existing scope and quality gates rather than inventing new
ones, and is explicitly told not to rebuild a PHASE that the roadmap already
marks `COMPLETE`.

## 3. Branch, commit, push

Claude works on a dedicated branch created for the Issue (not `main`). It
makes only the changes the Issue asks for, runs the required quality gates,
then commits and pushes that branch itself — the workflow does not push code
on Claude's behalf.

Claude is explicitly disallowed from:

- modifying or revealing secrets
- modifying GitHub workflow files (`.github/workflows/**`)
- merging branches

If a task needs an external or manual step (e.g. a migration apply, a
production deploy, real-device QA), Claude reports that instead of guessing
that it happened.

## 4. Automatic PR creation

After Claude's run finishes, if it pushed a branch with commits that differ
from `main`, the workflow itself (not Claude) opens the pull request:

- Base: `main`, head: the branch Claude pushed
- Title: the Issue title
- Body: references the source Issue and notes that human merge is required
  and that CI is dispatched explicitly

If a PR for that branch already exists, the workflow reuses it instead of
creating a duplicate.

## 5. CI is dispatched explicitly

Repository CI (`.github/workflows/ci.yml`, running `npm run typecheck`,
`npm run lint`, `npm test`, `npm run build`) only runs automatically on
`pull_request` events targeting `main`, or via manual `workflow_dispatch`.
Because the PR above is created by the workflow via `gh pr create` (not by a
human push), GitHub does not always fire a fresh `pull_request` check run for
it. To make sure CI actually runs against the new branch, the workflow
explicitly dispatches it:

```
gh workflow run ci.yml --ref "<branch-name>"
```

This happens right after PR creation, once per successful PR.

## 6. Merge remains manual

The workflow never merges anything. A human reviews the PR, checks CI
results, and merges (or requests changes) manually.

## 7. Real-device / manual QA remains human responsibility

Claude Code and CI can run automated checks (typecheck, lint, unit tests,
build) but cannot perform real-device or manual QA (e.g. iPhone testing, as
tracked in `docs/iphone-test-checklist.md`, or production smoke checks after
a Vercel deploy). Those remain a human responsibility and should not be
assumed to have happened just because CI is green.

## 8. Related files

| File | Role |
|---|---|
| `.github/workflows/claude-agent-ready.yml` | Runs on Issue `labeled` with `agent-ready`; runs Claude, opens the PR, dispatches CI |
| `.github/workflows/claude.yml` | Runs Claude Code on `@claude` mentions in comments/reviews/new issues (separate trigger, not covered in detail here) |
| `.github/workflows/ci.yml` | Quality gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` |
| `AGENTS.md` | Repo-wide agent rules, read first by Claude |
| `CLAUDE.md` | Project instructions, read first by Claude |
| `docs/implementation-roadmap.md` | Source of truth for PHASE progress; Claude must not redo `COMPLETE` PHASEs |
