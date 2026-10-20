# NOMO 1.0.1 release evidence matrix

Status: open for release on 2026-09-25. `source-inspected` means a code path was read; `fixture-tested` means a disposable conformance run passed in that session. Neither closes signed sandbox, physical-device or external beta gates. This matrix maps every checked work item and all 30 D03 families from the implementation plan. Planned gates are not reported as passing.

Evidence boundary of the 2026-09-25 update: source was re-read and the local toolchain re-observed. A Release `iphonesimulator` build and a simulator install/launch were run on this machine and are graded as simulator evidence below; a `generic/platform=iOS` build was attempted and failed for want of a provisioning profile. A disposable-fixture local acceptance harness over the real control-plane API, plus the repository suites named below, were run. No signing credential was read, printed or created, and no archive, export, TestFlight, App Store Connect, upload, physical-device install or provider run was performed. The unit and UI test results quoted below are the last recorded ones and stay labelled as historical. Every P01, P04-P09 and P11 row, plus P10.09, stays open: the local acceptance evidence narrows which sub-cases were exercised, and no row is promoted on a source, simulator, fixture or metadata result.

## Current capability and tooling snapshot

| Surface | Evidence grade | Current observed boundary |
| --- | --- | --- |
| Managed filesystem | Source-inspected and fixture-tested | `filesystem.managed` v1; POSIX create/write/delete/rename, cooperative regular files, bytes/mode. Four conformance scenarios passed. No external-writer or power-loss guarantee; no `certification` block. |
| Managed Git | Source-inspected and fixture-tested | `git.managed` v1; POSIX create/write/delete/rename/stage/unstage plus the single-path `commit` lifecycle. Seven conformance scenarios passed, `certification:false`. `commit` is the one operation with durable execution and recovery receipts, under `refs/void/operations/` and `refs/void/recoveries/`; the worktree and index actions still reconcile to unknown because state equality is ABA-unsafe. No remote, Windows or full-repository recovery. |
| Managed documents | Source-inspected and fixture-tested | `managed-documents` v1; text write/delete only, 256 kB, no host filesystem. Two conformance scenarios passed, `certification:false`. |
| Managed PostgreSQL | Source-inspected and fixture-tested; historical isolated-service evidence | `postgres-managed-conformance` v2, the id the adapter factory derives for the conformance workspace. Restricted primary-key row INSERT/UPDATE/DELETE plus a captured cascade subtree and a row-level tenant scope, over an in-process PGlite fixture. Five conformance scenarios passed, `certification:false`. Explicit metadata v1-to-v2 migration remains an operator command that tool execution refuses. No networked cluster, replication, network partition or process-death evidence, and no new live service test run here. |
| S3, GitHub, Vercel | Source-inspected exclusions | Legacy capture or OAuth connection does not imply executable recovery. No first-release Undo claim. |
| Mac direct beta | Historical packaged test, source-inspected | Ad-hoc signed Tauri app/DMG with bundled Node, not Developer ID notarization or App Sandbox. |
| Mac App Store | No signed sandbox/device test | No store entitlements/provisioning/pkg or signed sandbox capture/Undo evidence. |
| Native iPhone/iPad | Source-inspected; Release simulator build and simulator launch observed 2026-09-25, current simulator test run observed 2026-09-26; no physical-device build, signed-device or store evidence | `apps/apple/` contains a native iOS 17 Xcode project, Swift package, app, 12 `NOMOTests` source cases, 18 `NOMOUITests` source cases and protocol fixtures. On 2026-09-25 a Release `iphonesimulator` build of the `NOMO` scheme succeeded and the product installed and launched on an iPad Pro 11-inch (M5) simulator rendering the onboarding/entry screen. A 2026-09-26 simulator test run against the source of that day passed `NOMOUITests` 18/18, ending `** TEST SUCCEEDED **`; a later run the same day, against the source that added paired-device security and the cache policy, executed 12 unit tests with 0 failures in 59.6 s and ended `** TEST SUCCEEDED **`, and the 18-case UI run has not been repeated against that newer source; the 2026-09-25 run of that same destination covered only 6 `NOMOUITests` cases and is superseded. That product is ad-hoc signed with no team identifier, no entitlements and no bundle icon, so it is simulator evidence only. The separate `CompanionProtocolKit` host SwiftPM run passed 34/34 but is a macOS host run, not an iOS simulator or device result. A `generic/platform=iOS` device build failed on 2026-09-25 because no provisioning profile for `com.void.companion` is installed, the attached iPhone has Developer Mode off, and the project sets no `DEVELOPMENT_TEAM`. Physical iPhone/iPad install, App Store and TestFlight gates remain open. |
| Windows desktop | Out of scope for 1.0.1; current-source gate open | Historical beta-4 Actions evidence does not certify the current candidate. No current-source Windows packaging, installed smoke or full Windows recovery evidence is claimed. P10.09 remains open. |
| Tooling | Current machine observation, 2026-09-25; Xcode metadata and Release simulator build succeeded | Node v26.8.1, pnpm 10.33.0; Xcode 27.0 build 27A266a selected at `/Applications/Xcode.app`. `xcodebuild -list` reports targets `NOMO`, `NOMOTests`, `NOMOUITests`, configurations Debug/Release and schemes `CompanionProtocolKit`, `NOMO`. The keychain holds one Apple Development identity that the project does not reference, and the provisioning profile directory is empty. Apple account, Developer ID, provisioning, archive, physical-device install and store access remain unverified. |

Sources: `packages/cli/src/conformance.ts`, `packages/connectors/src/capability.ts`, `docs/RECOVERY-COVERAGE.md`, `docs/RECOVERY-CONTRACT.md`, `apps/desktop/src-tauri/tauri.conf.json`, `docs/GUI-COMPACT-VERIFICATION.md`. Conformance was re-measured on 2026-09-26 with real exit codes rather than a pipeline's last-command status, which had made an earlier `git.managed` result look green when it had in fact been killed: `filesystem.managed` exit 0 with 4 scenarios, 32 checks, 0 failed, `managed-documents` exit 0 with 2 scenarios, 16 checks, 0 failed, `git.managed` exit 0 with 7 scenarios, 56 checks, 0 failed in 86 s, and `postgres-managed-conformance` exit 0 with 5 scenarios, 40 checks, 0 failed in 23 s. The runtime difference matters and was not recorded before: `git.managed` took roughly nine minutes against seconds for the other two, so it needs its own budget in any CI job rather than a shared short timeout.

## 2026-09-26 web surface, credentialed end to end

This is the first run of the web surface that exercised a real write, a real
Undo and a real restart, rather than isolated route rendering.

`pnpm run build:web` exits 0; Vite 7.3.6 writes `dist/web`. The only build
warnings are module-level `"use client"` directives from `@tanstack/react-query`
and `framer-motion`, and a 791 kB index chunk above the 500 kB warning
threshold. No errors.

Navigation was driven in headless Chromium at 1440x900 through the repo's own
`scripts/src/cdp.mjs`, bound to 127.0.0.1. `/` returns 200 over `http/1.1` and
mounts `#root`. All eight sidebar routes render with real content: `/overview`
with stat tiles and a recent-work table, `/runs`, `/approvals` with the R3/R2
risk banner, `/documents` with column headers. The composer is present on `/`
and `/chat/new` and absent on the read-only routes, which is the intended
design. Console errors, uncaught exceptions and warnings were 0 on every page.

The write pass needed a second launcher. The default QA harness
`scripts/src/preview-workspace.mjs` sets only `NOMO_DATA_DIR` and
`NOMO_LEDGER_DIR`, so it inherits `DEFAULT_HTTP_PERMISSION_MODE = "read-only"`
from `packages/workbench/src/gui.ts:196`. A first attempt through the composer
therefore produced a session and an answer but no document, and the composer
reported `Režim: jen čtení · vynucuje server`. That is correct fail-closed
behaviour, not a defect, and the mode is deliberately not switchable from the
UI. With `NOMO_PERMISSION_MODE: 'normal'` supplied by the launcher, and acting
only through the browser, the fixture provider issued a real
`nomo_workspace_write` tool call and `GET /api/documents` returned `plan.md` at
114 bytes with a real revision id. The browser rendered that row, and its
content matched byte-exact through `GET /api/sessions/:id/documents`.

Undo from the context panel opened a native dialog with a real diff, six lines
before and `Dokument neexistuje` after. Confirming returned the document list
to empty, set `content: null` and wrote a `recovery-` revision. The inverse is
captured, previewed and applied by the server; it is not a client-side fiction.

Persistence across a real restart is confirmed. After SIGTERM and a new process
on the same `NOMO_DATA_DIR`, `notes.md` came back at 27 bytes with revision
`16ec5189-1f68-49ba-9faf-e75f6f02a1fd`, and the document history in the UI
still listed all three operations, `notes.md write`, `plan.md undo` and
`plan.md write`. The Undo record itself survived the restart.

This closes the credentialed-backend gap for the web surface only. Real
provider billing, real recovery targets and physical accessibility evidence are
still not covered here, and the Vercel deployment is a separate surface with
its own evidence. No source change was made in this run.

## 2026-09-26 re-check of the two recorded P0 reliability findings

Both were re-tested against the current source over the real control-plane
API, driven through `scripts/src/preview-workspace.mjs` on 127.0.0.1 with a
disposable `mkdtemp` data directory. One did not reproduce. The other was
real, but not where it had been recorded.

`POST /api/sessions/:id/branches` returning 404 did not reproduce. With a
session that exists and a body the contract requires, `{"seq":1,
"prompt":"b","idempotencyKey":"k1"}`, the route returns `201` with a child
session, and an immediate replay of the identical request returns `201` with
the same child id. A body missing `seq` or `idempotencyKey` correctly returns
`400 invalid_branch` from `parseBranchInput` at
`apps/control-plane/api/server.ts:1564`, and an unknown session returns 404. The
earlier observation is not carried forward as an open defect; if it was ever
real, the route is not where it was measured.

The permission-mode finding was misattributed. There is no runtime
`PATCH /permission-mode` route and there is not meant to be: the server is the
sole authority, `resolvePermissionMode` at
`apps/control-plane/ui/src/permission-mode.tsx:30` reads the mode from
`/api/capabilities`, and `usePermissionMode` returns `setMode: () => undefined`
so a client cannot grant itself permission. A 404 from a hand-written path is
the fail-closed design working, not a route discarding a value.

What was actually broken sat one layer out, in the QA harness.
`scripts/src/preview-workspace.mjs` built the server with a hardcoded two-key
env object, `createControlPlaneServer({ env: { NOMO_DATA_DIR, NOMO_LEDGER_DIR } })`,
so `NOMO_PERMISSION_MODE` from the operator's environment was silently dropped
and the harness always served `read-only`. The server honours the variable when
it is present in the env object: passing the same env with
`NOMO_PERMISSION_MODE: 'normal'` resolves to `normal`, and omitting it still
resolves to `read-only`. The harness now spreads `process.env` and keeps the
disposable QA directories as the override, so the fail-closed default is
unchanged and an explicitly requested mode is no longer swallowed.

The practical cost of the old behaviour was that the write path looked broken.
An operator following the harness would conclude document writes were refused
and would write a private launcher to work around a defect that was one missing
spread operator away from not existing.

## 2026-09-26 every user-operable surface launched

