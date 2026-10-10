# NOMO €10k MRR technical backlog

**Status:** proposed implementation sequence; no code or release evidence is claimed by this document.
**Target:** enable a first independent evaluator to install NOMO, reach one governed hold, produce a signed sample ledger, and verify it outside the NOMO runtime before the December 2026 acquisition push.
**Strategy:** [GO-TO-MARKET-10K-MRR.md](GO-TO-MARKET-10K-MRR.md)
**Date-bound plan:** [GO-TO-MARKET-10K-MRR-2026.md](GO-TO-MARKET-10K-MRR-2026.md)
**Execution board:** [10K-MRR-EXECUTION-BOARD.md](10K-MRR-EXECUTION-BOARD.md)
**Distribution research:** [DISTRIBUTION-PATH.md](DISTRIBUTION-PATH.md)
**Release gates:** [RELEASE.md](RELEASE.md)
**Tracking issue:** https://github.com/Dawe583/void/issues/1

This backlog separates source readiness from publication. The GitHub repository is private, authorized push access is a recorded blocker, package ownership is unknown, and a full-history secret scan and human visibility decision have not been evidenced here. Do not make the repository public or publish a package as a side effect of implementation.

## Decision and evidence status

| Item | Current source evidence | Status |
|---|---|---|
| CLI package metadata | packages/cli/package.json is private, has no package bin, exports raw src/index.ts, and depends on @nomo/registry via workspace:* | Distribution blocker; keep private until the artifact is self-contained and tested |
| CLI entry point | packages/cli/bin/nomo.mjs imports TypeScript and development workspace paths | Must be bundled or compiled for the published consumer artifact |
| Standalone verifier | packages/verifier/verify-ledger.mjs uses Node built-ins and has an existing self-test; @nomo/verifier is currently the allowlisted package in scripts/src/release-packaging.test.mjs | Reuse it; add a representative sample bundle and external verification evidence |
| Existing first-run command | packages/cli/src/init.ts creates local workspace storage and can pin a verification key; it does not emit the complete MCP config and starter policy described in distribution research | Define an explicit MCP bootstrap path without changing ordinary nomo init semantics |
| Registry metadata | server.json and release tests already exist; distribution research records that tool titles and a chosen npm package identity remain open | Validate current manifest, fill remaining metadata, do not publish yet |
| External release proof | docs/RELEASE.md still requires a clean consumer install, real-service tests, credential-safe CI, and release evidence | No public release claim until every relevant gate passes |

## Dependency order

P0 human gate → T1 distributable CLI artifact → T2 safe bootstrap → T3 reproducible proof bundle → T4 registry metadata and validation → T5 protected publish workflow → public user test.

The standalone verifier lane can proceed in parallel with T1. Registry publication depends on the package identity and public repository decision. A secret scan result alone does not authorize a visibility change; the founder decides visibility after reviewing the result.

## P0 — release and safety decisions

### P0.1 Repository and package gate

**Owner:** Founder / Distribution DRI. **Due:** 2026-10-04. **Status:** blocked on human/account-side evidence.

- Restore authorized GitHub push access through the existing trusted account flow; do not paste a token into chat, Slack, or a repository file.
- Run a full-history secret scan over every commit and record scanner, scanned ref/range, findings disposition, and exact commit.
- Decide whether to make Dawe583/void public. If history is not suitable, choose a clean distribution repository without rewriting product history.
- Verify who owns the chosen npm name/scope through normal account UI; do not assume @nomo is controlled by this repository.
- Choose one package name from the candidates in DISTRIBUTION-PATH.md; keep a fallback name documented.

**Acceptance:** a dated decision record links the scan result and identifies the public source of truth, release owner, package identity, and rollback owner. Until then the repo and packages stay private.

## T1 — bundle a consumer-installable CLI

**Owner:** Engineering + Distribution DRIs. **Target:** first engineering slice.

**Source files:** packages/cli/package.json; packages/cli/bin/nomo.mjs; packages/proxy/bin/nomo-proxy.mjs; rollup.config.mjs (confirm the actual root config before modifying); scripts/src/release-packaging.test.mjs; relevant CLI build scripts and lockfile only when the chosen change needs them.

**Work**

1. Build one versioned CLI artifact that contains or correctly resolves its runtime dependencies; the installed result must not depend on sibling workspace source or workspace:* links.
2. Add the real executable bin mapping to the package intended for distribution. Keep root development launchers distinct from the consumer package.
3. Preserve the repository's private-by-default release invariant. Change the explicit publishable allowlist for only the reviewed package and add a corresponding clean-install run entry; never blanket-remove private:true from workspace manifests.
4. Include required runtime assets such as policy packs, registry disclaimers, license, and NOTICE where required. Inspect the packed file allowlist.
5. Pin the supported Node engine to what the tested artifact actually supports; do not infer this from the developer machine.

**Acceptance**

- A packed tarball installs in a clean temporary consumer directory outside the workspace with no workspace symlink and no network access unless a reviewed runtime dependency is explicitly required.
- Its installed nomo --help and nomo --version run as executable programs and return the expected result.
- npm pack --dry-run contains no private keys, .env, test-only secrets, unrelated apps, or accidental workspace files.
- The release packaging test executes the installed bin, not the source-tree entrypoint.
- All unaffected workspace packages remain private and the release test fails if an unlisted package becomes publishable.

**Stop condition:** if one-bundle packaging cannot preserve current CLI contracts, report the smallest unresolved dependency boundary. Do not publish an unbundled workspace and do not build a nine-package chain by accident.

## T2 — make first-run setup usable by an evaluator

