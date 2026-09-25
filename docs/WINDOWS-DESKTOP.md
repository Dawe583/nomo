# Windows desktop

## Release scope

Windows is out of scope for the VOID 1.0.1 delivery. The current-source
Windows gate remains open: no current packaging, installed-application smoke or
full Windows recovery evidence is claimed. Historical beta evidence is retained
below but cannot certify the current candidate.

The historical Windows build target used the shared VOID browser GUI and local
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
| Failure mode if persistence degrades | `keychain.rs` `load_or_create` | Fails closed with `Encrypted workspace exists without its encryption key; restore the original key before opening VOID` rather than generating a new key over existing ciphertext. The post-write check compares the stored key in the same logon session, so it cannot detect a session-only persist downgrade; the cost is an availability failure after sign-out, not a silent key loss. |
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
