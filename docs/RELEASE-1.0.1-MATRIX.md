# VOID 1.0.1 release evidence matrix

Status: open for release on 2026-09-25. `source-inspected` means a code path was read; `fixture-tested` means a disposable conformance run passed in that session. Neither closes signed sandbox, physical-device or external beta gates. This matrix maps every checked work item and all 30 D03 families from the implementation plan. Planned gates are not reported as passing.

Evidence boundary of the 2026-09-25 update: source was re-read and the local toolchain re-observed. A Release `iphonesimulator` build and a simulator install/launch were run on this machine and are graded as simulator evidence below; a `generic/platform=iOS` build was attempted and failed for want of a provisioning profile. A disposable-fixture local acceptance harness over the real control-plane API, plus the repository suites named below, were run. No signing credential was read, printed or created, and no archive, export, TestFlight, App Store Connect, upload, physical-device install or provider run was performed. The unit and UI test results quoted below are the last recorded ones and stay labelled as historical. Every P01, P04-P09 and P11 row, plus P10.09, stays open: the local acceptance evidence narrows which sub-cases were exercised, and no row is promoted on a source, simulator, fixture or metadata result.

## Current capability and tooling snapshot

| Surface | Evidence grade | Current observed boundary |
| --- | --- | --- |
| Managed filesystem | Source-inspected and fixture-tested | `filesystem.managed` v1; POSIX create/write/delete/rename, cooperative regular files, bytes/mode. Four conformance scenarios passed. No external-writer or power-loss guarantee; no `certification` block. |
| Managed Git | Source-inspected and fixture-tested | `git.managed` v1; POSIX create/write/delete/rename/stage/unstage. Six conformance scenarios passed, `certification:false`; no commit, remote, Windows, or durable external receipt. |
| Managed documents | Source-inspected and fixture-tested | `managed-documents` v1; text write/delete only, 256 kB, no host filesystem. Two conformance scenarios passed, `certification:false`. |
| Managed PostgreSQL | Source-inspected; historical isolated-service evidence | Restricted primary-key row INSERT/UPDATE/DELETE, explicit metadata v1-to-v2 migration. Real cascade/tenant/network-partition certification remains open; no new live service test run here. |
| S3, GitHub, Vercel | Source-inspected exclusions | Legacy capture or OAuth connection does not imply executable recovery. No first-release Undo claim. |
| Mac direct beta | Historical packaged test, source-inspected | Ad-hoc signed Tauri app/DMG with bundled Node, not Developer ID notarization or App Sandbox. |
| Mac App Store | No signed sandbox/device test | No store entitlements/provisioning/pkg or signed sandbox capture/Undo evidence. |
| Native iPhone/iPad | Source-inspected; Release simulator build, simulator launch and current simulator test run observed 2026-09-25; no physical-device build, signed-device or store evidence | `apps/apple/` contains a native iOS 17 Xcode project, Swift package, app, 9 `VOIDTests` source cases, 6 `VOIDUITests` source cases and protocol fixtures. On 2026-09-25 a Release `iphonesimulator` build of the `VOID` scheme succeeded, the product installed and launched on an iPad Pro 11-inch (M5) simulator rendering the onboarding/entry screen, and a simulator test run passed `VOIDTests` 9/9 and `VOIDUITests` 6/6 against the current source. That product is ad-hoc signed with no team identifier, no entitlements and no bundle icon, so it is simulator evidence only. The separate `CompanionProtocolKit` host SwiftPM run passed 27/27 but is a macOS host run, not an iOS simulator or device result. A `generic/platform=iOS` device build failed on 2026-09-25 because no provisioning profile for `com.void.companion` is installed, the attached iPhone has Developer Mode off, and the project sets no `DEVELOPMENT_TEAM`. Physical iPhone/iPad install, App Store and TestFlight gates remain open. |
| Windows desktop | Out of scope for 1.0.1; current-source gate open | Historical beta-4 Actions evidence does not certify the current candidate. No current-source Windows packaging, installed smoke or full Windows recovery evidence is claimed. P10.09 remains open. |
| Tooling | Current machine observation, 2026-09-25; Xcode metadata and Release simulator build succeeded | Node v26.8.1, pnpm 10.33.0; Xcode 27.0 build 27A266a selected at `/Applications/Xcode.app`. `xcodebuild -list` reports targets `VOID`, `VOIDTests`, `VOIDUITests`, configurations Debug/Release and schemes `CompanionProtocolKit`, `VOID`. The keychain holds one Apple Development identity that the project does not reference, and the provisioning profile directory is empty. Apple account, Developer ID, provisioning, archive, physical-device install and store access remain unverified. |

Sources: `packages/cli/src/conformance.ts`, `packages/connectors/src/capability.ts`, `docs/RECOVERY-COVERAGE.md`, `docs/RECOVERY-CONTRACT.md`, `apps/desktop/src-tauri/tauri.conf.json`, `docs/GUI-COMPACT-VERIFICATION.md`. Current conformance commands: `node packages/cli/bin/void.mjs recovery conformance --adapter filesystem.managed`, and likewise `git.managed` and `managed-documents`; outputs summarized above.

## 2026-09-25 Apple build and signing observation

Recorded separately by evidence grade so a simulator result is never read as a device or store result.

| Observation | Command | Result | Grade |
| --- | --- | --- | --- |
| Project inventory | `xcodebuild -list -project apps/apple/VOID.xcodeproj` | Targets `VOID`, `VOIDTests`, `VOIDUITests`; configurations Debug, Release; schemes `CompanionProtocolKit`, `VOID`. | Metadata read |
| Release simulator build | `xcodebuild -project apps/apple/VOID.xcodeproj -scheme VOID -configuration Release -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build` | `** BUILD SUCCEEDED **`. Repeat with `CODE_SIGNING_ALLOWED=NO` also succeeded. | Built product, simulator SDK only |
| Product signature | `codesign -dv` on the built `VOID.app` | `Signature=adhoc`, `TeamIdentifier=not set`, no entitlements, no bundle icon. | Ad-hoc, unprovisioned |
| Simulator install and launch | `xcrun simctl install` and `xcrun simctl launch` on an iPad Pro 11-inch (M5) simulator | Installed and launched; the rendered entry screen showed the read-only pairing notice and an offline continue path. | Simulator rendering only |
| Device build | `xcodebuild -scheme VOID -configuration Release -destination 'generic/platform=iOS' build` with an explicit team and `Apple Development` identity | `** BUILD FAILED **`: no provisioning profile for `com.void.companion`; automatic signing cannot generate one without `-allowProvisioningUpdates`, which was not passed. | Failed gate, not a device claim |
| Signing inventory | `xcodebuild -showBuildSettings -scheme VOID`, provisioning profile directory, `xcodebuild -showdestinations` | `DEVELOPMENT_TEAM` and `CODE_SIGN_ENTITLEMENTS` are absent from the project file in every configuration, `CODE_SIGN_IDENTITY` is the legacy `iPhone Developer` alias with `PROVISIONING_PROFILE_REQUIRED=YES`, the profile directory is empty, and a physical iPhone is listed as a connected destination. A signing identity exists in the keychain but is not referenced by the project. | Inventory only; no credential read, no device build |
| Simulator test run | `xcodebuild test -project VOID.xcodeproj -scheme VOID -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5)'` | `VOIDTests` 9/9 and `VOIDUITests` 6/6 passed, 0 failures, 96.2s. This is a current run against the current source, replacing the earlier historical 6/6 unit figure. | Simulator test run, not a device run |
| Swift package test run | `cd apps/apple/CompanionProtocolKit && swift test` | 27/27 passed, including all 12 `SecurityRegressionTests` cases covering response scope mismatch, oversized and unknown response shapes, event-page replay-window/UTC/cursor rules, pre-transport request validation, a scoped operation-status store failing closed on corruption, IPv6 local-network impersonation and a URL outside the bound identity. | Host SwiftPM on arm64e-apple-macos14.0, not iOS simulator or device; `xcodebuild test -scheme CompanionProtocolKit` fails because that scheme is not configured for the test action |

No archive, export, TestFlight, App Store Connect, upload or physical-device install was attempted. The failing device build names the missing input rather than closing P01.06, P06.01-P06.05, P10.04 or P11.01.

## 2026-09-25 local acceptance evidence

Disposable temp-fixture runs on this machine. No provider, credential, signed build, provisioned profile, physical device or store was involved, so every P09 row below stays open; this section records which sub-cases were exercised and which were not.

