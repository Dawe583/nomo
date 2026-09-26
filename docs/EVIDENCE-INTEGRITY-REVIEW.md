# Independent hostile review: evidence-integrity change

Reviewer: independent agent, no stake in the change. Date: 2026-09-26.
Working tree at `main`, diff against `HEAD`.

Every finding below is labelled **[CONFIRMED]** (I constructed the scenario and
ran it; the quoted output is real) or **[SOURCE]** (established by reading the
code, not executed). I did not modify any source file. Proof-of-concept
scripts were throwaway and have been deleted; nothing was committed.

Test suites run, all green: `packages/ledger` 69/69, `packages/cli` 283/283,
`apps/control-plane` 174/174.

---

## Summary of what the change actually achieves

The core mechanism is real and I tried hard to break it. A pinned public key
bound to exactly one key id (`pinnedKey`, `verify-key.ts:115-122`) does make key
substitution detectable, and `verifyAnchor` genuinely catches a truncated or
rewritten chain as long as an anchor covering the rewritten prefix survives —
I confirmed both. The threat model's §5.3 diagnosis was correct and the fix is
the right shape.

The serious problems are all in the *labelling and the reach* of the fix, not
in the cryptography:

1. The thing called "pinned" is a file in the same directory tree as the key it
   is supposed to anchor, and it reports itself as the safe path. Replacing both
   is silent and total. **[CONFIRMED]**
2. Two shipped verification surfaces — the TUI and `void watch` — were never
   converted, and both report success while using the private key file. **[CONFIRMED]**
3. `verificationSummary` reports `degraded: false` when nothing was authenticated
   at all. **[CONFIRMED]**
4. The anchor file's own truncation is undetectable, and the operator-visible
   output is identical to the honest case. **[CONFIRMED]**
5. The documentation tells operators the pin is "out of band". It is not, and
   `void doctor` reports a fully-pinned host as unconfigured. **[CONFIRMED]**

---

## F1 — CRITICAL. The "pinned" trust file is not out of band, and it reports itself as the safe path

`packages/ledger/src/verify-key.ts:94-113` (`pinnedKeyFile`),
`packages/ledger/src/verify-key.ts:161-166` (the `pinned-file` branch).

The pinned key is stored at `~/.void/trust/verify-ed25519.spki`. The signing key
is at `~/.void/keys/dev-ed25519.pkcs8` (proxy, `sign.ts:66`) or
`~/.void/workbench/keys/dev-ed25519.pkcs8` (workbench, `index.ts:1405`). The
common ancestor is `~/.void/`. The module comment at `verify-key.ts:90-93`
claims the separation is deliberate — *"deliberately not under `~/.void/keys/`
next to the private key: a trust anchor reachable by taking the key file is not
an anchor"* — and `docs/OPERATIONS.md:73` puts it in a column headed
**"pinned, out of band"**. Neither is true of an attacker who has filesystem
write access to the data directory, which is the exact attacker the change
targets.

### Attack

1. Operator runs the documented setup, `void init --pin-verify-key`. Trust file
   exists at `~/.void/trust/verify-ed25519.spki`, mode `0400`, containing the
   honest SPKI. `resolveVerificationKey` returns
   `{source: "pinned-file", degraded: false}`. Correct so far.
2. Attacker (malware as the user, or agent-level code execution) generates an
   ed25519 keypair of their own and writes the public half to a scratch file.
3. Attacker `unlink`s the trust file and re-creates it with their SPKI. The
   `0400` mode is irrelevant: it blocks *in-place* `writeFile` (I confirmed that
   fails with `EACCES`) but not `unlink` + `create`, which any owner of the
   containing directory may do. File mode is an access control against other
   users, not against the owner.
4. Attacker replaces `~/.void/keys/dev-ed25519.pkcs8` with their private key.
5. Attacker rewrites the ledger with whatever body they like and re-signs the
   whole chain. `entryHash` + `signingPreimage` are three lines
   (`canonical.ts:94-105`, `index.ts:69-77`), so this is trivial.
6. Any VOID verifier — CLI, workbench, control-plane API — resolves the
   attacker's key and reports the forged chain as fully valid.