All 20 `nomo` subcommands were executed against real fixtures and a real
disposable workspace rather than read. `classify` scored the shipped
`fixtures/session.jsonl` as 30 calls, 25 r0, 3 r2, 2 r3, 0 unclassified.
`verify` passed a real signed chain; `verify --standalone` correctly says
`signature NOT VERIFIED` rather than implying one. `attest` emits a signed
attestation, `export --bundle --state` produces four sections with per-section
digests and `complete true`, and `export verify --bundle` re-hashes all of
them while refusing a wrong anchor with exit 1. `doctor` reports 5 pass, 1 warn,
0 fail, the warn being the genuinely unset `verify-key` on this machine, left
unsuppressed. `approvals` requires a real 0700 directory holding a 0600
`pending.json`, and `approve` prints `proxy resolution not confirmed` instead
of claiming a success it cannot see.

`nomo run` was driven through a real stdio upstream. An allowed call returned
`{"text":"hello from nomo run"}` and wrote two signed ledger rows; a denied call
returned structured JSON-RPC error `-32003` with the rule number, the rationale
and `"retry":"do-not-retry"`, and wrote `deny` then `deny:resolved`. All 14
`nomo recovery` actions ran on a real filesystem workspace: `health` exits 1
`unavailable` before install and exits 0 `healthy` after, `execute` genuinely
changed the target file, a wrong `--approve` digest was refused, and `apply`
restored the file to its exact original bytes.

`python/nomo-transport` ran 84 tests, OK. The client was then attached to a
real spawned relay: handshake, 8 tools listed, a mutating call without an
idempotency key refused with `pending_holds ()` proving nothing reached the
wire, a malformed key refused, and a valid key reached the real server and
returned a structured `missing_artifact`.

`nomo recovery serve` over real JSON-RPC stdio returned
`{"protocolVersion":"2024-11-05","serverInfo":{"name":"nomo-recovery",
"version":"0.1.0"}}` and the same 8-tool catalogue, and a `nomo_recovery_plan`
call returned a plan for an operation the CLI had actually journalled, so the
MCP and CLI surfaces demonstrably share one signed journal.

`node scripts/src/agentic-reverse-exercise.mjs` exits 0 with
`agentic reverse exercise passed: 8 steps`: the target is inspected before any
change, a refused destructive call leaves the bytes identical, an approved call
captures then changes, a reused operation identity is refused, the signed
journal verifies over 7 entries, a restarted runtime acts on the same
workspace and history, the confirmed inverse restores exact bytes and mode 600,
and a replayed inverse is refused.

One genuine defect was found and fixed during this run. `nomo watch --ledger
<dir> --workspace <ws>` exited 1 with `Read failed: Ledger unavailable or
verification failed` while `feed` read the identical ledger fine, because the
directory was passed straight into `readLedgerFeed` instead of being resolved
to `$NOMO_WORKSPACE.jsonl` the way `taint`, `verify`, `export` and `metrics` all
resolve it. Fixed and pinned by `packages/cli/src/watch.test.ts`.

Stated as not verified: `nomo agent` stops at the model-catalog gate because no
provider is configured, so the agent session loop itself is untested. There is
no replay apply, no `NOMO_PG_URL` connector, no S3 path beyond a dry-run inverse
plan, and no postgres or git recovery adapter. `watch` was exercised only in
`--once` non-TTY mode, never the interactive path.

### Correction on the agent loop, 2026-09-26

The paragraph above frames the untested `nomo agent` loop as the largest gap
against the reverse-tool objective and implies NOMO needs a particular model.
That framing is wrong and is withdrawn. NOMO is a tool surface and an MCP
server; the intelligence is supplied by whichever model the operator points it
at, so the question is not which model NOMO runs but whether the surface it
exposes is correct for any provider.

`packages/workbench/src/provider.ts` declares exactly two wire protocols,
`compatible` and `anthropic`. Anything that is not `anthropic` normalizes to
`compatible`, which is the OpenAI-compatible shape, so one endpoint covers
OpenRouter, NVIDIA, Groq, Together, vLLM, LM Studio and a local llama.cpp
server alike. Direct OpenAI URLs are refused on purpose, and the model is
chosen by the operator, not by NOMO.

What that surface is tested for, in `node --test` over `provider-native`,
`provider-retry` and `provider-stream` at 13/13: native Anthropic model, tool
and usage shapes over the shared agent interface; transient rejection retried
with identical model, messages and tools, while paid models, other providers,
auth errors and long `Retry-After` are excluded; cancellation interrupts
backoff without a second request; a lost connection and a partial stream are
never retried; split UTF-8 and CRLF frames survive streaming; and the
properties that matter most for a surface pointed at an untrusted model,
namely that truncated JSON, a reasoning-only answer, a partial tool stream and
truncated model output can never become a dispatched tool action, that a
completed empty stream is reported as failure rather than a blank success, and
that a secret split across provider chunks is redacted from the stream.

So the honest remaining gap is narrow: no single provider has been exercised
end to end on this machine, because none is configured and credentials are out
of scope. That is an environment fact, not a product gate, and it does not
block the tool/MCP surface from being called provider-agnostic.

## 2026-09-26 iPad gate closed

`NOMOUITests.testAppearanceSwitchChangesRenderedColorsAndKeepsTextAtAAContrast`
was the one red case in the iPad run. It is now green on iPad Pro 11-inch (M5),
iOS 27.0, Xcode 27.0, with `Executed 1 test, with 0 failures (0 unexpected) in
68.900 seconds` and `** TEST SUCCEEDED **`.