**Owner:** Engineering DRI with Product review. **Target:** after T1's package layout is agreed.
**Source files:** packages/cli/src/init.ts; packages/cli/src/argv.ts; packages/cli/src/dispatch.ts; policy/config schema and fixtures referenced by the existing CLI path; CLI init tests and clean-install acceptance in scripts/src/release-packaging.test.mjs.

Add an explicit opt-in MCP bootstrap mode, proposed as nomo init --mcp, that writes a minimal server configuration, a generated agent identity, the selected state directory, a starter policy, and references to encryption/signing key locations. Keep existing ordinary nomo init behavior intact unless Product review explicitly chooses a migration.

**Safety requirements**

- Generate key material with cryptographic randomness and store it only in the established private data directory with restrictive permissions; never print private key bytes, include them in config, or write them into a repository.
- Show output paths and explain trust boundaries. Do not imply a locally derived pin is an out-of-band identity anchor.
- Be idempotent: rerunning must not overwrite a user's edited config or policy. Require an explicit backup/replace flag if overwrite is ever supported.
- Refuse symlink/path traversal surprises and report permissions that the filesystem cannot enforce.
- Use a temporary directory in tests. Do not contact a provider, model, npm, or customer endpoint during init.

**Acceptance**

- A new temporary home yields a valid config/policy pair and one expected next command.
- A second run leaves bytes unchanged.
- Existing edited config is preserved and the command explains how to inspect or deliberately repair it.
- Tests assert restrictive file modes where the platform supports them, redaction of secret material from stdout/stderr, invalid input refusal, and no network calls.
- The packed installed CLI can complete bootstrap without reaching back into the source tree.

## T3 — produce independent proof, not a marketing fixture

**Owner:** Engineering + Distribution DRIs. **Target:** before the first technical post.
**Source files:** packages/verifier/verify-ledger.mjs; packages/verifier/package.json; packages/cli/src/verify.ts; the supported sample workflow and documentation chosen by Product.

1. Produce a sample ledger using a disposable demonstration key and clearly labeled synthetic tool calls. Never use customer records or a production signing key.
2. Export the ledger and its attestation/public verification material as an explicit bundle. Keep the private signing key out of the bundle.
3. Verify from a clean external directory using the standalone verifier, with the public key passed independently so output states that signatures were checked. A no-key hash-chain check is integrity-only and is not acceptable as the primary proof.
4. Demonstrate one tamper failure and one wrong-key failure; retain commands, exit codes, output, artifact digest, and verifier version.
5. Document what the proof establishes and does not establish: it does not prove agent reasoning, production-service behavior, universal reversibility, or third-party certification.

**Acceptance**

- The sample bundle verifies outside the runtime with no NOMO package import.
- Both tampered bytes and a wrong public key exit nonzero.
- The artifact and result are reproducible from documented commands and contain no customer or production data.
- The README/post points to the bundle, exact verifier command, digest, and limitations.

## T4 — prepare the official MCP Registry listing

**Owner:** Distribution DRI + Engineering. **Target:** after T1 and the P0 package decision.
**Source files:** server.json; MCP tool declarations in packages/cli/src/recovery-mcp.ts and any other advertised server entrypoint; scripts/src/release-packaging.test.mjs; selected CLI package.json.

- Choose and reserve a free package name; do not assume void, void-cli, or the @void scope is available.
- Add the official mcpName package metadata exactly as the registry requires and keep it aligned with package name and version.
- Validate server.json against the official schema, including namespace, source repository URL, monorepo subfolder, version, package registry, transport, and launch command.
- Add user-readable title metadata to each published tool schema as required by the vendor review checklist; tests must prevent omissions.
- Record exact mcp-publisher version and commands for init, validate, and publish in the release report.
- Treat the registry as discovery metadata, not uptime, security, or human endorsement.

**Acceptance before publication**

- mcp-publisher validate passes on the reviewed commit.
- A clean external install runs the documented stdio server command and tool discovery succeeds.
- Package version, server.json, repository URL and monorepo subfolder agree.
- A human release owner confirms npm package ownership and public-repository visibility.

## T5 — protected distribution and release evidence

**Owner:** Distribution DRI. **Target:** only after P0–T4 pass.

- Use GitHub Actions trusted publishing/OIDC if supported by the chosen npm setup; do not create a long-lived token in source or chat.
- Gate publish jobs on protected tags, reviewed changelog, explicit package allowlist, tests, pack/install checks, secret scan, and an authorized release approval.
- Capture commit SHA, package/version, tarball digest, provenance URL, CI run URL, verifier version, and rollback/deprecation procedure.
- Publish npm first; publish MCP Registry metadata only after the npm package is available and its install command passes.
- Publish the Show HN or equivalent post only after the stranger path succeeds. A directory listing by itself is not a customer-acquisition result.

**Acceptance:** an independent operator follows the public README from a clean machine to a governed hold and separately verifies a synthetic bundle, with each step linked to an immutable release artifact and source revision.

## Critical path and explicit non-goals

P0.1 decision/scan → T1 package artifact → T2 bootstrap → T3 proof bundle → T4 registry validation → T5 protected publication → independent evaluator → buyer interviews → paid scoped evaluation.

Non-goals for this MRR cycle unless a qualified paying account changes the evidence:

- Apple App Store, notarized DMG, Windows Store, or physical mobile expansion;
- hosted multi-tenancy, SSO, KMS, enterprise SLA, or generic compliance certification;
- a broad connector matrix or feature work unrelated to activation;
- making the repository public before the full-history scan and human decision;
- claiming an npm release, MCP listing, production test, customer, or revenue result before source evidence exists.

## Weekly reporting format

For each task report: Owner / Status / Due / Evidence / Next step / Blocker. Use READY, IN PROGRESS, BLOCKED, DONE, or STOPPED. A task is DONE only when acceptance evidence exists and another operator can inspect or reproduce it.