### What I observed **[CONFIRMED]**

```
operator-pinned trust file mode: 400
after honest pin  -> dev-ed25519:a840eb412fe97669 pinned-file degraded: false
attacker key id  -> dev-ed25519:97b4e1e3e4089142 (honest: dev-ed25519:a840eb412fe97669)
attacker overwrote both ~/.void/keys/ and ~/.void/trust/
after attack     -> dev-ed25519:97b4e1e3e4089142 pinned-file degraded: false
forged chain verifyChain -> true
with the honest pin       -> false entry 1 has no public key for dev-ed25519:97b4e1e3e4089142
```

The last line is the part that matters: the mechanism is good, and the attacker's
only problem is that they had to update a second file — which is one extra step,
reported nowhere, and which the documentation tells the operator is impossible.

### What the user or operator observes

Nothing. The CLI prints `verification key: pinned dev-ed25519:97b4... (pinned-file)`.
The API returns `verification: {source: "pinned-file", degraded: false}`. The
trust file is still `0400` and still parses. `void doctor` is silent on the pin
entirely (F10). The forged chain verifies clean and is presented as the
strongest possible evidence — better than the honest chain, which now fails.

### Smallest correct fix

Three parts, all small:

- The trust file must not be described or reported as "pinned". Introduce a
  distinct `source` (`"trust-file"`) and a separate boolean
  (`operatorSupplied`) that is only ever true for `VOID_VERIFY_KEY` /
  `VOID_VERIFY_KEY_FILE` configured out of band. Never derive `degraded: false`
  from the fact that a file was read.
- Move the default trust path out of `~/.void/` (e.g. `~/.config/void/trust/`)
  and, at minimum, state in `verify-key.ts` and `OPERATIONS.md` that this mode
  defends only against an attacker who can reach the *ledger* but not the home
  directory — the same caveat the anchor file already gets at `anchor.ts:9-15`.
- Keep the O_EXCL/0400 provisioning as is. It is correct; it is just not an
  anchor against a same-uid writer, and the code should say so where the code
  currently claims the opposite.

---

## F2 — HIGH. Two shipped verification surfaces were not converted; both silently use the private key file and both report success

`packages/cli/src/tui/workspace-proxy.ts:44-66`,
`packages/cli/src/watch.ts:51-52`.

Neither file is in the diff. Both are user-facing verifier surfaces and both
still resolve the verification key from `dev-ed25519.pkcs8`:

- `ProxyWorkspace.refresh()` prefers `VOID_VERIFY_KEY`, else `VOID_SIGNING_KEY`,
  else reads `~/.void/keys/dev-ed25519.pkcs8` directly with `readFile`. It
  **never consults the trust file**, so an operator who did exactly what
  `OPERATIONS.md` tells them to do gets no benefit. It then sets
  `this.signed = publicKey !== undefined` (`workspace-proxy.ts:84`), and the TUI
  renders that as `Proxy signatures: verified` (`workspace.ts:2339`) and
  `Signatures checked against the configured key` (`live.ts:38`).
- `watch.ts:51` calls `devKeyProvider()` with no options at all — no `env`, no
  `dir` — so it reads the real `~/.void/keys`, ignores `VOID_VERIFY_KEY` and the
  trust file, **mints a key if none exists** (`sign.ts:67` defaults
  `createIfMissing` to `true`), and prints no degraded notice anywhere.

### Attack

Identical to F1 step 5, minus the second file: the attacker replaces only
`~/.void/keys/dev-ed25519.pkcs8`, re-signs the chain, and opens the TUI or runs
`void watch`.

### What I observed **[CONFIRMED]**

```
operator pinned: dev-ed25519:... at /tmp/.../home/.void/trust/verify-ed25519.spki
attacker key installed at ~/.void/keys/, chain re-signed

TUI ProxyWorkspace.signed      : true   <- TUI renders this as 'Proxy signatures: verified'
TUI entries loaded             : 2 entries
TUI errors                     : []
pinned key actually used?      : no -- ProxyWorkspace reads the private key file and never looks at the trust file

void watch  feed.signed : true  using keyId dev-ed25519:dfde6a43574d8756
void watch  records shown: 2  (incl. the forged aws.s3.object.put)
```

