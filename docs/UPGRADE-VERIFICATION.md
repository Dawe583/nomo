# Bounded upgrade verification

This record supersedes missing-feature claims in older plans. It is not F0-F5 completion or provider certification. Source contracts are in [the parity contract](superpowers/specs/2026-09-22-parity-contracts.md).

## Delivered scope

- New unconfigured sessions use NVIDIA NIM, `https://integrate.api.nvidia.com/v1`, `z-ai/glm-5.3-flash`. Missing credentials require setup. Existing provider/model snapshots remain unchanged; no silent fallback.
- Local project IDs, immutable agent snapshots, allowed-tool enforcement and bounded context/turn budgets are implemented. Project roots and prompts grant no authority. Only the default operator policy is available; hooks are unsupported.
- Compaction preserves the initial system message and complete retained tool groups. Its summary is untrusted user context. Metadata persists; ledger evidence is not rewritten. Context count is actual retained messages, not measured token usage.
- Local background work keeps exact prompts, stable run identity and provider/profile/project snapshots. Admission is bounded to twenty queued runs. Restart never automatically dispatches saved work. Cloud advertises no background queue.
- Local API, cloud and TUI expose signed recovery jobs for explicit operation lists or one exact run. The GUI review selects explicit operation lists; it does not add an exact-run selector. Approval binds an immutable stored digest and boundary. HTTP/TUI apply rechecks explicit digest approval for a repaired paused job; CLI/runtime jobs retain their original signed approval. MCP job apply does not resume paused jobs. Unknown inverse outcomes never grant replay authority.
- Unknown survives cancellation and evidence failures. Mutation admission requires known settled state. A recovery blocker belongs to its exact job and workspace; unrelated recovery cannot clear prior forward uncertainty. Public `lastRecoveryJob:{jobId}` retains diagnostic identity after reload. Its GUI control reads status only and grants no recovery authority.
- GUI retains edited queued drafts through reload, rejection and provider failure. It clears them only after successful explicit submission. Local and cloud agent catalogs remain distinct.

## Verification evidence

All provider generation tests below use deterministic fixtures, not production credentials.

| Check | Evidence and boundary |
| --- | --- |
| Workspace check | Fresh `pnpm run check` passed on frozen source `17a3c94`: full typecheck and 1,168 passing tests across eleven workspace suites. The cloud unit run passed 49 tests with four opt-in SQL skips; those four SQL suites were separately executed and passed without skips. |
| SQL | Four isolated SQL suites plus managed cloud and PostgreSQL crash tests. Backend termination, client SIGKILL, restart, signed receipts, drift/ABA refusal and two-client races passed. Physical network partition was not tested. |
| End-to-end | `e2e.mjs`, `e2e-connectors.mjs`, `e2e-final.mjs all`, `e2e-arc.mjs all` passed. Connector fixtures do not certify external accounts. |
| Web build | `pnpm run build` produced a verified cloud artifact from frozen source `17a3c94`. |
| TUI | Real PTY checks covered 40/80/120/200 columns, signals/fatal exit, terminal restoration, paste confirmation refusal and selected-only cancellation. |
| Browser | Actual local API runs, untouched custom-profile defaults, retained queued edits, provider 429, compaction persistence and signed multi-operation recovery were exercised. Layout checks covered 320/768/1280/1440 pixels. A response-injected unknown-state UI check is not runtime unknown certification. Final source `17a3c94` was reloaded and rechecked. Retained-job status survived reload: three GET requests, zero mutations and no approve/resume controls. A new three-step recovery restored all selected documents and returned the session to idle. |
| Desktop | Packaged macOS application passed `--smoke-test` and `--smoke-mobile`: bundled runtime, rendered WebView, Blob download and mobile toolbar checks. Fresh temporary data and ephemeral keys were used with provider credentials removed. Both smoke paths passed again after repackaging frozen source `17a3c94`. |

Final review found and reproduced legacy single-Undo lifecycle, branch ownership and stop-state gaps. The fixes on `17a3c94` passed the unchanged independent boundary cases plus retained-job diagnostics (5/5), all Workbench/TUI tests (235/235, zero skips), and eight real PTY groups. The final whole-workspace check and the exact-source browser acceptance also passed. These checks establish the bounded local delivery, not the external gates below.

## Prime Agent MCP

The current local host authorizes five tools: `nomo_execute`, `nomo_recovery_plan`, `nomo_recovery_apply`, `nomo_reconcile`, `nomo_recovery_reconcile`. The server implements three additional job tools; they are not authorized in this dogfood setup.

Filesystem authority is only `$HOME/.local/share/void-prime-dogfood/project`. Config, policy, launcher, encrypted captures and journal remain outside that writable directory. A native launcher obtains the existing key from macOS Keychain (`dev.void.prime-recovery`, account `prime-dogfood`) and passes it only through the child environment. Missing or unavailable keys refuse startup; never generate a replacement for retained state. No plaintext key file or key argument is needed.

Actual MCP checks covered write, exact bytes, preview, restore, repeat apply, MCP subprocess restart, parent-session reload with a fresh Python kernel and no recovery-key environment variable, forward/recovery reconciliation, traversal refusal and duplicate-forward no-redispatch after restore. A newer human edit survived drift refusal. Local evidence is retained in `tmp/prime-mcp-evidence.json`, not committed as portable certification.

This explicit managed path does not intercept arbitrary shell/editor tools and does not make noncooperative external writers safe. A plan digest is not policy authorization. Hold and deny refuse execution; interactive approval is not implemented in this MCP transport.

## Still outside this delivery

No entire F0-F5 phase is complete. Remaining work includes dependency closure and time selectors, leases/fencing, general cross-system plans, full server-enforced per-hunk review, streaming capture, pin/retention/GC lifecycle, quota migration, key rotation drills and independent publication/certification.

External provider sandboxes, physical network faults, Windows/Linux native recovery and packaging, physical mobile devices, screen readers, Developer ID/notarization, npm publication and production-like KMS require separate evidence. Browser emulation and ad-hoc signed macOS packaging do not close those gates.

Run the documented local checks against the exact final commit. Local checks do not certify deployment or behavior on a clean machine.
