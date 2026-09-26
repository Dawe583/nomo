# VOID desktop

The native macOS and Windows apps run the same GUI and local control-plane API as `pnpm gui`.
Tauri 2 keeps one app instance per user and owns an isolated Node process and binds the backend to an ephemeral
loopback port. The packaged application contains Node 24 and the bundled backend;
end users do not need Node, pnpm, Rust, Vercel or a running terminal.

## Local Mac 1.0.1 candidate

This local-only Mac candidate is intentionally versioned `1.0.1` in all
desktop release sources: `apps/desktop/package.json`,
`apps/desktop/src-tauri/Cargo.toml` and `apps/desktop/src-tauri/tauri.conf.json`.
`apps/desktop/src-tauri/Cargo.lock` records the same package version. The
bundled Node runtime remains pinned independently at `24.21.0`; that runtime
version is not the VOID product version.

The direct-download profile is the only supported local Mac packaging path in
this repository. `apps/desktop/scripts/build.mjs` resolves that policy before
invoking Tauri: it refuses `VOID_DISTRIBUTION=store` on macOS and resolves the
Apple signing identity in order, as `APPLE_SIGNING_IDENTITY` used verbatim,
otherwise a stable code-signing identity already in the keychain, listed
read-only through `security find-identity -v -p codesigning` without opening any
key material, otherwise `-` (ad-hoc signature). The build log names the
identity it resolved. A stable identity matters locally: macOS binds a keychain
item to the identity that created it, so an ad-hoc signature that changes on
every rebuild is what makes a rebuild unable to read the workspace key. When no
stable identity is available the build still succeeds, but it warns and names
the exit the operator would otherwise meet. A run that expects a notarized
artifact is refused outright rather than built ad-hoc. The Mac App Store
remains explicitly unconfigured: no store
entitlements, provisioning profile, sandbox container or submission settings
are inferred. Developer ID signing, notarization and a clean-machine install
remain external release blockers, not local-build capabilities.

The native shell keeps the redacted diagnostic boundary: startup failures
persist only allowlisted categories in `desktop-startup.log`; paths, provider
data, environment values and exception text are not logged. Use the native
runtime smoke commands below after packaging. They use temporary data and do
not contact a provider.

## Develop and package

Run from the repository root after `pnpm install`:

```sh
pnpm --dir apps/desktop install --ignore-workspace
pnpm --dir apps/desktop dev
pnpm --dir apps/desktop build
```

The macOS build host needs Rust and Xcode Command Line Tools. Windows x64 needs
Rust MSVC, Visual Studio C++ build tools and WebView2; see `docs/WINDOWS-DESKTOP.md`. macOS 13.5 or newer is
required by the bundled Node runtime. macOS arm64 and x64 are
supported on their matching host architectures. The build pins and verifies the
SHA-256 of the official Node distribution. The exact website Aperture logo is
used to generate the application icons.

Artifacts are written to `apps/desktop/src-tauri/target/release/bundle/`.
DMG creation runs without Finder automation. The `.app` can run locally; public distribution also needs an Apple Developer
signing identity and notarization credentials configured using Tauri's standard
`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID`
environment variables. Without notarization credentials a macOS build is a local
bundle-integrity build and nothing more: it is signed with whatever stable
identity the policy resolved above, or with an ad-hoc signature if there is
none, and it is never notarized. This direct-download profile is separate from a Mac App Store profile: no store
entitlements, provisioning profile, sandbox container, or store submission configuration is present in this
repository, and those must not be inferred from the direct build. Windows produces an unsigned NSIS beta installer;
SmartScreen may warn. Linux packages are not verified.

`APPLE_SIGNING_IDENTITY` is the one variable that overrides the whole chain: set
it to any identity name and the build uses it verbatim, skipping both the
keychain lookup and the ad-hoc fallback. To see the names the machine already
holds, run `security find-identity -v -p codesigning`; it prints identity names
only. Apple does not accept an ad-hoc, Apple Development, Mac Distribution or
local development certificate for notarization, so a stable identity bought for
local keychain stability is not a notarization identity.