Note this is *worse* than the pre-change state on the TUI: the operator has now
been given a documented mechanism that looks like it protects them and does
nothing there.

### Smallest correct fix

Have both call `resolveVerificationKey` with the same options the other
surfaces use, and render `DEGRADED_VERIFICATION_NOTE` wherever they currently
render the binary `signed` boolean. For `ProxyWorkspace` that is a ~10-line
replacement of lines 44-66 plus a `degraded` field alongside `signed`; for
`watch.ts` it is one call plus one line of output. Both should use
`retainedKeyProvider`, not `devKeyProvider`, so the read path stops minting
(also F5).

---

## F3 — HIGH. `verificationSummary` reports `degraded: false` when nothing was authenticated

`apps/control-plane/api/server.ts:410-418`:

```ts
function verificationSummary(options: RouteOptions): JsonObject {
  const key = options.verificationKey;
  if (!key) return { keyId: null, source: "none", degraded: false };
  ...
}
```

The brief requires that the degraded state be machine-distinguishable. This is
the one boolean a consumer would check, and for the *most* alarming state —
no key, nothing verified — it says `false`.

### What I observed **[CONFIRMED]**

```
/api/ledger/verify: verificationKey = {"keyId":null,"source":"none","degraded":false}  signed = false
/api/feed:          verificationKey = {"keyId":null,"source":"none","degraded":false}  signed = false
```

`signed: false` is the honest signal, and `degraded: false` actively contradicts
it in the same object. Any client written as
`if (!body.verificationKey.degraded) trust()` — the obvious way to consume this
API — inverts the meaning in exactly the case where it matters.

### Smallest correct fix

Add an explicit `authenticated: boolean` to `verificationSummary` and to the
inline block at `server.ts:288`, and set `degraded` from its actual meaning
(private key material was involved) in both places. If `degraded` must keep its
current two-value shape for compatibility, return `degraded: true` for
`source: "none"` — it is strictly safer to over-report degradation.

---

## F4 — HIGH. Anchor-file truncation is undetectable and the operator-visible output is identical to the honest case

`packages/ledger/src/anchor.ts:66-68` (docstring) and `:95-110` (the checks).

The docstring claims:

> All of them are checked, not only the newest: a prefix that was rewritten
> after the first anchor was taken is caught by that first anchor, and a
> rewritten *anchor file* is caught by the ordering and head rules below before
> any signature is trusted.

The second clause is false. `checkAnchors` enforces `headSeq` non-decreasing
and rejects two anchors claiming the same head with different hashes — but only
across the anchors **still present in the array**. An attacker who deletes lines
satisfies both rules trivially. Nothing in the file records how many anchors
there were, so a shrink is invisible.

### What I observed **[CONFIRMED]**

Ledger of 6 entries, anchors taken at head 3 and head 5:

```
A) full anchor file                -> true  head 5 grown 1
B) first anchor line deleted       -> true  head 5 grown 1 (1 anchors)
C) anchor file emptied             -> false the anchor file holds no anchors
D) entry 1 rewritten + old anchor dropped -> false anchor 5: entry 5 is 8ba3..., the anchored head was 65cd...
E) same rewrite, anchor file INTACT -> false anchor 3: entry 3 is 45c7..., the anchored head was 7c20...
F) entry 6 (post-anchor) rewritten -> true  head 5 grown 1
```

A and B are identical apart from an attacker-controlled counter. Only the
completely-emptied file (C) is caught. D and E confirm the mechanism itself is
sound: a rewritten ledger *is* caught whenever an anchor covering the rewritten
prefix survives, because the head hash and Merkle root cascade. F is inherent to
any anchor scheme and is honestly described at `attest.ts:170-176`.

### Smallest correct fix

This is a naming and honesty fix, not a mechanism fix. Rename the concept from
"append-only anchor file" to "anchor set", reword the docstring to say exactly
what is enforced (contradiction among retained anchors, plus coverage of the
ledger prefix), and rename the misleading test at `anchor.test.ts:139`
("a rewritten anchor file is refused before any signature is trusted" — it only
covers the duplicate-head shape). If a shrink must be detectable, the count and
head have to be compared against something held elsewhere, which is the same
"keep a copy you control" caveat the CLI already prints at
`operations.ts:157`.

