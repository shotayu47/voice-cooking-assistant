<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Resuming the long-running feature build

Before starting any new work, read `docs/implementation-roadmap.md`. It records
which PHASE is complete, which is next, and what still needs a manual step.
Together with `git log` it is the source of truth — do not rebuild a PHASE that
is already marked COMPLETE.

One PHASE at a time: implement → test → update the roadmap → commit → push.
