# VOID for macOS and iOS

Release scope update, 2026-09-24: the approved implementation target is
`docs/superpowers/plans/2026-09-23-void-1.0.1-apple-release.md`, with the
product contract in `docs/superpowers/specs/void-1.0.1-product.md` and evidence
in `docs/RELEASE-1.0.1-MATRIX.md`. This older A2/A3 direction of a mandatory
SwiftUI Mac rewrite and iOS-local recovery core is superseded. Keep the
historical rationale below; do not execute both architectures.

Release evidence update, 2026-09-25: the native iOS 17 Xcode project, Swift
package, app, unit tests, UI-test source and protocol fixtures exist under
`apps/apple/`. Current source contains 9 `VOIDTests` cases and 6
`VOIDUITests` cases. On 2026-09-25 a Release `iphonesimulator` build of the
`VOID` scheme succeeded, the built product installed and launched on an
iPad Pro 11-inch (M5) simulator rendering the read-only onboarding/entry
screen, and a simulator test run passed `VOIDTests` 9/9 and `VOIDUITests` 6/6
against the current source. That product is ad-hoc signed with no team
identifier, no entitlements and no app icon, so it is simulator evidence and
not a device or store claim. The `CompanionProtocolKit` package passes 27/27
under `swift test`, but that is a macOS host run and not an iOS simulator or
device result, because `xcodebuild test -scheme CompanionProtocolKit` is not
configured for the test action. A `generic/platform=iOS` Release build failed
the same day because no provisioning profile for `com.void.companion` is
installed, the project declares no `DEVELOPMENT_TEAM` and no
`CODE_SIGN_ENTITLEMENTS`, and the paired iPhone reports Developer Mode off.
Physical iPhone/iPad install, signed-device, App Store Connect and TestFlight
evidence remain open. The older macOS-first scope and iOS companion boundary
remain in force.

Windows is outside the 1.0.1 delivery scope. Its historical beta evidence is
preserved in `WINDOWS-DESKTOP.md`, while current-source Windows evidence remains
open. No physical iPhone/iPad build, signing, provisioning or store action is
part of this evidence update.

The same-day local acceptance run is recorded in `RELEASE-1.0.1-MATRIX.md`: 67
live control-plane scenarios and 43 live CLI recovery-journey scenarios passed
against disposable temp fixtures, the named repository suites passed, and the
P09 rows are scoped rather than closed. No provider, credential, signed build,
provisioned profile, physical device or store was involved. One finding from
that run, that the operator tool catalog was not permission-mode filtered, is
corrected in source and covered by the permission-authority and control-plane
suites. The iOS companion is unaffected because this build has no write
authority, and the corrected catalog still has to be witnessed on a packaged
store build before that gate closes.

## Historical product direction (superseded)

The shared macOS-and-iOS SwiftUI implementation direction formerly recorded here
is historical and must not be used as 1.0.1 implementation guidance. The
current scope is the native paired-Mac companion described above and in
`RELEASE-1.0.1-MATRIX.md`: the Mac remains the trusted executor and recovery
engine, while iOS/iPadOS provides a bounded read-only companion surface with
explicit pairing, executor identity, revocation and truthful offline states.

Do not implement a shared Mac/iOS app or an iOS-local recovery core for this
release. The web app remains a separate Vercel surface, and every mobile action
must name its actual executor and recovery coverage rather than implying local
execution.

## A1: Distribution and installation

- Settings contains a direct versioned macOS DMG link, architecture, minimum OS,
  release status and signing status. First release: Apple Silicon, macOS 13.5+.
- Build from the current source, test the packaged backend and WKWebView, publish
  a GitHub prerelease with its SHA-256 checksum. Never bundle workspace tokens,
  API credentials or the developer's workspace. Local installation has separate
  storage and requires explicit provider setup or authenticated credential import.
- iOS Settings provides Safari Home Screen instructions now, labelled web app.
  Replace/add a native install button only when a verified TestFlight or App Store
  URL exists. Downloading an arbitrary IPA from a website is not an installation
  path for ordinary devices. Do not present a disabled or invented native link.
- Public Mac releases need Developer ID signing and notarization. The signing
  inventory observed on 2026-09-25 exposes an Apple Development identity only;
  no Developer ID Application identity, notarization ticket or Developer ID
  artifact is evidenced, and `apps/desktop/scripts/build-policy.mjs` still
  defaults the Mac identity to `-`.
- Native iOS metadata, a Release simulator build and a simulator launch now
  exist; distribution still requires a provisioning profile for
  `com.void.companion`, a `DEVELOPMENT_TEAM` wired into the project, Developer
  Mode enabled on the target device, App Store Connect access, a suitable Apple
  Developer membership, physical iPhone/iPad checks, and a completed
  TestFlight/archive run. None of that is claimed here.

Acceptance: actual DMG download returns bytes; checksum matches; fresh isolated
workspace starts without Node installed; UI accurately distinguishes local app,
web app and native iOS availability. Verify download links after publication.

## A2: SwiftUI macOS client, preserve the engine

Create one Xcode multiplatform app and a shared Swift package. Set initial
deployment targets to macOS 14 and iOS 17 for the native client. Keep the older
Tauri beta compatible with macOS 13.5. Use SwiftUI, Foundation, URLSession,
Security and CryptoKit before adding dependencies.