---

## F5 — MEDIUM-HIGH. The read path mints a signing key, and the primary API path returns HTTP 500 instead of a clean refusal

`apps/control-plane/api/server.ts:286-293`,
`packages/workbench/src/index.ts:1700-1710`.

`Workbench.verificationKey` passes `allowDegraded: true` with a `signingKey`
thunk of `devKeyProvider({dir: join(this.storage.directory, "keys"), env})` —
with `createIfMissing` defaulting to `true` (`sign.ts:67`). So the
workbench verification path still mints signing capability, the same footgun
`docs/THREAT-MODEL.md` §5.4.1 called out. The fix was applied to
`cli/verify.ts`; the HTTP API's verifier was left.

In `route()`, the inline block awaits `options.workbench.ledger(workspace)` with
no `try`/`catch`. `ledger()` throws `"Workspace ledger signature
verification failed."` when the chain cannot be authenticated, so the request
becomes `HTTP 500 {"error":"internal_error"}` and never reaches `handleVerify`,
which has a properly-shaped failure response.

### What I observed **[CONFIRMED]**

```
(a) no pin, no VOID_SIGNING_KEY -- a plain GET /api/feed:
      /api/feed?workspace=poc           -> HTTP 500 {"error":"internal_error",...}
      /api/ledger/verify?workspace=poc  -> HTTP 500 {"error":"internal_error",...}
      /api/ledger/export?workspace=poc  -> HTTP 500 {"error":"internal_error",...}
   !! a signing key was CREATED by a read-only GET: 600 48 bytes
```

A plain unauthenticated `GET /api/feed` created a fresh 0600 ed25519 private
key on disk. Both 500s and the key creation are real.

### Response-shape divergence **[SOURCE]**

The same endpoint has two shapes:

| | primary (`server.ts:290-292`) | fallthrough (`server.ts:439-470`) |
|---|---|---|
| field name | `verification` | `verificationKey` |
| `signed` | hardcoded `true` | `feed.signed` (derived) |
| reachable when | workbench has a workspace | no workspace / no entries |

`/api/ledger/export` in the primary block (`server.ts:294-295`) returns the
entries with **no provenance field at all**. I confirmed the 500s above; the
200-with-`signed:true` shape on the primary path is **[SOURCE]** only, because
every path I could construct threw.

### Smallest correct fix

- `Workbench.verificationKey`: use `retainedKeyProvider` (or pass
  `createIfMissing: false`) for the `signingKey` thunk. A verifier must not mint.
- Wrap the `workbench.ledger()` call in `route()` so a verification failure
  falls through to `handleFeed`/`handleVerify` and returns the shaped refusal.
- Return one shape from both paths, and include the verification block in
  `/api/ledger/export`.

---

## F6 — MEDIUM. `void verify --standalone` exits 0 when signatures were not verified

`packages/cli/src/verify.ts:236-244`.

`runStandalone` returns `0` whenever the child process exits 0, and the
standalone script prints `signature NOT VERIFIED` *and exits 0*. The change makes
"nothing configured" the **default** state of any install that has not pinned a
key, so this stopped being an edge case and became the normal outcome.

### What I observed **[CONFIRMED]**

```
=== void verify --standalone with NO key (nothing pinned) ===
  exit code: 0
  | verification key: none, signature NOT VERIFIED
  |   pin one with `void init --pin-verify-key`, or set VOID_VERIFY_KEY to a base64 SPKI public key
  | VERIFIED 2 entries, head 0557... (hash links only, signature NOT VERIFIED)
```

The text is honest; the exit code is a false pass for any script, CI gate, or
`set -e` wrapper.

### Smallest correct fix

In `runStandalone`, return 1 when `key.publicKey === undefined` (the parent
already knows it resolved nothing), or make the child exit non-zero when it
prints `signature NOT VERIFIED`. Keep the existing text; it is the right text.