The app was not at fault. `measureEntryTitle` resolved the entry title through
`app.scrollViews.staticTexts`, but `OnboardingView.swift` renders the scroll
view's body header only when `showsHeader` is true and passes `showsHeader:
false` at regular width, so on iPad the title exists solely as
`navigationTitle(copy.title)` in the navigation bar. The query now tries the
scoped element first and falls back to the unscoped
`app.staticTexts["Connect to your Mac"].firstMatch`, which is the form other
cases in the same file already use. `OnboardingView.swift` was not modified.

The contrast assertion was not weakened. The helper still ends in a pixel
measurement that splits the rendered window into glyph and surface colour and
returns a contrast ratio, and the `>= 4.5` assertions for both light and dark
are unchanged, so a merely-found title cannot pass. The passing run is
therefore evidence that the navigation-bar title itself clears AA, not just
that it was located.

Two environment notes belong with this. First, reaching a clean run required
freeing the host: the machine had ~73 MB free RAM with 10.9 GB of 12 GB swap
in use, `xcodebuild` sat at 0% CPU, and a simulator died under that pressure
with `Simulator device failed to launch com.void.companion`. Second,
`xcodebuild` on this host has repeatedly finished every case and then hung
without an exit code, so the console log, not the exit status, is the source of
truth for these runs.

## 2026-09-26 iOS App Config warnings cleared

The build emitted UIKit App Config warnings for orientation support and a
launch screen. The keys were declared but never reached the built plist:
`apps/apple/project.yml` now sets
`INFOPLIST_KEY_UISupportedInterfaceOrientations` and
`INFOPLIST_KEY_UILaunchScreen_Generation` as build settings, and the
per-idiom `UISupportedInterfaceOrientations~ipad` goes through a new
`apps/apple/NOMOApp/Info.plist` declared in the XcodeGen `info:` block. The
project comment records why it cannot be a build setting: Xcode's plist
generator silently drops any `INFOPLIST_KEY_*` whose key name contains a
tilde. That same file carries `CFBundleShortVersionString` and
`CFBundleVersion` as `$(MARKETING_VERSION)` and `$(CURRENT_PROJECT_VERSION)`,
so the plist can no longer advertise a version the project does not declare.
Simulator evidence only; nothing here is a device or store claim.

## 2026-09-26 the Apple project is generated, and how to prove it

`apps/apple/project.yml` is the source of truth for the native project and
`apps/apple/NOMO.xcodeproj/project.pbxproj` is a generated artifact that is
committed alongside it. Nothing in the repository recorded that, so the yml and
the generated project could drift apart with nothing failing. Two root scripts
now own the relationship:

- `pnpm apple:project` runs XcodeGen 2.46.0 from `apps/apple`, which is where the
  yml lives and where the project has to be written.
- `pnpm apple:project:check` copies the source tree to a scratch directory,
  excludes the existing project and the generated `Info.plist`, generates there
  and byte-compares the result with what is committed. It writes nothing to the
  working tree, so it is safe to run while other work is in progress.

Regeneration is reproducible on this machine, and the proof is a clean
`git archive HEAD apps/apple` extracted outside the working tree: before
regeneration `NOMO.xcodeproj/project.pbxproj` was at sha256
`26a66b7a3b8f7026d4452a43f3a0fab56b9fc4f5`, `xcodegen generate` rewrote it, and
after regeneration it was still at
`26a66b7a3b8f7026d4452a43f3a0fab56b9fc4f5` and byte-identical to
`git show HEAD:apps/apple/NOMO.xcodeproj/project.pbxproj`. The generated
`apps/apple/NOMOApp/Info.plist` was `3b12e3fc143c356c1d6c931c74d972069efa0ab8`
before and after. In the live working tree `pnpm apple:project` left
`project.pbxproj` at `804715d5f93b0a24c8d121ad9945f733a894e02e`, also unchanged,
and `pnpm apple:project:check` reported `apps/apple/NOMO.xcodeproj and
NOMOApp/Info.plist match project.yml (2 generated files)`. The 28-line
`project.pbxproj` diff against `HEAD` in the live tree is the seven untracked
chat-surface sources another agent had added, not regeneration
nondeterminism, and the check fails as intended in three cases: the committed
project is appended to, a new source file is added without regenerating, and a
file is committed inside `NOMO.xcodeproj` that XcodeGen no longer writes.

One boundary: `project.xcworkspace/xcshareddata/` holds SwiftPM package
resolution state that XcodeGen never writes, so it is excluded from the
comparison rather than reported as drift. The pbxproj itself is compared in full.

## 2026-09-26 four simulator destinations, including the tightest one

The suite was re-run on four destinations rather than the two it had been
pinned to, and the extra two were chosen for what they break rather than for
coverage credit.

| Destination | Result |
| --- | --- |
| iPhone Air, iOS 27.0 | `Executed 18 tests, with 0 failures (0 unexpected) in 306.538 (306.568) seconds`, ending `** TEST SUCCEEDED **` |
| iPhone 18 Pro, iOS 27.0 | `Executed 18 tests, with 0 failures (0 unexpected) in 308.594 (308.625) seconds`, ending `** TEST SUCCEEDED **` |
| iPad Pro 11-inch (M5), iOS 27.0 | `Executed 18 tests, with 0 failures (0 unexpected) in 402.766 (402.784) seconds` |
| iPad Pro 13-inch (M5), iOS 27.0 | `Executed 18 tests, with 0 failures (0 unexpected) in 378.884 (378.918) seconds`, ending `** TEST SUCCEEDED **` |

The unit suite was 9/9 on all four at the time of those runs. The current source carries 12 `NOMOTests` and 18 `NOMOUITests` cases, and a later run the same day passed 12/12 unit tests on the iPad Pro 11-inch (M5) simulator; the 18-case UI result above is from the earlier source. There is no `iPad Pro Max` device type; Apple
renamed the large iPad Pro to `iPad Pro 13-inch (M5)`, so that is the max form
factor and it is covered above. A physical David's iPhone Air is registered on
this machine but reports `Devices Offline`, so no physical-device evidence is
claimed anywhere in this row.

### The iPhone Air found a real one

`testStopEndsAStreamedRunAndKeepsThePartialAnswerTruthful` failed only on the
Air, at `NOMOUITests.swift:434`:
`XCTAssertGreaterThanOrEqual failed: ("43.999969482421875") is less than
("44.0")`. The same run passed it on the other three destinations.

The layout was never wrong. `NomoPrimaryButtonStyle` applies
`.frame(width: 44, height: 44)`, and `chat.stop` and `chat.send` use the very
same style in the same view. What differs is the number that comes back:
XCUITest reports a frame that has been through the render tree and a scale
conversion, and on this device the identical 44pt button read as
43.999969482421875, which is one unit in the last place below 44. In the same
Air run, another button built from the same style measured 44.000x. The
assertion was a float-equality trap, and the fix is a documented 0.5pt slack,
which still fails any real regression because the smallest target that passes
is 43.5pt, far from the 40pt a shrunken control would produce.

### And looking at the screen found what no assertion could

On the iPhone Air the entry screen printed its title twice: once in the
navigation bar and once as the large body header, because the body header is
shown at a compact width and the navigation title was not hidden. Every test
passed. The compact layout now hides the inline navigation title, which also
returned roughly one card of vertical space on the smallest screen in the
matrix, so the credential note below the fold became fully readable.

One boundary: `project.xcworkspace/xcshareddata/` holds SwiftPM package
resolution state that XcodeGen never writes, so it is excluded from the
comparison rather than reported as drift. The pbxproj itself is compared in full.

## 2026-09-26 explicit CI time budgets, from measured runtimes

Two gates ran for minutes while the CI jobs that contain them had a single
shared deadline, and the release matrix above already noted that `git.managed`
"needs its own budget in any CI job rather than a shared short timeout". It had
no budget anywhere. `ci.yml` allowed its `gates` job 20 minutes for install,
typecheck, build, `pnpm test`, two extra `node --test` runs and four e2e
scripts, and `manifest.yml` allowed 10 minutes for install, three `node --test`
runs and a conformance run. Under a shared deadline the slow step is the one
that gets killed, and a kill is then reported as a failure that never happened,
which is the same failure mode the `git.managed` result above was previously
graded against.

Every command step in `ci.yml` and `manifest.yml` now carries its own
`timeout-minutes`, and each job's budget is the sum of its steps. Measured on
this machine on 2026-09-26, as wall-clock seconds around the real command:

| Command | Measured | Step budget |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 1 | 10 |
| `pnpm run typecheck` | 7 | 10 |
| `pnpm run build` | 22 | 10 |
| `pnpm test` | 671 | 25 |
| `node --test apps/control-plane/api/server.test.ts ...` | 1 | 5 |
| `node --test scripts/src/*.test.mjs` | 158 | 10 |
| `node scripts/src/e2e.mjs` | 1 | 5 |
| `node scripts/src/e2e-connectors.mjs` | 0 | 5 |
| `node scripts/src/e2e-final.mjs all` | 15 | 10 |
| `node scripts/src/e2e-arc.mjs all` | 5 | 5 |
| `node --test --test-concurrency=1 packages/runtime/src/*.test.ts ...` | 19 | 10 |
| `node --test .../conformance.test.ts` | 81 | 15 |
| `nomo recovery conformance` (`filesystem.managed`) | 3 | 5 |
| `nomo recovery conformance --adapter git.managed` | 94, 112, 138 | inside `pnpm test` |
| `nomo recovery conformance --adapter managed-documents` | 2 | inside `pnpm test` |
| `node scripts/src/check-reverse-engine.mjs` | 557 | not in CI |

The `git.managed` figures are three consecutive runs of the same command on a
loaded host, which is why the spread is reported rather than a single number.
The adapter was not made faster: it runs seven scenarios through real `git`
subprocesses and that is an honest cost. `check-reverse-engine.mjs` is a local
gate, not a CI step, so it is listed without a budget rather than given an
invented one. The three `pnpm install`, `pnpm run typecheck` and
`node --test scripts/src/*.test.mjs` timings above were taken on a warm
working tree with another agent editing concurrently; the `pnpm test` and
`check-reverse-engine.mjs` figures come from a full uncontended run.

`scripts/src/ci-time-budgets.test.mjs` keeps this from decaying: every job in
every workflow needs a deadline, and in `ci.yml` and `manifest.yml` every
command step needs its own budget with the job budget covering the sum. The
Windows installer job and the cloud-integration job are deliberately excluded
from the per-step rule, because their runtimes need a Windows runner and a
disposable Postgres and were not measured here; a budget invented rather than
measured is exactly what this check exists to catch.

Not claimed: this is a budget, not a performance result. No gate was made
faster, no timing threshold was introduced, and the conformance runtimes above
are host measurements on a loaded machine rather than a controlled benchmark.

## 2026-09-26 a time-of-day test defect, found and fixed

`node scripts/src/check-reverse-engine.mjs` reported 107 pass and 1 fail out of
108 in its fifth suite. The failure was
`packages/runtime/src/budget.test.ts:381`, "a worker killed between reserve and
settle leaves a detectable charge that is never refunded", expecting `1` and
observing `0` at line 419. It reproduced on three consecutive runs, so it was
deterministic rather than flaky.

The product was correct and the test was wrong. The budget ledger buckets
charges by UTC date, `budget.ts:30` taking
`now.toISOString().slice(0, 10)`, and `budget.ts:43` skips reservations whose
day is not the current one. The test reserved on the real clock and then
inspected with `now: () => new Date(Date.now() + 3_600_000)`. At the time this
was run the machine was at 23:16 UTC, so the inspect clock landed on
00:16 UTC the next day, the reservation was correctly filtered out as
belonging to yesterday, and the snapshot read 0. The same thing happens to
anyone running this suite between 23:00 and 00:00 UTC, which in CEST is
01:00-02:00 local. Outside that hour the test passes.

That is a real defect even though nothing shipped is broken. A nightly CI run
would fail for an hour every day, and the obvious "fix" under that pressure is
to weaken the assertion rather than to pin the clock. The worker and the
inspecting ledger now share one fixed instant, midday UTC, which keeps the
whole test inside a single day. Nothing else changed: the ledger still
excludes a previous day's charges from today's limit, and a crashed
reservation still survives in the store as expired rather than being refunded.

## 2026-09-25 Apple build and signing observation

Recorded separately by evidence grade so a simulator result is never read as a device or store result.

| Observation | Command | Result | Grade |
| --- | --- | --- | --- |
| Project inventory | `xcodebuild -list -project apps/apple/NOMO.xcodeproj` | Targets `NOMO`, `NOMOTests`, `NOMOUITests`; configurations Debug, Release; schemes `CompanionProtocolKit`, `NOMO`. | Metadata read |
| Release simulator build | `xcodebuild -project apps/apple/NOMO.xcodeproj -scheme NOMO -configuration Release -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 18 Pro' build` | `** BUILD SUCCEEDED **`. Repeat with `CODE_SIGNING_ALLOWED=NO` also succeeded. | Built product, simulator SDK only |
| Product signature | `codesign -dv` on the built `NOMO.app` | `Signature=adhoc`, `TeamIdentifier=not set`, no entitlements, no bundle icon. | Ad-hoc, unprovisioned |
| Simulator install and launch | `xcrun simctl install` and `xcrun simctl launch` on an iPad Pro 11-inch (M5) simulator | Installed and launched; the rendered entry screen showed the read-only pairing notice and an offline continue path. | Simulator rendering only |
| Device build | `xcodebuild -scheme NOMO -configuration Release -destination 'generic/platform=iOS' build` with an explicit team and `Apple Development` identity | `** BUILD FAILED **`: no provisioning profile for `com.void.companion`; automatic signing cannot generate one without `-allowProvisioningUpdates`, which was not passed. | Failed gate, not a device claim |
| Signing inventory | `xcodebuild -showBuildSettings -scheme NOMO`, provisioning profile directory, `xcodebuild -showdestinations` | `DEVELOPMENT_TEAM` and `CODE_SIGN_ENTITLEMENTS` are absent from the project file in every configuration, `CODE_SIGN_IDENTITY` is the legacy `iPhone Developer` alias with `PROVISIONING_PROFILE_REQUIRED=YES`, the profile directory is empty, and a physical iPhone is listed as a connected destination. A signing identity exists in the keychain but is not referenced by the project. | Inventory only; no credential read, no device build |
| Simulator test run | `xcodebuild test -project NOMO.xcodeproj -scheme NOMO -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5)'` | 2026-09-26, against the source that added paired-device security and the cache policy: `NOMOTests` 12/12 passed, 0 failures (`Executed 12 tests, with 0 failures` in 59.6 s), ending `** TEST SUCCEEDED **`. The current source carries 12 `NOMOTests` and 18 `NOMOUITests` cases. The earlier run the same day, against the source of that day, executed 9 unit and 18 UI tests with 0 failures and also ended `** TEST SUCCEEDED **`; that UI result has not been repeated against the newer source, and the 2026-09-25 run of 6 `NOMOUITests` cases and the earlier 6/6 unit figure are superseded. | Simulator test run, not a device run |
| Swift package test run | `cd apps/apple/CompanionProtocolKit && swift test -j 1` | 34/34 passed, including all 12 `SecurityRegressionTests` cases covering response scope mismatch, oversized and unknown response shapes, event-page replay-window/UTC/cursor rules, pre-transport request validation, a scoped operation-status store failing closed on corruption, IPv6 local-network impersonation and a URL outside the bound identity. | Host SwiftPM on arm64e-apple-macos14.0, not iOS simulator or device; `xcodebuild test -scheme CompanionProtocolKit` fails because that scheme is not configured for the test action |

No archive, export, TestFlight, App Store Connect, upload or physical-device install was attempted. The failing device build names the missing input rather than closing P01.06, P06.01-P06.05, P10.04 or P11.01.

## 2026-09-25 local acceptance evidence

Disposable temp-fixture runs on this machine. No provider, credential, signed build, provisioned profile, physical device or store was involved, so every P09 row below stays open; this section records which sub-cases were exercised and which were not.

Live API harness (a throwaway script that drives the real `apps/control-plane/api/server.ts` over HTTP on `127.0.0.1` with `mkdtemp` data directories): 67 scenarios, 67 pass, 0 fail. Unset and hostile `NOMO_PERMISSION_MODE` both resolved to read-only with `documentEditing=false` and refused document `PATCH` (S-01, S-02); a client-supplied `permissionMode` was refused flat and nested (S-03); read-only planning returned 409 and left content untouched (S-04); branch idempotency returned one id on retry and 409/400 on conflicting and malformed bodies (S-05); unknown, digest-mismatched and unapproved applies returned 409 without mutating the document (S-06); a human edit followed by a stale apply returned 409 and preserved the human content (S-07); undo required confirmation, and the confirmed apply produced a real inverse (S-08); cross-origin, `sec-fetch-site: cross-site` and foreign `Host` were refused (S-09); missing, wrong and short bearers were refused while a correct bearer succeeded (S-10); prompt, idempotency-key and body limits were enforced at boundary and boundary+1 (S-11); and sentinel private and API keys never appeared in ledger-verify, capabilities or provider error responses (S-12).

Repository suites run green: `apps/control-plane/api/server.test.ts` + `apps/control-plane/api/parity.test.ts` 20/20; `packages/workbench` `permission-authority.test.ts` 4/4, `gui.test.ts` + `recovery-jobs.test.ts` 21/21, `provider-retry.test.ts` 5/5; `packages/proxy` transport and relay suites 39/39; `packages/cli` `recovery-filesystem` + `recovery-mcp` 9/9 and `recovery-health` 5/5; `packages/runtime` `reserved-vault` + `recovery-crash` 14/14 and `crash` + `persistence-fault` 22/22; `cargo test --offline diagnostics` 6/6 for the startup-log allowlist; conformance `filesystem.managed` 4/4, `git.managed` 7/7, `managed-documents` 2/2, `postgres-managed-conformance` 5/5.

Not covered, and therefore not claimed: no packaged-artifact install, upgrade, rollback or uninstall cycle; no end-to-end mobile-bridge or paired-phone transport journey, because the Apple client still has no envelope round-trip against the routes that now exist (see the 2026-09-25 companion section); no real provider streaming; no VoiceOver, keyboard, zoom, rotation or Dynamic Type run; no performance/load budget run; and no power-loss or genuinely full-disk proof, only injected ENOSPC and SIGKILL.

Live CLI recovery journey (a throwaway script that spawns the real `node packages/cli/bin/nomo.mjs recovery ...` binary with a minimal environment, per-run key material passed by environment variable name and never printed): 43 scenarios, 43 pass, 0 fail. `recovery health` on a fresh state directory exited non-zero as `unavailable` with `state.present=false`, explicit repair steps, no state directory and no key-shaped bytes in the report (L-01). `recovery inspect` returned an approval digest without touching the file (L-02). Execute required that exact digest: a forged digest was denied, and a denied operation identity stayed consumed even when replayed later with the correct digest, while a distinct operation identity with its own correct digest applied the write (L-03). A wrong key, a missing key variable and the correct key produced the expected non-zero, non-zero and exit-0 plan results with no refused plan mutating the file (L-04). A forged plan digest was refused without mutation, and the exact digest returned `restored` with bytes-and-mode evidence and content back at its original value, a real Undo through the CLI (L-05). Appending a forged line to the signed journal turned health and plan unsafe with the file unchanged, and restoring the original history returned health to exit 0 (L-06). Deleting the retained signing key was refused with the stable message `Retained recovery signing key is unavailable; restore the original key before continuing.`, the key was not silently regenerated, and restoring it returned health to exit 0 (L-07). `recovery-backup.mjs` create/verify exited 0 with a matching anchor, while a wrong anchor and a missing anchor both returned `history_unanchored`, a tampered backup journal returned `history_incomplete`, and a deleted vault artifact returned `missing_artifact`, with no workspace file mutated throughout (L-08). A second backup restored into an isolated copy reached health exit 0 and refused the wrong key (L-09). `apps/desktop` `runtime.test.mjs` + `release.test.mjs` pass 4/4.

One security-positive behaviour worth recording: a denied operation identity is never re-runnable. The journal state machine in `packages/runtime/src/journal.ts` gives `denied` an empty transition set, so an approval digest cannot be brute-forced by retrying the same identity, and L-03 exercised that against the real binary.

Finding from the 2026-09-25 local acceptance run, now fixed and re-verified: the operator tool catalog was not permission-mode filtered, so `GET /api/tools` advertised `nomo_workspace_write` while `documentEditing` was `false`, because `availableTools()` in `packages/workbench/src/index.ts` built the catalog from `workspaceTools` without the predicate dispatch applies. Dispatch-time enforcement held throughout, so it was a visible-capability mismatch rather than a bypass. `availableTools()` now filters through `toolAllowedInMode`; the live harness converted the observation into a hard assertion and re-ran at 67/67, checking that a read-only catalog returns exactly `nomo_workspace_list` and `nomo_workspace_read` while normal mode still advertises `nomo_workspace_write`. `packages/workbench` `permission-authority.test.ts` plus `safety-boundaries.test.ts` pass 8/8 and `apps/control-plane/api/parity.test.ts` passes 5/5.

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
`apps/control-plane/api/server.test.ts` 15/15, `apps/control-plane/api/parity.test.ts` 5/5, `apps/control-plane`
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
`python/nomo-transport` 84/84 under `unittest`. Typecheck is clean for
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
   unconditional `authorize`. An r1 `nomo_workspace_write` or
   `nomo_workspace_delete` therefore ran with no human in the loop while the
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
3. An absent `NOMO_PERMISSION_MODE` resolved to `normal` in the Workbench
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
unless `NOMO_COMPANION_WRITE_PAIRING=1`, it is refused rather than silently
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

### The agentic reverse loop, end to end

`scripts/src/agentic-reverse-exercise.mjs` is a disposable, self-checking
exercise of the loop an agentic reverse workflow depends on, run against real
bytes on a real filesystem through the shipped `filesystem.managed` adapter,
the shipped journal and the shipped vault. Eight steps, in order: the agent
inspects a target, a refused destructive call leaves it byte-identical, an
approved call captures before it changes the file, a reused operation identity
is refused rather than rebound to a different write, the signed journal
verifies, a restarted runtime acts on the same workspace and history, the
confirmed inverse restores the exact bytes and mode, and a replayed inverse is
refused instead of applied again.

A third arm runs the loop over the transport an agent actually uses.
`packages/cli/src/mcp-reverse-exercise.ts` spawns the real `nomo recovery serve`
as a child process over stdio, lets it negotiate its eight recovery tools under
an operator policy, and drives execute, plan and apply through JSON-RPC: a
permitted mutation lands on the real file, a previewed inverse restores the
exact bytes, the process's own retained journal verifies under its public key,
and tightening the policy to deny everything refuses the same mutation over the
same transport. The other two arms drive the runtime directly, which is the
right level for a unit and the wrong one for a claim about the product an agent
talks to. Changing the tight policy from deny to allow turns the last step red.

The same loop also runs against a real database, which is the flavour of
reverse engineering the product is sold on:
`packages/connectors/src/postgres/reverse-exercise.ts` installs a managed table
over PGlite, and a refused row change leaves the row exactly as it was, an
approved change lands and leaves every other row alone, the confirmed inverse
restores the captured values rather than a reconstruction, and the database
journal verifies. PGlite is a real engine running in process, so this is a real
transaction boundary, and a disposable local database, which is not the R04
networked-cluster certification and does not stand in for it.

It is a gate, not a demonstration: `check-tests.mjs` already globs
`scripts/src/*.test.mjs`, so both halves run under `pnpm test`. Three mutations
were shown red. Redoing the capture into the wrong vault slot makes the
approved write report `unknown` instead of succeeding; making the approval
callback approve everything makes a refused file call succeed and a refused row
change succeed with the row mutated, which is the failure mode the whole
product exists to prevent.

`scripts/src/agentic-reverse-exercise.mjs` also runs standalone with
`node scripts/src/agentic-reverse-exercise.mjs` and prints its steps.

### R06 and R07: a job lease, and a plan that proves its own order

A recovery plan was undone in reverse journal sequence, which is only safe
because every producer of a resource a step read is undone after that step.
Reverse sequence does not prove that: for a selected subset, or when a step
read what an earlier step wrote, the order can be wrong.

Provenance now makes the assumption checkable. An adapter may record a read set
with the revision it saw; `filesystem.managed` records the before image and, for
a rename, the destination, because that is exactly what it consulted. The
`filesystem` and `managed-postgres` paths carry it durably in the capture, and
`orderRecoverySteps` refuses a plan whose order it cannot prove. It does not
reorder: a plan whose order cannot be proven is not a plan worth guessing at. An
absent read set is treated as unknown rather than as empty, so an adapter that
reports nothing contributes no edges and no claim in either direction. Five
cases are pinned directly, and removing the refusal turns one red.

The R06 job lease closes the matching availability gap. A workspace already
refused a second recovery job while one was in flight, inside the journal
writer transaction, so two workers cannot interleave; what it could not survive
was the worker dying mid-`applying`, which blocked the workspace until someone
edited a journal by hand. A job now claims a lease naming its host and pid and
renews it at every step. Reclaiming requires both that the deadline passed and
that the holder is provably gone; an absent lease, an unparseable pid, an
unexpired lease and a live holder all keep blocking, and `EPERM` from a process
that exists but belongs to someone else counts as alive. A displaced job is
recorded as paused rather than silently stepped over. The rule lives in
`packages/runtime/src/recovery/lease.ts` so it can be proven for a real dead
process, a real live one and an unanswerable case. `packages/runtime` 104/104,
with both halves of the reclaim mutation-checked.

### The cloud deployment outage, 2026-09-26

Twelve consecutive Vercel production deployments failed before this fix, and
nothing was live. `pnpm run build` reproduced it exactly: eleven
`workflow-node-module-error` failures, because the agent-step workflow compiles
`cloud/steps.mjs`, which imports `decide`, which imported the policy barrel for
two string constants, and the barrel re-exports the pack loader and the approval
broker, both of which touch the filesystem. The workflow runtime refuses Node
builtins outright.

Two things are worth recording about why it took so long. The defect was
already in the tree before this change; a new import in `cloud/steps.mjs` only
removed the tree-shaking slack that had been hiding it. And the guard against it
is now a test that needs no bundler: no policy leaf may import the barrel, and
the barrel must still publish the whole grammar.

Verified after the fix: `pnpm run build` exits 0 from a cleared
`.vercel/output`, the cloud artifact check reports 4 frontend assets, the Node
API and the streaming route, the deployment
`https://void-tui.vercel.app` is `Ready` on the production alias, `/`, `/chat`
and `/gallery` serve 200, unauthenticated `/api/*` answers 401, an unknown route
is 404, and a request carrying a foreign `Origin` is refused with 403. This is
the first successful deployment in over two hours and the first evidence that
any of these routes has ever answered from this deployment.

### One unreproduced test failure, recorded rather than forgotten

A single run of the 506-test core set reported one failure. It did not
reproduce in the roughly thirty runs that followed, including six consecutive
runs of `packages/runtime` alone and eight of the other five packages together,
nor in focused repetition of `crash.test.ts`, `adversarial.test.ts` and
`persistence-fault.test.ts`. The failing test name was not captured, so the
honest record is that one failure was seen once and its cause is unknown, not
that the suite is deterministic. A flake in a security product is a finding in
its own right, and this one is open until it can be named.

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
red. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` for the
desktop crate is 23/23 on macOS. The
`CredReadW` and `CredWriteW` calls and the `#[cfg(all(test, windows))]` store
tests still need a Windows machine. P10.09 is unchanged. See
`docs/WINDOWS-DESKTOP.md`.

### Desktop keychain access after rebuild

Observed on 2026-09-26 on the local Mac candidate. The workspace key item
`dev.void.desktop.workspace` exists in the login keychain, created
2026-09-15, and the login keychain is unlocked with no timeout. The bundle is
signed ad-hoc: `codesign -dv` reports `Signature=adhoc` and
`TeamIdentifier=not set`. macOS binds a keychain item's access control to the
signing identity that created it, and an ad-hoc signature changes on every
rebuild, so the current build is no longer on that item's allowed list. The
old code mapped every non-`errSecItemNotFound` status to one message, told the
operator "cannot unlock", and then died in the Tauri setup hook, so the run
ended in `Cannot unlock the NOMO workspace key in macOS Keychain` with exit
134 and no window. There is no NOMO password and no workspace password in this
path: the key is 32 random bytes NOMO generated itself. The only password macOS
ever asks for here is the Mac login password, used to authorise the consent
prompt or unlock the login keychain.

The fix keeps the tight access control. Reporting a refused read as a missing
item would let `load_or_create` generate a fresh key over the existing
`workspace.enc`, so the two cases are now distinct and pinned by
`keychain::mac_read_tests`. The operator remedy is a stable signing identity.
`apps/desktop/scripts/build-policy.mjs` now resolves one in order:
`APPLE_SIGNING_IDENTITY` used verbatim, otherwise a code-signing identity the
keychain already holds, listed read-only through
`security find-identity -v -p codesigning` without opening any key material,
otherwise `-` (ad-hoc). On this machine discovery returns
`Apple Development: dsak5@email.cz (96426C65HK)`, so a local build is no longer
signed ad-hoc. The ad-hoc last resort warns instead of failing, and the warning
names the exit the operator would otherwise meet. When the profile expects a
notarized artifact, or notarization credentials are set, ad-hoc is a hard error
instead, because Apple does not accept an ad-hoc, Apple Development, Mac
Distribution or local development certificate. That is local stability only: it
is not notarization, and no notarized or Developer ID artifact is claimed.
Deleting the item is not a remedy, because the existing ciphertext then has no
key. Gate status: the keychain guidance and the stable-identity local build
default are both delivered in source, and no packaged bundle is claimed until
one is built and launched.

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
| P01.04 | Identify incompatible credential import, arbitrary child tool or unrestricted path features. Disable or redesign them in store mode, visibly rather than silently. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. Resolved defect from the 2026-09-25 local acceptance run: the operator tool catalog was not permission-mode filtered, so `GET /api/tools` advertised `nomo_workspace_write` while `documentEditing` was `false`. Dispatch-time enforcement held, so it was a visible-capability mismatch and not a bypass. `availableTools()` now filters through `toolAllowedInMode`, the live harness asserts the read-only catalog and re-passed at 67/67, and `permission-authority.test.ts` plus `safety-boundaries.test.ts` pass 8/8. The remaining sandbox and store-mode questions in this row are unwitnessed, so it stays open. |
| P01.05 | Verify clean shutdown, crash cleanup and no orphan runtime. Never interpret empty Tauri capabilities as App Sandbox support. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.06 | In parallel, validate a minimal native SwiftUI client against a TLS fixture on actual iPhone/iPad, including local-network permission denial and foreground reconnect, before investing in complete screens. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P01.07 | Decide continue Tauri, limited store companion with separate executor, or native Mac shell only from recorded evidence. Any architecture change requires approval. | Mac packaging | Open: signed sandbox install, real capture/Undo and iPhone/iPad TLS fixture. |
| P02.01 | Reproduce string/numeric ID collision, huge numeric-string IDs and string progress tokens. Preserve exact identity through batch responses/cancellation. | Core transport | Evidence: `node --test packages/proxy/src/relay/http-requests.test.ts` (12/12), `node --test packages/proxy/src/session.test.ts` (25/25), and `node --test packages/proxy/src/transport/http.test.ts` (8/8) pass. Client string IDs remain typed through Session; upstream IDs allocated by the relay remain numeric, so string upstream response IDs are rejected rather than coerced. |
| P02.02 | Add failed-partial-batch cleanup, disconnected-client cleanup, stalled POST and infinite/idle SSE tests. | Core transport | Evidence: relay suite (12/12) covers failed partial batches, disconnected clients, stalled POST, idle SSE, cancellation and mapping cleanup; HTTP transport suite (8/8) covers stalled POST and idle SSE. `pnpm --filter @nomo/proxy test` passed 140/140 on three post-race-fix runs. |
| P02.03 | Define bounded admission, pending-request cap, deadline/idle behavior, cancellation and backpressure. Mutating timeout yields uncertain evidence, not an automatic retry. | Core transport | Evidence: relay suite (12/12) covers pending cap, deadlines, cancellation, disconnect cleanup and SSE writable-buffer backpressure; HTTP transport suite (8/8) covers pending POST cap, post deadline, idle SSE, uncertain outcome and no POST replay. |
| P02.04 | Stop tight reconnect on persistent authentication failure; use bounded retry/backoff for safe reconnectable reads only. | Core transport | Evidence: HTTP transport suite (8/8) verifies 401 stops reconnecting, short GET streams use increasing bounded delays, and the reconnect limit stops after five retries. |
| P02.05 | Test slow stdin and slow HTTP response consumers; respect drain/abort paths without losing mapping cleanup. | Core transport | Evidence: stdio suite (10/10) covers bounded writes and signal-ladder cleanup; relay suite (12/12) covers slow SSE writable-buffer delivery and abort/disconnect cleanup. `pnpm --filter @nomo/proxy typecheck` passes. |
| P02.06 | Run a repeatable load test and record maximum pending count and quiescent cleanup. | Core transport | Evidence: 60-minute bounded load result `{completed:4256461,peakPending:16,finalPending:0,rssBytes:1158627328}`. Focused suites pass as above. Full `pnpm run check` completed all workspace/package/UI typechecks, then the test phase exceeded the harness 250-second cumulative limit; full check is not reported green. |
| P03.01 | Improve relative-path tool schema/help and stable sanitized error categories; test invalid path, missing artifact, denied policy and unavailable key. | Recovery core | Evidence: `node --test packages/cli/src/recovery-mcp.test.ts` (6/6) passes; signed MCP runtime, denied writes, closed mutation schemas, and sanitized path/secret-free error categories are covered. Full `pnpm run check` test phase timed out under the 250-second harness limit; no full-check green claim. |
| P03.02 | Add read-only health reporting for supported adapter/version, capacity, paused/unknown jobs and required repair steps; separate diagnosis from explicit reconcile/apply. | Recovery core | Fixture-tested: `node --test packages/cli/src/recovery-health.test.ts` (5/5) and `pnpm --filter @nomo/cli typecheck` pass. `nomo recovery health --config file` emits compact sanitized JSON before input/signer/bootstrap handling; fresh and retained-state checks prove no key generation or filesystem mutation, and missing/mismatched retained keys report unavailable/unsafe. Backup restoration remains tracked separately below. |
| P03.03 | Define complete backup contents and consistent snapshot procedure, including SQLite/WAL state and required artifacts. Keys must not enter a plaintext diagnostics export. | Recovery core | Evidence: `node --test packages/cli/src/recovery-filesystem.test.ts` (3/3) passes; the stopped-executor backup helper copies SQLite WAL state, preserves manifest/history, and excludes plaintext encryption-key bytes. |
| P03.04 | Restore a disposable complete backup and verify signatures, history visibility and real Undo. Test missing WAL/artifact, wrong key and truncated history according to explicit completeness policy. | Recovery core | Evidence: the same `node --test packages/cli/src/recovery-filesystem.test.ts` (3/3) run restores a disposable backup, verifies signed history, exercises wrong-key/missing-artifact/truncated-history refusals, and completes a real filesystem Undo. |
| P03.05 | Document unavailable-key handling; never regenerate a retained key. Test rotation/migration in disposable state before offering a user-facing rotation feature. | Recovery core | Evidence: `node --test packages/runtime/src/reserved-vault.test.ts` (12/12) passes; unmarked-vault marker verification, retained-evidence key rotation, wrong/unavailable-key refusal, and no retained-key regeneration are covered. |
| P03.06 | Exercise storage refusal/ENOSPC or equivalent fault harness without claiming power-loss proof from injected exceptions. | Recovery core | Evidence: `node --test packages/runtime/src/reserved-vault.test.ts` passes 12/12; the deterministic ENOSPC-equivalent harness fails before adapter.execute with zero dispatches and no dispatched/succeeded receipt. This is injected storage-refusal evidence only, not physical power-loss proof. Full `pnpm run check` typechecks pass; its test phase exceeded the 250-second cumulative harness limit. |
| P04.01 | Inventory existing endpoints first. Reuse safe read/recovery services, not a second implementation of policy. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P04.02 | Freeze capability handshake, device/workspace scope, chat/session reads, event cursor, request outcome, approval/recovery preview/apply and device revocation schemas. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. Partial 2026-09-25 evidence on the client side only: `apps/apple/CompanionProtocolKit` `swift test` passed 34/34 on a macOS host, and its 12 `SecurityRegressionTests` cases cover response device/workspace scope mismatch, an oversized response, an unknown outcome shape, event-page replay-window, UTC and cursor rules, and a URL outside the bound local-network identity. That is client-side contract enforcement, not a paired-device or transport result, and the shared-fixture and security-review part of this gate is still unwitnessed. |
| P04.03 | Specify limits for body/event sizes, concurrency, replay window and token/grant lifetime with rationale. Test both boundary and boundary+1. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. Partial 2026-09-25 evidence on the client side only: the same 34/34 `CompanionProtocolKit` host run exercises a bounded maximum response size and a scoped operation-status store that fails closed on corruption, and `scripts/src/companion-fixtures.test.mjs` passes 7/7 against the shared P04 fixtures. Those are fixture and host runs; the boundary-plus-one matrix against a real transport and the security review are still unwitnessed. |
| P04.04 | Threat-model stolen invitation, QR substitution, stolen token, compromised device, malicious executor address, replay, cross-workspace access and multiple-device races. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P04.05 | Write shared JSON fixtures for Swift decoding and server validation: succeeded, denied, conflict, unknown, unsupported-version and revoked cases. | API/security | Open: protocol schema tests + Swift/TypeScript shared fixture decoding + security review. |
| P05.01 | Add explicit start-pairing, invitation expiry/single-use, host confirmation and initial read-only grant. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.02 | Store device credentials in native secure storage; test replay, duplicate acceptance, certificate mismatch, revoked device and expired grant. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.03 | Bind each approved action to device/workspace/session/operation/current authorization. Add two-device races where only the still-valid exact action succeeds. | Executor/security | Out of scope/open: the device half of this row is struck by the read-only decision in `docs/DECISIONS.md`: a device cannot approve anything, so there is no device-side action to bind. The binding itself is real work on the Mac and is covered there. The two-device race survives as a pairing race, not an approval race, and is proved by the invitation tests in `apps/control-plane/api/companion/companion.test.ts`. |
| P05.04 | Implement bounded event reconnect and status lookup. Kill the mobile client after dispatch and prove reconnect does not repeat the forward mutation or inverse. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.05 | Revoke a device during an open stream and during pending approval; stop further authorized work while preserving already-dispatched outcome evidence. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P05.06 | Test local network permission denial, executor sleeping/offline and change of network. No router port forwarding required or implied. | Executor/security | Open: authenticated paired-device E2E + revocation/replay/race cases. |
| P06.01 | Create a universal iOS/iPadOS app with reproducible project configuration, correct bundle identity, environment separation and native tests. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.02 | Implement typed URLSession client and versioned fixture decoding; keep credentials in Keychain, not UserDefaults or logs. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.03 | Implement onboarding, pair/revoke, executor identity/status, safe reconnect and offline read-only state. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. Pairing now requires a host-minted single-use invitation, revoke leaves no credential behind, the reconnect is bounded and cannot carry a mutation, and the cache is non-authoritative; those are implemented and covered by `swift test` (58 cases) and the 12 `NOMOTests` cases. What remains is a paired round trip on hardware. |
| P06.04 | Implement iPhone navigation and iPad split view, shared NOMO identity, Dynamic Type, reduced motion and native accessibility labels. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P06.05 | Define cache retention/redaction and logout/device-removal cleanup. Cached history is not authority for a new mutation. | Apple client | Open: native XCTest/Swift Testing + simulator and physical iPhone/iPad. |
| P07.01 | Add streamed chat, draft preservation, cancellation and attachment limits; verify Japanese IME, long content, tables/code and provider rejection. | Apple client + recovery | Open, and the gate is now the read-only one: paired-device chat against the live routes on physical hardware, plus force-quit, drift and VoiceOver. The paired-device write and Undo half this row used to name is struck by the read-only decision, because the phone never writes. IME composition, draft preservation and cancellation are already asserted in the browser gate. |
| P07.02 | Show requested tool, affected resource, actual executor, recoverability and permission source before confirmation. | Apple client + recovery | Open, as observation rather than as confirmation: the phone shows the tool, the resource, the executor, the recoverability and the permission source for work the Mac is about to run, and the operator confirms on the Mac. A phone-side confirmation is struck by the read-only decision in `docs/DECISIONS.md`. |
| P07.03 | Add exact preview and explicit confirmation for Undo; truncated/unavailable previews must be labeled, not displayed as a complete diff. | Apple client + recovery | Open, split in two: the exact preview and its labelling are phone work and stay, and the explicit confirmation is Mac work by the read-only decision. An Undo preview that shows a truncated diff as a complete one is the defect this row exists to prevent, and that half does not depend on who confirms. |
| P07.04 | Preserve unknown/partial/conflict/paused states. Refresh stale previews instead of silently applying a newer plan. | Apple client + recovery | Open, unchanged in substance: the phone must show what state the Mac is in, including the ones it cannot resolve, and must not present a stale preview as current. The browser gate now drives a conflict end to end on the Mac surface, which is the same invariant one surface up. |
| P07.05 | Test two phones approving the same work, revocation during preview, host restart, app force-quit, background/foreground and lost apply response. | Apple client + recovery | Out of scope/open: the two-phones-approving half is struck by the read-only decision: two phones cannot approve the same work, because neither approves anything. The surviving half is real and stays: revocation during a preview, host restart, app force-quit, background and foreground, and a lost apply response must not repeat a forward mutation. The bounded reconnect that covers the last of those is implemented in `EventReconnector` and proved in `swift test`; a paired round trip on hardware is still open. |
| P07.06 | Add iPad hardware keyboard, portrait/landscape/multitasking and VoiceOver navigation. | Apple client + recovery | Open: paired-device chat/write/Undo E2E + force-quit/drift/VoiceOver. |
| P08.01 | Add a short guided safe-workspace exercise; no customer account or production mutation is needed to learn Undo. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.02 | Show running build/version/channel, current executor, capability limitations, storage location and provider snapshot. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.03 | Replace opaque startup exits with actionable keychain/runtime/permission guidance, preserving a safe redacted diagnostic path. | Desktop/UI | Open: the keychain and runtime halves are delivered, the permission half is not. 2026-09-26: `keychain::classify_mac_read` splits `errSecItemNotFound` from `errSecAuthFailed`, `errSecInteractionNotAllowed` and `errSecUserCanceled`, which the previous code collapsed into a single arm, and `main.rs` prints fixed operator guidance for `KEYCHAIN_ACCESS_DENIED` and for the runtime categories through `startup_guidance`, instead of only pointing at a log. The `Absent`/`Denied` split is pinned by `keychain::mac_read_tests`, because reporting a refused read as a missing item would let `load_or_create` mint a fresh key over an existing encrypted workspace. Pinned by `cargo test` 23/23 on macOS in this tree, the 22nd case being `tests::resolve_env_precedence`, added by the rename compatibility work to pin that a NOMO value wins over the legacy VOID name, and the 23rd being the startup classification case the desktop smoke work added. Also 2026-09-26: `resolveBuildPolicy` now prefers a stable signing identity, so the build no longer invalidates the keychain item the runtime then cannot read. Still open: there is no permission failure path at startup to guide, so the permission half of this requirement still produces no actionable guidance, and the gate stays open. See "Desktop keychain access after rebuild". |
| P08.04 | Add diagnostics preview/export with an allowlist: build, OS, capability versions, failure codes and opaque IDs. Unit-test exclusion of synthetic secrets and content. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.05 | Expose privacy/support/release notes and explicit export/delete/reset choices consistent with retained signed evidence. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P08.06 | Fix outdated provider bootstrap instructions and stale beta download links. Store builds use Store updates; direct builds may initially use a verified release link rather than a new updater framework. | Desktop/UI | Open: desktop new-user flow + diagnostic secret-exclusion tests. |
| P09.01 | Test fresh install, supported upgrade, rollback/unsupported-newer-format refusal and uninstall/reinstall behavior without accidental key/data loss. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: the live harness ran each scenario against a fresh `mkdtemp` data directory, so fresh-state behaviour is covered, and a real inverse undo was applied in S-08. Not covered: install, upgrade, rollback, unsupported-newer-format refusal and uninstall/reinstall on a packaged artifact. No key or data-loss claim is made for an installed build. |
| P09.02 | Execute normal and negative recovery journeys through actual desktop, mobile bridge and configured MCP transports in isolated environments. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: the live harness ran normal and negative recovery journeys over the real control-plane API including confirmation-gated undo with a genuine inverse (S-08), and a live CLI journey ran 43 scenarios against the real `nomo.mjs recovery` binary covering health, inspect, digest-bound execute, key availability, plan/apply, journal tampering, retained-key loss, backup create/verify and an isolated backup restore (L-01 to L-09). The CLI suites cover the MCP stdio path. Added the same day: the companion surface now has 20 tests over the real control-plane HTTP server, so runtime revocation, device scope and workspace scope are no longer unverified. They cover pairing issuing a one-time credential that is never stored or repeated, the protocol's eight-device-per-workspace cap, the exact response shapes, a fail-closed 404 for an unprovable operation identity, fail-closed auth for missing, wrong, expired and revoked credentials, a read-only device refused a mutation, a device refused another device's revoke, idempotent revocation that keeps the dispatched effect readable, a second workspace seeing neither data nor credential, redacted and bounded diagnostics, cross-site refusal, the frozen outcome vocabulary, and a full `void.companion.v1` envelope round-trip whose live responses are validated by the frozen `validateCompanionFixture`. Still not covered: the desktop packaged app, and any paired-phone journey over a real transport with TLS. `swift test` for the Apple client is a macOS-host run against in-process transport doubles, so the envelope is proven against the server, not across a network. |
| P09.03 | Test offline, revoked token, missing key, corrupted artifact, full storage, executor crash before/after dispatch and before/after recovery receipt. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: missing, wrong and short credentials were refused with 403 (S-10); unknown, digest-mismatched and unapproved applies were refused with 409 without mutation (S-06, S-07); a stale plan could not overwrite a human edit (S-07); a missing key, a wrong key, a forged approval digest and a forged plan digest each failed closed without mutating the file (L-03, L-04, L-05); a deleted retained signing key was refused with a stable message and never silently regenerated (L-07); a forged journal line turned health and plan unsafe until the original history was restored (L-06); backup verification returned `history_unanchored`, `history_incomplete` and `missing_artifact` for a wrong or missing anchor, a tampered journal and a deleted vault artifact (L-08); a denied operation identity stayed consumed (L-03); and `packages/runtime` `recovery-crash` plus `persistence-fault` pass 36/36 across injected ENOSPC and SIGKILL. Not covered: real mid-stream revocation, genuinely full storage, a physically killed executor, and any power loss. |
| P09.04 | Verify no secret/content leaks in exported diagnostics, logs, build artifacts, crash reports or screenshots. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. Partial 2026-09-25 evidence: sentinel private and API keys never appeared in ledger-verify, capabilities or provider error responses (S-12); the Rust startup-log allowlist passes 6/6; the Swift package bounds and redacts diagnostic identifiers and message content. Added the same day: the companion diagnostics surface is proven to refuse a sentinel credential and a home-directory path, caps the page at 100 entries and the summary at 320 characters counted in whole code points so an astral character cannot push it one unit over the frozen bound, and every live response body is additionally run through the frozen fixture field, bound and allowlist predicates. Still not covered: exported diagnostics, logs, build artifacts, crash reports or screenshots taken from an exact packaged build. |
| P09.05 | Test real provider streaming in an explicitly authorized bounded-cost sandbox. Without credentials/budget, leave that gate open; fixtures cannot close it. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. No provider sandbox, credential or budget was authorized, so no real provider streaming run is claimed. Fixture and stream-unit coverage cannot close this gate. |
| P09.06 | Run VoiceOver and physical keyboard tests, true 200% desktop zoom, iPhone/iPad safe areas, rotation, Dynamic Type and background lifecycle. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. The 2026-09-26 simulator run now covers 12 `NOMOTests` and 18 `NOMOUITests` cases, and the web gate `scripts/src/ui-layout.test.mjs` covers 69 desktop and 55 mobile tab stops with a measured focus ring, reduced motion collapsing 12 animated elements to 0, and mobile touch targets. Those are still synthetic: a real Tab in a headless browser is not a physical keyboard, emulated 200% zoom is not browser zoom, and a simulator is not a device. VoiceOver, physical keyboard, true browser zoom, iPhone/iPad safe areas, rotation, Dynamic Type and background lifecycle remain untested, so this gate stays open. |
| P09.07 | Validate performance/load budgets and record machine/device/network details. | Independent QA/security | Open: exact-build install/security/device/performance acceptance matrix. The 2026-09-25 simulator build, install and launch were not an instrumented performance run. The recorded transport load result under P02.06 is a relay bound, not this gate, and no device or network profile was captured. |
| P10.01 | Coordinate marketing version 1.0.1, monotonically increasing Apple build numbers and source/binary provenance. Do not bump unrelated package compatibility blindly. | Release operator/product | Source-inspected and contract-tested: `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/Cargo.lock` and `apps/desktop/src-tauri/tauri.conf.json` intentionally agree on local candidate `1.0.1`; `apps/desktop/release.test.mjs` verifies those sources. The Apple project metadata remains `MARKETING_VERSION=1.0.1` and `CURRENT_PROJECT_VERSION=1`. The bundled Node runtime remains separately pinned to `24.21.0`; root and unrelated workspace package versions are intentionally unchanged. No exact committed source/binary provenance, clean-tree record, or approved Apple build number is recorded. |
| P10.02 | Freeze persisted-format migration/backup documentation and test upgrade from advertised prior versions. | Release operator/product | Source-inspected: `docs/RECOVERY-CONTRACT.md` documents current journal/vault formats and the complete stopped-executor backup; `scripts/src/recovery-backup.mjs` documents SQLite online backup, WAL manifest contents, and verification categories. No supported prior-version source, old-to-new upgrade fixture, or downgrade guarantee is advertised; those remain blockers. |
| P10.03 | Configure separate Developer ID/notarized DMG and Mac App Store signing/provisioning paths. Sign nested executables and test exact packaged artifacts. | Release operator/product | Source-inspected: `apps/desktop/src-tauri/tauri.conf.json` targets `app` + `dmg`; `apps/desktop/scripts/build-policy.mjs` resolves the Apple signing identity from `APPLE_SIGNING_IDENTITY`, then from a stable code-signing identity already in the keychain, and only falls back to ad-hoc, so a local build is no longer ad-hoc by default. That fallback is local stability, not notarization: the machine holds no Developer ID Application identity, and `apps/desktop/README.md` says the same. A notarized run is refused outright when the identity resolves ad-hoc. No signed/notarized artifact, separate Mac App Store path, or nested-executable evidence is recorded. Blocker: authorized Apple Developer identity/team and signing/notary setup. |
| P10.04 | Configure iOS distribution provisioning, archives, TestFlight and build environment. Verify installed full Xcode/SDK rather than relying on old machine inventory. | Release operator/product | Source-inspected and simulator-built: `apps/apple/` contains the native iOS 17 Xcode project, Swift package, app, unit tests, UI-test source and protocol fixtures. Current source contains 12 `NOMOTests` cases and 18 `NOMOUITests` cases. On 2026-09-25 Xcode metadata resolved, the Release `iphonesimulator` build of the `NOMO` scheme succeeded and the product installed and launched on a simulator. A 2026-09-26 simulator test run then executed 9 unit and 18 UI tests against the source of that day with 0 failures, ending `** TEST SUCCEEDED **`, and a later run the same day passed `NOMOTests` 12/12 after the paired-device and cache-policy work landed; the 18-case UI run has not been repeated against that newer source, and the 2026-09-25 run of 6 `NOMOUITests` cases and the earlier historical 6/6 unit figure are superseded. The `CompanionProtocolKit` host SwiftPM run passed 58/58 on macOS host, which is client-side contract enforcement and not an iOS simulator or device result. Reserved-vault evidence is 12/12. The distribution path is not configured: `DEVELOPMENT_TEAM` and `CODE_SIGN_ENTITLEMENTS` are absent from the project, `CODE_SIGN_IDENTITY` is the legacy `iPhone Developer` alias, the provisioning profile directory is empty, and a `generic/platform=iOS` Release build failed for want of a profile for `com.void.companion`. No archive/export was produced and the project has no asset catalog, so the built product carries no app icon. The attached iPhone reports Developer Mode off, so even a dev-signed install is blocked. Provisioning, archives, physical iPhone/iPad install, signed-device evidence, App Store Connect and TestFlight remain open. |
| P10.05 | Complete data inventory, in-app privacy policy, App Privacy labels, retention/deletion policy and support contact. Audit required-reason APIs/SDK manifests from actual dependencies. | Release operator/product | Source-inspected data categories: local encrypted workspace snapshots (sessions, provider profiles, connector credentials, managed documents, signed history) under `NOMO_DATA_DIR`; JSONL ledgers under `NOMO_LEDGER_DIR`; approval state under `NOMO_APPROVALS_DIR`; recovery keys/journals/vault; legacy snapshots and operator exports. Cloud Neon stores session/preference/provider/integration/OAuth/hold documents, append-only events, and signed ledger; provider/OAuth secrets are encrypted. External flows include model providers, GitHub/Vercel/Supabase MCP, Appwrite, Neon/Vercel Workflow, and optional S3/Postgres/Prime. No privacy policy, App Privacy/PrivacyInfo manifest, support contact, or product-wide retention/deletion policy was found; support/privacy/legal ownership remains unassigned. Local recovery evidence/artifacts are retained by design, legacy snapshot GC is namespace-scoped, cloud ledger/events are append-only, and no data-subject deletion workflow is mounted. |
| P10.06 | Decide export-compliance classification for encryption deliberately; do not blindly set a no-encryption exemption flag. | Release operator/product | Source-inspected encryption includes local/cloud AES-256-GCM, Ed25519 signing, HTTPS/TLS, and Keychain/Credential Manager or mode-0600 key files. No `ITSAppUsesNonExemptEncryption`, export classification, entitlements, or native iOS metadata exists in the repository; the Apple classification cannot be inferred from source and must be decided by the release operator before store metadata. |
| P10.07 | Prepare accurate device screenshots, descriptions, age rating, reviewer instructions, accessible test account/demo and a reachable safe test executor for review. | Release operator/product | Source-inspected: the public demo is isolated to managed documents; current UI exposes provider/integration settings and local chat/document/ledger exports, but no P10-specific App Store screenshots, descriptions, age rating, reviewer instructions, or native iOS asset set was identified. OAuth/provider consent and a reachable safe test executor remain external setup gates. |
| P10.08 | If account creation exists, implement and test the applicable account-deletion path. If no account exists, do not invent one solely for release. | Release operator/product | Source-inspected: `cloud/auth.mjs` contains a server-side Appwrite signup helper and no application mounts it, so that module is not a live path. The live identity path is the Supabase broker in `cloud/account.mjs`, mounted in the middleware behind `GET /api/account`, `POST /api/account/signin` and `DELETE /api/account`; signup is refused while `NOMO_ACCOUNT_SIGNUP` is unset and no mounted route accepts an invitation code, so no account is created. A person whose account exists at the provider could sign in and own rows, but no Supabase project is configured here and none has been signed in against. The cloud tables are now scoped by owner (`docs/ACCOUNT-OWNERSHIP.md`), so any future deletion is owner scoped. No account-deletion route, data-subject deletion workflow, or test exists. Keep open; do not invent an account path. |
| P10.09 | Validate and advertise a Windows desktop build with Windows filesystem/Git recovery evidence. | Release operator/product | Out of scope/open for 1.0.1: no current-source Windows packaging, installed smoke or full Windows recovery-suite evidence is claimed. A later authorized Windows x64/MSVC candidate must pass this gate before advertisement. |
| P11.01 | Start with internal testers, then invite-only TestFlight for iPhone/iPad and the chosen Mac distribution track. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.02 | Run the proposed tester sample and review every data-integrity/auth incident before expanding. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.03 | Retain prior compatible binaries and a documented server rollback. Mobile clients must tolerate supported server version skew; no forced unsafe data downgrade. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.04 | Keep emergency disablement scoped to new remote writes while preserving read/history/diagnosis; no control that silently deletes recovery evidence. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.05 | Submit only after all promised-platform gates pass. Track submission, review, approval and public availability separately. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| P11.06 | Monitor opt-in/redacted signals and support reports after release. If privacy-safe monitoring is absent, do not claim a crash-free rate. | Release operator/product | Open: approved TestFlight install + external cohort/rollback evidence. |
| D01.01 | Inventory every current route, modal, composer control, status and icon. Record reuse/redesign/remove decisions; do not remove working capabilities for a cleaner screenshot. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.02 | Propose two coherent visual directions built around NOMO branding: compact neutral workspace with restrained orange, and a slightly more native Apple presentation sharing the same information hierarchy. Retain the approved Claude Code-like chat priority, not its brand assets. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.03 | Produce readable high-fidelity references for Mac chat, active tool run, recovery preview/conflict, activity/history, provider setup; iPhone chat/approval/pairing; iPad split-view review. Show actual content rather than empty hero-only screens. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.04 | Review light/dark, loading, long content and destructive/unknown states in the design, not only the happy path. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D01.05 | User approves one direction and navigation structure before implementation. Images are design references, never claimed as screenshots of working software. | Product design | Open: route/state inventory + high-fidelity design review and user selection. |
| D02.01 | Define semantic color, surface, border, focus, typography, spacing, radius, elevation and motion tokens with light/dark variants. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.02 | Remove conflicting overrides incrementally. No additional global patch stylesheet, blanket zoom, giant padding or full-app monospace. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.03 | UI desktop body target13-14px and chat15-16px remain readable; mobile web input>=16px, native text follows Dynamic Type, touch targets>=44px web/>=44pt native. Do not hard-code small native font sizes to mimic desktop density. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.04 | Preserve NOMO aperture as the brand mark. Use one existing SVG family on web/Mac, extending only missing semantic icons; use SF Symbols on Apple-native screens with a documented semantic mapping. Do not ship SF Symbols as a cross-platform web icon font. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.05 | Catalog navigation, chat, attachment, tool, policy, approval, preview, undo, conflict, unknown, executor, pairing, network, backup, privacy and support symbols. Avoid emoji/ASCII as the only functional icon. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.06 | Icon-only controls receive accessible names/tooltips; destructive and ambiguous actions also show text. Never distinguish approved/conflict/unknown by color alone. | Design system | Open: component gallery + contrast/focus/target checks. |
| D02.07 | Build a lightweight internal component/state gallery using existing app/dev tooling. Do not add Storybook or a new UI kit unless the existing tools genuinely cannot serve the need. | Design system | Open pending design approval, with the build work already landed without a new tool: `/gallery` is an internal-only route in the existing app, mounted from `Root` so `App` never mounts, and it issues zero `/api/` requests. It is absent from `routes`, so it is out of the sidebar and out of the command palette, it sets its own internal document title, and it renders only static representative state. `apps/control-plane/ui/src/gallery.test.ts` and `scripts/src/ui-layout.test.mjs` run it through the same nine-viewport, focus-ring, reduced-motion, zoom and touch-target checks as the rest of the product, including an assertion that a synthetic secret fed through `RedactedJson` never reaches the DOM. `apps/control-plane/ui/src` 73/73 and `scripts/src/ui-layout.test.mjs` 22/22. Implementation is not design approval, so this row stays open with the rest of D02. |
| D03.01 | Button and icon button variants with pending/disabled behavior. | UI implementation | Open: the requirement itself is witnessed; the family inventory behind it is not. Requirement evidence, 2026-09-26: `scripts/src/ui-layout.test.mjs:318`, "D03.01 the shared DataTable refresh exposes a pending state", holds the refetch open through `scripts/src/ui-matrix.mjs:786` so the pending state is observed rather than raced, and passed in that file's 22/22 run against current source. Inventory evidence, recounted 2026-09-26 across `apps/control-plane/ui/src`: D03.22 (backup and retained-history health) and D03.26 (pairing QR, confirmation, expiry, device revoke) have no consumer, and neither does D03.28 (guided first action and checklist progress), which the 2026-09-25 inventory called partial; no onboarding or checklist component exists, the nearest surface being the public demo. The earlier 24/4/2 split is therefore unconfirmed and is not republished here: three families are confirmed to have no consumer, while the partial and full-consumer counts were not re-derived, so this row records no tally. The 2026-09-25 cell also cited a per-family `file:line` table as its evidence, and no such table exists in `docs/`; the only per-family mapping in the tree is the internal gallery, which names 12 D03 families, so that reference is withdrawn. The primitives named in the plan and absent from the code are tooltip, `role="menu"`, `role="tablist"`/`role="tab"`, `role="switch"`, `role="combobox"`, skeleton, toast, native sheet, split-view, inspector and breadcrumb, each at zero occurrences in the same recount; the app uses native `<details>`/`<summary>` in 20 places instead, not the 18 previously recorded. These are absences, not test failures: no run closes a family that has nothing mounted, and D01 design approval is still outstanding, so building a missing family is not authorised work. |
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
| D04.01 | Mac: chat, overview, conversations, runs, documents, approvals, ledger, connections, models, settings and public demo. Include search, detail views, paging, export and all dialogs. | UI QA/product | Open: Routes measured on the 2026-09-25 build: `/chat`, `/overview`, `/runs`, `/documents`, `/approvals`, `/ledger`, `/connections`, `/models`, `/settings` and `/demo` all exist and are server-served. The "conversations" destination is `/sessions`, named "Konverzace / Conversations" in the sidebar (`main.tsx:92`); `/conversations` is a genuine 404 and was not invented into existence. Still open: per-route search, detail views, paging, export and dialogs were not individually exercised, and the public demo settles on "Demo is currently unavailable" when the fixture origin has no `/api/demo`. |
| D04.02 | iPhone: onboarding/pairing, workspace/session selection, chat, activity, approval/recovery detail, documents and settings/device management. | UI QA/product | Open: partly closed, partly not built. Corrected 2026-09-26: the earlier `NOMOUITests 8/8` figure was stale. The current source carries 18 `NOMOUITests` cases, and a full `xcodebuild test` on iPad Pro 11-inch (M5), iOS 27.0, Xcode 27.0, reports `Executed 9 tests, with 0 failures` for `NOMOTests` and `Executed 11 tests, with 0 failures (0 unexpected) in 402.766 seconds` for `NOMOUITests`, ending `** TEST SUCCEEDED **`. Getting there required a source fix, not a rerun: `measureEntryTitle` looked for the entry title only inside the scroll view, but at regular width `OnboardingView.swift` passes `showsHeader: false` and the title exists only as the navigation bar title, so the query now falls back to the unscoped element. The AA contrast assertion is unchanged and still measures rendered pixels, so the pass means the navigation-bar title itself clears 4.5:1. Screenshots in `tmp/apple-ui-matrix/screenshots/` (iPhone and iPad, English and Czech, light and dark). Present: onboarding `OnboardingView.swift:3`, pairing card `:104-125`, activity `SessionsView` `:199-247`, settings `SessionDetailView.swift:36-75`. Not implemented, so no run can close them: workspace selection (no picker exists), session selection (read-only list, two hardcoded rows `AppModel.swift:71-77`), chat (no composer anywhere under `apps/apple`), documents, approval or recovery actions, and device management (the only control, `SessionDetailView.swift:56-60`, is disabled because `connectionState` never becomes `paired`). The pairing CTA is intentionally disabled: `canPair` is false in every state of this build. |
| D04.03 | iPad: sidebar plus chat/detail, resizable/multitasking layouts, inspector, keyboard shortcuts and pointer interactions. Do not simply stretch the phone layout. | UI QA/product | Open: Partly closed. `NavigationSplitView` sidebar plus detail at `RootView.swift:15-27` with the sidebar at `:45-74`, and a real `horizontalSizeClass == .regular` split view, captured on an iPad Pro 11-inch (M5) simulator. Not implemented: inspector, keyboard shortcuts (no `keyboardShortcut` in the target), and chat detail. Pointer interaction is not verifiable on this machine; `simctl` has no mouse event injection. |
| D04.04 | Preserve drafts, IME, attachment removal, stream/cancel, status truth and focus when moving components. | UI QA/product | Open: the draft and cancel-focus behaviour is witnessed; the IME claim is not pinned. Witnessed 2026-09-26 in `scripts/src/ui-layout.test.mjs` at 22/22: "D04.04 the draft survives a route change and an in-place view switch" (line 176) and "D04.04 cancelling a run returns focus to the composer" (line 181). The second pins a real defect: pressing Stop unmounted the focused button and dropped focus to `document.body`, so `stopRun` returns focus to the composer in its `finally`; reverting that fix turns the gate red. Attachment add and remove are asserted at `scripts/src/ui-layout.test.mjs:65,69`, in the D04.07 stacked case rather than this one. The 2026-09-25 claim that IME composition inserts characters with no submit and no loss is withdrawn: `scripts/src/ui-matrix.mjs:942-961` measures `report.ime`, but no assertion in the layout suite reads it, so composition is measured and unverified. Status truth is not exercised by that suite at all. |
| D04.05 | Capture actual built screens in both themes and English/Czech with long realistic content, not only component previews. | UI QA/product | Open: Web closed 2026-09-25: light/en, light/cs, dark/en and dark/cs each render 2430-2542 characters with a 589px transcript, zero overflow, a visible composer and no error boundary; the public demo renders the same four combinations on its own server with the correct "From idea. Back anytime." and "Od nápadu. Zpět kdykoliv." headings, and the demo is clean across all nine viewports. Native closed the same day: the app now has a real appearance preference, `AppTheme` in `apps/apple/NOMOApp/AppModel.swift:81-98` persisted through `@AppStorage("nomo-theme")` and applied once as `.preferredColorScheme` at `RootView.swift:35`, defaulting to `system` so the OS setting wins. Copy exists in both languages, `AppCopy.swift:124-127` English and `:73-76` Czech. Four screens captured on an iPhone 18 Pro simulator, iOS 27.0: `tmp/apple-theme/{light-en,dark-en,light-cs,dark-cs}.png`. Measured, not asserted by eye: the entry title renders `rgb(0,0,0)` on `rgb(255,255,255)` at 21.00:1 in light and `rgb(255,255,255)` on `rgb(0,0,0)` at 21.00:1 in dark, cross-checked by a host-side tool independent of XCTest. Cutting `preferredColorScheme` makes the two render identically and turns the test red. Long realistic content on a small phone, Dynamic Type, and the iPad regular-width layout are not covered. |
| D04.06 | Web viewport matrix:320x568,390x844,430x932,768x1024,834x1112,1024x768,1280x800,1440x900 and short landscape. Native matrix includes supported physical iPhone/iPad classes, orientation, larger text and keyboard. | UI QA/product | Open: Web closed 2026-09-25 with a real three-exchange conversation carrying a heading, a table and a code block. All nine viewports report `scrollWidth == clientWidth`, so horizontal overflow is zero everywhere, and Send is reachable at all nine. Native part stays open: it needs physical iPhone/iPad classes, orientation changes, larger text and a hardware keyboard. |
| D04.07 | Keep basic320x568 transcript>=200px and ordinary desktop transcript>=60% work area. Test stacked notices/tool/attachments and long draft; Send/Stop must remain reachable. Keyboard-visible tiny viewports prioritize accessible composer, with transcript shrink explicitly measured rather than a physically impossible fixed height promise. | UI QA/product | Open: the transcript thresholds and the stacked long-draft case are asserted; the stacked notices and selected-tool rows are measured only. Asserted 2026-09-26 in `scripts/src/ui-layout.test.mjs` at 22/22: "D04.07 transcript keeps 200px at 320x568 and 60% of the work area on desktop" (line 43) and "D04.07 a long draft plus an attachment keeps Send reachable at 320x568" (line 62), with Send-or-Stop reachability at all nine viewports asserted by the D04.06 gate at line 33. The 2026-09-25 per-viewport figures, 320x568 transcript 372px of 520px work area (71.5%), 390x844 648/796 (81.4%), 430x932 736/884 (83.3%), 768x1024 813/976 (83.3%), 834x1112 901/1064 (84.7%), 1024x768 557/720 (77.4%), 1280x800 589/752 (78.3%), 1440x900 689/852 (80.9%), are harness output from that day's run and were not re-derived on 2026-09-26; what the suite witnesses now is the threshold, not each percentage. The stacked case asserts a transcript of at least 200px, Send reachable and the attachment removable at 320x568; the notices-region and selected-tool figures the harness records at `scripts/src/ui-matrix.mjs:876-914` (notices 80px, attachments 56px) are not asserted by any test. A keyboard-sized 667x375 measured 179px and 54.7%, which is reported rather than promised away, exactly as this row allows; the suite asserts only that the transcript stays above 100px and the send control stays inside the viewport there. |
| D04.08 | Verify real keyboard focus, VoiceOver, contrast, target sizes, reduced motion, zoom and app resume. Screenshot comparison supplements interaction tests, not replaces them. | UI QA/product | Open: web closed 2026-09-25 with a browser gate, `scripts/src/ui-layout.test.mjs` 22/22 as re-run 2026-09-26: 69 desktop and 55 mobile tab stops, none without a solid outline of at least 2px; the composer textarea measured with a real Tab at 1280x800 and 390x844 shows a solid 2px ring in the app's own `--focus` token with `:focus-visible` true; 12 animated elements normally and 0 under `prefers-reduced-motion: reduce`; no sub-44px touch target on mobile except the visually hidden file input, and none at all in settings at 390x844. One real defect was found and fixed: the composer textarea had no visible focus ring, because `.composer textarea { outline: none }` outranked `:focus-visible` and the halo painted the canvas colour on the canvas colour; a real `:focus-visible` rule reusing the existing token and the existing 2px value was added. Reverting it turns the gate red. Contrast was not measured numerically and app resume was not exercised. On the native side, `NOMOUITests` asserts `accessibilityLabel` on two surfaces, `isHittable` on two, `isEnabled` on four, a 44-point minimum target height on four, a non-zero on-screen frame on four, zero credential fields on three, and that an activity row is announced as one combined element. Still missing there: VoiceOver focus order, measured contrast, reduced motion, zoom and app resume. The `accessibilityIdentifier` values `activity.settings` and `sidebar.settings` are defined in the app but referenced by no test, so they are dead metadata. On the native side an appearance control is now part of the entry screen with a 44pt minimum target and an accessible label, and the four theme-by-language screens above are measured, but secondary `.foregroundStyle(.secondary)` text contrast was deliberately not claimed: the element capture came back unreadable in both themes, so the AA figure covers primary-label text only. A real palette change is needed to close that, which is separate work. Reduced motion on the native side is a finding, not coverage: the app animates nothing, so there is no branch to test and none was faked. |
| D04.09 | User approves proposed stack/platform floors, initial connectivity scope and exclusions. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.10 | Every milestone has dependencies, bounded deliverable and observable acceptance. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.11 | Requirements map covers Mac, iPhone, iPad, pairing, recovery, diagnostics, privacy, signing, tests, beta and rollback. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.12 | Product code remains unchanged during planning. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |
| D04.13 | Next implementation batch is explicitly authorized before starting. | UI QA/product | Open: actual screen capture + viewport/locale/theme/native accessibility matrix. |

## Blocking inputs

Provisioning, App Store Connect access, Mac App Store team/App ID/signing and separate Developer ID, physical iPhone/iPad and clean test Mac; support/legal/privacy owner; bounded-cost provider sandbox; local-network scope and approved design direction remain blockers. Xcode metadata, native project listing, simulator build, Swift package tests and NOMO unit tests do not replace these gates. Do not replace them with fixtures. Store uploads, public release and purchases require separate explicit approval.

## Reconciliation of older audits

Earlier audit material and `docs/APPLE-APPS-PLAN.md` predate this scope decision. The older iOS local-core and mandatory macOS SwiftUI claims are superseded. G-01 cloud journal, G-03 local/cloud job availability, G-04 recorded resource sets and G-20 standalone verifier already have bounded implementations; their remaining cross-system, certification, distribution and network gates remain open. The old `docs/RELEASE.md` 0.1.0/npm release runbook is historical and does not certify Apple 1.0.1.
