# Security review, adversarial pass 2

## Scope and evidence

Reviewed the WP-15 context pack, commit ecdd151f, ledger storage/signing/
verification/attestation, proxy framing/session/forwarding, policy parsing and
channels, control-plane API, and approval-state changes from wave 5.
This is a targeted source review, not a claim that every repository file or
external dependency received a complete audit.

Threats: hostile upstream MCP server, hostile agent, hostile local user, and
malicious ledger files. A local upstream running as the proxy OS user is not
sandboxed. It can read that user's files. Local development keys cannot protect
against a compromise of that same user.

Native command execution is currently blocked by `bash(): orphan-journal
enrollment failed`. The parent ran RED tests and observed assertion failures. Five targeted fixes
are written; parent-run GREEN tests passed 8/8. Ledger and proxy typechecks
also passed. The RED runner
reported exit 0 despite assertion failures, so GREEN must use TAP and inspect
the failure count. Parent owns full workspace fan-in.

## Findings

| ID  | Severity | Finding and impact                                                                                                                                                                                                                                                               | Status and owner track                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S01 | High     | `ledger/src/store.ts` catches every read error as empty content. A directory at the ledger path makes verification claim a valid zero-entry chain. Permission and I/O failures must not look like absence.                                                                       | Fixed, parent-run regression tests pass; adversarial-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S02 | High     | Store and chain verification do not bind unsigned envelope workspace to signed body workspace. A valid ledger can be copied or relabeled into another workspace, and `attestLedger` will sign that new workspace label.                                                          | Fixed, parent-run regression tests pass; adversarial-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S03 | High     | `proxy/src/forward/tools.ts` returns arbitrary dependency exception text as a denial rationale. A signer/store/policy exception containing a credential reaches the hostile agent.                                                                                               | Fixed, parent-run regression tests pass; adversarial-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S04 | High     | HTTP SSE retains unlimited partial lines. `maxBufferSize` only checks completed `data:` lines, so a stream without newlines or a huge comment can exhaust memory. Empty data lines also consume an unbounded array when delimiters are excluded from the event count.            | Fixed, parent-run regression tests pass; adversarial-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| S05 | High     | Control-plane approval POST accepts cross-origin `text/plain` JSON without Origin or Host validation. A website can send a simple POST to localhost to approve a known or guessed hold. No CORS response header does not prevent this write.                                     | Closed locally on 2026-09-11: JSON content type plus loopback peer, Host, Origin and Fetch Metadata validation, with real HTTP regressions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| S06 | High     | Blast-radius policy trusts agent `rows`, `count`, `limit`, or `n`, including negative values, when no probe exists or a probe fails. The caller can claim a small count to reach an allow rule. This violates the measured-count contract.                                       | Closed locally on 2026-09-11: agent counts never enter policy radius; only nonnegative safe-integer probe measurements are accepted, with real policy regressions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| S07 | Medium   | Unknown/unclassified tools become R3 but can still pass a broad allow rule. R3 substitution alone is not unconditional denial.                                                                                                                                                   | Fixed: the shared decide path now carries an unclassified flag from the proxy classifier, and an allow rule never matches an unclassified call unless the rule explicitly lists class unknown. Deny and hold rules still match. Policy and proxy regression tests prove a broad allow, a class r3 allow, and a tool-pinned allow all refuse unclassified calls while explicit unknown allows still work                                                                                                                                                                                                                                                                                                  |
| S08 | High     | Feed/API and SDK verification paths call `verifyChain` without a key, then expose `verified: true` or accept startup. A locally rewritten and rehashed ledger can pass without a valid signature.                                                                                | Fixed for the control-plane surfaces: readLedgerFeed accepts a public key lookup, the server resolves a read-only key from a trust file or `VOID_VERIFY_KEY` (never generates one and never reads the private key file), and both /api/ledger/verify and /api/feed report `verified` only when signatures were checked, with `integrity` and `signed` stated separately. The UI shows an integrity-only badge when no key is configured. A regression test rewrites and rehashes a ledger and proves the attack fails with a key and is honestly downgraded without one. The CLI verify path already took a key; SDK startup acceptance closed in the small SDK followup. **The trust file is not a pin, and the row above overstated that.** The default trust file is `~/.void/trust/verify-ed25519.spki`, which shares a tree with the private key, and mode `0400` stops an in-place write by a different user and stops nothing for its own owner, who may unlink and recreate it. Substituting the trust file and the signing key together is silent; the attack was executed and the forged chain verified `ok=true`. So the resolution now reports `source: "trust-file"` and `operatorSupplied: false` rather than calling it pinned, every surface carries the caveat, the API returns `substitutionDetected` beside `authenticated`, and `VOID_VERIFY_ALLOW_SIGNING_KEY` (previously documented nowhere) is named in the degraded note and in `docs/OPERATIONS.md`. Substitution remains detectable **only** by a holder of a key obtained out of band; for every shipped default the signature proves the bytes came from a process holding a specific key and little more. See `docs/OPERATIONS.md` §"The verification key is not the signing key" and `docs/THREAT-MODEL.md` §2.4. |
| S09 | Medium   | Signature verification accepts any next key returned by an injected lookup. There is no outgoing-key-signed rotation transition or validity-window enforcement. The default dev provider only recognizes its single key, so arbitrary attacker keys are not accepted by default. | **Not resolved, and deliberately not built.** A rotation needs a trust *set* in the pin rather than one SPKI, a decision about whether pre-rotation entries are re-signed or left readable, an anchor/attestation story for keys an existing anchor already names, revocation distinct from acceptance, and a `void` command that prints what it is about to stop trusting. Each changes a persisted artifact or a trust decision, so none is a small obviously-correct change. Concretely today: rotating `dev-ed25519.pkcs8` makes `void attest` exit 1 with `entry N has no public key for <old id>` while `void export --ledger` still succeeds, and `pinVerificationKey` refuses a different key, so there is no in-command way out. The full write-up, including why each piece is required, is `docs/OPERATIONS.md` §"Key rotation". The one-key-id binding is intact meanwhile: a chain signed by a key the verifier does not hold is refused, not verified. |
| S10 | Medium   | Notification relaying and stdout writes have no backpressure. A valid progress flood can grow the output queue even after SSE framing is bounded. Agent stdin uses readline before the line ceiling, so an unterminated inbound line can also grow without limit.                | Fixed: agent stdin now reads raw chunks through the bounded ReadBuffer instead of readline, so an unterminated line past the cap throws a named input error and ends the session after one Invalid Request. Relayed upstream content passes a per-message outbound ceiling and is dropped with a named ProxyOutputError reason; the default stdout writer refuses lines past a buffered-bytes queue cap. Locally generated errors bypass the relay cap so small-cap configs cannot self deny, and the queue guard still applies to every line. Regression tests cover both ceilings, the queue guard, stdin framing, and the relay drop path                                                             |
| S11 | Medium   | Session coerces numeric strings, so `1`, `"1"`, and `"01"` collide. It accepts unsafe integers and retains used IDs forever. The runProxy server-request relay receives Session but not its nested maps, so server response remapping is not recorded.                           | Fixed the coercion root cause: session ids stay typed end to end, server-originated string ids never become their numeric lookalike, inbound cancellation translates typed request ids, and the relay path records typed server-request mappings through a new recordServerRequest hook. Session regression tests prove 42 vs "42" vs "01" route independently and string response ids drop as unknown. Unsafe-integer rejection, used-ID retention bounds, and the bin response remapping lookup remain open followups                                                                                                                                                                                  |
| S12 | Medium   | Policy validator can throw on `rules: [null]`, accepts empty array match as catch-all, and accepts invalid class values. Null validation throws before the documented typed load error. YAML parser error text can include source snippets in startup logs.                      | Closed locally on 2026-09-11: null and array rules and matches, invalid classes and thresholds return load errors; YAML diagnostics omit source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| S13 | Medium   | Ledger readers load entire files into memory. A malicious multi-GB file can exhaust CLI, SDK, or control-plane memory.                                                                                                                                                           | Flagged for replay-registry/parent ledger owner; bounded streaming parser or explicit size ceiling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| S14 | Medium   | Slack webhook URL is operator-configured but has no HTTPS/host/redirect policy, and response bodies enter failure messages. Policy rationale is intentionally shown to the agent and Slack, so it must never contain secrets.                                                    | Flagged for parent/policy channel owner; operator input is not a remote-user SSRF boundary today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| S15 | Medium   | Local upstream inherits the proxy environment, including `VOID_SIGNING_KEY` if configured. Same-user local processes can also read development key files.                                                                                                                        | Fixed the inheritance root cause: bin cleanEnv allowlists inherited variables, and spawnUpstream now deletes VOID_SIGNING_KEY from the child environment even when explicitly provided, so a local upstream can never sign ledger entries. A regression test spawns a real child with the key set and proves it arrives unset. Same-user key-file readability remains out of scope: no OS isolation is claimed and the finding is documented as defense in depth only. No doctor change was needed: doctor never spawns an upstream                                                                                                                                                                      |
| S16 | Medium   | Approval persistence originally trusted existing directory permissions and symlinks despite creating new paths with 0700. Existing public-write directories do not become private through recursive mkdir.                                                                       | Owner reports directory/file mode, symlink, and 1 MiB checks added. Refusals are now named rather than generic: `classifyPosixApprovalState` and `inspectApprovalStateDirectory` return an `ApprovalStateVerdict`, and `ApprovalStateUnsafeError` carries a fixed `ApprovalStateCode` while its message deliberately omits the path, the account and anything icacls printed. POSIX still judges mode bits and uid, unchanged. Windows, where those bits are meaningless, judges the DACL read through the shipped icacls binary and narrows a directory it can claim to the operator before accepting it; a proven foreign write grant is never acknowledgeable, and anything unproven is `unverifiable` and refused unless the host names the finding and accepts it. Verified on POSIX; the Windows DACL branch requires a Windows host and has no observed coverage yet (see `REVERSE-UPGRADE-PROGRESS.md`).                                                                                                                                     |

