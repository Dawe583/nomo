# NOMO 0.1.0 release runbook

> Historical runbook. Hosted jobs described below have been removed and are not release prerequisites. Account billing or missing hosted results must never block local verification or release planning.

Apple 1.0.1 release planning and exact evidence now live in
`docs/superpowers/specs/void-1.0.1-product.md` and
`docs/RELEASE-1.0.1-MATRIX.md`. This 0.1.0 development/npm runbook remains
historical; it does not certify a Mac App Store or native iOS release.

## Status and version policy

0.1.0 is a coherent development release, not an npm publication or a production
readiness claim. Workspace packages use the `@nomo/<package>` convention. The
root is `@nomo/workspace`; private packages remain private. The standalone
verifier is the sole publishable exception; publication still requires explicit
approval.

Versions move together while cross-package contracts and the on-disk formats
are being validated. Before 1.0, record incompatible API, policy, snapshot, or
ledger changes explicitly and provide migration instructions. Do not silently
rewrite old signed records. At 1.0, use semantic versioning and publish a
compatibility policy for every persisted format.

## Runtime support

The supported floor is Node.js 24 (`engines.node: >=24`). Node 26 remains the
local development and verification target. Use the same Node major for
development and local release checks where possible. This is a support baseline,
not a claim that Ed25519 or `node:test` first appeared in Node 24.

