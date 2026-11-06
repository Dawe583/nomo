# NOMO work handover

Snapshot taken 2026-11-06 against `main` at
`7a242d56b0035ff7bc5c4fefd9d89a94af052c9a`. Recheck branches, issues and PRs
before making changes; active work may have moved on.

## Work available on GitHub

- Agent policy: [PR #119](https://github.com/Dawe583/nomo/pull/119) is merged.
  `oliver/nomo-policy` at `1b54cdf006d21b13b9a2dabb3138655d3019ba4c` is an
  ancestor of this main snapshot. Start from current main rather than merging it
  again.
- [Agent policy proxy wiring](https://github.com/Dawe583/nomo/tree/feat/nomo-agent-policy-proxy-wiring):
  `211081aaab995c4cea320d9246b4eab85c54e05d` is on the remote but is not an
  ancestor of this main snapshot. It covers proxy grant and policy wiring and
  agent identity handling. Compare the implementation and history with current
  main before selecting any changes.
- [Harness proposals](https://github.com/Dawe583/nomo/tree/claude/fleet-main):
  `304851fcaa80609d75a9b19318cedf67c122580f` is on the remote but is not an
  ancestor of this main snapshot. Seven LiveFuller commits from `1d41892` to
  `304851f` address proposal provenance, review and retrieval. The branch also
  contains earlier work by others, and main has progressed; compare rather than
  merging the whole branch blindly. Full branch tests were not rerun here.

## Open work and blockers

- [#125 PTY verifier](https://github.com/Dawe583/nomo/issues/125): a candidate
  exists only as uncommitted local changes on Oliver's machine; it is not in
  this PR or on GitHub. It adjusts input observation, completion fixtures and
  the post-Undo completion scenario. Fixture and provider-retry tests passed
  locally, but full POSIX PTY acceptance and CLI typecheck remain unverified.
  Obtain the local patch from Oliver, apply it to the stated base, and run the
  complete verifier and relevant test and typecheck gates on a dependency-ready
  Linux or macOS checkout before treating it as a fix.
- [#127 TUI baseline](https://github.com/Dawe583/nomo/issues/127):
  [PR #128](https://github.com/Dawe583/nomo/pull/128) contains a fixture slice;
  its description reports 197/206 tests passing and lists additional changed
  files. Inspect its full diff and coordinate TUI ownership. A separate Windows
  `pnpm run test:tui` attempt here failed during module loading because
  `@aws-sdk/credential-provider-node` was unavailable; it was interrupted and
  does not establish a full test result.
- [#126 Kitty logo](https://github.com/Dawe583/nomo/issues/126): verify the
  raster asset's origin and licence before packaging it, as required by the
  issue owner's comment.
- [#131 provider contracts](https://github.com/Dawe583/nomo/issues/131): keep
  unsupported transports fail-closed until authoritative public protocol and
  third-party authentication contracts are available. A possible next research
  slice is Vertex with Anthropic Messages: Google documents [Claude on Vertex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/partner-models/claude/use-claude)
  and [Application Default Credentials](https://docs.cloud.google.com/docs/authentication/application-default-credentials),
  while Anthropic documents [message streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
  These sources do not establish that the complete issue acceptance is met:
  project and location configuration, host credential boundaries, pinned model
  eligibility and offline tests still need an explicit design and verification.
- [#55 paid and open boundaries](https://github.com/Dawe583/nomo/issues/55):
  the original report is partly stale. `docs/DECISIONS.md` records `cloud/` as
  closed and classifies the remaining tree; `scripts/src/licence-line.test.mjs`
  passed 13/13 on the main snapshot on Windows. The same decisions distinguish
  hosted taint access from the open builder and record that open retention cannot
  simply be capped. Irreversibility budgets and other unbuilt paid capabilities
  remain separate product and licensing questions. This test alone does not
  establish that the whole issue is resolved.
  A separate uncommitted local comment fix corrects the false claim in
  `cloud/capability-gate.mjs` that `apps/control-plane` does not exist. Its
  licence test passed 13/13, but the required workspace typecheck could not run
  in that worktree because `tsc` was unavailable; the fix is not in this PR.
- GitHub Actions: in [run 42301115291](https://github.com/Dawe583/nomo/actions/runs/42301115291),
  manifest jobs had no assigned runner and no steps. The job annotation cites
  failed payments or a spending limit. Resolve account billing, rerun the
  required jobs and inspect their results; the run is not test evidence.
- [PR #138](https://github.com/Dawe583/nomo/pull/138) combines several CI
  readiness fixes and requires green GitHub CI before merge. Check it before
  duplicating that work.

Do not stage unrelated uncommitted work from other checkouts. This handover is
a status snapshot, not a claim that the listed issues are closed.