Live API harness (a throwaway script that drives the real `apps/control-plane/api/server.ts` over HTTP on `127.0.0.1` with `mkdtemp` data directories): 67 scenarios, 67 pass, 0 fail. Unset and hostile `VOID_PERMISSION_MODE` both resolved to read-only with `documentEditing=false` and refused document `PATCH` (S-01, S-02); a client-supplied `permissionMode` was refused flat and nested (S-03); read-only planning returned 409 and left content untouched (S-04); branch idempotency returned one id on retry and 409/400 on conflicting and malformed bodies (S-05); unknown, digest-mismatched and unapproved applies returned 409 without mutating the document (S-06); a human edit followed by a stale apply returned 409 and preserved the human content (S-07); undo required confirmation, and the confirmed apply produced a real inverse (S-08); cross-origin, `sec-fetch-site: cross-site` and foreign `Host` were refused (S-09); missing, wrong and short bearers were refused while a correct bearer succeeded (S-10); prompt, idempotency-key and body limits were enforced at boundary and boundary+1 (S-11); and sentinel private and API keys never appeared in ledger-verify, capabilities or provider error responses (S-12).

Repository suites run green: `apps/control-plane` `api/server.test.ts` + `api/parity.test.ts` 20/20; `packages/workbench` `permission-authority.test.ts` 4/4, `gui.test.ts` + `recovery-jobs.test.ts` 21/21, `provider-retry.test.ts` 5/5; `packages/proxy` transport and relay suites 39/39; `packages/cli` `recovery-filesystem` + `recovery-mcp` 9/9 and `recovery-health` 5/5; `packages/runtime` `reserved-vault` + `recovery-crash` 14/14 and `crash` + `persistence-fault` 22/22; `cargo test --offline diagnostics` 6/6 for the startup-log allowlist; conformance `filesystem.managed` 4/4, `git.managed` 6/6, `managed-documents` 2/2.

Not covered, and therefore not claimed: no packaged-artifact install, upgrade, rollback or uninstall cycle; no end-to-end mobile-bridge or paired-phone transport journey, because the Apple client still has no envelope round-trip against the routes that now exist (see the 2026-09-25 companion section); no real provider streaming; no VoiceOver, keyboard, zoom, rotation or Dynamic Type run; no performance/load budget run; and no power-loss or genuinely full-disk proof, only injected ENOSPC and SIGKILL.

Live CLI recovery journey (a throwaway script that spawns the real `node packages/cli/bin/void.mjs recovery ...` binary with a minimal environment, per-run key material passed by environment variable name and never printed): 43 scenarios, 43 pass, 0 fail. `recovery health` on a fresh state directory exited non-zero as `unavailable` with `state.present=false`, explicit repair steps, no state directory and no key-shaped bytes in the report (L-01). `recovery inspect` returned an approval digest without touching the file (L-02). Execute required that exact digest: a forged digest was denied, and a denied operation identity stayed consumed even when replayed later with the correct digest, while a distinct operation identity with its own correct digest applied the write (L-03). A wrong key, a missing key variable and the correct key produced the expected non-zero, non-zero and exit-0 plan results with no refused plan mutating the file (L-04). A forged plan digest was refused without mutation, and the exact digest returned `restored` with bytes-and-mode evidence and content back at its original value, a real Undo through the CLI (L-05). Appending a forged line to the signed journal turned health and plan unsafe with the file unchanged, and restoring the original history returned health to exit 0 (L-06). Deleting the retained signing key was refused with the stable message `Retained recovery signing key is unavailable; restore the original key before continuing.`, the key was not silently regenerated, and restoring it returned health to exit 0 (L-07). `recovery-backup.mjs` create/verify exited 0 with a matching anchor, while a wrong anchor and a missing anchor both returned `history_unanchored`, a tampered backup journal returned `history_incomplete`, and a deleted vault artifact returned `missing_artifact`, with no workspace file mutated throughout (L-08). A second backup restored into an isolated copy reached health exit 0 and refused the wrong key (L-09). `apps/desktop` `runtime.test.mjs` + `release.test.mjs` pass 4/4.

One security-positive behaviour worth recording: a denied operation identity is never re-runnable. The journal state machine in `packages/runtime/src/journal.ts` gives `denied` an empty transition set, so an approval digest cannot be brute-forced by retrying the same identity, and L-03 exercised that against the real binary.

Finding from the 2026-09-25 local acceptance run, now fixed and re-verified: the operator tool catalog was not permission-mode filtered, so `GET /api/tools` advertised `void_workspace_write` while `documentEditing` was `false`, because `availableTools()` in `packages/workbench/src/index.ts` built the catalog from `workspaceTools` without the predicate dispatch applies. Dispatch-time enforcement held throughout, so it was a visible-capability mismatch rather than a bypass. `availableTools()` now filters through `toolAllowedInMode`; the live harness converted the observation into a hard assertion and re-ran at 67/67, checking that a read-only catalog returns exactly `void_workspace_list` and `void_workspace_read` while normal mode still advertises `void_workspace_write`. `packages/workbench` `permission-authority.test.ts` plus `safety-boundaries.test.ts` pass 8/8 and `apps/control-plane` `api/parity.test.ts` passes 5/5.

The release matrix intentionally retains P01 and P04-P11, which includes the Windows gate P10.09, plus every D01-D04 requirement. Their open gates are not converted into source-inspection, simulator or metadata claims. Windows is outside the 1.0.1 delivery scope; its historical evidence is preserved, and P10.09 remains open for a later authorized current-source build.

## 2026-09-25 companion transport and adversarial security pass

The 2026-09-25 gaps recorded as "no existing route" for `operation.status`,
`device.revoke` and `diagnostics.read` are closed at the source level. This is
local, loopback and fixture evidence only: no paired phone, no physical
device, no provider and no store were involved.

### Companion routes now present

`apps/control-plane/api/companion/` adds a minimal device pairing model and
the three missing operations. Paired devices are read-only by default, carry
`companion:read` or `companion:write`, and are bound to one workspace. Device
tokens are minted with `randomBytes`, stored only as a SHA-256 digest, and
compared with `timingSafeEqual`; the plaintext is returned exactly once and
never written to disk. A missing, wrong, expired or revoked credential is
`403`. A structurally invalid or foreign `operationId` is `404`, never a
synthesised success. Diagnostics are an allowlisted projection capped at 100
entries with a 320-character summary bound; a sentinel credential and a
home-directory path were both proven absent from the response.

`operation.status` serves the frozen `void.companion.v1` outcome vocabulary
(`running`, `succeeded`, `denied`, `conflict`, `unknown`, `revoked`,
`expired`) and rejects a stored record carrying any other value as a corrupt
store, because the frozen fixture validator would refuse it. `CompanionProtocolKit`
acceptance rules were transcribed into a test over live responses: bounded
identifiers, the client's accepted status-code window, and the 1 MiB response
ceiling.

Suites: `apps/control-plane/api/companion/companion.test.ts` 14/14,
`api/server.test.ts` 15/15, `api/parity.test.ts` 5/5, `apps/control-plane`
typecheck exit 0. Each new assertion was mutation-checked.

The envelope gap is now closed at the source level. `POST
/api/companion/envelope` accepts a `void.companion.v1` request envelope,
validates the exact field set, the admission window, the canonical-JSON digest
and the per-operation body shape, proves the device credential, maps the
operation onto the same store and projection primitives the internal path
uses, and wraps the result in a response envelope with the echoed identity.
Five operations are bound: `capability.handshake`, `operation.status`,
`device.revoke`, `diagnostics.read` and `device.pair`. `device.pair` is the only
operation that may be called without a credential and the only one whose
identity is server-derived; a pairing request that carries a `deviceId` or
`workspaceId` claim is refused so a caller cannot probe for a named workspace.
On the Apple side, `CompanionPairingRequest` is a separate type rather than an
optional `deviceId`, so the bounded-identity check stays strict for every other
operation, and `device.pair` joined the mutating set. Two client guards were
corrected against the frozen contract: a `succeeded` outcome may no longer
carry an error or arrive without a body, and the response identity is checked
before the payload.

Evidence: `apps/control-plane/api/` 51/51, `apps/control-plane` typecheck exit
0, `CompanionProtocolKit` `swift test` 33/33, and
`scripts/src/companion-fixtures.test.mjs` 7/7. The acceptance gate is the real
`validateCompanionFixture`, loaded by the contract test from fixtures built out
of live HTTP responses. Three mutations were shown red and reverted.
`swift test` is a macOS-host run against in-process transport doubles, so this
is not an iOS simulator or device result, no TLS pinning path was exercised,
and idempotent replay of a stored response is not implemented. P09.02 therefore
stays open: no paired-phone journey is claimed.

### Aggregate gate note, 2026-09-25

