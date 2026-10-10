# Vendoring decision: evidence pack

Prepared 2026-10-05 for the choice between four options for handling two upstream
trees (`can1357/oh-my-pi`, `PrimeIntellect-ai/prime-agent`).

**This document contains no recommendation.** Every option is costed. The choice
belongs to the owner.

## How to read the labels

| Label          | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **measured**   | Read directly from a file in this repo or from a local clone on this machine, with the path given. |
| **inferred**   | Follows from measured facts by a reasoning step stated inline.                                     |
| **unverified** | Could not be established from this machine. Stated as a gap, not filled with a guess.              |

## Sources actually read

| What                | Where                                                                | State                |
| ------------------- | -------------------------------------------------------------------- | -------------------- |
| `oh-my-pi` clone    | `/Users/dawe/Developer/upstream/omp-src` @ `1c0993c` / tag `v18.6.2` | measured             |
| `prime-agent` clone | `/Users/dawe/Developer/upstream/prime-src` @ `41e1f41`               | measured             |
| This repository     | `/Users/dawe/Developer/Claude-Projects/VOID` @ `0791c1f`             | measured             |
| npm registry        | `registry.npmjs.org`                                                 | measured, 2026-10-05 |

Both clones are present on this machine. Nothing in this document about the
upstream trees is extrapolated from a remote fetch.

**Correction to the brief.** The installed binary reports `omp/18.6.1`, not
`18.5.1` (`/Users/dawe/.local/bin/omp --version`, measured). The clone is at
`18.6.2`, which is **not yet on npm**: `npm view @oh-my-pi/pi-tui version`
returns `18.6.1` with `dist-tags.latest = 18.6.1` (measured). So three
distinct version identifiers exist for the same project: installed `18.6.1`,
published `18.6.1`, cloned source `18.6.2`.

---

## 1. The four options, costed

### Baseline numbers (measured)

| Measure         | `omp-src`                                                                                        | `prime-src`                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Tracked files   | 8,651                                                                                            | 1,453                                                                                 |
| On-disk size    | 283 MB                                                                                           | 39 MB                                                                                 |
| Source lines    | 1,807,739 `.ts` (5,706 files)<br>365,710 `.rs` (682 files)<br>96,698 `.py` (186 files)           | 594,337 `.rs` (1,221 files)                                                           |
| Root manifest   | `package.json`, `Cargo.toml`, `MODULE.bazel`, `bun.lock`, `flake.nix`, `Makefile`-equivalent set | `Cargo.toml`, `Cargo.lock`, `Makefile`, `deny.toml`, `install.ps1`, `install-rust.sh` |
| Language        | TS + Rust + Python                                                                               | Rust                                                                                  |
| Package manager | bun (`packageManager: "bun@>=1.4"`)                                                              | Cargo + `make`                                                                        |
| Registry names  | 12 publishable `@oh-my-pi/*` packages, 5 private                                                 | none (no `package.json` anywhere: `git ls-files \| grep -c package.json` → `0`)       |

`omp-src` file distribution (measured, `git ls-files <dir> | wc -l`):
`packages/` 6,844 · `crates/` 1,275 · `python/` 134 · `docs/` 141 · `scripts/` 91 ·
`sdk/` 51 · `bazel/` 16 · `infra/` 12 · `assets/` 13 (24 MB) · `nix/` 5.

---

### Option A — record provenance only

| Cost                       | Value                                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files landing in repo      | 1 doc. `docs/` already holds 100 files.                                                                                                                                                                                    |
| Lines landing              | ~this file.                                                                                                                                                                                                                |
| New build systems in CI    | none                                                                                                                                                                                                                       |
| Collision with `packages/` | none                                                                                                                                                                                                                       |
| Left undone                | Rebranding never happens. Nothing is copied, so nothing needs rebinding. The two CLIs remain external binaries at `~/.local/bin/omp` (18.6.1) and `~/.local/bin/prime` (0.9.1), outside the repo and outside any lockfile. |

Existing home for this: `docs/VERSIONING-AND-UPDATE-PLAN.md` and
`docs/DECISIONS.md` (measured: both exist). No provenance file exists today —
`ls docs | grep -iE "vendor|licen|provenance|third|attribut"` returns only
`VERSIONING-AND-UPDATE-PLAN.md` (measured).

---

### Option B — fork on the owner's GitHub account, depend on the fork

