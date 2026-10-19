# NOMO agent harness implementation specification

Status: historical refinement-scope draft. It does not authorize unrelated
changes. The operator separately approved the project-capabilities addendum at
the end of this document on 2026-10-18.

This specification extends `NOMO-AGENT-HARNESS-SPEC.md`. That file remains the
reference for the harness concepts and evidence. This document resolves the
implementation gaps found in the current local tree and adds a compatibility
contract for the VOID to NOMO rename.

## Goal

Deliver a local NOMO coding agent that keeps the current Workbench provider,
tool, policy, ledger, and TUI behavior while completing the verified learning
loop. Make NOMO the canonical product name without breaking existing local
state, signed records, environment configuration, or compatible clients.

## Capability map

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `rename-compat` | Canonical NOMO names with deliberate VOID compatibility aliases | None |
| `state-migration` | Detect, copy, and verify legacy local state without destroying it | `rename-compat` |
| `refinement-lifecycle` | Connect turn boundaries, gates, review, proposal validation, and signed records | Existing provider, ledger, trigger, gate, ranking |
| `operator-review` | Inspect and approve or reject pending harness proposals | `refinement-lifecycle`, TUI |
| `context-retrieval` | Add approved, verified, bounded harness context to later sessions | `operator-review`, `refinement-lifecycle` |
| `harness-evaluation` | Report honest case-level metrics and confidence intervals | Verified ledger cases |

Build order: `rename-compat` -> `state-migration`; then
`refinement-lifecycle` -> `operator-review` -> `context-retrieval`;
`harness-evaluation` can proceed after verified cases are defined.

## Rename and compatibility contract

1. NOMO is canonical for user-facing text, owned package names, executable and
   launcher names, configuration names, and default state paths.
2. Existing `VOID_*` configuration remains a fallback. If both spellings are
   set, the `NOMO_*` value wins. Secret values are never printed or logged.
3. The old local state directory remains readable. Migration copies state to
   the NOMO directory, validates the copy, and leaves the original untouched.
   If both directories contain different valid state, fail with an actionable
   choice. Never overwrite a key or ledger automatically.
4. Existing signed ledger bytes and frozen `void.*` wire or storage identifiers
   are historical contracts. Do not rewrite them in place. Readers continue to
   accept them. New identifiers are introduced only with an explicit version
   and dual-read tests.
5. An old CLI entry point may remain as a compatibility alias when this does
   not collide with an unrelated installed command. NOMO is the documented
   entry point.
6. Do not rename language keywords, third-party identifiers, URLs, license
   text, or ordinary uses of the word `void`.
7. Code and tests must cover NOMO-first precedence, old-state discovery,
   signature and encryption continuity, conflict refusal, and rollback by
   retaining the source copy.

The rename is code-only until migration behavior is tested against temporary
fixtures. Do not move, rewrite, or delete the user's real `~/.void` data during
implementation.

## Refinement lifecycle

1. Refinement runs only after a settled turn. Deterministic gates run before
   model calls. Disabled, in-flight, cooldown, branch mismatch, and no-candidate
   cases make no unnecessary model call.
2. A started review attempt stamps cooldown on success or failure. Results from
   a stale session or changed branch are discarded.
3. Mining and proposals use only a verified workspace chain. Every proposed
   edit cites existing sequence numbers from that same chain. Secret-bearing,
   malformed, unproven, or oversized proposals are refused before persistence.
4. The provider review and refinement calls use existing configured providers.
   No new provider, key, dependency, or silent fallback is added.
5. Model output is a proposal, never an authority. The ledger records proposal
   status and later operator decisions. Caller-supplied identity text is not
   approval.
6. The operator review shows the exact change, provenance, and expected outcome.
   It requires explicit local confirmation. The signed record proves the
   Workbench recorded that confirmation; it does not claim cryptographic proof
   of a person's identity.
7. `rule` entries remain mined from refusals, are always `hold`, and are
   appended after operator-authored rules. Model output never creates rules or
   changes permission modes, tool catalogs, aliases, or `decide` behavior.
8. Approved workspace lessons and prompt addenda affect later sessions only.
   The base system prompt is immutable. Session-scoped entries are limited to
   their session and are not restored as active state after restart.
9. Skill and subagent proposals stay non-executable until their schemas,
   approval flow, and runtime support are designed. This implementation does
   not add an in-product subagent execution engine. Development review agents
   are separate from that product capability.