Source review: `tsconfig.base.json` targets ES2022. Product tsconfigs use
`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, and
`verbatimModuleSyntax`. The binaries import `.ts` files directly. Tests use
`node:test` and `node:assert/strict`; runtime code uses Node crypto, filesystem,
streams, `fetch`, `AbortController`, `Headers`, and `TextDecoder`. None of those
reviewed APIs establishes a Node 24-only runtime requirement. Native TypeScript
stripping is enabled by default from Node 22.18; Decision 6a records a successful
Node 22.22.2 test. The full gate suite (397 package tests, 27 control-plane tests,
30 scripts tests, all e2e suites incl. e2e-final 8/8, moment, bench) was verified
green under Node v24.21.0 on 2026-09-10.

Node 26 is the current verification target. Its default spec test reporter is
not accepted by the workspace test-count gate, so use the TAP reporter for
release checks. Do not add an experimental type-stripping flag. Native type
stripping does not make these source packages publishable under `node_modules`;
that restriction is a separate distribution blocker below.

## Done, with evidence boundaries

The wave 4 handoff at commit `cac57d7f` reports **346 package checks and 26 e2e
checks passing**. These are a recorded baseline, not a fresh wave 5 count. The
blackboard contains older totals; do not add them to this baseline. Record the
final revision and fresh totals when integrating wave 5.

Implemented development surfaces include:

- MCP interception with a stdio agent side and stdio or Streamable HTTP
  upstreams, declared facts, policy decisions, blocking holds, and a local
  signed ledger.
- Postgres and S3 connector contracts, snapshots, manifests, inverse planning,
  and target drift refusal with injected executors.
- CLI classification, verified ledger views, replay, taint queries, and
  verification; SDK interception and approval handles; a local control plane
  API and development pages.
- JSONL durability, SHA-256 chaining, Ed25519 signatures, attestations, and
  verification tests that detect tampering. The ledger is tamper evident, not
  tamper proof. A compromised signing host can forge future entries. Published
  checkpoints outside that host's control are needed to anchor past evidence.

The local e2e programs are `scripts/src/e2e.mjs`, `e2e-connectors.mjs`, and
`e2e-final.mjs`. The baseline final sweep contains two honest NOTEs: CLI approval
was missing, and replay through the binary lacked connector wiring. Wave 5
addresses those paths separately. Re-run the sweep before removing either
NOTE. Fixture executors do not prove restoration against a real service.

Wave 5 source status, pending integrated verification:

- `void approve` and the proxy share a filesystem request path. The proxy uses
  `--approvals-dir`, then `NOMO_APPROVALS_DIR`, then
  `~/.void/approvals/<workspace>`. An exclusive `proxy.lock` prevents a second
  proxy writer. Binary wiring is implemented; real end-to-end verification is
  still required before closing the baseline NOTE. These files do not prove
  human identity. After a crash, remove a stale lock only after confirming the
  prior proxy exited.
- Replay can plan from persisted Postgres snapshots without an executor. Apply
  reports `ExecutorNotConfigured` without configuration and
  `ExecutorAdapterUnavailable` even when `NOMO_PG_URL` is present. No production
  driver is installed. Persisted S3 replay and live binary drift proof remain
  open. In-process injected-executor tests do not close those gaps.

## Blocks public release

1. **npm organization and credential.** Confirm ownership of the `@void` scope
   and choose a scoped publish token or trusted publishing identity. No npm
   credential has been verified here. Never put tokens in a manifest, shell
   transcript, log, test, or release document.
2. **Hosted publish workflow retired.** Do not create or rely on a publishing
   workflow. Keep packages private until the owner approves a local publication
   procedure with an explicit package allowlist, protected human approval,
   provenance and a clean install test. Local verification does not itself
   authorize publication.
3. **Installable artifacts.** Current exports point to TypeScript source and
   several modules use relative imports across package directories. Node does
   not strip TypeScript inside `node_modules`, and a separately packed package
   cannot assume its sibling source tree exists. Define and test a compiled or
   bundled distribution before npm publication. Include policy pack YAML,
   registry disclaimers, license text, and required runtime assets. Root bin
   mappings only expose development entrypoints; they do not solve this.
4. **Real-service e2e.** Use a service machine with disposable Postgres and
   S3-compatible storage. Prove direct versus proxied transcripts, an R3 hold
   cancelled before any write, an inverse with exact before/after comparison,
   and refusal after target drift. No production accounts or autonomous writes
   to customer data. Replay apply still needs a real executor supplied by the
   host; a configured URL alone is not a database driver.
5. **Historical note, not a release gate.** This runbook recorded that hosted
   jobs were unavailable in October 2026. The repository no longer configures
   hosted CI, and account billing is not an engineering prerequisite. Release
   evidence must be gathered through the local checks and release-specific
   evidence described in this runbook. A local pass does not prove behavior on
   a clean machine or another operating system.
6. **WP-15 delivery evidence.** A published `@nomo/cli` version, clean-machine
   quickstart under five minutes, Docker image, and MCP registry listing still
   require release evidence. The WP-15 exit is not complete just because the
   source and metadata are present.
8. **Apple signing and notarization.** Local macOS builds are ad-hoc signed
   for bundle integrity only, not Apple notarization. Public distribution
   needs a paid Apple Developer identity: Developer ID certificate,
   hardened runtime, secure timestamp, and `notarytool` (Apple retired
   `altool` uploads on 2023-11-01). Tauri reads `APPLE_SIGNING_IDENTITY`,
   `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`; a free Apple account
   cannot notarize. A missing team id is a hard bundler error, other
   missing credentials only warn and skip. Evidence per release: signed
   `.app`/`.dmg` (tauri.conf.json targets `app` + `dmg`, macOS 13.5
   floor), notary log, and Gatekeeper ticket stapled or online. Sources:
   Apple "Notarizing macOS software before distribution", Tauri
   `distribute/Sign/macos` doc and bundler `macos/app.rs`, plus
   `apps/desktop/README.md`.
   **Owner decision, 2026-10-03: neither the Apple surface nor the desktop
   app is being built.** No iOS client, no macOS client, no desktop app at
   all. These blockers therefore stay open because nobody is working on them,
   not because the work is pending. They return as a phase immediately before
   a public release, and until the owner says so they are not part of the current
   engineering scope. This scope decision is historical; the current Apple release
   boundary is recorded in `docs/RELEASE-1.0.1-MATRIX.md`. Item 9 below is
   packaging **for the desktop app**, the Tauri `deb`, `rpm`
   and `AppImage` targets, so removing the app removes its packaging tail.
   Nothing here changes the Linux or macOS *server* or CLI distribution, which
   is a different question and is not part of this decision.
9. **Linux packaging and installer signing.** Linux targets (`deb`, `rpm`,
   `AppImage` via Tauri `BundleTarget`) are unverified, including the
   installed-app smoke check. The v2 updater reuses the AppImage plus a
   `.sig` sidecar. Windows ships an unsigned NSIS beta installer;
   SmartScreen may warn. Evidence per OS: native build, install, and the
   packaged `--smoke-test` on that OS. No Linux download is advertised
   until that passes. Source: Tauri updater plugin doc and bundle-target
   reference (`/tauri-apps/tauri-docs` via Context7).
10. **Production secrets, mobile, and accessibility gates.** Local secret
    storage (AES-256-GCM snapshot, macOS Keychain / Windows Credential
    Manager, mode-0600 key file) exists, but production KMS and a key
    rotation drill remain open. `NOMO_SIGNING_KEY` rotation today means
    redeploy plus `provision-cloud.mjs`; it is not a KMS rotation.
    Physical iOS/Android keyboards, VoiceOver/TalkBack, and true 200%
    browser zoom at desktop and mobile widths are pending per
    `docs/MOBILE-ACCESSIBILITY-ACCEPTANCE.md`. The 640x450 reflow check
    is explicitly not a browser-zoom test. Each pending case must record
    device, OS, browser, screen reader, viewport, zoom, commit, and a
    screenshot or recording with disposable content. Desktop emulation
    cannot close these cases.
7. **Security and licensing signoff.** Resolve release-blocking findings in
   `packages/security-notes.md` after the wave 5 adversarial review. In
   particular, unclassified calls permitted by broad allow rules remain a
   blocker. Agent-provided blast radius was removed on 11 September 2026,
   with regression tests for missing, failed and invalid probes; hash-only views labeled verified are closed
   for the control plane, which now distinguishes chain integrity from
   signature-checked verification and never reports verified without a
   configured key. The
   control-plane decision endpoint now rejects posts that do not carry an
   application/json content type. Peer address, Host, Origin and Fetch Metadata
   checks now enforce the local browser boundary. Authentication between local
   users and authenticated remote access remain unimplemented. The root `LICENSE` is Apache 2.0 and product metadata matches it. Confirm NOTICE and
   the registry disclaimer are included in each distributed artifact. Decision
   5 reserves paid features, but the control plane manifest currently declares
   Apache 2.0; resolve that boundary deliberately before distribution. This
   task does not create a new license or silently relicense a package.

## Verification and release sequence

Run from the repository root on a clean, reviewed revision. The root maintainer
owns dependency installation and the lockfile. Do not install during a worker
verification run.

1. Record `git rev-parse HEAD`, `node --version`, and `pnpm --version`. Confirm
   the tree contains only the intended release changes and no credentials.
2. Check entrypoint syntax and release metadata:

   ```sh
   node --check packages/cli/bin/nomo.mjs
   node --check packages/proxy/bin/nomo-proxy.mjs
   node --test --test-reporter=tap scripts/src/release-packaging.test.mjs
   ```

3. Typecheck each directory under `packages/` with
   `CI=true npx tsc -p tsconfig.json` from that package directory. Also check
   `apps/control-plane`. Then run the integrated gates:

   ```sh
   pnpm run typecheck
   pnpm test
   node scripts/src/e2e.mjs
   node scripts/src/e2e-connectors.mjs
   node scripts/src/e2e-final.mjs all
   ```

   Confirm nonzero test counts, zero failures, and no skipped release gates.
   Keep any unresolved e2e NOTE in the release report.
4. Run the benchmark on the service machine and record the command, machine,
   runtime, workload scale, p50/p95/p99, and sample counts. A fixture benchmark
   is not a production latency guarantee.
5. Complete the real-service checks above. Review fail-closed failures, stale
   approvals, ledger tampering, drift, and shutdown behavior. Verify signatures
   using trusted public keys; a hash-only check is not signer authentication.
6. After the distribution blockers are fixed, run `npm pack --dry-run` for each
   intended public package. Inspect every file. Install the resulting tarballs
   in a clean external directory, without workspace symlinks, and run both
   bins, policy pack loading, and the five-minute first-hold quickstart.
7. Obtain human approval for publishing, confirm npm identity without exposing
   credentials, run the approved local checks, and publish only reviewed
   artifacts. Verify the published version with `npm view @nomo/cli version`.
   Record the tag, commit, artifact digests and provenance. This runbook does not
   authorize publication or create a hosted workflow.

### What the packaging gate now executes

`node --test scripts/src/release-packaging.test.mjs` runs a clean install for
every package in the test's `PUBLISHABLE` map, and the exact commands are:

1. `npm pack --pack-destination <sandbox> --json` from the package directory.
2. `npm install --no-save --no-audit --no-fund --offline <tarball>` into a
   fresh directory under the system temp directory, with a consumer
   `package.json` of its own and `npm_config_registry` pointed at a discard
   port.
3. The installed `node_modules/.bin/<bin>` is executed as a program, and its
   exit code and a line of its output are both required.

This proves the packed tarball carries a manifest, installs with no network
and no workspace link, and yields a bin a consumer can execute and that still
produces real work. A metadata assertion cannot prove any of that, which is
why the previous version of this gate did not.

It does not prove the following, and none of it may be inferred from a green
run here. It does not prove the remaining twelve directories install, because
they are excluded: the ten under `packages/` other than `verifier`, the root,
`apps/control-plane` and `scripts` all stay `private: true` and are absent
from `PUBLISHABLE`. One assertion names that boundary, so a package
un-privated without a written reason and a clean install command fails the
gate rather than shipping untested. It does not prove signature verification
against a trusted key, a clean-machine quickstart, policy pack loading, the
blocker 3 compiled distribution, or that any artifact was ever published. It
covers only the packages named publishable, which today is
`packages/verifier` alone.

`npm pack` and a local tarball install need no registry. If a future
publishable package needs a dependency, the offline install will fail here
rather than quietly reaching the network.

### Suites outside the Node gate

`scripts/src/check-tests.mjs` now also runs the Python suite,
`python/void-transport/tests`. A suite that cannot run prints as `UNRUN`,
naming the interpreters it tried and the commands to run it, and is excluded
from the total rather than counted as a pass. When anything was skipped the
summary reads `N suites, M tests, K could not run`, so a test count quoted from
this gate cannot be read as covering a suite that never executed.

`python/void-transport` runs under the system interpreter and executes on an
ordinary checkout. This suite is local-only. A release report must say which
local suites ran.

Historical note: the former workflow also defined an `apple` job for both
Swift packages and the `VOID` scheme on an iOS simulator. No result was claimed
for that retired hosted job. Current Apple evidence remains the local machine
results recorded in `docs/RELEASE-1.0.1-MATRIX.md`; hosted status is not a gate.

If a released artifact fails verification, stop rollout. Deprecate the bad npm
version and ship a corrected version rather than replacing it. Restore the last
verified binary only if its persisted-format compatibility is proven. Never
truncate, rewrite, or delete ledger records as a release rollback.

## 1.0 checklist

- [ ] All publication and WP-15 blockers above are closed with command output.
- [ ] Independent clean-machine install reaches the first hold in five minutes.
- [ ] Postgres and S3 restore and drift refusal pass against disposable services.
- [ ] Unknown tools, unclassified calls, invalid policy, internal errors, and
      failed ledger appends cannot widen into permission to write.
- [ ] Human approval identity, local trust boundaries, and remote authentication
      are specified and tested. Development approvals are not an identity system.
- [ ] API, CLI, policy grammar, snapshot format, and ledger format compatibility
      promises have migration and downgrade tests.
- [ ] Offline attestation verification has trusted key distribution and a
      separately installable verifier with no VOID package dependency.
- [ ] Security review findings are resolved, accepted risks are explicit, and
      key rotation, backup, recovery, and checkpoint procedures are exercised.
- [ ] License boundaries, NOTICE, registry disclaimers, and contribution terms
      are checked in the actual release artifacts.
- [ ] Support ownership, incident handling, rollback, and measured performance
      budgets are documented without claims from fixture-only evidence.
- [ ] Apple signing and notarization pass with Developer ID, notary log,
      and Gatekeeper ticket (blocker 8). Ad-hoc local signature is not
      release evidence.
- [ ] Linux packaging and installed-app smoke pass on a Linux machine;
      Windows stays unsigned-beta until signed (blocker 9).
- [ ] Production KMS plus rotation drill, physical mobile keyboards,
      VoiceOver/TalkBack, and true 200% zoom acceptance are recorded with
      device evidence (blocker 10). Reflow checks do not close zoom.