| Cost                       | Value                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Files landing in repo      | 0 source files. A `package.json` dependency line plus lockfile churn.                                           |
| Lines landing              | ~1 dependency entry; `pnpm-lock.yaml` is currently 173.2 KB and would grow.                                     |
| New build systems in CI    | none from the fork itself — the fork's CI is upstream's problem, not VOID's. VOID installs a published tarball. |
| Collision with `packages/` | none, unless the fork is consumed via `workspace:`.                                                             |
| Left undone                | The rebrand still has to happen somewhere. See §2 — it is ~15,949 import statements.                            |

The structural constraint is measured, not assumed: `omp-src/packages/*/package.json`
contains **119 `catalog:` references** and **1 `workspace:` reference** across the
17 package manifests (measured). The internal dependency graph is expressed
through a **bun catalog**, not `workspace:*`:

```
packages/tui/package.json:  "@oh-my-pi/omptype": "catalog:"
packages/tui/package.json:  "@oh-my-pi/pi-agent-core": "catalog:"
```

and `omp-src/bun.lock:722` shows what `catalog:` resolves to:

```
"@oh-my-pi/pi-tui": ["@oh-my-pi/pi-tui@workspace:packages/tui"]
```

**inferred:** `catalog:` in bun resolves to the local workspace package by
_name_. Renaming a package's `name` field therefore invalidates every
`catalog:` key that pointed at it, so the catalog in `omp-src/package.json`
(12 `@oh-my-pi/*` keys pinned to `18.6.2`) must be renamed in lockstep with the
16 `packages/*/package.json` name fields. `bun.lock` must then be regenerated.

---

### Option C — port selected capabilities, reimplement in VOID's idiom

| Cost                       | Value                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files landing              | Only the ported capability. Unbounded by this document; depends on the selection.                                                                                                                                                                                                                                 |
| Lines landing              | Unbounded by this document. For scale only: `omp-src` is 2.27 M source lines across TS/Rust/Python (measured), so "selected capabilities" must be named before this option can be costed.                                                                                                                         |
| New build systems in CI    | none, **if** the port is TS-only. VOID's `packages/*` are TS (`packages/cli/package.json` → `"exports": { ".": "./src/index.ts" }`, measured).                                                                                                                                                                    |
| Collision with `packages/` | Depends on placement. All ten existing packages are named `@void/*` (measured: `pnpm m ls --depth -1 --json` returns `@void/cli`, `@void/connectors`, `@void/ledger`, `@void/policy`, `@void/proxy`, `@void/registry`, `@void/runtime`, `@void/sdk`, `@void/verifier`, `@void/workbench`, all `"private": true`). |
| Left undone                | Whatever is not ported. This option has no defined boundary in the brief; the boundary _is_ the cost.                                                                                                                                                                                                             |

**measured:** VOID's own runner is Node 24 and 26 on ubuntu-latest
(`.github/workflows/ci.yml`, `gates` matrix `node-version: [24, 26]`), pnpm
10.33.0, TypeScript ~5.9.3 (`package.json`). A TS-only port inherits this
toolchain unchanged.

---

### Option D — vendor both trees under `packages/` with a deep rebrand

This is the most expensive and the only option whose cost is dominated by
find-and-replace volume.

| Cost                       | Value                                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files landing              | Up to **10,104** (`omp-src` 8,651 + `prime-src` 1,453), measured.                                                                                                                                                                                                                   |
| Lines landing              | ~2.86 M source lines, measured (see Baseline).                                                                                                                                                                                                                                      |
| Disk in repo               | Up to ~322 MB of working tree, measured (283 + 39), before `node_modules`/build output.                                                                                                                                                                                             |
| New build systems in CI    | **bun, Rust nightly, Bazel 9.2.0, Nix** — see §2 for the file paths.                                                                                                                                                                                                                |
| Collision with `packages/` | `packages/cli/src` exists and is one of the ten workspace packages; `check-tests.mjs` reacts to _any_ directory under `packages/` — see §3.                                                                                                                                         |
| Left undone                | Everything about upstream's release cadence. A vendored tree has to be re-vendored on every upstream bump; measured evidence that this is frequent: `omp-src` is at `18.6.2` and `prime-src/Cargo.toml` declares `version = "0.9.8"` while the installed `prime` binary is `0.9.1`. |

Rebrand volume for D (measured):