## Fixed-now scope

- Only ENOENT becomes empty ledger content. Other read errors propagate.
- Store verification binds requested workspace, envelope, and signed body.
  Chain verification binds envelope to signed body. Attestation creation rejects
  an input workspace different from its requested workspace.
- Dependency failures return a generic denial, without raw exception text.
  Raw text is not copied into logs either, because it can contain secrets.
- SSE rejects oversized completed and partial lines, including comments. Empty
  data lines count toward the event budget. Refused readers are cancelled.
- Agent radius fallback accepts only nonnegative safe integers. Existing valid
  positive fallback and authoritative probe behavior stay unchanged.

## Checks that did not establish a vulnerability

- JSON.parse consumes the entire framed message. Two JSON objects on one line
  are rejected, not parsed as a first object plus a hidden second request.
  Newline-separated objects are separate MCP messages, as intended.
- Entry signature tag, entry algorithm, and signed preimage algorithm are
  checked on authenticated verification. Unsupported algorithms fail. A
  multi-algorithm provider and rotation remain unsupported, not silently valid.
- Merkle pairs preserve input order. Reversing two distinct hashes changes the
  digest. Duplicating an odd terminal leaf is standard here; the signed
  attestation also binds entry count and head. This is not an unordered-set
  digest.
- Attestation signature binds its workspace. `verifyAttestation` compares that
  workspace to entry envelopes. The S02 gap is the missing binding from those
  envelopes back to signed bodies and to the workspace being attested.