A single `node --test packages/ apps/control-plane/ cloud/ scripts/` run did
not finish inside the 240-second harness limit, in the same way the earlier
full `pnpm run check` did not. That is negative evidence, not a pass. The
suites were therefore run in bounded groups instead, each with its own result:
`packages/workbench` + `packages/policy` + `packages/runtime` 256/256;
`packages/proxy` + `packages/ledger` 193/193; `apps/control-plane/api` 51/51;
`cloud` 61 pass / 4 skipped / 0 fail, the 4 being the database-gated cases;
`apps/control-plane/ui/src` 71/71; `scripts/src/ui-layout.test.mjs` 12/12;
`scripts/src/companion-fixtures.test.mjs` 7/7; and
`python/void-transport` 84/84 under `unittest`. Typecheck is clean for
`apps/control-plane`, its UI, and each of `workbench`, `policy`, `runtime`,
`proxy` and `ledger`. `packages/cli` is 256/256 in its own bounded run.
`packages/connectors` was not touched in this wave and its run exceeded the
same limit on the PGlite fixtures, so no claim is made for it. A one-shot
whole-tree green is still not claimed.

### Adversarial security pass and four fixes

A read-only adversarial pass over `packages/`, `cloud/`, `apps/control-plane`
and `policy/` found no defect in the approval-digest binding, the journal
state machine, workspace isolation, secret redaction, the proxy replay
boundary, or the connector apply path; those boundaries were read and are
recorded as confirmed rather than assumed. Three real defects and one
hardening gap were found; all four are now closed:

1. Cloud tool dispatch short-circuited built-in tools to `allow` without
   consulting the policy, and the cloud recovery runtime was wired with an
   unconditional `authorize`. An r1 `void_workspace_write` or
   `void_workspace_delete` therefore ran with no human in the loop while the
   signed journal recorded the agent itself as the approver. Both are fixed:
   every classified tool now takes a real policy decision, and the sink fails
   closed against an explicit allowlist of authorizing surfaces.

   `cloud/steps.test.mjs` 5/5 and `cloud/` 54 pass / 4 skipped / 0 fail, with
   the built-in exemption mutation turning the approval test red.
2. `Workbench.branch` performed durable managed-document writes through
   `snapshotDocuments: true` with no permission-mode gate, reachable over HTTP
   while `/api/capabilities` advertised `documentEditing: false`. Seeding a
   branch is now gated like every other document mutation; branching without a
   snapshot still works in read-only mode. The parity test that had pinned the
   old behaviour now runs in normal mode and asserts the read-only refusal.
   `packages/workbench` 104/104 and `permission-authority.test.ts` 6/6, with
   the gate mutation turning the refusal test red.
3. An absent `VOID_PERMISSION_MODE` resolved to `normal` in the Workbench
   constructor and to `read-only` in the control plane, through two unrelated
   literals. Both defaults are now named constants with a test, so the
   deliberate difference is reviewable.

A fourth, informational hardening gap from the same pass is now closed: the
cloud approval hold identifier is derived from public session counters and its
decision route had no possession factor, unlike
`packages/policy/src/approvals.ts`. A hold now carries an unguessable token
minted with 24 random bytes, and a decision that does not present it is `403`.
`cloud/steps.test.mjs` 5/5, `cloud/` 54 pass / 4 skipped / 0 fail, with a
constant-token and non-timing-safe mutation turning the test red. This crossed
no live privilege boundary, because every cloud route already requires the
same control token, but it removes the one approval surface that relied on a
guessable identifier alone.

### Reverse-tool milestone progress, 2026-09-25

Three open R-series and gap items moved, each with a bounded test and a named
remainder. None of them is a certification.

R03 file recovery vault retention. `collectVaultGarbage` is the explicit,
operator-driven collector. The shipped `MANUAL_RETENTION_POLICY` is
`mode: "manual"` with no TTL, so nothing is collected implicitly. A pinned
artifact is never evicted, a policy that gives a pinned kind an expiry is
refused as a contradiction, an artifact with no lifecycle record is protected
because its pin state is unknown, and unreadable or invalid evidence refuses
the whole run before any delete. Evidence lives outside the artifact tree
deliberately: `reservedRecoveryVault` reads every file in a workspace
directory as a legacy artifact, so a sidecar there could make an existing
vault unverifiable. Every run is a signed `void.operation.v1` chain under
`adapterId "vault.retention"`, so a delete is never silent. `vault.ts` itself
is byte-identical. `packages/runtime` 81/81. Not covered: the reserved SQLite
vault, pin release, retention-index backup, streaming, and quota migration.

R14 export bundle and metrics. `void.export-bundle.v1` carries the ledger,
the journal, a vault manifest and the capability profile, each with a record
count, a byte length and a SHA-256, plus a manifest written last into a
staging directory that is renamed into place, so a failure leaves no
completeness claim on disk. Verification needs an out-of-band anchor,
recomputes every declared number from the bytes, re-verifies both signed
chains, and replays the journal through the transition tables; a section
rewritten in place, a re-declared manifest, or a missing section is refused.
`metrics` recomputes 18 closed-label counters from the existing ledger,
journal and vault with no new persisted state and no client library.
`export-bundle.test.ts` plus `operations.test.ts` 14/14, and the real binary
reports the counters. Operational certification is not claimed.

G06 machine-readable capability profiles. The schema moved to
`void.adapter-capability.v2`: a required `authority: "scope-only"`, a required
`conformance.runtime`, a required `maxDecodedBytes`, a required `certification`
where a bare `true` is refused as "not evidence", refusal of unknown fields
and of a retired `v1` report, and a per-provider profile set that refuses an
adapter with no published profile rather than skipping it. The release gate
is `scripts/src/capability-profile-gate.test.mjs`, which `check-tests.mjs`
already globs, so it runs under `pnpm test` with no package.json change.
`capability.test.ts` plus `capability-profiles.test.ts` 18/18, gate 3/3. Every
profile stays `certification: false`.

The `void.adapter-capability.v1` to `v2` move is a report format break and is
recorded as one. No persisted state depends on the older shape, and a v1
report is refused rather than silently accepted.

### Adversarial pass over the new surface

A read-only pass over the companion routes, the vault collector, the export
bundle, the metrics surface, the capability profiles and the Apple client
returned twelve findings: four medium, six low, two informational, none
critical. Six are fixed here, each with a mutation proof.

1. The bound envelope `operation.status` resolved an operation by workspace
   only, while the internal route it claims to mirror also requires the record
   to belong to the calling device. A read-scoped device in the same workspace
   could read a sibling's operation record. Both paths now apply the same
   refusal, so a sibling's record is indistinguishable from one that does not
   exist.
2. The collector snapshotted the pin flag and deleted later, while
   `markVaultLifecycle` never took the collection lock. A pin recorded during a
   run was never observed, the artifact was deleted, and the sidecar was
   removed with it, so the record that protected the artifact was destroyed by
   the run meant to respect it. Marking takes the same lock now, and the
   collector re-reads the evidence immediately before each unlink.
3. Nothing enforced that the evidence index sits outside the artifact root,
   which is the reason it lives there: a `.meta` sidecar in a workspace
   directory makes the reserved vault refuse the whole store. It is refused at
   the boundary now.
4. The export bundle's capability section disclosed two exclusions and did not
   say that the ledger and journal sections are verbatim copies of recorded
   operations. It says so now.
5. `verifyBundle` and `collectMetrics` asserted `signed.ledger` as a literal
   `true` instead of deriving it, so neither could ever report a degraded
   state. Both derive it now, the metrics flag additionally accounts for a
   directory scan that deliberately counts files which failed verification, and
   the metrics report emits basenames instead of absolute host paths so a
   pasted report does not carry the operator's home directory and username.
6. The Apple client accepted a `succeeded` answer carrying an empty body
   object, which the server's own `sendReply` downgrades to a refusal. The
   client applies the server's invariant now.

The last one is closed as well. Pairing used to accept a caller-chosen scope
list, so a device could grant itself `companion:write`. The scope is inert today
only because the one operation that needs it targets the caller's own device,
which is exactly the kind of accident that stops holding when the next binding
lands. The write scope is now the host operator's decision: pairing refuses it
unless `VOID_COMPANION_WRITE_PAIRING=1`, it is refused rather than silently
downgraded, and the test that exercises write-scoped revocation opts in the way
an operator would. `apps/control-plane/api/companion` 24/24, with the default
mutation shown red.

The retention lock's availability gap is now closed. It used to have no lease,
so a collector that died left the lock behind and froze collection in that
workspace permanently. A lock now records its owner and a lease, and is
reclaimed only when the lease has passed AND the owner is provably gone; an
unreadable, unparseable or unattributable lock is still refused, so the failure
mode stays "no delete" rather than "two deletes". `packages/runtime` 92/92, with
both halves of the reclaim mutation-checked.

Two of the remaining findings are now closed as well. A mutating companion
operation is deduplicated by its idempotency key, bound to the exact request
body, so a retry is distinguishable from a key reused for a different body; a
replayed `device.pair` is refused with a conflict instead of minting a second
device, and its one-time plaintext credential is deliberately never stored to
make a retry cheap. A replayed `device.revoke` is refused even earlier, because
a revoked device can no longer authenticate at all. The handshake now lists
`idempotent replay of a mutation` and `recovery of a lost device.pair response`
among its pending behaviors, so the advertised limits match what is enforced.
`apps/control-plane/api/companion` 23/23 with both mutations shown red.

