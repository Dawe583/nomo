---
description: "Use when starting or continuing a NOMO work package. Follow docs/CONTEXT.md, docs/DECISIONS.md, docs/STANDARDS.md, the active capability map, MVP spec and implementation plan."
---

# NOMO work package protocol

Read first, in order: docs/CONTEXT.md, docs/DECISIONS.md, docs/STANDARDS.md,
the NOMO capability map, MVP spec, implementation plan and package READMEs
involved. The pack is authoritative; code that disagrees is wrong; a pack that
is wrong gets updated by a package, never silently.

## Delegation

Use native harness delegation without project-level feature disablement. Start
subagents only when explicitly requested; the preference is at most five per
session, subject to lower native limits. Parallelize independent graph nodes
when paths are disjoint; assign one owner per path and one writer per graph.
Reuse the assigned worktree. Do not create one per role or solely for parallel
work. Preserve existing dirty files.

## Phases per package

A Scout: state current WP, prerequisites, smallest vertical slice, allowed
and forbidden files, exact exit commands written BEFORE implementation.
B Design: resolve routine choices from the existing product and safety contracts.
For a material decision with genuinely competing valid outcomes, record the
trade-offs and decision. Freeze a shared contract only when multiple writers
need it before implementation.
C Implement: give each independent writer disjoint owned paths in the assigned
  worktree. Create another worktree only for a real branch/path conflict under
  explicit authorization and the Worktrunk procedure.
D Integrate: one primary owner reviews and combines completed disjoint slices.
Do not add scope during integration. Run only authorized checks; tests require
user request.
E Verify: run every authorized exit criterion, capture real output. Do not add
  or run tests unless requested. When tests are requested, pnpm test here needs
  node --test --test-reporter=tap through scripts/src/check-tests.mjs aware
  paths (Node 26 emits spec reporter; the TAP parser chokes). For TUI: real
  PTYs at 80, 120, 200 columns; piped, NO_COLOR, TERM=dumb, CI; signals during
  raw mode. For providers: invalid key, rate limit, timeout, cancellation,
  malformed response, redaction.
F Adversarial review: skeptics with distinct lenses return JSON findings
  {file, line, severity, claim, repro, recommendation}. Default to refuted.
G Fix and re-verify: fix confirmed findings in worktrees, re-run.
H Evidence and handoff: files changed, commands run, findings resolved,
  limitations, next package. Do not commit, push, publish, deploy, or start
  hosted jobs unless the user explicitly requests that action in the current task.

## Non-negotiables

registry is data and pure functions, imports nothing. A connector never
imports another connector. Proxy resolves connectors by id. Ledger is
append and read only. UI consumes contracts and events, never reimplements
policy, classification, replay or ledger logic. Provider logic never enters
proxy, TUI or GUI. Secrets only via the secret store abstraction, never in
files, logs, events, ledger, storage or screenshots. Nothing autonomous
touches a production account.