## Runtime boundary

### First-run provider import

Settings offers local API-key import from OpenCode and Prime for supported
TokenRouter, OpenCode Zen and OpenRouter profiles. This explicit action replaces
the active provider after catalog validation and chooses an available model.
The key stays in the encrypted local workspace and is sent only to its fixed
provider endpoint. Existing OpenCode/Prime files are not modified. OAuth tokens,
command expressions and custom endpoints are not imported. No import API is
available to the cloud or remote-token server mode.

See `docs/MACOS-ALL-IN-ONE-RESEARCH.md` for current support and the next project
setup/recovery stages. iOS implementation is deferred until macOS release gates.

### Execution

Provider selection, model catalogs, connectors, sessions, approvals, signed
history and guarded undo are implemented in the shared workbench/backend. The
shell neither bypasses nor duplicates VOID policy or replay logic. Basic local
inspection is independent of the hosted web app; model calls still require a
configured provider or a running local model server.

Data is stored under the OS application data directory (`~/Library/Application
Support/dev.void.desktop` on macOS). The backend receives `VOID_DATA_DIR` and a
local ledger directory. The workspace encryption key is retained in macOS
Keychain or the current user’s Windows Credential Manager, and passed privately to the backend for startup. It is removed from the
runtime environment before MCP processes are launched. A legacy `workspace.key`
is migrated with native store readback verification and retired only after the
backend opens successfully. A locked Keychain or conflicting keys stops startup
without overwriting the workspace. The native smoke check and migration tests use ephemeral or injected storage.
The Windows-specific tests verify temporary Credential Manager entries, remove them
with unconditional cleanup, and cover persistence across workspace loads. On
Unix, directories have mode 0700. Runtime stderr is not persisted because it may contain backend details; startup
failures are reduced to an allowlisted category in `desktop-startup.log` and the terminal points to that file
without printing paths, environment values, provider data, or exception text. Closing the app closes the ownership
pipe, cancels the workbench and closes HTTP connections; a stuck backend is terminated after five seconds. Closing the
pipe also handles an unexpected shell termination.
If the owned Node runtime exits after readiness, the shell treats that as a
fail-closed runtime failure, records only `RUNTIME_EXITED`, and closes the
desktop window instead of leaving a dead workbench origin open.

The webview has no Node integration, shell access or broad Tauri permissions.
Navigation is restricted to its own loopback origin. Document and conversation
exports allow only same-origin HTTP/Blob downloads into the Downloads folder. External provider requests
run in the backend. The runtime does not inherit `NODE_OPTIONS`, `NODE_PATH` or
cloud operator tokens. A remote page cannot become the desktop workbench.

The shell currently does not embed a PTY or native external-agent adapters.
These require explicit process and terminal permission boundaries; the built-in
VOID agent uses the shared guarded tool interface.

## Verification

```sh
pnpm --dir apps/desktop test
pnpm --dir apps/desktop prepare:runtime
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The runtime test starts the real backend, checks local pages and APIs, verifies
cross-origin denial and confirms that closing the ownership pipe releases the
server. It does not contact a paid provider.

After packaging, exercise the native executable and its embedded Node runtime:

```sh
apps/desktop/src-tauri/target/release/bundle/macos/VOID.app/Contents/MacOS/void-desktop --smoke-test
```

The debug lifecycle smoke exercises that failure path without a provider or
user workspace and must exit nonzero:

```sh
cargo run --manifest-path apps/desktop/src-tauri/Cargo.toml -- --smoke-runtime-exit
```

This checks that the packaged application resolves its own resources and serves
the real workbench, renders it in the native WebView, opens the slash menu, selects a real tool, and verifies an actual Blob download
to its temporary directory, then shuts down. It uses a temporary data directory and does
not contact a provider. Smoke tests bypass the single-instance guard so they do
not focus or alter an already running user workspace.