`resolveProviderProfile` now goes through `bindsAdapter`, so the rule "this
profile was issued for exactly this adapter" lives in one place instead of
being restated and existing only in a test. `capability.test.ts` and
`capability-profiles.test.ts` 19/19, the release gate 3/3, and
`conformance.test.ts` 8/8.

One finding is not fixable in the adapter and is recorded in the protocol spec
instead: `device.pair` is implemented and dispatchable but is not in the
handshake capability catalog, because the frozen v1 catalog is derived from the
frozen `operations` set, which does not contain it. Publishing it would make
every handshake response fail the frozen validator, so closing this needs a
v1.1 contract change rather than an adapter change.

### A wiring that was attempted and reverted

Wiring the shared budget ledger into `execute.ts` was attempted and backed
out. The reason is worth recording because it is a design constraint, not an
oversight.

The ledger has to be reserved before dispatch, and the journal's writer lock is
held for the whole transaction, so acquiring the budget lock inside it lets one
contended worker hold the journal lock for the budget lock's full retry
deadline and stall every workspace behind it. Reserving before the transaction
means the preflight observation has to happen before it too, since that
observation is what decides whether a unit is needed. Hoisting preflight out of
the transaction compiles, passes most of the suite, and breaks a real property
that `crash.test.ts` pins: a restarted executor reconciling an operation that
already dispatched must not observe, prepare or execute it again. The fixture
adapter for that test throws on a second preflight, and it fired.

The safe order therefore needs the prior-record check to run as a short read
before the reservation, with the transaction still re-checking it
authoritatively. That is real work with its own failure modes, so it is left
open rather than half-done. The ledger is a tested library with an honest
"not yet wired" gate, and every host that has not opted into it keeps the
existing local cap, which is unchanged by this decision.

### Windows source audit

The `cfg(windows)` workspace-key path was audited against the documented Win32
contract and needs no change: `CredWriteW` takes persistence from the
`Persist` member, `Flags` accepts only `0` or `CRED_PRESERVE_CREDENTIAL_BLOB`,
and `CRED_PERSIST_LOCAL_MACHINE` is visible only to other logon sessions of the
same user on the same computer, which matches the per-user macOS keychain item.
Home-edition support is unverified, and `load_or_create` fails closed with an
explicit restore message if a key ever becomes unavailable, so a persistence
downgrade is an availability failure rather than silent key loss. The
`#[cfg(all(test, windows))]` tests cannot run on a macOS host and no
`x86_64-pc-windows-msvc` target is installable here, so the Win32 calls
themselves stay source-inspected. One part of that path is now testable
without Windows: the Credential Manager target name and the accepted blob
length moved out of the `#[cfg(windows)]` block, and
`keychain::windows_naming_tests` pins that the target is the same
`dev.void.desktop.workspace` service and account the macOS keychain uses, is
NUL terminated exactly once, carries a non-ASCII account name whole, and is
never shared between two workspaces. Renaming the target turns two of them
red. `cargo test --offline` for the desktop crate is 16/16 on macOS. The
`CredReadW` and `CredWriteW` calls and the `#[cfg(all(test, windows))]` store
tests still need a Windows machine. P10.09 is unchanged. See
`docs/WINDOWS-DESKTOP.md`.

## Distribution and retained-format rules

Mac App Store, notarized direct Mac download and native iOS/iPadOS are three independent distribution tracks. Public managed cloud is not a first-beta executor. The local Mac candidate now intentionally uses version `1.0.1` in `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock` and `apps/desktop/src-tauri/tauri.conf.json`; the bundle identifier `dev.void.desktop` remains development metadata, not approved store identity. The bundled Node runtime remains independently pinned to `24.21.0`. `void.adapter-capability.v2` describes scope and does not authorize execution: it adds a required `authority: "scope-only"`, a required `conformance.runtime`, a required `maxDecodedBytes`, required `certification` where a bare `true` is refused as "not evidence", and it refuses unknown fields and a retired `v1` report. That is a report format break, recorded as one: a `v1` report is refused rather than silently accepted, and no persisted state depends on the older shape. Preserve `certification:false` on Git/documents and the uncertified filesystem profile until a separate certification process exists. Sources: `apps/desktop/README.md`, `apps/desktop/release.test.mjs`, `packages/connectors/src/capability.ts`, `packages/connectors/src/capability-profiles.ts`, `packages/cli/src/conformance.ts`.

Journal `void.operation.v1` and `void.recovery-job.v1`, encrypted vault SQLite and legacy files, JSONL signatures, encryption/signing keys and document storage form one restore set. No general 1.x compatibility or downgrade promise until old-build fixtures prove it. A wrong key or truncated/unanchored history must be reported as unverifiable, not silently repaired. Sources: `packages/runtime/src/journal.ts`, `packages/runtime/src/reserved-vault.ts`, `docs/RECOVERY-CONTRACT.md`.

## Requirement to owner and acceptance gate

Every row starts open. A gate labels what must be run or witnessed for that requirement; the owner must attach exact source commit, installed binary checksum and sanitized evidence after execution.

