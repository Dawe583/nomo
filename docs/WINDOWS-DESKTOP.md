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
The NSIS installer is generated under
`apps/desktop/src-tauri/target/release/bundle/nsis/`.

The manually dispatched **Windows desktop** GitHub Actions workflow builds the
installer, tests credential storage, installs the package, and checks that its
WebView can load the local runtime, open the slash menu, select a real tool and
download an export. Only a successful run
uploads an installer and its SHA-256 file. Builds are unsigned previews; Windows
may display a SmartScreen warning. No Windows download is advertised until the
native build and installed-application smoke test succeed.

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