- Installed YAML source sets `maxAliasCount` to 100 and rejects excess alias
  expansion. Billion-laughs protection is not disabled. Policy text still has
  no file-size ceiling.
- Operator-selected `--policy ../../path` is not a path-containment boundary.
  It is an intentional ability to choose a local file, not remote traversal.
- Control-plane request bodies already have a 64 KiB ceiling. Oversize or bad
  JSON currently returns an internal error rather than a precise 413/400.
  Static paths use decoded-path containment; no URL traversal escape found.
  Static symlinks remain trusted deployment content.

## Verification evidence

Parent ran `node --test packages/ledger/src/security.test.ts packages/proxy/src/security.test.ts`
after the fixes and reported exit 0 with this tail:

```text
tests 8
pass 8
fail 0
```

Parent also ran the complete affected package suites and typechecks:

```text
TSC_LEDGER=0
TSC_PROXY=0
security suites: tests 8, pass 8, fail 0
ledger full: pass 49, fail 0
proxy full: pass 79, fail 0
```

These are parent-run results because this child could not start native commands.
The full workspace fan-in is separate.

## Verification commands

From repository root, before and after fixes:

```sh
node --test --test-reporter=tap packages/ledger/src/security.test.ts packages/proxy/src/security.test.ts
CI=true npx tsc -p packages/ledger/tsconfig.json
CI=true npx tsc -p packages/proxy/tsconfig.json
```

The parent must run the complete package and e2e suites after all tracks land.
No dependency was added. No authentication, rotation, parser-format, or
approval-queue contract was silently redesigned by this review.

---

# Security review, adversarial pass 3

Wave 5 shipped new surface (cross-process approvals, policy packs, replay
registry, control-plane pages), so this pass went after it with hostile intent
and no code trusted from the previous pass. Every check below was executed
against the shipped source, not inferred from tests.

## Scope and evidence

- `packages/policy/src/approvals.ts`: state directory reads and writes,
  decision files, token binding, expiry, the in-use lock.
- `packages/proxy/src/approval-loop.ts`: the pump, watcher, fail-closed paths,
  hold registration races.