| ID | Requirement | Owner | Acceptance gate |
| --- | --- | --- | --- |
| P00.01 | Reconcile stale gaps against current implementation; mark each supported adapter/operation/platform as source-inspected, fixture-tested, device-tested or externally verified. | Release/product | Done: current capability and tooling snapshot above; no device-tested claims. |
| P00.02 | Record supported distribution modes and exact advertised exclusions. Reuse void.adapter-capability.v1; preserve certification:false unless an actual certification process exists. | Release/product | Done: distribution and retained-format rules above. The schema moved to `void.adapter-capability.v2` on 2026-09-25 and now refuses a retired `v1` report, so the wording of this row is one version behind the code; the intent is unchanged. Every provider profile keeps `certification:false` and a bare `certification:true` is refused as "not evidence", and the release gate `scripts/src/capability-profile-gate.test.mjs` asserts it per provider. |
| P00.03 | Define persisted-format compatibility and supported upgrade sources before promising stable 1.x compatibility. | Release/product | Done: no upgrade source or downgrade promise is supported yet; exact old-build migration gate is P09.01/P10.02. |
| P00.04 | Map every requirement below to a test and accountable owner. Record initial device/build tool inventory without exposing signing credentials. | Release/product | Done: each plan row has owner and acceptance gate below; current Xcode inventory is recorded above. |
| P01.01 | Build a minimal signed sandbox variant retaining the real bundled runtime, not a placeholder UI. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.02 | Test child process entitlement inheritance, runtime/JIT needs if applicable, loopback listener, outbound TLS, Keychain, explicit user-granted folder access and Downloads export. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.03 | Use system file selection and persistent security-scoped access where required; test denial, revocation, path change and restart. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.04 | Identify incompatible credential import, arbitrary child tool or unrestricted path features. Disable or redesign them in store mode, visibly rather than silently. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. Resolved defect from the 2026-09-25 local acceptance run: the operator tool catalog was not permission-mode filtered, so `GET /api/tools` advertised `void_workspace_write` while `documentEditing` was `false`. Dispatch-time enforcement held, so it was a visible-capability mismatch and not a bypass. `availableTools()` now filters through `toolAllowedInMode`, the live harness asserts the read-only catalog and re-passed at 67/67, and `permission-authority.test.ts` plus `safety-boundaries.test.ts` pass 8/8. The remaining sandbox and store-mode questions in this row are unwitnessed, so it stays open. |
| P01.05 | Verify clean shutdown, crash cleanup and no orphan runtime. Never interpret empty Tauri capabilities as App Sandbox support. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.06 | In parallel, validate a minimal native SwiftUI client against a TLS fixture on actual iPhone/iPad, including local-network permission denial and foreground reconnect, before investing in complete screens. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.07 | Decide continue Tauri, limited store companion with separate executor, or native Mac shell only from recorded evidence. Any architecture change requires approval. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P02.01 | Reproduce string/numeric ID collision, huge numeric-string IDs and string progress tokens. Preserve exact identity through batch responses/cancellation. | Core transport | Evidence: `node --test packages/proxy/src/relay/http-requests.test.ts` (12/12), `node --test packages/proxy/src/session.test.ts` (25/25), and `node --test packages/proxy/src/transport/http.test.ts` (8/8) pass. Client string IDs remain typed through Session; upstream IDs allocated by the relay remain numeric, so string upstream response IDs are rejected rather than coerced. |
| P02.02 | Add failed-partial-batch cleanup, disconnected-client cleanup, stalled POST and infinite/idle SSE tests. | Core transport | Evidence: relay suite (12/12) covers failed partial batches, disconnected clients, stalled POST, idle SSE, cancellation and mapping cleanup; HTTP transport suite (8/8) covers stalled POST and idle SSE. `pnpm --filter @void/proxy test` passed 140/140 on three post-race-fix runs. |
| P02.03 | Define bounded admission, pending-request cap, deadline/idle behavior, cancellation and backpressure. Mutating timeout yields uncertain evidence, not an automatic retry. | Core transport | Evidence: relay suite (12/12) covers pending cap, deadlines, cancellation, disconnect cleanup and SSE writable-buffer backpressure; HTTP transport suite (8/8) covers pending POST cap, post deadline, idle SSE, uncertain outcome and no POST replay. |
| P02.04 | Stop tight reconnect on persistent authentication failure; use bounded retry/backoff for safe reconnectable reads only. | Core transport | Evidence: HTTP transport suite (8/8) verifies 401 stops reconnecting, short GET streams use increasing bounded delays, and the reconnect limit stops after five retries. |
| P02.05 | Test slow stdin and slow HTTP response consumers; respect drain/abort paths without losing mapping cleanup. | Core transport | Evidence: stdio suite (10/10) covers bounded writes and signal-ladder cleanup; relay suite (12/12) covers slow SSE writable-buffer delivery and abort/disconnect cleanup. `pnpm --filter @void/proxy typecheck` passes. |
| P02.06 | Run a repeatable load test and record maximum pending count and quiescent cleanup. | Core transport | Evidence: 60-minute bounded load result `{completed:4256461,peakPending:16,finalPending:0,rssBytes:1158627328}`. Focused suites pass as above. Full `pnpm run check` completed all workspace/package/UI typechecks, then the test phase exceeded the harness 250-second cumulative limit; full check is not reported green. |
| P03.01 | Improve relative-path tool schema/help and stable sanitized error categories; test invalid path, missing artifact, denied policy and unavailable key. | Recovery core | Evidence: `node --test packages/cli/src/recovery-mcp.test.ts` (6/6) passes; signed MCP runtime, denied writes, closed mutation schemas, and sanitized path/secret-free error categories are covered. Full `pnpm run check` test phase timed out under the 250-second harness limit; no full-check green claim. |
| P03.02 | Add read-only health reporting for supported adapter/version, capacity, paused/unknown jobs and required repair steps; separate diagnosis from explicit reconcile/apply. | Recovery core | Fixture-tested: `node --test packages/cli/src/recovery-health.test.ts` (5/5) and `pnpm --filter @void/cli typecheck` pass. `void recovery health --config file` emits compact sanitized JSON before input/signer/bootstrap handling; fresh and retained-state checks prove no key generation or filesystem mutation, and missing/mismatched retained keys report unavailable/unsafe. Backup restoration remains tracked separately below. |
| P03.03 | Define complete backup contents and consistent snapshot procedure, including SQLite/WAL state and required artifacts. Keys must not enter a plaintext diagnostics export. | Recovery core | Evidence: `node --test packages/cli/src/recovery-filesystem.test.ts` (3/3) passes; the stopped-executor backup helper copies SQLite WAL state, preserves manifest/history, and excludes plaintext encryption-key bytes. |
| P03.04 | Restore a disposable complete backup and verify signatures, history visibility and real Undo. Test missing WAL/artifact, wrong key and truncated history according to explicit completeness policy. | Recovery core | Evidence: the same `node --test packages/cli/src/recovery-filesystem.test.ts` (3/3) run restores a disposable backup, verifies signed history, exercises wrong-key/missing-artifact/truncated-history refusals, and completes a real filesystem Undo. |
| P03.05 | Document unavailable-key handling; never regenerate a retained key. Test rotation/migration in disposable state before offering a user-facing rotation feature. | Recovery core | Evidence: `node --test packages/runtime/src/reserved-vault.test.ts` (12/12) passes; unmarked-vault marker verification, retained-evidence key rotation, wrong/unavailable-key refusal, and no retained-key regeneration are covered. |
| P03.06 | Exercise storage refusal/ENOSPC or equivalent fault harness without claiming power-loss proof from injected exceptions. | Recovery core | Evidence: `node --test packages/runtime/src/reserved-vault.test.ts` passes 12/12; the deterministic ENOSPC-equivalent harness fails before adapter.execute with zero dispatches and no dispatched/succeeded receipt. This is injected storage-refusal evidence only, not physical power-loss proof. Full `pnpm run check` typechecks pass; its test phase exceeded the 250-second cumulative harness limit. |
| P04.01 | Inventory existing endpoints first. Reuse safe read/recovery services, not a second implementation of policy. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P04.02 | Freeze capability handshake, device/workspace scope, chat/session reads, event cursor, request outcome, approval/recovery preview/apply and device revocation schemas. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. Partial 2026-09-25 evidence on the client side only: `apps/apple/CompanionProtocolKit` `swift test` passed 27/27 on a macOS host, and its 12 `SecurityRegressionTests` cases cover response device/workspace scope mismatch, an oversized response, an unknown outcome shape, event-page replay-window, UTC and cursor rules, and a URL outside the bound local-network identity. That is client-side contract enforcement, not a paired-device or transport result, and the shared-fixture and security-review part of this gate is still unwitnessed. |
| P04.03 | Specify limits for body/event sizes, concurrency, replay window and token/grant lifetime with rationale. Test both boundary and boundary+1. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. Partial 2026-09-25 evidence on the client side only: the same 27/27 `CompanionProtocolKit` host run exercises a bounded maximum response size and a scoped operation-status store that fails closed on corruption, and `scripts/src/companion-fixtures.test.mjs` passes 7/7 against the shared P04 fixtures. Those are fixture and host runs; the boundary-plus-one matrix against a real transport and the security review are still unwitnessed. |
| P04.04 | Threat-model stolen invitation, QR substitution, stolen token, compromised device, malicious executor address, replay, cross-workspace access and multiple-device races. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P04.05 | Write shared JSON fixtures for Swift decoding and server validation: succeeded, denied, conflict, unknown, unsupported-version and revoked cases. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P05.01 | Add explicit start-pairing, invitation expiry/single-use, host confirmation and initial read-only grant. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.02 | Store device credentials in native secure storage; test replay, duplicate acceptance, certificate mismatch, revoked device and expired grant. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.03 | Bind each approved action to device/workspace/session/operation/current authorization. Add two-device races where only the still-valid exact action succeeds. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.04 | Implement bounded event reconnect and status lookup. Kill the mobile client after dispatch and prove reconnect does not repeat the forward mutation or inverse. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.05 | Revoke a device during an open stream and during pending approval; stop further authorized work while preserving already-dispatched outcome evidence. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.06 | Test local network permission denial, executor sleeping/offline and change of network. No router port forwarding required or implied. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P06.01 | Create a universal iOS/iPadOS app with reproducible project configuration, correct bundle identity, environment separation and native tests. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.02 | Implement typed URLSession client and versioned fixture decoding; keep credentials in Keychain, not UserDefaults or logs. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.03 | Implement onboarding, pair/revoke, executor identity/status, safe reconnect and offline read-only state. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.04 | Implement iPhone navigation and iPad split view, shared VOID identity, Dynamic Type, reduced motion and native accessibility labels. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.05 | Define cache retention/redaction and logout/device-removal cleanup. Cached history is not authority for a new mutation. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P07.01 | Add streamed chat, draft preservation, cancellation and attachment limits; verify Japanese IME, long content, tables/code and provider rejection. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P07.02 | Show requested tool, affected resource, actual executor, recoverability and permission source before confirmation. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P07.03 | Add exact preview and explicit confirmation for Undo; truncated/unavailable previews must be labeled, not displayed as a complete diff. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P07.04 | Preserve unknown/partial/conflict/paused states. Refresh stale previews instead of silently applying a newer plan. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P07.05 | Test two phones approving the same work, revocation during preview, host restart, app force-quit, background/foreground and lost apply response. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P07.06 | Add iPad hardware keyboard, portrait/landscape/multitasking and VoiceOver navigation. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P08.01 | Add a short guided safe-workspace exercise; no customer account or production mutation is needed to learn Undo. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.02 | Show running build/version/channel, current executor, capability limitations, storage location and provider snapshot. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.03 | Replace opaque startup exits with actionable keychain/runtime/permission guidance, preserving a safe redacted diagnostic path. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.04 | Add diagnostics preview/export with an allowlist: build, OS, capability versions, failure codes and opaque IDs. Unit-test exclusion of synthetic secrets and content. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.05 | Expose privacy/support/release notes and explicit export/delete/reset choices consistent with retained signed evidence. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.06 | Fix outdated provider bootstrap instructions and stale beta download links. Store builds use Store updates; direct builds may initially use a verified release link rather than a new updater framework. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P09.01 | Test fresh install, supported upgrade, rollback/unsupported-newer-format refusal and uninstall/reinstall behavior without accidental key/data loss. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: the live harness ran each scenario against a fresh `mkdtemp` data directory, so fresh-state behaviour is covered, and a real inverse undo was applied in S-08. Not covered: install, upgrade, rollback, unsupported-newer-format refusal and uninstall/reinstall on a packaged artifact. No key or data-loss claim is made for an installed build. |
| P09.02 | Execute normal and negative recovery journeys through actual desktop, mobile bridge and configured MCP transports in isolated environments. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: the live harness ran normal and negative recovery journeys over the real control-plane API including confirmation-gated undo with a genuine inverse (S-08), and a live CLI journey ran 43 scenarios against the real `void.mjs recovery` binary covering health, inspect, digest-bound execute, key availability, plan/apply, journal tampering, retained-key loss, backup create/verify and an isolated backup restore (L-01 to L-09). The CLI suites cover the MCP stdio path. Added the same day: the companion surface now has 20 tests over the real control-plane HTTP server, so runtime revocation, device scope and workspace scope are no longer unverified. They cover pairing issuing a one-time credential that is never stored or repeated, the protocol's eight-device-per-workspace cap, the exact response shapes, a fail-closed 404 for an unprovable operation identity, fail-closed auth for missing, wrong, expired and revoked credentials, a read-only device refused a mutation, a device refused another device's revoke, idempotent revocation that keeps the dispatched effect readable, a second workspace seeing neither data nor credential, redacted and bounded diagnostics, cross-site refusal, the frozen outcome vocabulary, and a full `void.companion.v1` envelope round-trip whose live responses are validated by the frozen `validateCompanionFixture`. Still not covered: the desktop packaged app, and any paired-phone journey over a real transport with TLS. `swift test` for the Apple client is a macOS-host run against in-process transport doubles, so the envelope is proven against the server, not across a network. |
| P09.03 | Test offline, revoked token, missing key, corrupted artifact, full storage, executor crash before/after dispatch and before/after recovery receipt. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: missing, wrong and short credentials were refused with 403 (S-10); unknown, digest-mismatched and unapproved applies were refused with 409 without mutation (S-06, S-07); a stale plan could not overwrite a human edit (S-07); a missing key, a wrong key, a forged approval digest and a forged plan digest each failed closed without mutating the file (L-03, L-04, L-05); a deleted retained signing key was refused with a stable message and never silently regenerated (L-07); a forged journal line turned health and plan unsafe until the original history was restored (L-06); backup verification returned `history_unanchored`, `history_incomplete` and `missing_artifact` for a wrong or missing anchor, a tampered journal and a deleted vault artifact (L-08); a denied operation identity stayed consumed (L-03); and `packages/runtime` `recovery-crash` plus `persistence-fault` pass 36/36 across injected ENOSPC and SIGKILL. Not covered: real mid-stream revocation, genuinely full storage, a physically killed executor, and any power loss. |
| P09.04 | Verify no secret/content leaks in exported diagnostics, logs, build artifacts, crash reports or screenshots. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: sentinel private and API keys never appeared in ledger-verify, capabilities or provider error responses (S-12); the Rust startup-log allowlist passes 6/6; the Swift package bounds and redacts diagnostic identifiers and message content. Added the same day: the companion diagnostics surface is proven to refuse a sentinel credential and a home-directory path, caps the page at 100 entries and the summary at 320 characters counted in whole code points so an astral character cannot push it one unit over the frozen bound, and every live response body is additionally run through the frozen fixture field, bound and allowlist predicates. Still not covered: exported diagnostics, logs, build artifacts, crash reports or screenshots taken from an exact packaged build. |
| P09.05 | Test real provider streaming in an explicitly authorized bounded-cost sandbox. Without credentials/budget, leave that gate open; fixtures cannot close it. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. No provider sandbox, credential or budget was authorized, so no real provider streaming run is claimed. Fixture and stream-unit coverage cannot close this gate. |
| P09.06 | Run VoiceOver and physical keyboard tests, true 200% desktop zoom, iPhone/iPad safe areas, rotation, Dynamic Type and background lifecycle. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. The 2026-09-25 simulator run now covers 9 `VOIDTests` and 8 `VOIDUITests` cases, and the web gate `scripts/src/ui-layout.test.mjs` covers 69 desktop and 55 mobile tab stops with a measured focus ring, reduced motion collapsing 12 animated elements to 0, and mobile touch targets. Those are still synthetic: a real Tab in a headless browser is not a physical keyboard, emulated 200% zoom is not browser zoom, and a simulator is not a device. VoiceOver, physical keyboard, true browser zoom, iPhone/iPad safe areas, rotation, Dynamic Type and background lifecycle remain untested, so this gate stays open. |
| P09.07 | Validate performance/load budgets and record machine/device/network details. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. The 2026-09-25 simulator build, install and launch were not an instrumented performance run. The recorded transport load result under P02.06 is a relay bound, not this gate, and no device or network profile was captured. |
| P10.01 | Coordinate marketing version 1.0.1, monotonically increasing Apple build numbers and source/binary provenance. Do not bump unrelated package compatibility blindly. | Release operator/product | Source-inspected and contract-tested: `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock` and `apps/desktop/src-tauri/tauri.conf.json` intentionally agree on local candidate `1.0.1`; `apps/desktop/release.test.mjs` verifies those sources. The Apple project metadata remains `MARKETING_VERSION=1.0.1` and `CURRENT_PROJECT_VERSION=1`. The bundled Node runtime remains separately pinned to `24.21.0`; root and unrelated workspace package versions are intentionally unchanged. No exact committed source/binary provenance, clean-tree record, or approved Apple build number is recorded. |
| P10.02 | Freeze persisted-format migration/backup documentation and test upgrade from advertised prior versions. | Release operator/product | Source-inspected: `docs/RECOVERY-CONTRACT.md` documents current journal/vault formats and the complete stopped-executor backup; `scripts/src/recovery-backup.mjs` documents SQLite online backup, WAL manifest contents, and verification categories. No supported prior-version source, old-to-new upgrade fixture, or downgrade guarantee is advertised; those remain blockers. |
| P10.03 | Configure separate Developer ID/notarized DMG and Mac App Store signing/provisioning paths. Sign nested executables and test exact packaged artifacts. | Release operator/product | Source-inspected: `apps/desktop/src-tauri/tauri.conf.json` targets `app` + `dmg`; `apps/desktop/scripts/build.mjs` defaults Apple signing identity to `-`, and `apps/desktop/README.md` says builds are ad-hoc without Developer ID/notarization credentials. No signed/notarized artifact, separate Mac App Store path, or nested-executable evidence is recorded. Blocker: authorized Apple Developer identity/team and signing/notary setup. |
| P10.04 | Configure iOS distribution provisioning, archives, TestFlight and build environment. Verify installed full Xcode/SDK rather than relying on old machine inventory. | Release operator/product | Source-inspected and simulator-built: `apps/apple/` contains the native iOS 17 Xcode project, Swift package, app, unit tests, UI-test source and protocol fixtures. Current source contains 9 `VOIDTests` cases and 6 `VOIDUITests` cases. On 2026-09-25 Xcode metadata resolved, the Release `iphonesimulator` build of the `VOID` scheme succeeded, the product installed and launched on a simulator, and a simulator test run passed `VOIDTests` 9/9 and `VOIDUITests` 6/6 against the current source, superseding the earlier historical 6/6 unit figure. The `CompanionProtocolKit` host SwiftPM run passed 27/27 on macOS host, which is client-side contract enforcement and not an iOS simulator or device result. Reserved-vault evidence is 12/12. The distribution path is not configured: `DEVELOPMENT_TEAM` and `CODE_SIGN_ENTITLEMENTS` are absent from the project, `CODE_SIGN_IDENTITY` is the legacy `iPhone Developer` alias, the provisioning profile directory is empty, and a `generic/platform=iOS` Release build failed for want of a profile for `com.void.companion`. No archive/export was produced and the project has no asset catalog, so the built product carries no app icon. The attached iPhone reports Developer Mode off, so even a dev-signed install is blocked. Provisioning, archives, physical iPhone/iPad install, signed-device evidence, App Store Connect and TestFlight remain open. |
| P10.05 | Complete data inventory, in-app privacy policy, App Privacy labels, retention/deletion policy and support contact. Audit required-reason APIs/SDK manifests from actual dependencies. | Release operator/product | Source-inspected data categories: local encrypted workspace snapshots (sessions, provider profiles, connector credentials, managed documents, signed history) under `VOID_DATA_DIR`; JSONL ledgers under `VOID_LEDGER_DIR`; approval state under `VOID_APPROVALS_DIR`; recovery keys/journals/vault; legacy snapshots and operator exports. Cloud Neon stores session/preference/provider/integration/OAuth/hold documents, append-only events, and signed ledger; provider/OAuth secrets are encrypted. External flows include model providers, GitHub/Vercel/Supabase MCP, Appwrite, Neon/Vercel Workflow, and optional S3/Postgres/Prime. No privacy policy, App Privacy/PrivacyInfo manifest, support contact, or product-wide retention/deletion policy was found; support/privacy/legal ownership remains unassigned. Local recovery evidence/artifacts are retained by design, legacy snapshot GC is namespace-scoped, cloud ledger/events are append-only, and no data-subject deletion workflow is mounted. |
| P10.06 | Decide export-compliance classification for encryption deliberately; do not blindly set a no-encryption exemption flag. | Release operator/product | Source-inspected encryption includes local/cloud AES-256-GCM, Ed25519 signing, HTTPS/TLS, and Keychain/Credential Manager or mode-0600 key files. No `ITSAppUsesNonExemptEncryption`, export classification, entitlements, or native iOS metadata exists in the repository; the Apple classification cannot be inferred from source and must be decided by the release operator before store metadata. |
| P10.07 | Prepare accurate device screenshots, descriptions, age rating, reviewer instructions, accessible test account/demo and a reachable safe test executor for review. | Release operator/product | Source-inspected: the public demo is isolated to managed documents; current UI exposes provider/integration settings and local chat/document/ledger exports, but no P10-specific App Store screenshots, descriptions, age rating, reviewer instructions, or native iOS asset set was identified. OAuth/provider consent and a reachable safe test executor remain external setup gates. |
| P10.08 | If account creation exists, implement and test the applicable account-deletion path. If no account exists, do not invent one solely for release. | Release operator/product | Source-inspected: `cloud/auth.mjs` contains a server-side Appwrite signup helper, but `cloud/server.mjs` does not mount it; `docs/APPWRITE-AUTH.md` explicitly says public signup is disabled and shared cloud routes are not safe for multiple owners. No account-deletion route, data-subject deletion workflow, or test exists. Keep open; do not invent an account path. |
| P10.09 | Validate and advertise a Windows desktop build with Windows filesystem/Git recovery evidence. | Release operator/product | Out of scope/open for 1.0.1: no current-source Windows packaging, installed smoke or full Windows recovery-suite evidence is claimed. A later authorized Windows x64/MSVC candidate must pass this gate before advertisement. |
| P11.01 | Start with internal testers, then invite-only TestFlight for iPhone/iPad and the chosen Mac distribution track. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.02 | Run the proposed tester sample and review every data-integrity/auth incident before expanding. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.03 | Retain prior compatible binaries and a documented server rollback. Mobile clients must tolerate supported server version skew; no forced unsafe data downgrade. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.04 | Keep emergency disablement scoped to new remote writes while preserving read/history/diagnosis; no control that silently deletes recovery evidence. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.05 | Submit only after all promised-platform gates pass. Track submission, review, approval and public availability separately. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.06 | Monitor opt-in/redacted signals and support reports after release. If privacy-safe monitoring is absent, do not claim a crash-free rate. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| D01.01 | Inventory every current route, modal, composer control, status and icon. Record reuse/redesign/remove decisions; do not remove working capabilities for a cleaner screenshot. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.02 | Propose two coherent visual directions built around VOID branding: compact neutral workspace with restrained orange, and a slightly more native Apple presentation sharing the same information hierarchy. Retain the approved Claude Code-like chat priority, not its brand assets. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.03 | Produce readable high-fidelity references for Mac chat, active tool run, recovery preview/conflict, activity/history, provider setup; iPhone chat/approval/pairing; iPad split-view review. Show actual content rather than empty hero-only screens. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.04 | Review light/dark, loading, long content and destructive/unknown states in the design, not only the happy path. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.05 | User approves one direction and navigation structure before implementation. Images are design references, never claimed as screenshots of working software. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D02.01 | Define semantic color, surface, border, focus, typography, spacing, radius, elevation and motion tokens with light/dark variants. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.02 | Remove conflicting overrides incrementally. No additional global patch stylesheet, blanket zoom, giant padding or full-app monospace. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.03 | UI desktop body target13-14px and chat15-16px remain readable; mobile web input>=16px, native text follows Dynamic Type, touch targets>=44px web/>=44pt native. Do not hard-code small native font sizes to mimic desktop density. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.04 | Preserve VOID aperture as the brand mark. Use one existing SVG family on web/Mac, extending only missing semantic icons; use SF Symbols on Apple-native screens with a documented semantic mapping. Do not ship SF Symbols as a cross-platform web icon font. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.05 | Catalog navigation, chat, attachment, tool, policy, approval, preview, undo, conflict, unknown, executor, pairing, network, backup, privacy and support symbols. Avoid emoji/ASCII as the only functional icon. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.06 | Icon-only controls receive accessible names/tooltips; destructive and ambiguous actions also show text. Never distinguish approved/conflict/unknown by color alone. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.07 | Build a lightweight internal component/state gallery using existing app/dev tooling. Do not add Storybook or a new UI kit unless the existing tools genuinely cannot serve the need. | Design system | Closed 2026-09-25 without a new tool: `/gallery` is an internal-only route in the existing app, mounted from `Root` so `App` never mounts, and it issues zero `/api/` requests. It is absent from `routes`, so it is out of the sidebar and out of the command palette, it sets its own internal document title, and it renders only static representative state. `apps/control-plane/ui/src/gallery.test.ts` and `scripts/src/ui-layout.test.mjs` run it through the same nine-viewport, focus-ring, reduced-motion, zoom and touch-target checks as the rest of the product, including an assertion that a synthetic secret fed through `RedactedJson` never reaches the DOM. `apps/control-plane/ui/src` 73/73 and `scripts/src/ui-layout.test.mjs` 22/22. |
| D03.01 | Button and icon button variants with pending/disabled behavior. | UI implementation | Inventory 2026-09-25, counting only a component mounted in a running surface: 24 of the 30 D03 families have a real consumer with a `file:line`, 4 are partial, and 2 have none. D03.22 (backup and retained-history health) and D03.26 (pairing QR, confirmation, expiry, device revoke) have no consumer anywhere in `apps/control-plane/ui/src`. D03.25, D03.28, D03.29 and D03.30 are partial. These are absences, not test failures: no run closes a family that has nothing mounted. The primitives named in the plan and absent from the code are tooltip, `role="menu"`, `role="tablist"`/`role="tab"`, `role="switch"`, `role="combobox"`, skeleton, toast, native sheet, split-view, inspector and breadcrumb; the app uses native `<details>`/`<summary>` in 18 places instead. The full per-family table with `file:line` is the evidence for this row, and D01 design approval is still outstanding, so building a missing family is not authorised work. |
| D03.02 | Text field, search, secure field, select/combobox and validated field message. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.03 | Checkbox, radio/segmented control and switch with actual semantic role. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.04 | Badge/status label, progress, skeleton and inline notice. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.05 | Tooltip, menu, command palette and contextual actions. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.06 | Dialog/confirmation, native sheet, popover and notification/toast. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.07 | Tabs, breadcrumb, sidebar item, toolbar, split-view and inspector. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.08 | Empty state, error panel, offline banner and recoverable loading state. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.09 | Message composer with attachments, model selection and compact secondary controls. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.10 | User/assistant message, Markdown/code/table view, copy and accessible code overflow. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.11 | Streaming indicator, Stop control, queued-unsent draft and retry explanation. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.12 | Tool execution row/card with expandable arguments/result and durable outcome. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.13 | Session/context summary and compaction control whose pending state survives navigation. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.14 | Permission-source badge, provider status and executor identity/availability strip. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.15 | Change summary with affected resources and capability limitations. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.16 | Before/after diff, unified narrow-screen view and large/binary preview explanation. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.17 | Approval panel with exact scope, expiry and explicit confirm/deny. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.18 | Recovery preview and confirmation with actual plan identity and state boundary. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.19 | Timeline/event row, grouped run history and detailed signed outcome receipt. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.20 | Conflict comparison with safe next steps, no default force overwrite. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.21 | Unknown/paused/partial recovery panel with explicit reconciliation status. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.22 | Backup/retained-history health summary, capacity notice and repair guidance. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.23 | Workspace picker/browser and document detail. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.24 | Search/filter/pagination, desktop data table and equivalent mobile list/detail. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.25 | Executor picker, connection state, device identity and permissions view. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.26 | Pairing QR/confirmation/expiry flow and device revoke confirmation. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.27 | Provider onboarding, credential setup and connection validation feedback. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.28 | Guided first safe action and checklist progress. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.29 | Version/about/update information and release notes. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D03.30 | Diagnostics preview/export, privacy/support links and data management. | UI implementation | Open: real consumer + interaction states + gallery for each family. |
| D04.01 | Mac: chat, overview, conversations, runs, documents, approvals, ledger, connections, models, settings and public demo. Include search, detail views, paging, export and all dialogs. | UI QA/product | Routes measured on the 2026-09-25 build: `/chat`, `/overview`, `/runs`, `/documents`, `/approvals`, `/ledger`, `/connections`, `/models`, `/settings` and `/demo` all exist and are server-served. The "conversations" destination is `/sessions`, named "Konverzace / Conversations" in the sidebar (`main.tsx:92`); `/conversations` is a genuine 404 and was not invented into existence. Still open: per-route search, detail views, paging, export and dialogs were not individually exercised, and the public demo settles on "Demo is currently unavailable" when the fixture origin has no `/api/demo`. |
| D04.02 | iPhone: onboarding/pairing, workspace/session selection, chat, activity, approval/recovery detail, documents and settings/device management. | UI QA/product | Partly closed by the 2026-09-25 simulator matrix, partly not built. `xcodebuild test` on iPhone 18 Pro and iPad Pro 11-inch (M5), iOS 27.0, Xcode 27.0: `VOIDUITests` 8/8 and `VOIDTests` 9/9 on both device classes. Screenshots in `tmp/apple-ui-matrix/screenshots/` (iPhone and iPad, English and Czech, light and dark). Present: onboarding `OnboardingView.swift:3`, pairing card `:104-125`, activity `SessionsView` `:199-247`, settings `SessionDetailView.swift:36-75`. Not implemented, so no run can close them: workspace selection (no picker exists), session selection (read-only list, two hardcoded rows `AppModel.swift:71-77`), chat (no composer anywhere under `apps/apple`), documents, approval or recovery actions, and device management (the only control, `SessionDetailView.swift:56-60`, is disabled because `connectionState` never becomes `paired`). The pairing CTA is intentionally disabled: `canPair` is false in every state of this build. |
| D04.03 | iPad: sidebar plus chat/detail, resizable/multitasking layouts, inspector, keyboard shortcuts and pointer interactions. Do not simply stretch the phone layout. | UI QA/product | Partly closed. `NavigationSplitView` sidebar plus detail at `RootView.swift:15-27` with the sidebar at `:45-74`, and a real `horizontalSizeClass == .regular` split view, captured on an iPad Pro 11-inch (M5) simulator. Not implemented: inspector, keyboard shortcuts (no `keyboardShortcut` in the target), and chat detail. Pointer interaction is not verifiable on this machine; `simctl` has no mouse event injection. |
| D04.04 | Preserve drafts, IME, attachment removal, stream/cancel, status truth and focus when moving components. | UI QA/product | Measured 2026-09-25 in headless Chromium over the built bundle: a draft survives both a route change (`/chat/<id>` to `/settings` and back) and an in-place sidebar collapse with its exact text intact; IME composition inserts characters with no submit and no loss; attachments add and remove. One defect was found and fixed: pressing Stop unmounted the focused button and dropped focus to `document.body`, so `stopRun` now returns focus to the composer in its `finally`. Reverting that fix turns the gate red. |
| D04.05 | Capture actual built screens in both themes and English/Czech with long realistic content, not only component previews. | UI QA/product | Web closed 2026-09-25: light/en, light/cs, dark/en and dark/cs each render 2430-2542 characters with a 589px transcript, zero overflow, a visible composer and no error boundary; the public demo renders the same four combinations on its own server with the correct "From idea. Back anytime." and "Od nápadu. Zpět kdykoliv." headings, and the demo is clean across all nine viewports. Native closed the same day: the app now has a real appearance preference, `AppTheme` in `apps/apple/VOIDApp/AppModel.swift:81-98` persisted through `@AppStorage("void-theme")` and applied once as `.preferredColorScheme` at `RootView.swift:35`, defaulting to `system` so the OS setting wins. Copy exists in both languages, `AppCopy.swift:124-127` English and `:73-76` Czech. Four screens captured on an iPhone 18 Pro simulator, iOS 27.0: `tmp/apple-theme/{light-en,dark-en,light-cs,dark-cs}.png`. Measured, not asserted by eye: the entry title renders `rgb(0,0,0)` on `rgb(255,255,255)` at 21.00:1 in light and `rgb(255,255,255)` on `rgb(0,0,0)` at 21.00:1 in dark, cross-checked by a host-side tool independent of XCTest. Cutting `preferredColorScheme` makes the two render identically and turns the test red. Long realistic content on a small phone, Dynamic Type, and the iPad regular-width layout are not covered. |
| D04.06 | Web viewport matrix:320x568,390x844,430x932,768x1024,834x1112,1024x768,1280x800,1440x900 and short landscape. Native matrix includes supported physical iPhone/iPad classes, orientation, larger text and keyboard. | UI QA/product | Web closed 2026-09-25 with a real three-exchange conversation carrying a heading, a table and a code block. All nine viewports report `scrollWidth == clientWidth`, so horizontal overflow is zero everywhere, and Send is reachable at all nine. Native part stays open: it needs physical iPhone/iPad classes, orientation changes, larger text and a hardware keyboard. |
| D04.07 | Keep basic320x568 transcript>=200px and ordinary desktop transcript>=60% work area. Test stacked notices/tool/attachments and long draft; Send/Stop must remain reachable. Keyboard-visible tiny viewports prioritize accessible composer, with transcript shrink explicitly measured rather than a physically impossible fixed height promise. | UI QA/product | Closed 2026-09-25 with measured pixels: 320x568 transcript 372px of 520px work area (71.5%), 390x844 648/796 (81.4%), 430x932 736/884 (83.3%), 768x1024 813/976 (83.3%), 834x1112 901/1064 (84.7%), 1024x768 557/720 (77.4%), 1280x800 589/752 (78.3%), 1440x900 689/852 (80.9%). The stacked case at 320x568 with a 14-line draft and an attachment measured transcript 254px, notices 80px, attachments 56px, Send still reachable and the attachment removable. A keyboard-sized 667x375 measured 179px and 54.7%, which is reported rather than promised away, exactly as this row allows. |
| D04.08 | Verify real keyboard focus, VoiceOver, contrast, target sizes, reduced motion, zoom and app resume. Screenshot comparison supplements interaction tests, not replaces them. | UI QA/product | Web closed 2026-09-25 with a browser gate, `scripts/src/ui-layout.test.mjs` 12/12: 69 desktop and 55 mobile tab stops, none without a solid outline of at least 2px; the composer textarea measured with a real Tab at 1280x800 and 390x844 shows a solid 2px ring in the app's own `--focus` token with `:focus-visible` true; 12 animated elements normally and 0 under `prefers-reduced-motion: reduce`; no sub-44px touch target on mobile except the visually hidden file input, and none at all in settings at 390x844. One real defect was found and fixed: the composer textarea had no visible focus ring, because `.composer textarea { outline: none }` outranked `:focus-visible` and the halo painted the canvas colour on the canvas colour; a real `:focus-visible` rule reusing the existing token and the existing 2px value was added. Reverting it turns the gate red. Contrast was not measured numerically and app resume was not exercised. On the native side, `VOIDUITests` asserts `accessibilityLabel` on two surfaces, `isHittable` on two, `isEnabled` on four, a 44-point minimum target height on four, a non-zero on-screen frame on four, zero credential fields on three, and that an activity row is announced as one combined element. Still missing there: VoiceOver focus order, measured contrast, reduced motion, zoom and app resume. The `accessibilityIdentifier` values `activity.settings` and `sidebar.settings` are defined in the app but referenced by no test, so they are dead metadata. | On the native side an appearance control is now part of the entry screen with a 44pt minimum target and an accessible label, and the four theme-by-language screens above are measured, but secondary `.foregroundStyle(.secondary)` text contrast was deliberately not claimed: the element capture came back unreadable in both themes, so the AA figure covers primary-label text only. A real palette change is needed to close that, which is separate work. Reduced motion on the native side is a finding, not coverage: the app animates nothing, so there is no branch to test and none was faked.
| D04.09 | User approves proposed stack/platform floors, initial connectivity scope and exclusions. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.10 | Every milestone has dependencies, bounded deliverable and observable acceptance. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.11 | Requirements map covers Mac, iPhone, iPad, pairing, recovery, diagnostics, privacy, signing, tests, beta and rollback. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.12 | Product code remains unchanged during planning. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.13 | Next implementation batch is explicitly authorized before starting. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |

## Blocking inputs

Provisioning, App Store Connect access, Mac App Store team/App ID/signing and separate Developer ID, physical iPhone/iPad and clean test Mac; support/legal/privacy owner; bounded-cost provider sandbox; local-network scope and approved design direction remain blockers. Xcode metadata, native project listing, simulator build, Swift package tests and VOID unit tests do not replace these gates. Do not replace them with fixtures. Store uploads, public release and purchases require separate explicit approval.

## Reconciliation of older audits

`docs/PLAN-GAPS.md` and `docs/APPLE-APPS-PLAN.md` predate this scope decision. Their iOS local-core and mandatory macOS SwiftUI claims are superseded. G-01 cloud journal, G-03 local/cloud job availability, G-04 recorded resource sets and G-20 standalone verifier already have bounded implementations; their remaining cross-system, certification, distribution and network gates remain open. The old `docs/RELEASE.md` 0.1.0/npm release runbook is historical and does not certify Apple 1.0.1.