1. Implement a typed URLSession client for the existing control-plane API and
   event stream. Publish versioned Codable request/response fixtures from the
   current API. Render chat, ledger and recovery plans natively; WKWebView can
   remain an explicitly transitional screen until each native screen passes.
2. Port the existing process ownership contract to a macOS-only actor: bundled
   verified Node, ephemeral loopback port, private Application Support directory,
   Keychain key, readiness handshake, owned stdin pipe and bounded shutdown.
   Reject unexpected readiness messages and do not inherit provider secrets into
   arbitrary child tools. Retain existing origin and authorization controls.
3. First ship native workspace navigation, timeline, operation details and Undo
   preview/confirmation. Then chat streaming, cancellations, approvals, providers
   and MCP settings. Preserve the current API's conflict and unknown outcomes.
4. Select a workspace with the system file picker and explicit scope. Connect
   Prime as a separate executor with its real status. Do not label arbitrary
   Prime tool calls as captured by VOID.
5. Migrate credentials through a user-authorized Keychain flow. Never compile the
   current user's token into an app, downloadable archive or public configuration.
6. Package both arm64 and x86_64 only after testing each architecture with its
   matching runtime. Sign nested executables, notarize and staple the release.

Acceptance: native chat streams and cancels; an isolated managed-document change
can be previewed, applied, restored and verified; process exit and forced app
termination leave no unowned server; corrupt journal, missing artifacts and
concurrent writers fail closed. Compare outcomes against the existing engine.

## A3: iOS local recovery core

Share views, API models and policy vocabulary with macOS. Platform-specific
executors remain separate. Build local recovery before exposing writable tools.

1. Store the signed operation journal and durable state in SQLite transactions.
   Store encryption/signing material in Keychain and artifacts with authenticated
   encryption. Explicitly reserve artifact quota before mutation.
2. Initially support app-owned text documents only: exact-byte capture, hashed
   preconditions, create/update/delete, recovery preview and post-restore check.
   Imported external documents first become explicit app-owned copies; later
   add security-scoped URLs and coordinated external writes as a separate adapter.
3. Persist intent and recovery artifacts before writing. Use atomic replacement
   where possible, then persist observed outcome. Reconcile after interruption.
   An uncertain effect remains unknown and must never be blindly repeated.
4. Bind approval to the exact plan digest, workspace, target and captured state.
   Refuse restoration when the target changed, a signature fails or an artifact
   is unavailable. Repeated Undo must be idempotent. Never treat compensation
   as exact restoration.
5. Add URLSession provider chat and a bounded native tool loop. Expose only the
   managed local document tools until each additional adapter passes recovery
   tests. Save provider keys in Keychain; default to GLM 5.3 Free through
   TokenRouter when that provider is connected and the model is available.
6. Treat background suspension as normal. Persist state before each tool effect,
   resume through reconciliation, and show suspended jobs. Do not promise an
   indefinitely running background agent on iOS.

Acceptance: airplane-mode capture/edit/delete/restore, app termination at each
durability boundary, full disk/quota rejection before mutation, corrupted vault,
wrong workspace key, expired file access, concurrent edits, Unicode and binary
contents, repeated Undo and recovery after restart. Run on simulator and a real
iPhone before TestFlight. Online provider calls have separate network tests.

## A4: Mac pairing and service context

Reuse the existing outbound Prime bridge and durable jobs on Vercel. Add device
pairing with short-lived single-use enrollment and revocable per-device keys.
Keep workspace authorization distinct from worker authorization. Store device
keys in Keychain and never include them in QR history, logs or release assets.

The iOS client displays three explicit modes: On this device, Paired Mac and
Cloud. Show the target workspace, online state, available tools and recovery
coverage before sending a task. A disconnected Mac leaves work pending or
unknown according to the job state; it does not silently transfer execution.

Use ASWebAuthenticationSession for service OAuth. Keep client secrets on the
backend, use PKCE/state and tested callback validation. Reuse current service
connections rather than copying browser cookies or Codex-only connectors.

Acceptance: revoked devices lose access; another workspace cannot claim jobs;
duplicate requests do not duplicate effects; cancellation, expired credentials,
network loss before/after dispatch and reconnect display truthful job states.

## A5: Native experience and release gate

Use NavigationSplitView on Mac/iPad and NavigationStack on iPhone. Keep the
timeline searchable and filterable by session, target, executor, class and
outcome. Use tables on desktop, compact cards on mobile, a focused recovery
preview and an explicit confirmation for the bound recovery plan. Support
English and Czech, Dynamic Type, VoiceOver, keyboard navigation, dark mode and
Reduce Motion. Animate streaming and state changes without hiding failures.

Release only after contract tests, native recovery fault tests, real-device
checks, signing/provisioning and download verification pass. Keep TestFlight
and DMG versions visibly separate from the online web version. A full Swift
port of the Mac engine is optional after protocol parity; it is not a prerequisite
for a SwiftUI Mac app and must not delay the tested recovery path.

Apple references:
- https://developer.apple.com/documentation/swiftui
- https://developer.apple.com/testflight/
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- https://support.apple.com/guide/iphone/turn-a-website-into-an-app-iph42ab2f3a7/ios
