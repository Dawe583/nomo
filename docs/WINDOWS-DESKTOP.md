# Windows desktop

## Release scope

Windows is out of scope for the NOMO 1.0.1 delivery. The current-source
Windows evidence is green for packaging and the installed-application
smoke on a Windows 11 local host (see the dated section below); the Windows
gate still needs a current-source Windows CI run, installer/checksum upload
and a recovery/attestation pass before it can be claimed for release.
Historical beta evidence is retained below; it cannot certify the current
candidate.

The historical Windows build target used the shared NOMO browser GUI and local
guarded runtime. Its intended platform was Windows 10/11 x64 with WebView2.
Node 24 was bundled and verified against a pinned official SHA-256. Workspace
encryption keys were stored in the current user's Windows Credential Manager;
there was no plaintext fallback.

Run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm desktop:setup`, then
`pnpm desktop:build` on Windows with Rust MSVC and Visual Studio C++ build tools.
The shared `apps/desktop/src-tauri/tauri.conf.json` targets only `app` and
`dmg`; the NSIS installer comes from the Windows overlay
`apps/desktop/src-tauri/tauri.windows.conf.json`, which targets `nsis` with
`installMode: currentUser`. It is generated under
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

The manually dispatched **Windows desktop** GitHub Actions workflow builds the
installer, tests credential storage, installs the package, and checks that its
WebView can load the local runtime, open the slash menu, select a real tool and
download an export. Only a successful run
uploads an installer and its SHA-256 file. Builds are unsigned previews; Windows
may display a SmartScreen warning. No Windows download is advertised until the
native build and installed-application smoke test succeed.

## 2026-10-04 developer inner-loop map (keep TUI, mobile and desktop easy)

This section is the research note for how NOMO's user surfaces are
developed day to day, so that opening one does not require remembering
undocumented incantations. Today's surfaces and their direct entrypoints:

- **TUI**, `pnpm tui` (alias of `nomo` with no arguments:
  `packages/cli/bin/nomo.mjs` calls `withDefaultTui` and dispatches to
  `packages/cli/src/tui/*`). Tests: `pnpm test:tui` (node --test for
  `packages/cli/src/tui/workspace*.test.ts` plus
  `python3 scripts/src/verify-tui-terminal.py`). The workspace TUI has its own
  `README.md` visual contract (inline call, watch frame, hold prompt) and
  parity tests.
- **Desktop (native)**, `pnpm desktop` runs `apps/desktop dev`:
  `pnpm prepare:runtime && tauri dev`. In order it needs: root
  `pnpm install --frozen-lockfile --ignore-scripts` (**first**, without it
  `desktop:test` fails with `Cannot find package 'node-sql-parser'`),
  `pnpm desktop:setup` (pnpm install inside `apps/desktop` with
  `--ignore-workspace`), and a working Rust MSVC toolchain + VS C++ build
  tools for `cargo` (per-shell env loader in `vsenvs.ps1`). Tests:
  `pnpm desktop:test`, `cargo test`.
- **Desktop (smoke)**, same binary accepts `--smoke-test`, `--smoke-mobile`
  (visible 390 × 844 window), `--smoke-runtime-exit`. These start the bundled
  Node 24 runtime, load the local UI, exercise a download and exit with a
  code; they exist so CI and release packaging can gate on real behaviour. The
  Windows gate is open until a green installed `--smoke-test`.
- **Web control plane / mobile shell**, `pnpm dev:web` (dev server for
  `@nomo/control-plane-ui`), `pnpm gui` (build the web UI and serve it),
  `pnpm build` (production nitro build). Mobile layout is the same UI at a
  narrow viewport (see `docs/MOBILE-WEB-REFINEMENT.md`): chat-first header,
  bottom sheets, options in a mobile popover, bottom composer.
- **Watch / inline wrapper**, `pnpm watch` opens the second-terminal watch
  frame for a session that also runs inline output in the first. The same
  renderers (`renderInlineCall`, `renderWatchFrame`, `renderHoldPrompt`) are
  shared: TUI is three surfaces of one contract, not three implementations.

**Keeping this ergonomic long term:** run `pnpm install` at the workspace
root first; keep the desktop README's per-surface smoke flags next to the
dev commands; and make the Windows smoke export check target a tool the
no-credential smoke workspace actually exposes, the 2026-10-04 Windows smoke
failure came from the smoke expecting `/nomo_workspace_write` under
`.command-trigger` while the fresh smoke workspace renders only the
no-provider workspace, not from Node, packaging or the WebView2 download
path. WP-09b parity tests keep TUI and GUI matching; we should hold the
desktop smoke to the same "one contract, many surfaces" discipline.

## Windows workspace-key storage source audit

Read-only audit of the current source on 2026-09-25, against the documented
Win32 contract. It does not replace the open Windows gate and it is not a
compile or runtime result on Windows.

| Item | Source | Result |
| --- | --- | --- |
| Credential type and persistence | `apps/desktop/src-tauri/src/keychain.rs` `WindowsCredentials::put` | `CRED_TYPE_GENERIC` with `Persist: CRED_PERSIST_LOCAL_MACHINE` and `CredWriteW` flags `0`. |
| Flags argument | Microsoft `CredWriteW` documentation | Correct as written. Persistence is selected by the `Persist` member; the `Flags` parameter accepts only `0` or `CRED_PRESERVE_CREDENTIAL_BLOB`, so passing `CRED_PERSIST_LOCAL_MACHINE` in `Flags` would fail with `ERROR_INVALID_FLAGS`. No change is required. |
| Visibility of a persisted key | Microsoft `CREDENTIAL` documentation | `CRED_PERSIST_LOCAL_MACHINE` is visible to other logon sessions of the same user on the same computer, and not to other users or to other computers. The stored workspace key is therefore per-user, which matches the macOS keychain item, not a machine-wide secret. |
| Unsupported editions | Microsoft `CREDENTIAL` documentation | The documentation lists `Windows Vista Home Basic`, `Windows Vista Home Premium`, `Windows Vista Starter` and `Windows XP Home Edition` as not supporting this value. It does not state support for modern Windows 10/11 Home, so Home-edition behaviour is unverified and is not claimed either way here. |
| Read path | `WindowsCredentials::get` | `CredReadW` returns `Ok(None)` only on `ERROR_NOT_FOUND`. A zero or non-32-byte blob is a hard error, not a silent new key, and the Windows-owned allocation is released with `CredFree`. |
| Failure mode if persistence degrades | `keychain.rs` `load_or_create` | Fails closed with `Encrypted workspace exists without its encryption key; restore the original key before opening NOMO` rather than generating a new key over existing ciphertext. The post-write check compares the stored key in the same logon session, so it cannot detect a session-only persist downgrade; the cost is an availability failure after sign-out, not a silent key loss. |
| Test coverage | `keychain.rs` `windows_tests` | Gated `#[cfg(all(test, windows))]`, so it does not run on a macOS host. |

Toolchain limit on the audit machine: `rustc`/`cargo` are Homebrew `1.98.0`
and `rustup` is not installed, so no `x86_64-pc-windows-msvc` target and no
cross-target `cargo check` of the `cfg(windows)` paths is possible here. The
`cfg(windows)` blocks in `keychain.rs` and `main.rs` are source-inspected only.

Next: the Windows x64/MSVC gate above. Source correctness does not substitute
for it.

The one part of the `cfg(windows)` path that can be tested without Windows is
now tested: the Credential Manager target name and the accepted blob length
were moved out of the `#[cfg(windows)]` block into
`windows_credential_target` and `WINDOWS_CREDENTIAL_BLOB_BYTES`, so a rule
that can only be exercised on the platform it runs on is exercised on this
host instead. `keychain::windows_naming_tests` pins that the Windows target is
the same `dev.void.desktop.workspace` service and account the macOS keychain
uses, that it is NUL terminated exactly once, that a non-ASCII account name
survives whole, and that two workspaces never share one target. Renaming the
target turns two of those tests red. `cargo test --offline` for the desktop
crate is 16/16 on macOS.

What is still not covered on this host: the `CredReadW` and `CredWriteW` calls
themselves, `CredFree`, the `get_generic_password` error mapping, and the
`#[cfg(all(test, windows))]` store tests. Those need a Windows machine.

## Historical beta-4 evidence (not current-candidate evidence)

The Windows x64 package passed native build, credential tests, silent installation
and the command-menu/runtime/export smoke check in Actions run
https://github.com/Dawe583/void/actions/runs/34896103807 .

The run above is historical beta-4 evidence for the published installer. It
does not certify the current source revision. The current-source gate remains
open until a Windows x64/MSVC runner compiles the `cfg(windows)` Rust paths,
runs the Credential Manager tests, installs the freshly built NSIS package and
passes the installed WebView/export smoke.
Published installers and checksums:
https://github.com/Dawe583/void/releases/tag/desktop-v0.1.0-beta.4 .


## 2026-10-04 host verification on Windows (replaces the macOS audit as the
`cfg(windows)` evidence for the current source)

Machine: Windows 11, `LAPTOP-TAB9CBGR`, 16 cores. Added: `rustup` + Rust
stable 1.99.0 (`x86_64-pc-windows-msvc`), Visual Studio Build Tools 2022
17.14.41 with `Microsoft.VisualStudio.Workload.VCTools` + recommended
components (Windows 10 SDK 10.0.26100.0). Already present: WebView2
154.0.4258.53, Node 24.20.0, pnpm 10.33.0. Repo at `main` (aafa078).

Verified on this host, against docs and the desktop package:

- `pnpm install --frozen-lockfile --ignore-scripts`, then
  `pnpm desktop:setup`: OK. An immediate `pnpm desktop:test` failure
  (`node-sql-parser` missing) is resolved by running the root install first;
  the test then passes 9/9, including the real-backend runtime smoke.
- `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`: OK.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 20/20,
  including `keychain::windows_tests::windows_credentials_round_trip` and
  `keychain::windows_tests::windows_credentials_persist_across_workspace_loads`
  which run for the first time off macOS.
- `pnpm desktop:build`: OK. Produces
  `apps/desktop/src-tauri/target/release/bundle/nsis/NOMO_1.0.1_x64-setup.exe`
  (26.77 MB).
- Silent install: `NOMO_1.0.1_x64-setup.exe /S` installs under
  `%LOCALAPPDATA%\NOMO` (`currentUser` mode) with `uninstall.exe`; silent
  uninstall path exists.

**Resolved Windows smoke failure (root causes fixed).** The previous run
failed because the embedded runtime inherited the HTTP control-plane's
locked default (`DEFAULT_HTTP_PERMISSION_MODE = "read-only"` in
`packages/workbench/src/gui.ts`): the workspace rendered "Režim: jen čtení",
`/api/tools` exposed only read/list tools, and the smoke looking for
`/nomo_workspace_write` timed out and exported its own FAIL blob. The
desktop window is a local operator surface, so `launch_runtime` in
`apps/desktop/src-tauri/src/main.rs` now sets
`NOMO_PERMISSION_MODE=normal` for the bundled Node runtime (accepted by
`serverPermissionMode`). The mobile smoke also bit on a stale selector:
it clicked `.mobile-action-list .theme-toggle`, which no longer exists , 
the current theme control is the button labelled "Toggle theme" in the
mobile options popover. That probe now matches on `aria-label`, so both
smoke legs are green again on current source.

Next for the Windows gate:
- Windows desktop gate now has current-source Windows 11 evidence: MSVC
  build, `cfg(windows)` Rust tests 20/20, `desktop:test` 9/9, silent NSIS
  install to `%LOCALAPPDATA%\NOMO`, and BOTH installed smokes green , 
  `%LOCALAPPDATA%\VOID\nomo-desktop.exe --smoke-test` and `--smoke-mobile`:
  bundled Node runtime, real WebView render, byte-exact Blob export, mobile
  toolbar. Packaging/smoke packaging is ready for a human to run the manual
  GitHub Actions `windows-desktop` workflow and, if it passes on a real
  runner, move the gate. The remaining gate item is that manual CI run and
  signing/publishing policy, not the desktop code.
