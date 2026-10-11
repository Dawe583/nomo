# Prime continuation, 11 September 2026

## Source recovered

The working directory was on local `main` at e3093e5, 80 commits behind the
already stored origin/main reference. The local branch
`claude/aw-00-workbench-contracts` and origin/main both pointed to 04586c3.
The continuation uses `codex/finish-prime-work`, based on that newer local
revision. No remote fetch, push, publication or default-branch merge occurred.
The existing .opencode, .prime, .playwright-mcp and scripts/team files were
preserved. Changes from this continuation are in the working tree.

## Work completed

- S05: local control-plane peer, Host, Origin and Fetch Metadata checks protect
  reads and decisions against hostile browser origins and DNS rebinding.
- S06: caller counts cannot become measured policy radius. Missing, failed,
  fractional, negative and unsafe probe counts remain unknown. A measured zero
  remains valid. Radius-dependent rules no longer authorize unmeasured calls.
- S12: malformed policy shapes fail as load errors; invalid classes and radius
  thresholds are refused; YAML syntax errors do not echo policy source.
- Control-plane S08: the feed now distinguishes signature verification from
  hash integrity at the API boundary, and integrity-only data remains visible
  with the existing warning in the client.
- Internal API dependency failures no longer expose arbitrary exception text.
- The standard check includes control-plane typechecking, control-plane tests,
  and scripts tests, with TAP counts and nonzero-suite enforcement.

No new dependency was needed. Compatibility changes and operator consequences
are documented in DECISIONS.md, POLICY-REFERENCE.md and RELEASE.md.

## Verification

Runtime: Node v26.8.1, pnpm 10.33.0.

The recovered baseline passed typechecking and 397 package tests. After the
fixes, `pnpm run check` covers 9 suites and 460 passing tests, zero failures:

| Suite         | Pass |
| ------------- | ---: |
| cli           |   95 |
| connectors    |   57 |
| ledger        |   49 |
| policy        |   75 |
| proxy         |   80 |
| registry      |   38 |
| sdk           |    6 |
| control-plane |   30 |
| scripts       |   30 |

The four local integration commands also passed:

```
node scripts/src/e2e.mjs
node scripts/src/e2e-connectors.mjs
node scripts/src/e2e-final.mjs all
node scripts/src/e2e-arc.mjs all
```

The final sweep reported eight passing moments and the arc passed through the
SDK, real local proxy process, HTTP approval, ledger and tamper detection.
Connector fixture executors do not prove restoration against live Postgres or
S3. No live service, hosted provider, browser automation or desktop packaging
verification is claimed by this continuation.

Review covered bypass via positive agent counts, invalid probe output, null
and array policy structures, hostile HTTP headers, error text disclosure and
unsigned feeds. A hostile Host regression initially used fetch, which ignores
that override here. It now uses node:http and checks actual rejection before
any broker call. Signed and unsigned feeds are tested separately.

## Still incomplete

WP-15 is not complete and this is not a public release. RELEASE.md remains the
release gate. In particular:

- S07 deliberately retained broad operator allow rules for unknown tools. That
  prior policy decision has not been silently reversed here.
- Key rotation (S09): the write-side drill landed 2026-10-03. The signer can
  now rotate (`devKeyRing`, `rotateDevKey` in `packages/ledger/src/sign.ts`) and
  a two-key chain verifies through the ring and through `jsonlStore.verify`
  (`packages/ledger/src/rotation-drill.test.ts`). What a verifier trusts has not
  moved: the same chain is still refused by the shipped single-key resolution,
  which that test asserts. The trust set in the pin, the rotation entry record
  and the re-signing decision are still open and still reserved for the owner.
- Transport bounds and backpressure (S10): the per-message ceilings were
  already in place; the queues around them were not. Closed 2026-10-03: the
  proxy caps upstream messages parsed but not yet handled, upstream stderr goes
  through the same queue guard as stdout, the control-plane session stream has
  a buffer ceiling, a drain deadline and one subscriber, the workbench view
  drops its oldest events at a byte ceiling, and the SDK client bounds the
  error lines it retains. Two claims were corrected rather than fixed, and two
  fixes ship without a deterministic regression; both are written out in the
  S10 row of `packages/security-notes.md`, along with the connector retention
  that remains open.