10. Deletes and updates remain auditable. Replacements retain supersession
    history; deletions use durable tombstones or an equivalent replayable
    record. Rebuilding from the verified chain must reproduce the same active
    entries.
11. Retrieval is ranked, bounded, workspace-scoped, and sourced from approved
    entries reconstructed from the verified chain. It must not change policy
    decisions or the current session's prompt-cache prefix.

## Evaluation

1. Metrics use verified, independent cases and report sample counts. A
   correction or retry signal must be observed before a metric is called
   `first_pass_rate`. If no trustworthy signal exists, report it as unavailable
   rather than treating any allowed decision as a first-pass success.
2. Confidence intervals are computed over case means and are unavailable below
   two cases. Improvement requires a defined baseline on the same case set.
3. The TUI score is descriptive only. It never changes a gate, policy, or
   permission.

## Acceptance criteria

- A local integration test covers settled turn -> cheap gate -> provider review
  -> validated proposal -> pending operator review -> signed decision -> restart
  -> verified bounded context in a later session.
- Disabled and no-candidate paths make zero provider calls. Failure stamps the
  cooldown. A branch move prevents stale results from being applied.
- Invalid, stale, secret-bearing, and unapproved proposals do not change active
  harness entries or policy.
- Approval binds to the exact proposal digest and current verified provenance.
  Changing the proposal after review invalidates approval.
- Same-workspace retrieval reconstructs after restart. Cross-workspace entries
  never leak. Session entries do not become workspace entries.
- Old signed records still verify byte-for-byte. Migration preserves key
  continuity and the original data directory.
- NOMO names win over VOID aliases, and legacy-only configuration keeps the
  same behavior.
- TUI displays pending proposal diffs and the measured score with its sample
  count and confidence interval.
- Focused tests, package typechecks, and full relevant package suites pass.
  No unrelated pre-existing changes are discarded or committed.

## Explicit non-goals

- No changes to production accounts, cloud state, deployed schemas, cookies,
  Keychain services, or external repositories.
- No Python skill executor, global skill store, automatic policy mutation, or
  model fallback. Existing bounded subagent behavior is not expanded here.
- No claim that the ledger signature authenticates a human identity.
- No commit, push, reset, stash, or broad text replacement as part of the local
  implementation.

## Owner-approved addendum: project capabilities, 2026-10-18

This addendum is the implementation contract for the separate work package
approved by the operator. It supersedes the former host-tool deferral only for
the capabilities below; it does not change the refinement lifecycle above.

1. `nomo tui --project PATH [--skill ID ...]` selects one canonical project
   root. A visible interactive confirmation names the root, selected skill
   hashes, provider disclosure, and local history retention. Consent is
   process-local, not restored. Non-interactive and `--once` runs cannot grant
   it.
2. A custom profile must explicitly allowlist `nomo_project_exec`. Each call
   follows the existing R3 policy, approval, and signed-ledger path. The tool
   has a closed schema and dispatches a command only through Docker or Podman.
3. The image is a local immutable `sha256:` image ID. The runtime disables
   network, uses a read-only container root, mounts only the selected project
   read-write, passes no host environment variables, and applies CPU, memory,
   process, timeout, output, and cleanup bounds. Missing runtime or image is a
   refusal, never a host fallback.
4. Selected skills come only from the project root `skills-lock.json` and
   `.agents/<skillPath>`. Resolve paths under `.agents/skills`, reject
   traversal and out-of-root symlinks, bound file and aggregate size, compute
   SHA-256, and disclose any difference from `computedHash` before consent.
   Freeze the accepted content and digest in the session. Skill text is
   untrusted prompt context, never executable, and cannot add tools or change
   policy. There is no global skills source.
5. The operator selected whole-project visibility. Project files and command
   output can contain secrets and can reach the configured provider or local
   session history. State this before consent; do not pass host credentials or
   mount host credential stores. This isolation is not a guarantee that
   secrets inside the project remain hidden from the model.
6. `/compact` stays manual and deterministic, with no model call. No change to
   that behavior is part of this work package.

Acceptance: tests cover skill-lock drift, path/symlink containment, immutable
session snapshots, refusal without consent/profile/policy/runtime/image,
operator approval before execution, non-zero/timeout/output-limit outcomes,
and actual container isolation. Typechecks and relevant Workbench/TUI suites
run sequentially. A runtime smoke uses a real configured Docker/Podman image;
host execution is never an acceptable substitute.