| Scope                               | Count                            |
| ----------------------------------- | -------------------------------- |
| Occurrences of `oh-my-pi`           | 20,560                           |
| Occurrences of `@oh-my-pi`          | 18,859                           |
| Files containing `@oh-my-pi`        | 4,407                            |
| — in `.ts`                          | 17,359 occurrences / 4,283 files |
| — in `.tsx`                         | 9 / 9                            |
| — in `.json`                        | 104 / 19                         |
| — in `.md`                          | 369 / 79                         |
| — in `bun.lock`                     | 122 / 1                          |
| — in `.rs` / `.py` / `.sh` / `.yml` | 21 / 9 / 22 / 2                  |
| Files containing `can1357`          | 236 (1,709 occurrences)          |
| `prime-agent` occurrences           | 14,118 across 389 files          |

Of the 18,859 `@oh-my-pi` occurrences, the **code-level** import statements are
(measured, `git grep -hoE` over `*.ts`/`*.tsx`):

| Form                                            | Count      |
| ----------------------------------------------- | ---------- |
| `import … from "@oh-my-pi/…"` / `export … from` | 15,888     |
| dynamic `import("@oh-my-pi/…")`                 | 50         |
| `require("@oh-my-pi/…")`                        | 11         |
| **Total import/require statements**             | **15,949** |

Distinct specifiers seen (33, measured) include 12 that are real packages
(`pi-ai`, `pi-tui`, `pi-catalog`, `pi-agent-core`, `pi-coding-agent`, `pi-wire`,
`pi-utils`, `pi-natives`, `omptype`, `omp-stats`, `snapcompact`, `pi-mnemopi`)
and 21 that are subpath or platform fragments (`pi-natives-darwin-arm64`,
`pi-natives-linux-x64`, `pi-natives-win32-x64`, `pi-web-ui`, `swarm-extension`,
`pi-proxy`, `exa`, `hashline`, `agent`, `coding-agent`, `collab-web`,
`browser-relay`, `pi-metaharness`, `typescript-edit-benchmark`, and 7 partial
prefixes such as `pi-`, `pi-agent`, `pi-mom`).

---

## 2. The two questions that decide B and C

### Q1 — Can `@oh-my-pi` be republished under a different name or scope?

**Answer, from the manifests and the registry: yes, the rename is mechanical and
does not require owning the `@oh-my-pi` scope. What it costs is 15,949 import
statements across 4,292 `.ts`/`.tsx` files, plus 16 manifest `name` fields, 12
catalog keys and a regenerated `bun.lock`.**

Evidence:

1. **`@oh-my-pi` is not an npm organisation and not an npm user.** Both registry
   endpoints 404 (measured):
   - `https://registry.npmjs.org/-/org/oh-my-pi/package/pi-tui` → HTTP 404
   - `https://registry.npmjs.org/-/user/oh-my-pi` → HTTP 404
2. **The sole maintainer is a personal account** (measured,
   `npm view @oh-my-pi/pi-tui maintainers author --json`):
   ```json
   {
     "maintainers": ["can1357 <can.boluk89@gmail.com>"],
     "author": "Stencil Labs, Inc. (https://stencil.so)"
   }
   ```
   **inferred:** publishing under the literal string `@oh-my-pi` would require
   the `can1357` account or an npm-granted publish right on it. Publishing under
   _any other_ name or scope requires nothing from that account.
3. **The scope name is not load-bearing at runtime — it is a string in a
   specifier.** 15,949 import statements, 16 manifest `name` fields, 12 catalog
   keys. No build-time codegen reads the literal: `git grep` shows the scope
   appearing in `.ts` (imports), `.json` (manifests/catalog), `.md` (docs),
   `bun.lock`, `.rs`/`.py`/`.sh`/`.yml` (incidental). (measured)
4. **Resolution stays local after a rename.** `bun.lock:722` maps
   `@oh-my-pi/pi-tui@catalog:` to `@oh-my-pi/pi-tui@workspace:packages/tui`.
   A renamed package resolves to its renamed workspace entry; nothing is
   fetched from the registry. (measured; the lockfile consequence is inferred —
   `bun.lock` regeneration is required, exact output **unverified** without
   running bun.)
5. **The distribution name is already free of the scope.** `omp-src/package.json`
   has `"name": "omp"` and `"private": true` (measured). Only the _libraries_
   under `packages/*` carry the `@oh-my-pi/` prefix; the CLI does not. This
   confirms the brief's claim and adds the detail that the rebrand surface is
   the library graph, not the binary.