---

## F7 — MEDIUM. `void export verify` is unusable on a clean reviewer machine, and its error message gives the wrong remedy

`packages/cli/src/operations.ts:100-110`.

This is a reviewer-side command run by someone holding a bundle, not a local
ledger. It previously fell back to `devKeyProvider({env})`; it now requires a
configured key.

### What I observed **[CONFIRMED]**

```
=== void export verify on a clean reviewer machine ===
  THREW: A verification key is required: set VOID_VERIFY_KEY, or pin one with `void init --pin-verify-key`.
```

`--pin-verify-key` is the wrong advice for a reviewer: on their machine it runs
`pinVerificationKeyFromSigner`, which mints a *new* key of the reviewer's own
and pins that. It matches nothing and will fail confusingly later. There is also
no `--key` flag on `export verify`, though `void verify --key` exists
(`verify.ts:130-134`), and the bundle does **not** carry the SPKI — I checked
`export-bundle.ts`: no created section contains a public key, so a reviewer has
no in-band way to obtain the right one.

This is not a security hole, but it is a real regression against the
brief's "safe path by default" in the only sense an operator experiences: the
safe path does not work. Pressure to route around it will push people back to
the old behaviour.

### Smallest correct fix

Accept `--key base64-spki` on `export verify` (the parser already exists in
`verify.ts`), add it to `BUNDLE_FLAGS`, and change the remedy text to name
`--key` first. Optionally embed the SPKI in a new, clearly-optional bundle
section so the reviewer can lift it — but that is a manifest change, so it is
out of scope for this change.

---

## F8 — MEDIUM. The trust anchor is bootstrapped from the untrusted source it is meant to anchor, and the result is sticky

`packages/ledger/src/verify-key.ts:268-288`, called from
`packages/cli/src/init.ts:66-76`.

`pinVerificationKeyFromSigner` derives the pin from
`<dataDir>/keys/dev-ed25519.pkcs8`. If that file was replaced before the
operator ever ran `void init --pin-verify-key`, the attacker's key becomes the
permanent trust anchor. `pinVerificationKey` (`:255-263`) then *refuses* to
change it: `"a different verification key is already pinned at ... remove it
deliberately to repin"`. The poisoning is therefore sticky, and the operator who
pinned it was told nothing.

**[SOURCE]** — I established the code path and the sticky-refusal behaviour from
the source; I did not construct a full end-to-end "replace key file, then pin"
scenario, because the outcome is unambiguous: the pin is a pure function of
whatever the key file held at pin time.

This is also the one place where the change is weaker than the analysis it came
from. `docs/THREAT-MODEL.md` §5.3 required *"a pinned, **independently
obtained** public key"*. The shipped first-run path derives it from the same
file the anchor is supposed to make trustworthy.

### Smallest correct fix

Make `--pin-verify-key` print the SPKI and state plainly that it anchors
whatever the local key file holds *at this moment* and detects only subsequent
substitution. Add an explicit `--from-spki <base64>` for the genuinely
out-of-band case, and mention that in `OPERATIONS.md`.

---

## F9 — MEDIUM. `void export --bundle` verifies with the recorder's own signing key and reports nothing

`packages/cli/src/operations.ts:128-133` and `:148-160`.

The shared path resolves `resolveVerificationKey({env, allowDegraded: true,
signingKey: async () => signer})` and verifies with it. The `DEGRADED` line is
printed in the `attest` branch (`:141`) and the `export verify` branch (`:120`)
— but **not** in the `export --bundle` branch, which prints only
`describeBundle(created)`, and `describeBundle` (`export-bundle.ts:866-878`)
contains no key line.

**[SOURCE]** — read from source; I did not execute `void export --bundle`. The
new test file `packages/cli/src/evidence-integrity.test.ts` covers `attest` and
`verify` but not `--bundle`, so nothing catches this either.

### Smallest correct fix

Emit the same one-line DEGRADED report from the `--bundle` branch. Three lines.

---

## F10 — MEDIUM. Documentation and status surfaces contradict the code

Four separate places, three of them confirmed by execution.

