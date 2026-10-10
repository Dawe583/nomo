# Independent verification: are the evidence-integrity fixes actually resolved?

Verifier: independent agent, no stake in the fixes. Date: 2026-09-26.
Working tree at `main`, uncommitted. No source file was modified. Every proof
below is output from a throwaway script run against the current tree, or a
command executed in a scratch `HOME`; the scripts are not part of the repo.

Specification: `docs/EVIDENCE-INTEGRITY-REVIEW.md` (F1–F13).

## Suites run

| Suite | Command | Result |
| --- | --- | --- |
| `packages/ledger` | `node --test` | `tests 71 / pass 71 / fail 0` |
| `packages/cli` | `node --test` | `tests 283 / pass 283 / fail 0` |
| `apps/control-plane` | `node --test` | `tests 174 / pass 174 / fail 0` |
| `apps/desktop` | `node --test apps/desktop/release.test.mjs` | `tests 8 / pass 8 / fail 0` |

The untracked `apps/control-plane/api/verify-key.test.ts` is **not** unfinished.
It parses, all three of its tests run and pass inside the 174, and the suite it
declares (`control plane verification key`) appears in the run log. `pnpm test`
was deliberately not run: other agents are mid-edit in `apps/apple/**`.

---

## Findings

| # | Verdict | Evidence | What remains |
| --- | --- | --- | --- |
| **F1** | **Partially resolved** | The mechanism is unchanged and the attack still lands. Executed: after `unlink`+recreate of the 0400 trust file and replacement of `dev-ed25519.pkcs8`, `resolveVerificationKey` returns `dev-ed25519:a93d… source=trust-file degraded=false operatorSupplied=false`, and a chain re-signed with the attacker's key verifies `ok=true checked=2` while the honest chain fails with `entry 1 has no public key for dev-ed25519:76d8…`. What changed is the labelling: the source is `trust-file`, not `pinned-file`; `operatorSupplied` exists and is `false` at the default path; the same attacker key at `NOMO_TRUST_DIR` reports `operatorSupplied=true`; `degraded` is derived only from private material (`verificationKeyFrom`, `verify-key.ts:137`). `nomo doctor` now names the path and prints the caveat. The API emits `operatorSupplied` and the caveat. The default path was deliberately **not** moved; `verify-key.ts:173-187` says why. | The attack still works, and the two most operator-facing surfaces still call it pinned. `nomo verify` prints `verification key: pinned dev-ed25519:9908… (trust-file)` and does **not** print the caveat (`verify.ts:198` is the only surface still using that wording). `docs/OPERATIONS.md:70-73` still lists the default trust file as "pinned, out of band" and `:77-80` still claims replacing the key file "no longer changes what 'valid' means for anything that verifies against a pin". The TUI headline still reads `Proxy signatures: verified` for a default-path trust file. `degraded: false` is now defensible (it means "no private material", per its own docstring) but the discriminator is `operatorSupplied`, which `nomo verify` does not print. |
| **F2** | **Resolved** | `ProxyWorkspace.refresh` and `runWatchCommand` both call `resolveVerificationKey` with `retainedKeyProvider` (`workspace-proxy.ts:64`, `watch.ts:62`). Executed: the proxy honours the pin and reports `degraded=false` with the caveat; with only the key file substituted the forged chain is refused — `entries=0 errors=["Invalid proxy ledger: poc.jsonl"]`; with nothing configured `signed=false degraded=true` and **files created under the data dir: NONE**. `nomo watch --once` rendered `Verification key: the trust file shares ~/.nomo/ with the signing key, so anyon.` beside the feed. Neither surface calls `devKeyProvider`. | The binary `signed` boolean is still `true` for a default-path trust file (`workspace.ts:2339` renders "verified"). The caveat line is what carries the truth, and it only renders when entries exist. No test covers either surface's degraded rendering. |
| **F3** | **Resolved** | `verificationSummary` returns `authenticated: false, degraded: true` for `source: "none"` (`server.ts:470-494`). Executed over HTTP, all three endpoints: `{"keyId":null,"source":"none","authenticated":false,"degraded":true,"note":"no verification key is configured, so no signature was checked; hash links are intact and nothing is authenticated"}`. `authenticated` is present on the workbench-backed path too (`server.ts:305`). | Nothing found. |
| **F4** | **Resolved** (as an honesty fix; the mechanism is unchanged) | `anchor.ts:1-27` now says "The anchor file is an **anchor set**, not an append-only log" and states that deleting lines satisfies every rule. `checkAnchors`' docstring (`:107-119`) claims only non-decreasing heads and no duplicate head with different hashes. The limitation is pinned as a test: `anchor.test.ts` "deleting anchor lines is NOT caught: a shrink needs a copy held elsewhere". The dead code at `anchor.test.ts:143-144` is gone. | Nothing found. A shrink of the anchor file is still undetectable by design, and is now documented as such rather than claimed otherwise. |
| **F5** | **Resolved** | Executed against a real `listenControlPlane`, nothing configured: `/api/feed`, `/api/ledger/verify` and `/api/ledger/export` all returned **HTTP 200** (was 500), with `signed=false verified=false integrity=true checked=2` and the no-key note. The workbench data directory held only `workspace.key` (the workspace encryption key, created at server construction, present before the reads) before **and** after; **key material created by a read-only GET: NONE**. `Workbench.verificationKey` routes through `retainedSigner()` (`index.ts:1695-1727`) and `server.ts:300` catches the ledger throw. Executed separately: `workbench.ledger(ws)` still throws `No verification key is available for the workspace ledger.`, which is the throw the review turned into a 500 and which the route now absorbs. | The primary workbench-backed branch (`server.ts:302-317`) could not be reached over HTTP without a live provider, so its 200 is argued from the same `handleFeed` that was proved, not observed. It is also still untested (see F12). |
| **F6** | **Resolved** | `runStandalone` returns 1 when no key resolved (`verify.ts:241-245`). Executed: `nomo verify --standalone` with no key printed `verification key: none, signature NOT VERIFIED` / `VERIFIED 2 entries … (hash links only, signature NOT VERIFIED)` / `nomo verify failed: no verification key was resolved, so no signature was checked` and **exited 1**. | Nothing found. |
| **F7** | **Resolved** | `--key` is in `BUNDLE_FLAGS` (`operations.ts:15`) and leads the remedy text. Executed with a real bundle: `export verify --key <recorder's SPKI>` → **exit 0**, `verification key: … (pinned-env)`; `--key <a different key>` → **exit 1**, `Ledger section could not be verified. (entry 1 has no public key for …)`; no key at all → **exit 1**, `A verification key is required: pass --key <base64-spki>, or set NOMO_VERIFY_KEY. Do not run 'nomo init --pin-verify-key' to get one: that mints a key of your own and pins it.` `NOMO_VERIFY_KEY` also works. | The bundle still carries no SPKI, so the reviewer has to be handed the key out of band. The review called embedding it a manifest change and out of scope; it is still out of scope. |
| **F8** | **Resolved** (disclosure), unchanged in mechanism | `pinVerificationKey` records `anchoredFrom`, and `nomo init` gained `--from-spki`. Executed: `nomo init --pin-verify-key` printed the SPKI plus `this anchors whatever the local key file holds right now, and detects only a LATER change to it` / `if the key file was already replaced, this pinned the wrong key; compare the spki above against the key you expect` / `for a key obtained out of band, run 'nomo init --from-spki <base64>' instead`. `nomo init --from-spki <spki>` printed `this key was supplied out of band, so a key file replaced before or after this point is detected`. The docstring at `init.ts:75-89` states it. | The pin is still sticky: `pinVerificationKey` still refuses a different key, and nothing walks the operator through repinning. `OPERATIONS.md` still documents only `nomo init --pin-verify-key`; `--from-spki` appears nowhere outside `init.ts`. |
| **F9** | **Resolved** | `operations.ts:199` passes `verificationLine(verification)` into `describeBundle`, inside the summary block. Executed: `nomo export --bundle` emitted `verification key: dev-ed25519:d641… (trust-file): the trust file shares ~/.nomo/ with the signing key …` above `complete true`. | Nothing found. |
| **F10** | **Partially resolved** | `doctor.ts:110-151` resolves through `resolveVerificationKey` and reports the real source, the path and the caveat. Executed: a valid default-path pin gives `WARN verify-key: dev-ed25519:4ca9… (trust-file) at …/.nomo/trust/verify-ed25519.spki: the trust file shares ~/.nomo/ …` — no longer "unset"; with no key it gives `WARN verify-key: unset; no key at <path>, so no signature is checked`; an out-of-band key is the only `PASS`. | The two documentation contradictions are untouched. `docs/OPERATIONS.md:70-73` still says "pinned, out of band" for the default trust file and `:77-80` still makes the false claim. `packages/security-notes.md` S08 still reads "the server resolves a read-only key from NOMO_SIGNING_KEY or NOMO_VERIFY_KEY" — pre-change, no trust file, no degraded reporting. `NOMO_VERIFY_ALLOW_SIGNING_KEY` appears nowhere in `docs/` or `security-notes.md`; it is still undiscoverable. No test covers the doctor trust-file branch. |
| **F11** | **Resolved** | `readAnchors` returns `AnchorsRead`, never throws (`anchor.ts:64-93`). Executed: a half-written line returned `ok=false reason="anchor line 1 of … is unreadable: …"`; a missing file returned `ok=false reason="the anchor file … is unreadable: ENOENT …"`; `checkAnchors([], [], …)` returned `ok=false reason="the anchor file holds no anchors"`. No exception escaped. | Nothing found. |
| **F12** | **Partially resolved** | Present: the trust-file substitution test (`verify-key.test.ts:161-184`, asserts `operatorSupplied` stays `false` and the source stays `trust-file` after unlink+recreate) and the anchor-shrink limitation test. Removed: the dead `const { appendAnchor: _ignored, … }` lines. The control-plane file parses and its 3 tests pass. | Missing, and the gaps are the ones that let F5 through: **no test reaches the primary workbench-backed API path** (`server.ts:302-317` — the branch that hardcodes `signed: true`); **no test asserts that a read path never mints key material** (I had to prove it by directory listing); no test for the doctor trust-file branch; no test for the watch/proxy degraded note. |
| **F13** | **Not resolved** | Executed. An honest chain (`dev-ed25519:83b8…`) with an honest pin at the default path, then a legitimate key rotation (`rm`+regenerate `dev-ed25519.pkcs8`, new key `dev-ed25519:1c61…`): `nomo attest` → **exit 1**, `cannot attest invalid ledger: entry 1 has no public key for dev-ed25519:83b854b16c5b8d34`. `nomo export --ledger` still succeeds (it does not verify), so the failure lands asymmetrically. `pinVerificationKey` still refuses a different key, so there is no in-command way out. There is no `key_id` allowlist in the pin and no rotation story in the tree. | The whole finding. A rotated key bricks attestation and bundling with an error that names a key id the operator never asked about. |

