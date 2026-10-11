# NOMO 1.0.1 product contract

Status: implementation authorized on 2026-09-24; release NOT ready. This contract records the initial scope from `docs/superpowers/plans/2026-09-23-nomo-1.0.1-apple-release.md`. The release matrix tracks evidence, not promises.

## Platforms and execution

- Mac App Store: intended target, conditional on a signed App Sandbox build that runs the real bundled recovery engine. Keep the current Tauri/React shell unless that experiment demonstrates a blocker. macOS 13.5 remains the provisional floor; no store binary has passed this gate.
- Direct Mac download: separate Developer ID/notarized DMG track. An ad-hoc signed development DMG is not a public release. Store-only limits never disappear through an alternate download.
- iPhone and iPad: universal native SwiftUI companion, proposed iOS/iPadOS 17 floor. It reads and requests narrowly scoped work from one explicitly paired, user-owned Mac on a trusted local network. It does not run local shell/Node/MCP, write offline or implement a second recovery engine. Background execution is not promised. A server profile needs independent security and isolation gates. Neither native target nor pairing exists yet.
- Existing browser and public demo remain separate; a mobile-sized WebView or Home Screen shortcut is not a native iOS app. Public demo has isolated managed documents, not authority over the host computer.

## First-release journey

The user selects a workspace with explicit consent, sees the executor, supported operations and provider snapshot, pairs one device with local unlocked-Mac confirmation, chats, reviews the exact action and its recoverability, authorizes within a separate execute grant, sees a durable result, previews an exact Undo plan, grants Undo separately, and checks the independent restored state. Unknown, partial, paused and conflict states remain visible; client reconnect fetches durable state rather than replaying effects. Read-only pairing is the default. Revocation closes active authority, not just future logins. Locked-Mac remote mutations are refused in the first beta. Offline approvals remain unsent drafts.

The existing signed TypeScript journal/runtime and executable adapter remain authoritative. Capture and durable intent precede mutation. A changed operation ID, scope, state, device or digest fails closed. A preview is not an authorization grant. Never overwrite a newer human edit; never repeat an unknown dispatch automatically. No cloud relay, public listener, billing or unattended remote write in the first release. S3, GitHub, Vercel and arbitrary shell activity have no universal Undo claim.

## Version and compatibility boundary

`1.0.1` is a proposed Apple marketing version, not an assertion that 1.0.0 shipped. Source package version and current desktop bundle version are both 0.1.0. Before an external update, identify installed build origins and persist-format versions, back up a complete stopped/consistent state, run old-to-new read/write/Undo and wrong-key/unsupported-newer-format refusal on those actual artifacts, and fix a monotonically increasing Apple build number. No supported upgrade source or downgrade guarantee is advertised yet. Existing operation/job journal schemas are `void.operation.v1` and `void.recovery-job.v1`; capability reports moved to `void.adapter-capability.v2` on 2026-09-25, and a retired `v1` report is refused rather than silently accepted. `reservedRecoveryVault` writes SQLite plus possibly legacy encrypted artifacts. The persisted state also includes signing and encryption keys, signed JSONL records and host-owned workspace data. Missing one component cannot be called a verified restore. Never regenerate a missing retained key or rewrite signed history.

## Evidence and approvals

`docs/RELEASE-1.0.1-MATRIX.md` assigns each work item an owner and a runnable or human-observable gate. Source inspection, disposable fixtures, current packaged runtime, signed sandbox installation and physical device observation are distinct grades. A checked fixture is not store certification. Release needs zero known severity-1 data-loss/authentication defects and zero severity-2 blockers in advertised scope, backup restore plus actual Undo, denied/drift/unknown/revoked cases, bounded transport load, performance and accessibility measurements, exact-build signing/privacy/reviewer metadata and physical iPhone/iPad evidence. External beta requires explicit human approval and the stated tester sample; upload/publication and purchases remain separate decisions. Apple's acceptance is not implied by submission readiness.

Product owner must supply team, bundle IDs, signing/provisioning access, physical devices, support/legal contact, design direction approval and bounded-cost provider sandbox before their gates close. No missing external gate becomes a simulated pass.