**unverified:** whether the owner's npm account has any existing scope, org, or
2FA/publish token configured. Not determinable from this machine.

### Q2 — Which build systems would VOID's CI have to acquire?

**Answer: bun, Rust (nightly), Bazel, and Nix. prime-agent adds only Rust, which
VOID already has for its Apple job. The Rust halves of both trees are therefore
the cheaper half to vendor; the TypeScript half of `oh-my-pi` is what drags in
bun and Bazel.**

What VOID's CI runs today (measured, `.github/workflows/ci.yml`):

| Job          | Toolchain                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gates`      | `ubuntu-latest`, matrix Node **24, 26**; `pnpm/action-setup@v4` pin `10.33.0`; `pnpm install --frozen-lockfile`; `pnpm run typecheck`; `pnpm test`; `node --test`; 4 × `e2e*.mjs`; `pnpm run build` |
| `hosted-mcp` | same pnpm/Node, plus `actions/setup-python@v5` **Python 3.14**, a venv from `apps/appwrite-mcp/requirements.txt`, and `python -m unittest` over `python/void-transport/tests`                       |
| `apple`      | `macos-latest`; `xcodebuild`, `swift test` over `apps/apple/CompanionProtocolKit` and `apps/apple/VoidDesignSystem`, `VOID.xcodeproj` on the `iPad Pro 11-inch (M5)` simulator                      |

So VOID's existing matrix is **pnpm + Node 24/26 + Python 3.14 + Xcode/Swift**.
No Rust toolchain step, no bun, no Bazel, no Nix.

What each upstream needs (measured):

| Tool               | Evidence in `omp-src`                                                                                                                                                              | Evidence in `prime-src`                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| bun                | `package.json` → `"packageManager": "bun@>=1.4"`; `bun.lock` (157 KB); root `"test": "bun scripts/ci-test-ts.ts local"`                                                            | —                                                                                     |
| Rust nightly       | `rust-toolchain.toml` → `channel = "nightly-2026-08-12"`, components `rustfmt`, `clippy`, `rust-analyzer`, three cross targets                                                     | `.github/workflows/ci.yml` uses `dtolnay/rust-toolchain*`; `install-rust.sh` (123 KB) |
| Bazel              | `.bazelversion` → `9.2.0`; `MODULE.bazel` (14.6 KB); `MODULE.bazel.lock` (**4.2 MB**); `BUILD.bazel`; `bazel/`; CI runs `bazelisk --bazelrc=… build --config=rustfmt //crates/...` | —                                                                                     |
| Nix                | `flake.nix` (6.0 KB), `flake.lock` (6.3 KB); `.github/workflows/nix.yml`                                                                                                           | —                                                                                     |
| Cargo + make       | 17 `crates/*/Cargo.toml`, root `Cargo.toml` 31.3 KB                                                                                                                                | 9 `crates/*/Cargo.toml`, root `Cargo.toml`, `Makefile` (17 targets)                   |
| Self-hosted runner | `omp-kata` — `runs-on: ${{ github.event_name == 'pull_request' && 'ubuntu-22.04' \|\| 'omp-kata' }}`, used by 8 jobs                                                               | `actions/create-github-app-token` (a GitHub App, not a plain `GITHUB_TOKEN`)          |

Two of these are not merely "new tools" but new **infrastructure**:

- **`omp-kata` is a self-hosted runner label.** VOID's `ci.yml` uses only
  `ubuntu-latest` and `macos-latest` (measured). Reproducing `omp-src`'s CI
  means standing up or renting that runner. **unverified** what it is.
- **The `prime-agent` workflows need a GitHub App token** via
  `actions/create-github-app-token` (measured) for at least 2 jobs. **unverified**
  what that App is authorised for.

`omp-src/.github/workflows/` totals 1,505 lines across 3 files (`ci.yml` 1,341,
`bazel-cache-warm.yml` 103, `nix.yml` 61). `prime-src/.github/workflows/` holds
8 files. **measured.**

---

## 3. The honest risk of D

### What the glob actually is

`pnpm-workspace.yaml`, quoted:

```yaml
packages:
  - packages/*
  - scripts
  - apps/control-plane/ui
```

The workspace glob is **`packages/*`** — a single-segment glob.

**Measured, by running picomatch 4.0.7 (the matcher pnpm bundles via fast-glob)
against the hypothetical paths from this repo's root:**

