# Windows desktop

The Windows build uses the shared VOID browser GUI and local guarded runtime.
The target is Windows 10/11 x64 with WebView2. Node 24 is bundled and verified
against a pinned official SHA-256. Workspace encryption keys are stored in the
current user's Windows Credential Manager; there is no plaintext fallback.

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