1. **`docs/OPERATIONS.md:73`** lists `~/.void/trust/verify-ed25519.spki` as
   **"pinned, out of band"**, and `:90-92` states that replacing
   `dev-ed25519.pkcs8` *"no longer changes what 'valid' means for anything that
   verifies against a pin."* Both are false per F1. The default trust file and
   the default key file share the ancestor `~/.void/`. This is the operator's
   only guide to whether the mechanism protects them and it overstates the
   protection in the one direction that causes harm.
2. **`packages/cli/src/doctor.ts:104-108`** checks only `env.VOID_VERIFY_KEY`.
   **[CONFIRMED]** with a valid trust file pinned:
   ```
   trust file pinned at: ~/.void/trust/verify-ed25519.spki
   WARN verify-key: unset; proxy entries show hash integrity only
   doctor: 5 pass, 1 warn, 0 fail
   ```
   The one command whose job is "is this host set up safely" reports a
   fully-pinned host as unconfigured, and never mentions the pin exists.
3. **`packages/security-notes.md:34` (S08)** still describes the pre-change
   resolution — *"the server resolves a read-only key from `VOID_SIGNING_KEY` or
   `VOID_VERIFY_KEY`"*. It was not updated for the trust file, the degraded
   reporting, or the removal of the private-key-file read.
4. **`VOID_VERIFY_ALLOW_SIGNING_KEY`** (`verify-key.ts:38`,
   `DEGRADED_KEY_ENV`) is the one explicit opt-in that unlocks the key-file
   path, and it appears **nowhere** in `docs/` or `security-notes.md`. An
   operator cannot discover it. It is at least correctly named and it does set
   `degraded: true`, so the mechanism is sound; only the documentation is
   missing.

### Smallest correct fix

Correct `OPERATIONS.md` to match F1's fix. Make `doctor` resolve through
`resolveVerificationKey` and report the real `source` and `degraded` state plus
the trust-file path. Update S08. Document the env var in the same table as the
others.

---

## F11 — LOW. `readAnchors` throws instead of returning a failed check

`packages/ledger/src/anchor.ts:44-51`. A malformed or partially-written line
makes `readAnchors` throw, so `checkAnchors` is never reached and a caller
expecting an `AnchorCheck` gets an exception; the CLI's top-level catch turns it
into exit 1 with a raw `JSON.parse` message. It fails closed, so this is API
consistency and diagnosability, not a bypass. **[SOURCE]** — I did not construct
a partial-line case.

Fix: have `readAnchors` return the line index with a failed result, or document
that it throws and have `checkAnchors` own the parse.

---

## F12 — LOW. Test quality: the two tests that matter most are missing

The brief asked what it would take to make the feature fail while the tests
still pass. Mostly the tests are good — `verify-key.test.ts:82-113` is exactly
the right test: it builds a forged chain with a substituted key, asserts the
attacker's own key accepts it, then asserts the pinned lookup returns `null` and
`verifyChain` fails with `has no public key for`. `evidence-integrity.test.ts`
and `verify-key.test.ts` in the control plane are real end-to-end tests, and the
control-plane one boots a server and checks a re-signed chain is refused. The
gaps are:

1. **Nothing tests F1.** No test asserts that a substituted *trust file* is
   detected, because it cannot be. The central claim of the change therefore
   has no test that would fail if the pin were subverted. The nearest test,
   `verify-key.test.ts:139-155`, only checks the file is read back.
2. **Nothing tests F4.** `anchor.test.ts:139` is named "a rewritten anchor file
   is refused before any signature is trusted" but only covers the
   duplicate-head-different-hash shape. There is no test for truncating the
   anchor file, which is the case that succeeds silently.
3. **`verify-key.test.ts` (control plane) never reaches the primary API path.**
   Its workbench has no workspace, so `workbench.list()` is empty,
   `workspace` resolves to `undefined`, and every request falls through to
   `handleVerify`. The primary block at `server.ts:286-293` — the one that
   hardcodes `signed: true`, uses a different field name, and 500s — is
   untested. This is why F5 went unnoticed.
4. **Dead code left in a test**: `anchor.test.ts:143-144`,
   `const { appendAnchor: _ignored, ...rest } = { appendAnchor }; void rest;`.