| Pattern        | `packages/oh-my-pi` | `packages/oh-my-pi/packages/tui` | `packages/prime-agent` | `packages/prime-agent/crates/pa-core/src/main.rs` |
| -------------- | ------------------- | -------------------------------- | ---------------------- | ------------------------------------------------- |
| `packages/*`   | **MATCH**           | no-match                         | **MATCH**              | no-match                                          |
| `packages/**`  | MATCH               | MATCH                            | MATCH                  | MATCH                                             |
| `packages/*/*` | no-match            | no-match                         | no-match               | no-match                                          |

So the answer is neither "ignore" nor "break". It is **partial capture**, and
that is the worst of the two:

1. **The vendored root is captured.** `packages/*` matches `packages/oh-my-pi/`
   and `packages/prime-agent/` — depth 1 only. Everything _below_ the vendored
   root is invisible to pnpm.
2. **`omp-src` ships a root `package.json`** (`"name": "omp"`, `"private": true`,
   measured), so the captured directory **has a manifest**. `pnpm install
--frozen-lockfile` — the first step of VOID's `gates` and `hosted-mcp` jobs
   — would then treat `packages/oh-my-pi` as a VOID workspace project and pull
   its `dependencies` (measured: `sherpa-onnx`, `sherpa-onnx-darwin-arm64`,
   `sherpa-onnx-node` plus 11 `catalog:` devDependencies) into the VOID
   lockfile. The `--frozen-lockfile` flag turns that into a hard failure, not a
   silent merge. **inferred** from the manifest + the flag; the exact pnpm error
   text is **unverified** without running an install.
3. **The 17 real sub-packages are NOT captured**, because they sit at
   `packages/oh-my-pi/packages/*`, which `packages/*` does not match. So pnpm
   would install the vendored root's dependencies while ignoring the 16 nested
   package manifests — a split state that matches neither the upstream repo's
   intent nor VOID's.
4. **`prime-src` has no `package.json` anywhere** (`git ls-files | grep -c package.json`
   → `0`, measured). `packages/prime-agent/` matches the glob but has no
   manifest. Whether pnpm skips such a directory silently or errors is
   **unverified** — it was not tested, because doing so would require writing a
   scratch workspace, which this task's constraints exclude.

### The collision the brief asked about

`packages/cli/src` is one of the ten workspace packages. The sharper collision is
not `cli` itself but the test driver. `scripts/src/check-tests.mjs:53-59`:

```js
const suites = [
  ...readdirSync(packagesDir)
    .sort()
    .map((name) => ({ name, dir: join(packagesDir, name) })),
  { name: "control-plane", dir: join(root, "apps", "control-plane") },
  { name: "scripts", dir: join(root, "scripts") },
];
```

It enumerates **every directory under `packages/`**, not the ten workspace
packages. The guard at `:64-73` skips a directory only if it has no
`package.json`, or has one with no `scripts.test`.

`omp-src`'s root package.json **does** have a `test` script (measured):
`"test": "bun scripts/ci-test-ts.ts local"`. So a vendored `packages/oh-my-pi/`
would pass both guards, and `pnpm test` — the third step of `gates`, budgeted at
25 minutes — would shell out to `bun scripts/ci-test-ts.ts local` inside
`packages/oh-my-pi/`. On a runner with no `bun` on PATH, that fails. (measured
that the script exists and what it runs; **inferred** that the failure mode is a
missing-binary error, since no run was performed.)

`prime-src`'s equivalent would be skipped at `:64`, having no `package.json`.

### A third collision, not in the brief: `.gitignore`

`.gitignore` (measured) contains an **unanchored** `dist` entry, plus:

```
dist
packages/*/src/**/*.js
packages/*/src/**/*.js.map
.build/
```

- The unanchored `dist` ignores any directory named `dist` at any depth. A
  vendored tree's build output would be silently untracked. **inferred.**
- `packages/*/src/**/*.js` is scoped to exactly one level of `src` beneath
  `packages/*`. It would **not** match `packages/oh-my-pi/packages/tui/src/*.js`,
  because that is two levels of `packages/`. (measured, by inspection of the
  pattern shape)
- `.build/` is ignored, which is where both Bazel and Cargo/SwiftPM place
  output — convenient, but it also means a vendored `MODULE.bazel` would have its
  `bazel-*` symlink forest ignored by a rule written for Xcode.

---

