# Agent Automation Workflow

This project can hand off well-scoped GitHub Issues to Claude Code. This is a
concise reference for how that automation behaves.

## 1. Trigger

Adding the `agent-ready` label to an open Issue starts Claude Code. The
labeled Issue body is treated as the complete task specification — Claude
does not infer additional scope beyond what the Issue describes.

## 2. Context Claude reads before editing

Before making any change, Claude reads:

- `AGENTS.md` — repo-wide agent conventions and constraints
- `CLAUDE.md` — project instructions (in this repo it points back to
  `AGENTS.md`)
- `docs/implementation-roadmap.md` — the source of truth for which
  implementation PHASE is complete, which is next, and what still needs a
  manual step

These files take precedence over default agent behavior.

## 3. Implementation

Claude works on a dedicated branch created for the Issue, makes only the
changes requested in the Issue body, and then commits and pushes that branch.
It does not rebuild work already marked complete in the roadmap, and it does
not expand scope beyond the labeled Issue.

## 4. Pull request and CI

Once the branch is pushed, the workflow opens a pull request from that branch
and dispatches the repository's CI. Deterministic quality gates (typecheck,
lint, tests, build, etc.) run there, after the PR is created — not as part of
the agent's own turn.

## 5. What stays manual

- **Merging** the pull request remains a manual, human decision. Claude does
  not merge branches.
- **Real-device and manual QA** (for example, verifying behavior on an actual
  iPhone, or any check that isn't part of the automated CI gates) remains
  human responsibility. Claude will not claim this kind of verification
  succeeded unless it was actually performed and observed.