### Findings whose fix is present but has no test

Worth listing separately because "implemented" and "protected" are different
claims, and the F10.2/F2/F5 fixes currently rest on nothing but the source:

- `doctor.ts:140-150` (default-path trust file → `WARN` with the caveat).
- `workspace-proxy.ts:85-92` and `watch.ts:77-85` (degraded/trust-file notes).
- `Workbench.retainedSigner()` never creating a key.
- `runStandalone`'s non-zero exit is covered by `verify.test.ts`; the rest are not.

---

## What an attacker can and cannot do after these fixes

An attacker with local filesystem write access and agent-level code execution
still cannot forge a chain that verifies against a public key they do not
control: the one-key-id binding is intact, and I confirmed both directions of
it — a chain re-signed with a substituted key is refused by a key taken out of
band (`entry 1 has no public key for …`), while the same chain verifies clean
against the attacker's own key, which is the whole point. They also still
cannot rewrite or truncate a ledger whose anchored prefix is covered by an
anchor set somebody else holds, because the head hash and Merkle root cascade
back through every retained anchor, and they still cannot get a read-only
`GET /api/feed` to mint signing capability or to return a 500 in place of a
shaped refusal, and they can no longer get a CI gate to pass on a chain whose
signatures were never checked. What they can still do is the thing the review
said they could: replace `~/.nomo/keys/dev-ed25519.pkcs8` **and**
`~/.nomo/trust/verify-ed25519.spki` — unlink and recreate, since `0400` stops
a different user, not the owner — re-sign the entire local history, and have it
verify clean. That is now reported as `source: "trust-file"`,
`operatorSupplied: false` and accompanied by a caveat on every surface except
`nomo verify`, which still calls it "pinned", and no documentation that says
so. They can also substitute a trust file at an out-of-tree path and have it
reported as `operatorSupplied: true`, because the code infers that from the
path alone and cannot tell who wrote the bytes. And the honest operator still
has a trap waiting: rotate the signing key and attestation stops working
outright, with no allowlist and no repin path. The net effect of this round of
fixes is that the weakness is *named* rather than *removed* — which is a real
improvement, because the code, the API and `nomo doctor` now say the truth, but
the boundary has not moved. Substitution is detectable only by a holder of a key
obtained out of band and never written to a file the agent can reach; for every
shipped default, the correct status remains the threat model's own sentence,
that the signature proves the bytes came from a process holding a specific key,
and against the agent itself that is worth close to nothing.