- Typed request identity (S11): closed across the relay paths. `Session` keeps
  the agent id, the upstream id and the progress token as typed identities
  (`JsonRpcId`), the HTTP relay keys its pending maps by `JsonRpcId` instead of
  rejecting a non-integer upstream id, and a server-originated request's
  progress token is recorded and answered with the token the server named.
  `recordServerRequest` now reserves the upstream id it was given, so the same
  number cannot be live as an upstream id in one direction and an agent id in
  the other. `relayServerRequest` remaps `_meta.progressToken`, which the live
  `runProxy` path had been passing through untouched. Regressions: a relay whose
  upstream ids are strings routes and answers its own request; a
  server-originated token round trips through the production `Session`; a
  reserved upstream id is never re-issued. Two limits remain by design: an
  upstream that echoes a progress token with a different JSON type than it was
  sent still gets no frame, and `NomoClient` no longer coerces a response id
  with `Number()`, which is hardening the full stack cannot reach a test for,
  because the proxy drops a string response id before the client sees it.
- Ledger read limits (S13): closed at the entry boundary. `readLedgerEntries`
  caps file bytes and entries per call (95c73e6). Growth during a single read
  remains an accepted limit of the whole file read.
- Child environment isolation (S15): closed. runProxy passes an allowlist to
  the upstream child, case-insensitive on Windows, with upstreamEnv as the
  explicit escalation. Verified with a real child process (396178a).
- Real binary replay executors and disposable Postgres/S3 verification remain
  absent. Configuring a database URL is not an executor implementation.
- Independently installable compiled artifacts, protected publication, npm
  scope ownership and public release evidence remain open. Packages stay private.
- AW provider/runtime contracts are not evidence of working provider adapters,
  desktop sessions or full workbench orchestration. The AW sequence remains
  subject to the dependencies in EXECUTION-PLAN.md.

Next local hardening step: the retention findings the S10 audit left open, in
`packages/connectors/src/registry.ts` and `probes/cache.ts`, before more agent
runtime surfaces. The S09 key rotation drill is done and is
evidence, not a decision: the trust set in the pin, the rotation entry record
and the re-signing decision it deliberately does not make are still open and
still the owner's. Hosted verification and publication require the relevant
user-provided test resources and release authorization.

## Small section 2: SDK startup signatures

Closed SDK S08: an existing ledger now requires valid signatures from the same
configured signer as the proxy before upstream startup. Three added regression
cases distinguish a trusted ledger from rehashed content and a foreign signer.

Scoped checks: 9 SDK tests passed, SDK typechecking passed, and
`node scripts/src/e2e-arc.mjs all` passed. The earlier 460-test workspace result
above is the previous full baseline; the full suite was not rerun for this small
section. No dependency, public API or other product section changed.

## Small section 3: GUI and live TUI

Priority changed by the user to GUI/TUI design and completion. Applied the local
awesome-design-md Apple reference and frontend-design. Shared GUI refinement
uses system typography, neutral surfaces and one interactive blue accent. It
adds search, activity pause, keyboard-accessible record details and full digest
inspection. Polling preserves the focused activity button. The four pages share
workbench.css, served through an explicit static allowlist.

The previously unwired `nomo watch` now reads the actual local ledger, checks
signatures and provides selection, class filters, pause, detail, help and refresh.
It offers no fake replay or approval controls. `--once`, piped output, CI,
TERM=dumb and NO_COLOR emit a plain snapshot. This is the first runnable live
watch; the older dashboard renderers remain preview contracts.

Verified: 99 CLI tests and 31 GUI/API tests; CLI and control-plane typechecking;
render bounds at 80, 120 and 200 columns; browser search and keyboard opening of
a real API record; no page overflow at 320, 768, 1024 and 1440 pixels; no browser
console errors. Browser preview uses an explicitly isolated design fixture, not
production data. Dark-mode visual inspection ran; light-mode visual inspection
and the full provider/session workbench are not claimed complete.

Next GUI/TUI slice: connect live pending approvals to the watch and standalone
GUI broker, with consistent action confirmation and status. Agent sessions,
provider setup and full replay UI remain separate unfinished workstream items.

Live watch PTY verification also passed at 80x24: Enter detail, Escape, help,
normal quit, SIGINT, SIGTERM and SIGHUP all restored the original terminal mode
and left the alternate screen. The test drained PTY output while awaiting exit;
a test that stopped reading caused a false signal timeout through backpressure.
Mobile record-dialog inspection at 320px showed no page or dialog overflow.

Run the current surfaces from the repository root:

```
pnpm gui
pnpm watch --workspace default
node packages/cli/bin/nomo.mjs watch --workspace default --once
```

GUI defaults to http://127.0.0.1:8081. `PORT` chooses another local port.
The retained browser preview uses a separate temporary design fixture and server.

## Main integration verification

The user requested pushing the completed changes to main. Before integration,
`pnpm run check` passed with 468 tests across 9 suites and all included
typechecks. The remote main reference still matched the original 04586c3 base.
Local agent configurations and browser captures are not part of this change.
