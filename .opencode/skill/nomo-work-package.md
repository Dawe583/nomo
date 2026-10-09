---
description: "Use when starting or continuing a NOMO work package (WP-NN or AW-NN). The exact phase protocol, exit evidence requirements, and commit rules from docs/EXECUTION-PLAN.md and docs/GLM-5.3-MASTER-PROMPT.md."
---

# NOMO work package protocol

Read first, in order: docs/CONTEXT.md, docs/DECISIONS.md, docs/STANDARDS.md,
the package READMEs involved. The pack is authoritative; code that disagrees
is wrong; a pack that is wrong gets updated by a package, never silently.

## Phases per package

A Scout: state current WP, prerequisites, smallest vertical slice, allowed
and forbidden files, exact exit commands written BEFORE implementation.
B Design: at least two independent proposals for material decisions, one
judge recording selected, rejected, trade offs, migration, testing and
security consequences. Freeze the contract before parallel implementation.
C Implement: parallel writers each in an isolated git worktree:
  git worktree add ../nomo-<role> -b claude/<wp>-<role>
D Integrate: one merger, conservative, no features, typecheck and tests.
E Verify: run every exit criterion, capture real output. pnpm test here needs
  node --test --test-reporter=tap through scripts/src/check-tests.mjs aware
  paths (Node 26 emits spec reporter; the TAP parser chokes). For TUI: real
  PTYs at 80, 120, 200 columns; piped, NO_COLOR, TERM=dumb, CI; signals during
  raw mode. For providers: invalid key, rate limit, timeout, cancellation,
  malformed response, redaction.
F Adversarial review: skeptics with distinct lenses return JSON findings
  {file, line, severity, claim, repro, recommendation}. Default to refuted.
G Fix and re-verify: fix confirmed findings in worktrees, re-run.
H Evidence and commit: files changed, commands run, findings resolved,
  limitations, next package. Commit on a feature branch, imperative subject
  under 72 chars, Co-Authored-By trailer, no em or en dashes.

## Non-negotiables

registry is data and pure functions, imports nothing. A connector never
imports another connector. Proxy resolves connectors by id. Ledger is
append and read only. UI consumes contracts and events, never reimplements
policy, classification, replay or ledger logic. Provider logic never enters
proxy, TUI or GUI. Secrets only via the secret store abstraction, never in
files, logs, events, ledger, storage or screenshots. Nothing autonomous
touches a production account.