## 4. Factors not in the brief

### 4.1 Both upstreams are already running, and one is already a `devDependency` neighbour

`omp` (`omp/18.6.1`) and `prime` (`Prime CLI version: 0.9.1`) are installed on
this machine (measured). Separately, `@void/policy` and `@void/ledger` exist as
workspace packages, and `packages/cli/package.json` depends on
`@void/registry` via `"workspace:*"` (measured).

**unverified:** how much of the working behaviour in those two binaries is
already consumed by VOID today. The 84 installed markdown skills described in
`/Users/dawe/Developer/Claude-Projects/prime-agent-setup/PRIME-AGENT-SETUP.md`
(136 lines, measured) appear to be _this agent's own_ skills installed by
`prime lab sync`, not a VOID dependency. Nothing in the VOID tree was traced to
either binary. **This is the largest unverified item in the document and it
bears directly on A vs B/C/D.**

### 4.2 `assets/` is 24 MB in 13 files

`omp-src/assets/` is 24 MB across 13 tracked files (measured: `git ls-files assets | wc -l` → 13; `du -sh` → 24 MB). **inferred:** these are model or asset bundles, i.e. binary payloads that a text find-and-replace rebrand cannot touch and that would land in git as large blobs. Option D's repo-size cost is dominated by this, not by the 2.27 M source lines. **`MODULE.bazel.lock` (4.2 MB) and `THIRD-PARTY-NOTICES.txt` (1.0 MB)** add a further 5.2 MB of generated/vendor text (measured).

### 4.3 Licence posture differs and `NOTICE` is a real obligation

VOID is Apache-2.0 (`LICENSE`, 11.1 KB, measured) and carries a populated
`NOTICE` (765 B, measured) that already reproduces a `@void/registry` caveat.
`omp-src/LICENSE` is MIT, `Copyright (c) 2025 Mario Zechner` (measured).
`prime-src/LICENSE` is 1,234 bytes and `Cargo.toml` declares
`license = "MIT"` (measured).

MIT is compatible with Apache-2.0 for redistribution. **measured:** the
obligation that does bite is attribution — 236 files mention `can1357`, and
`omp-src/THIRD-PARTY-NOTICES.txt` is 1.0 MB of upstream third-party notices that
MIT §"include the copyright notice" makes a redistribution artefact, not a
discardable build file. **inferred:** a D or B rebrand must regenerate that file.

### 4.4 `oh-my-pi` uses `catalog:` where VOID uses `workspace:*`

VOID's cross-package wiring is `"workspace:*"` (measured,
`packages/cli/package.json`). `omp-src` uses `catalog:` for **119 of 120**
cross-package references (measured). A rebrand therefore has to move two
mechanisms, not one, and bun's `catalog:` resolution-by-name is the part that is
least well documented. **unverified** how bun behaves when a catalog key names a
package that no longer exists in the workspace.

### 4.5 The 3-version skew is already live

Installed `omp` = `18.6.1`. npm `latest` = `18.6.1`. Clone = `18.6.2`, a commit
(`1c0993c chore: bump version to 18.6.2`) that is ahead of the registry. For
`prime`: installed `0.9.1`, clone `Cargo.toml` `0.9.8`. **measured.** Any of
options A–D has to name which of these it is pinned to, and the brief's
`18.5.1` is not a number that exists anywhere on this machine.

### 4.6 `packages/cli/src` is modified in the working tree right now

`git status --short` shows ` M packages/cli/src/tui/workspace.ts` and
` M packages/cli/src/tui/workspace-parity.test.ts` (measured). Another agent is
editing `packages/cli/src` concurrently. **inferred:** any operation that touches
`packages/cli` — which a naive `git add -A` during a D-shaped vendoring would —
is contending with an in-flight edit.

### 4.7 `.omp/` and `.prime/` already exist in this repo

VOID already has `.omp/config.yml` (504 B) and `.omp/WATCHDOG.md` (888 B), plus
`.prime/agent/` (measured, `ls -la`). `omp-src` also ships a `.omp/` directory
whose 3 files contain `@oh-my-pi` references (measured, top-level dir tally).
A vendored `omp-src` would bring a second `.omp/` into the tree. Naming
collision is **unverified** — depends on where the vendored root lands.

---

## Cost summary