---

## F13 — LOW. Key rotation now bricks export and attest **[SOURCE]**

`operations.ts:128-133` verifies with the pinned key, then `attestLedger` signs
with the current signer. With a pin in place, a legitimately rotated key makes
`verifyChain` fail and the command refuses outright
(`"Ledger verification failed; export and attestation refused."`). There is no
rotation story in the codebase — `docs/THREAT-MODEL.md` §7.5 records this — so
this is a forward-looking operational trap rather than a current defect. Worth a
`key_id` allowlist in the pin before pinning becomes the documented default.

---

## What did *not* change, verified

**Persisted record shape: unchanged.** Confirmed by diff inspection, not by
inference.

- `packages/ledger/src/store.ts` and `packages/ledger/src/canonical.ts` do not
  appear in the diff at all.
- `sign.ts` changes `keyProviderFromPkcs8` to call a new
  `devKeyIdFromSpki`, which is a literal extraction of the expression it
  replaced: `` `dev-${keyIdFromSpki(spki)}` ``. Byte-identical. **No key-id
  migration**, so every existing ledger still verifies against its own recorded
  `key_id`.
- `AttestationDocument` and `storeAttestation` are untouched. `anchor.ts` writes
  the same document with `JSON.stringify`, so an existing attestation parses as
  an anchor unchanged.
- `export-bundle.ts` is +18/-0 across exactly three hunks: an import, a field on
  the `VerifyBundleOptions` **type**, and a block inside `verifyBundle`.
  `createBundle` and the manifest section list are untouched, so the bundle
  manifest digest is unaffected.

New on-disk artefacts only: `~/.void/trust/verify-ed25519.spki` and the
operator-named anchor file. Nothing existing changes meaning.

**The no-mint change broke nothing in the suites.** ledger 69/69, CLI 283/283,
control-plane 174/174. The two workflow impacts I found are F5 (the read path
*still* mints, and 500s) and F7 (`export verify` refuses).

**The `grown` path is not exploitable.** I tried. `verifyAnchor` checks
`entriesCount > ledgerEntries.length` and commits the prefix with
`headHash` + Merkle root, so an attacker who rewrites entries inside the
anchored prefix is caught (cases D and E above), and entries written after the
last anchor are simply uncommitted — inherent to anchoring, and honestly
described at `attest.ts:170-176`. The only thing `grown` fails to signal is
*how much* uncommitted history there is, which no anchor scheme can do.

---

## Plain paragraph

After this change, an attacker with local filesystem write access and
agent-level code execution still **cannot** forge a chain that verifies against
a verification key they do not control, and still **cannot** truncate or rewrite
a ledger whose anchored prefix is covered by an anchor file somebody else
holds — both of those I tried to break and failed, and the pinned-key-to-one-
key-id binding is a genuine detection primitive where the pin genuinely came
from outside. What they **can** do is rewrite the entire local history, and make
it report `pinned-file, degraded: false` while doing it, because the file called
the pin sits in the same `~/.void/` tree as the key it is supposed to anchor and
is only a `0400` file against its own owner; they can simply leave the TUI and
`void watch` reporting `verified` off the private key they replaced, because
neither surface was converted; they can get `void verify --standalone` to exit
0 on a chain whose signatures were never checked, and can read `degraded: false`
from an API response that authenticated nothing. The change does not cross the
principal boundary, and `docs/THREAT-MODEL.md` §6 was right that it could not
be made to from inside this process. What it genuinely buys is narrower than
the change's own comments claim and narrower than `OPERATIONS.md` tells the
operator: substitution is detectable **only** by a holder of a key that was
obtained out of band and never written to a file the agent can reach — for
everyone else the correct status is still the threat model's §5.1 sentence,
verbatim: the signature proves the bytes came from a process holding a specific
key, and against the agent itself that is worth close to nothing. The fix that
would actually change this is the one the threat model already named and this
change did not attempt — move the anchor somewhere the agent has no credentials
for, and state the trust level honestly in the user-facing docs rather than
implying the pin closes a gap it relocates.