- `packages/policy/src/packs.ts`: policy pack loading.
- `packages/cli/src/replay.ts`: environment handling around `VOID_PG_URL`.
- `apps/control-plane/web/app.js` plus the four pages: injection surfaces.

## Checks that did not establish a vulnerability

- Decision file planting. `assertPrivateFile` uses `lstat`, so a symlink in
  `decisions/` fails the regular-file check before any read follows it. On POSIX
  the mode and uid checks bound both the permission and the owner; on Windows
  the evidence is the containing directory's DACL verdict rather than mode bits
  that do not exist there, so a file the operator's own directory already
  protects is not re-read per file. The unlink
  in `consumeDecisions` happens in a `finally`, so a hostile or stale file
  cannot accumulate or survive as a replay source.
- Double decision. Two operators approving the same hold concurrently both
  see it pending, both write decision files, and the first consumed file
  decides; the second is dropped because the status is no longer pending and
  the decision call is idempotent by status, not by file count. The recorded
  decision is the first write, which is the only ordering an approval can
  promise.
- TOCTOU on expiry. `writeDecision` re-checks `expiresAt <= now()` at decision
  time from the pending record it just re-read, so a decision written for a
  hold that expired between load and write is refused.
- Hold registration race in `newestHold`. `queue.hold` is synchronous through
  `register`, and JavaScript cannot interleave two synchronous runs, so the
  newest hold for a tool at registration time is the one this call just
  created. Two sequential holds each bind their own record.
- Pump failure containment. The fail-closed path closes the active queue, then
  expires every hold with `Infinity` so nothing is left pending on a broken
  disk, and each step swallows only the errors of the steps after it, which
  means a failure in diagnostics cannot undo the refusal.
- Pack path traversal. `loadPack` accepts only the frozen `PACK_NAMES`
  allowlist before any `join`, so `../` in a name fails as an unknown pack.
  The YAML files are shipped with the package, so a hostile YAML implies write
  access to the package, which implies code execution already.
- Credential leak through replay errors. `VOID_PG_URL` can carry a password,
  but the CLI only ever says "set" or "unset"; the value itself never reaches
  an error message, a replay record, or stdout.
- UI injection. Every dynamic value in `app.js` flows through `escapeHtml`
  (all five HTML metacharacters) including attribute contexts such as
  `data-hold-id`, the decision URL encodes the hold id with
  `encodeURIComponent`, and the one `innerHTML` sink receives only strings
  built from those escaped renderers. The decision POST sends
  `content-type: application/json`, which is the same gate the CSRF fix
  requires, so the UI cannot be locked out by its own guard.

## Findings

None new. Two data defects were found by the registry audit pass in the same
wave and fixed with it: the unmigrated `mysql.table.truncate` case and the
over-optimistic `stripe.subscription.delete` fallback, both recorded in the
registry commit.

## Verification commands

```
CI=true node --test packages/policy/src/*.test.ts
CI=true node --test packages/proxy/src/*.test.ts
CI=true node --test apps/control-plane/web/*.test.mjs apps/control-plane/api/*.test.ts
```

The parent ran the full workspace fan-in after this pass: 451 checks, zero
failures.

## Local continuation, 11 September 2026

The previous control-plane S08 closure was incomplete: `/api/feed` still returned
`verified: true` without a key. The endpoint now returns `verified: signed` and
an explicit `integrity: true`; the web client can display integrity-only feeds
without claiming signature verification. Signed and unsigned server responses,
forged-ledger refusal and integrity-only rendering are regression tested.

S05 tests use node:http to send hostile Host headers. Node fetch ignores the
attempted Host override in this environment, which initially made that test
exercise a legitimate local request. Direct HTTP proves rebinding rejection.
Both reads and decision writes are checked; the broker receives no denied
request. Same-origin decisions still reach it. Internal errors no longer echo
arbitrary dependency exception text into API responses.

No cross-user authentication or OS process isolation is claimed. S07,
S09 through S11, S13 through S15 retain their stated boundaries and followups.

### SDK S08 followup

SDK startup now passes the proxy's development signer public-key lookup into
`verifyLedgerFile`. The shared verifier rejects forged signatures and unknown
key IDs before any upstream process starts. Three regression cases cover a
trusted ledger, altered content with a recomputed valid hash, and an otherwise
valid ledger signed with a separate key. The latter two passed hash-only
verification and failed the new startup assertions before the fix; after it,
all 9 SDK tests pass. SDK typechecking and the whole-product arc also pass.
No key-rotation or protection against compromise of the signing host is claimed.