|                                         | A    | B      | C                   | D                                                                                    |
| --------------------------------------- | ---- | ------ | ------------------- | ------------------------------------------------------------------------------------ |
| Files into repo                         | 1    | 0      | selection-dependent | up to 10,104                                                                         |
| Source lines into repo                  | ~0   | ~0     | selection-dependent | ~2.86 M                                                                              |
| Repo size impact                        | ~0   | ~0     | selection-dependent | ~322 MB + build output                                                               |
| New CI tools                            | none | none   | none if TS-only     | bun, Rust nightly, Bazel 9.2.0, Nix, `omp-kata` self-hosted runner, GitHub App token |
| New CI infrastructure                   | none | none   | none                | self-hosted runner label + GitHub App                                                |
| Rebrand statements to rewrite           | 0    | 15,949 | 0 (reimplemented)   | 15,949 + 7,814 `prime-agent` refs                                                    |
| Touches `packages/cli`                  | no   | no     | depends             | **yes** — `check-tests.mjs:53` enumerates all of `packages/`                         |
| Upstream bumps become manual re-vendors | no   | no     | no                  | **yes**                                                                              |

## Decision, 2026-10-05

**Option A: record provenance only.** The two upstream trees stay external
binaries at `~/.local/bin/omp` (18.6.1) and `~/.local/bin/prime` (0.9.1),
outside the repo and outside the lockfile. No source is copied, so no rebrand
is needed and nothing vendored can drift from the published packages.

Why not the others, in one line each: D vendors 2.86 M source lines whose
`packages/*` glob match is a partial capture that fails `pnpm install
--frozen-lockfile` and routes `pnpm test` to `bun` on a runner with none,
while needing bun, Rust nightly, Bazel, Nix and a self-hosted runner LABEL to
be reproduced; B defers the same 15,949 import-statement rebrand to a fork and
pushes CI reproducibility onto upstream; C has no boundary, so its cost is
literally unwritable. What remains to do for A: the provenance note is now
written. `docs/DECISIONS.md` carries the decision itself under the entry dated
2026-10-05, and `docs/AGENT-BINARIES.md` names each binary, where it is
installed, what version was measured on what date, and how to check it, so the
external dependency is visible rather than implied.

## Usage audit, 2026-10-05

What the tree actually consumes from the two binaries, measured by grep over
every surface outside `node_modules`:

**`oh-my-pi` / `omp`: zero code-level consumption.** No import, no spawn, no
lockfile entry, no path to `~/.local/bin/omp` anywhere in `packages/`, `apps/`,
`cloud/`, `paid/` or `scripts/`. What exists is operator tooling config only:
`.omp/config.yml` and `.omp/WATCHDOG.md`, classified open in
`scripts/src/licence-line.test.mjs`. So vendoring `omp-src` would protect
nothing VOID uses.

**`prime-agent`: consumed as an external process, through three narrow
surfaces, and no others.**

1. `scripts/src/prime-bridge.mjs`: spawns the prime binary with a claimed
   job (`primeArguments`), parses its NDJSON stdout (`primeEvent`), reads
   `~/.prime/agent/settings.json`, `auth.json`, `models.json` and
   `~/.prime/config.json`, and reports the text answer back to the cloud.
2. `cloud/prime.mjs`: a session `agent` type named `prime-agent` that queues
   work for the local worker, plus `scripts/team/prime-spawn.sh` spawning
   `prime-agent -p --autonomous` for free-tier team members.
3. The TUI agent switch: `/harness cloud | prime-agent` in
   `packages/cli/src/tui/workspace.ts`, mirrored in the web chat catalog
   (`apps/control-plane/ui/src/chat.tsx`).

Nothing in `packages/*` imports prime source. The boundary is a CLI process
and four config files, which is exactly why Option A holds: there is no
versioned code surface to vendor, only a process contract to keep working.

## Open items marked unverified

1. Whether pnpm silently skips or errors on a `packages/*` match with no
   `package.json` (`prime-src` case). Not tested; would require a scratch
   workspace.
2. The exact pnpm error text when `--frozen-lockfile` meets a newly captured
   `packages/oh-my-pi` manifest.
3. What the `omp-kata` self-hosted runner is, and its cost.
4. What the `prime-agent` GitHub App is authorised for.
5. Whether the owner's npm account has a scope or org available.
6. ~~How much of the currently-installed `omp` / `prime` behaviour VOID actually
   consumes today~~ Answered 2026-10-05 in the usage audit above: `omp`
   nowhere in code, `prime` through one process contract.
