# Threat model: what NOMO's signature can and cannot prove

Scope: the trust boundaries, key custody, and attestation coverage of the
`runtime`, `ledger`, `policy`, `proxy`, `control-plane` and `desktop` components
as they are in this repository. Written 2026-09-26 against the working tree.
No build or test suite was run for this document. No key, credential or
keychain secret was read, printed or created.

The question this document answers is narrow and load-bearing: **against a
compromised agent, a hostile local operator, or malware running as the user on
the host, does NOMO's ed25519 signature prove anything?**

The short answer, established from source below:

- The recorder, the tool executor, the policy engine, the model client and the
  signature all run in **one Node process under one OS principal**, on every
  platform and in every shipped configuration. AAT §5.2's "distinct
  operating-system security principal" requirement is not met anywhere.
- The research pass is right about the trust domain and wrong about the
  mechanism. The signing key is **not** in the keychain. It is a `0600` PKCS#8
  file in the same directory as the data it signs. The keychain holds a
  *different* secret, the workspace encryption key, and conflating the two
  makes the finding sound more alarming and the fix look more expensive than
  it is.
- Against a third party who can edit the JSONL but cannot read the key file,
  the signature is real and does work. Against anyone with agent-level code
  execution, or any other process running as the same user, it is worth close
  to nothing on its own.
- NOMO's own code already refuses to claim more than that, in six places. This
  is therefore a **ceiling on what the signature can ever prove**, not a live
  vulnerability against a stated guarantee. See §6.

---

## 1. Trust-boundary map

### 1.1 What "the process" is on each surface

There are two shipped topologies. Both collapse to one OS principal.

**Desktop / GUI (Tauri).** Two processes, one principal.

| Process | What it is | Evidence |
| --- | --- | --- |
| `NOMO.app` (Rust/Tauri) | Window shell. Reads the workspace key from the OS keychain, hands it to Node **as a base64 environment variable**, spawns the Node runtime as a direct child. | `apps/desktop/src-tauri/src/main.rs:98`, `:107`, `:126`, `:137` |
| `node runtime/runtime.mjs` | The control-plane HTTP server **and** the entire workbench: agent loop, provider client, tool dispatch, connector code, policy, journal, vault, ledger store, signer, verifier. | `apps/desktop/runtime.mjs:15-18` → `apps/control-plane/api/server.ts:113` |

The Tauri shell is a genuine second process, but it runs as the same login
user, and its only security-relevant act is to read a secret and hand it to the
child. It contributes no isolation: `apps/desktop/src-tauri/src/main.rs:137`
sets `NOMO_WORKSPACE_KEY` in the child environment.

Inside the Node process:

| Component | Where it is wired | Same process as the signer? |
| --- | --- | --- |
| HTTP API / verifier / feed | `apps/control-plane/api/server.ts:113-126`, `:331`, `:337` | Yes |
| Agent loop (model calls) | `packages/workbench/src/index.ts:2027` (`session.provider.complete`) | Yes |
| Tool executor | `packages/workbench/src/index.ts:1908` → `:1456-1483` | Yes |
| Connectors (filesystem, postgres, s3) | In-process modules; no child process. Only the git connector shells out (`packages/connectors/src/git/managed.ts:22`, `managed-commit.ts:1020`). | Yes |
| Policy engine | `packages/workbench/src/index.ts:74-75`; also in the proxy at `packages/proxy/src/bin.ts:11` | Yes |
| Operation journal | `packages/workbench/src/index.ts:1443-1454` → `packages/runtime/src/journal.ts:221` | Yes |
| Reserved recovery vault | `packages/workbench/src/index.ts:1448`; `packages/workbench/src/storage.ts:13` | Yes |
| Ledger store + signer | `packages/workbench/src/index.ts:64`, `:1705`, `:1739` | **This is the reference point** |
| Ledger verifier | `packages/workbench/src/index.ts:1682-1688`; `apps/control-plane/api/server.ts:85-102` | Yes |

The single strongest citation for the whole claim is
`packages/workbench/src/index.ts`: the same class that calls the model
(`:2027`), dispatches tools (`:1908`), and commits signed evidence
(`:1693-1751`) is one object in one process, opening its signing key with
`devKeyProvider` at `:1705` and signing at `:1739`.

**stdio proxy (agent integrations).** Also one principal, and the topology is
worse for the claim: the proxy *is* the recorder, and the proxy *spawns the
audited agent as its own child*.

- `packages/proxy/bin/nomo-proxy.mjs:44` runs the proxy.
- `packages/proxy/src/bin.ts:11-15` imports policy and ledger into the proxy
  process; `:172-178` builds the ledger store with `devKeyProvider()`.
- `packages/proxy/src/bin.ts:705-717` writes the signed decision record.
- `packages/proxy/src/transport/stdio.ts:118` spawns the upstream agent
  **as a child of the recorder**.

So in the stdio topology the auditor is literally the parent of the audited
process, and both run as the login user. There is no setuid, launchd daemon,
helper service, DPAPI call, Secure Enclave use, TPM use, or keychain ACL
anywhere in the source tree, I grepped for all of them and found nothing.

### 1.2 The one piece of boundary work that does exist, and what it is worth

`packages/proxy/src/transport/stdio.ts:113` deletes `NOMO_SIGNING_KEY` from the
upstream child's environment, with a comment stating the threat model
precisely: "An upstream that can sign ledger entries can forge the audit trail
it is audited by." That is correct, and the regression test is real.

It is environment hygiene, not isolation. It protects the *env-carried* key on
the stdio path. It does nothing about the `~/.nomo/keys/dev-ed25519.pkcs8` file,
which the child reads at the same UID, and it does nothing at all on the
desktop path, where the key is only ever a file. The project says so itself in
`packages/security-notes.md:41` (finding S15): "Same-user key-file readability
remains out of scope: no OS isolation is claimed and the finding is documented
as defense in depth only."

---

## 2. Key custody

### 2.1 The signing key

| Deployment | Location | Who can read it | Reference |
| --- | --- | --- | --- |
| CLI / local workbench | `<workbench dir>/keys/dev-ed25519.pkcs8`, mode `0600`, dir `0700` | Any process as the login user | `packages/ledger/src/sign.ts:61`, `:105-133`, `:147-165`; dir from `packages/workbench/src/index.ts:282-286` |
| Default (no dir override) | `~/.nomo/keys/dev-ed25519.pkcs8` | Same | `packages/ledger/src/sign.ts:61` |
| Proxy | Same, or `NOMO_SIGNING_KEY` from env | Same | `packages/proxy/src/bin.ts:176` |
| Desktop | `$NOMO_DATA_DIR/keys/dev-ed25519.pkcs8`, `0600` | Any process as the login user; **not** gated by the keychain | `packages/workbench/src/index.ts:1403-1406`, `:1705-1708` |
| Cloud tier | `process.env.NOMO_SIGNING_KEY` | Anything that can read the server process environment or a core dump | `cloud/store.mjs:101-104` |

The key is generated with `generateKeyPairSync("ed25519")`
(`packages/ledger/src/sign.ts:147`) and written with `O_CREAT|O_EXCL` at `0600`
(`:150-151`), a real symlink-preplacement defence, and `readExistingKey`
asserts mode `0600`, non-symlink, regular file (`:135-138`,
`packages/ledger/src/hardening.ts:75-96`), with a Windows ACL check
(`hardening.ts:8-64`). On Windows the ACL is allowed to grant only the current
SID, `S-1-5-18` (SYSTEM) and `S-1-5-32-544` (Administrators)
(`hardening.ts:30`), the same three principals that can already read anything
the user can.

**Every one of those defences is a defence against a *different* user.** There
is no defence in the design against the same user, because the same user is the
recorder.

### 2.2 The keychain: what it actually holds

The research pass's specific mechanism claim is **wrong**, and worth correcting
because the correction changes the fix.

`apps/desktop/src-tauri/src/keychain.rs` handles exactly one secret: the
32-byte **workspace encryption key** that encrypts `workspace.enc`
(`keychain.rs:32-58`, `random_key` at `:26`). It is read from
`MacKeychain` (`keychain.rs:130-160`, service `dev.void.desktop.workspace`) or
`WindowsCredentials` (`keychain.rs:166-215`, `CredReadW`/`CredWriteW`), and is
handed to the Node child as `NOMO_WORKSPACE_KEY`
(`apps/desktop/src-tauri/src/main.rs:137`).

`apps/desktop/src-tauri/` contains **no reference to the ledger signing key at
all**, I grepped `main.rs`, `keychain.rs`, `diagnostics.rs` and `downloads.rs`
for `sign`, `ed25519` and `ledger`: the only hit is an unrelated UI string at
`main.rs:414`.

So the accurate statement is: **the signing key is in the same directory and
the same trust domain as the data it signs**, which is worse than "in the same
keychain", because `0600` on a file in the app data directory offers no access
control at all against the process that is running. But it is *not* a keychain
custody problem, and moving it to a keychain would not fix the AAT gap,
because the agent is in the same process and would read it just the same.

The desktop keychain does buy one real thing: **confidentiality of workspace
contents against other applications and other users**, which is a different
threat from ledger integrity. `packages/workbench/src/index.ts:276-278` labels
this honestly as `keyStorage: "os-keychain"` (surfaced at `:505`). That label
describes the encryption key and should not be read as a statement about the
signature.

Note also that `MacKeychain` sets no `SecAccessControl`
(`keychain.rs:134-162`, a plain `get_generic_password` /
`set_generic_password`): no user-presence requirement, no ACL bound to a
signing identity. The doc comments on `MacKeychainRead` at `keychain.rs:96-115`
correctly explain that an ad-hoc-signed rebuild loses the grant and that this is
why `Denied` is distinguished from `Absent`.

### 2.3 Key custody summary

| Secret | Custody | Trust domain of the data it protects |
| --- | --- | --- |
| Ledger signing key (ed25519) | `0600` file, same UID as everything | **Same** |
| Workspace encryption key (desktop) | macOS Keychain / Windows Credential Manager, then env var into the agent's process | **Same** (the agent decrypts everything) |
| Workspace encryption key (CLI) | `workspace.key`, `0600`, **in the same directory as `workspace.enc`** (`packages/workbench/src/storage.ts:17-25`) | **Same** |
| Cloud signing key | Environment variable on the server | Same host; separate from any local agent, but not a KMS |
| Upstream agent process | `NOMO_SIGNING_KEY` scrubbed from env (`stdio.ts:113`) | Still same UID; still reads the key file |

### 2.4 The verifier reads the private key

This is the finding that turns "limited value" into "no value", and it is
independent of process boundaries.

Every verification path resolves the *public* key by loading the *private* key
file:

- `apps/control-plane/api/server.ts:97`, reads
  `~/.nomo/keys/dev-ed25519.pkcs8` and returns `keyProviderFromPkcs8(...).publicKey`.
- `packages/cli/src/verify.ts:166`, `devKeyProvider({ env })`, same default dir.
- `packages/workbench/src/index.ts:1682-1688` and `:1767-1770`, same.

Consequence: an attacker who replaces `dev-ed25519.pkcs8` controls both halves
of verification. They do not need to re-sign anything to make old entries look
forged, but more usefully, they can re-sign **everything** with their own key
and every NOMO verifier will report the rewritten chain as valid, because the
verifier is asking the attacker's key whether the attacker's signatures are
good. Rewriting is cheap: `entryHash` and `signingPreimage` are three lines
(`packages/ledger/src/canonical.ts:94-105`, `packages/ledger/src/index.ts:69-77`).

Two secondary consequences of the same design:

- **Truncation is undetectable locally.** `verifyChain` is happy on any
  consistent prefix (`packages/ledger/src/verify.ts:92-146`); the only thing
  that pins a length is an attestation document, and `storeAttestation`
  (`packages/ledger/src/attest.ts:61-74`) has **no production caller**, only
  tests and `scripts/src/e2e-final.mjs:310`. The anchoring mechanism exists and
  is not shipped.
- **`nomo verify` could mint a key (historical).** This was true before the verifier switched to `resolveVerificationKey` with no `createIfMissing`; it no longer mints a key. Left as a record of the prior footgun.

---

## 3. What the signature actually attests today

The signed pre-image is narrow and well-defined. Entry hash:
`sha256("void.ledger.entry.v1|" + prev_hash + "|" + canonicalJson(body))`
(`packages/ledger/src/canonical.ts:94-105`). Signature pre-image:
`"void.ledger.<ver>|" + alg + "|" + key_id + "|" + entry_hash`
(`packages/ledger/src/index.ts:69-77`). Canonicalisation is recursive, so
nested tool arguments are genuinely covered, the comment at
`packages/ledger/src/canonical.ts:1-17` records that a shallower design would
have silently erased them, and it is correct.

### 3.1 Coverage table

Two record shapes exist. The **proxy decision record** is what
`packages/proxy/src/forward/tools.ts:34-40` defines and
`packages/proxy/src/bin.ts:716` writes. The **workbench evidence record** is
`packages/workbench/src/index.ts:1709-1727`. The **journal operation event** is
`packages/runtime/src/journal.ts:25-47`.

| Property | Proxy decision record | Workbench evidence | Journal operation event | Attestation doc |
| --- | --- | --- | --- | --- |
| Workspace | yes (`bin.ts:716`) | yes (`:1712`) | yes (`journal.ts:27`) | yes (`attest.ts:48`) |
| Timestamp | yes (`:1713` / `tools.ts:35`) | yes (`:1713`) | yes (`:162`) | yes (`:51`) |
| Tool name | yes (`:1714`) | yes (`:1714`) | via `adapterId` (`:313`) |, |
| Reversibility class | yes (`klass`, `:1715-1717`) | yes (`:1715-1717`) | no |, |
| Decision / outcome | yes, as a free string (`:1718`) | yes, free string (`:1718`) | as `stage` (`:318`) |, |
| **Tool arguments** | **digest only**, `argsDigest` (`:1719`) | digest only (`:1719`) | `requestDigest` (`:312`) |, |
| **Which policy rule fired** | yes, `attribution.rule.index` (`attribution.ts:46-49`) | **no** | **no** |, |
| **Why that rule fired** | yes, `attribution.rule.rationale` when the rule states one | **no** | **no** |, |
| **The policy itself** (content or version) | yes, `attribution.policyDigest` = `canonicalDigest(policyFile)` | **no** | **no** |, |
| **The model that made the call** | **no** | **no** | **no** |, |
| **The prompt / conversation** | **no** | **no** | **no** |, |
| **The tool result / side effect** | **no** | **no** | result goes to the vault, not the chain (`execute.ts:240-249`) |, |
| Agent identity | **no** | `approvedBy` only (`:1710`) | yes, `agentId`, `runId` (`:315-316`) |, |
| Adapter identity | connector only, not signed (`bin.ts:758`) | no | yes, `adapterId`, `adapterVersion` (`:313-314`) |, |
| Predecessor link | yes (`store.ts:107`) | yes (`:1728`) | yes (`store.ts:107`) | yes (`:50`) |
| Signing key id | yes (`store.ts:109`) | yes (`:1737`) | yes (`store.ts:109`) | yes (`:54`) |
| Chain position | yes (`store.ts:105`) | yes (`:1733`) | yes (`store.ts:105`) | yes (`:49`) |
| Whole-file commitment |, |, |, | Merkle root over all entry hashes (`attest.ts:53`, `:113-127`) |

### 3.2 The interesting failure

Read the table as: *what can an attacker with agent-level code execution change
without invalidating the chain?*

Almost everything that matters.

- **The policy is now named, and naming it is what closes this.** A decision
  record carries `attribution.policyDigest`, the sha256 over the canonical JSON
  of the policy content the call was decided under
  (`packages/policy/src/digest.ts`, bound by the entry hash at
  `packages/ledger/src/canonical.ts:101`). A reviewer who obtains
  `policy.yaml` recomputes one value and learns whether the record was made
  under the policy they think is in force, instead of being told so by whoever
  wrote the record. `PolicyFile.version` remains a **format** constant and is
  part of that content, so a policy that changed only its declared version is a
  different policy with a different digest. AAT §5.3 asks for exactly this and
  calls it "Policy integrity".
  What it does not do: it does not stop an attacker who also holds the signing
  key, and it does not make the policy itself available, the digest is
  evidence, not the document. Note also that the *retention* `policyDigest`
  (`packages/runtime/src/retention.ts:271`) is a different quantity: it is
  `digest(canonicalJson(policy))`, which canonicalises an already-canonical
  string and so carries an extra layer of JSON quoting. The two digests are not
  comparable and must not be.
- **The rule that fired.** `PolicyDecision` now names the rule on all three
  paths, allow included (`packages/policy/src/decide.ts:37-49`), and the record
  binds `attribution.rule.index` and, when the rule states one,
  `attribution.rule.rationale`. A record written before this existed carries no
  `attribution` at all and still verifies, because the entry hash is over the
  body that was actually written; there is no migration and none is invented.
  `readLedgerReason` (`packages/ledger/src/attribution.ts:89`) keeps "this
  record names no policy", "this record names a policy and no rule" and "a rule
  fired with no rationale" apart, because collapsing them would let a reader
  report the last as the middle.
  What still leaks: in observe posture the proxy forwards a call the policy
  would have refused and records `decision: "allow"` with no rule
  (`packages/proxy/src/bin.ts:659-663`), so an observe-mode record names the
  policy but not the rule it evaded.
- **The classification.** `klass` is recorded, so the R-class is bound, but
  `blastRadius`, `unclassified`, and the probe facts that produced them are not.
- **Everything about the model.** No model id, no prompt, no digest. Nothing in
  `packages/ledger/`, `packages/runtime/src/journal.ts` or `execute.ts` mentions
  either. AAT §13.6 ("Attestation Closure") is the direct reference here, and
  NOMO is far outside it, though §13.6 is about decision *reproducibility*, a
  stronger property than NOMO claims.
- **The evidence itself.** The workbench keeps `evidence` in memory
  (`packages/workbench/src/index.ts:1681`, `:1743`) and serialises it into
  `workspace.enc` via `this.persist()` (`:1745`), the same process, same key,
  same directory.
- **The verifier's answer.** As established in §2.4, replacing the key file
  makes any rewritten chain verify clean.

What the signature *does* hold, and it is not nothing:

- **The append-only ordering is enforced in-process** by
  `validateTransition` (`packages/runtime/src/journal.ts:107-151`) against a
  table that is the single source of truth (`:181-186`). An attacker who wants a
  `succeeded` stage without a `prepared` stage has to violate that table.
- **The decision is written before the verdict**, deliberately
  (`packages/proxy/src/forward/tools.ts:97-98`): a crash after the decision
  still leaves a record saying what was about to happen. That is the
  pre-execution property AAT §4.2 is about, and NOMO has it.
- **Durability is real**: `fsync` before the receipt
  (`packages/ledger/src/store.ts:117-123`), directory `fsync`
  (`packages/runtime/src/journal.ts:288-296`).
- **Algorithm agility is absent by design**: `verifyChain` rejects any `alg`
  other than `ed25519` (`packages/ledger/src/verify.ts:123`, `store.ts:180`).
  AAT §-04 asks for ML-DSA-65 alongside ECDSA P-256. This is a small gap and
  NOMO is behind, not exposed.

### 3.3 Two things the verifier is already honest about

Credit where due, because these are the reason this document does not call
NOMO's signature worthless:

1. **Signature checking is conditional and the difference is reported.**
   `verifyChain` verifies signatures only when a public key is supplied
   (`packages/ledger/src/verify.ts:122`), and every consumer propagates the
   distinction: `packages/ledger/src/feed.ts:62` returns
   `signed: options.publicKey !== undefined`, and
   `apps/control-plane/api/server.ts:337` does the same for the taint view. The
   project's own finding S08 (`packages/security-notes.md:34`) is precisely
   that these paths used to report `verified: true` without checking anything.
2. **Destructive operations refuse to run unverified.**
   `apps/control-plane/api/server.ts:344` returns
   `signature_key_required` for ledger replay without a key. And
   `nomo verify --standalone` runs the check in a child process that does not
   import the repository (`packages/cli/src/verify.ts:113-136`), printing
   `signature NOT VERIFIED` rather than implying otherwise.

The architecture is one process. The *reporting* around it is careful.

---

## 4. The gap against the IETF Agent Audit Trail draft

Sources fetched:

- <https://datatracker.ietf.org/doc/draft-sharif-agent-audit-trail/>
- <https://www.ietf.org/archive/id/draft-sharif-agent-audit-trail-05.txt>

The draft is an **individual Internet-Draft with no RFC stream and no IESG
state**; the datatracker page states plainly that it "is not endorsed by the
IETF and has no formal standing in the IETF standards process." It should be
treated as a design reference, not a conformance target. That does not make it
useless as a specification of what independent recording means, it is a
careful one, but it does mean "non-compliant with AAT" is not, by itself, a
finding.

### 4.1 What the draft actually requires

§5.2, quoted verbatim from the fetched text:

> For deployments at trust level L2 and above, audit records SHOULD be written
> by a component independent of the agent.

> The independence of the recording component is a property of its deployment,
> not only of its key. At minimum, an independent recording component MUST
> execute under a distinct operating-system security principal from the audited
> agent process, and SHOULD execute in a distinct failure domain (separate
> host, container, or trust zone).

> The recording component's signing key (Section 6.2) MUST reside outside the
> audited process's writable filesystem and MUST NOT be accessible to the
> audited agent process.

> Verification (Section 6.3) SHOULD be performed outside the recorder's
> security principal. An in-process signature demonstrates the transit
> integrity of a record but not recording honesty: a process that both
> produces a record and holds the key that signs it can produce a well-formed
> record of an event that did not occur, or omit one that did.

The draft's own threat model is stated in §5.1: "Self-recording provides weaker
evidentiary guarantees because the agent could, in principle, omit or alter
records of its own actions without external detection." And §5.3 makes
suppression itself visible: consequential actions, payment or fund movement,
deletion of data, production deployment, delegation, or egress of data to an
external party, "MUST be assigned a `trust_level` of L2 or above by default,"
and downgrading one requires an explicit, signed `trust_assignment` naming the
classifier and the `policy_version` in force.

### 4.2 How far NOMO is from it

| AAT §5.2 / §5.3 requirement | NOMO status |
| --- | --- |
| Records written by a component independent of the agent | **Not met.** Recorder and agent share a process on every surface (§1.1). |
| Recording component under a **distinct OS security principal** | **Not met anywhere.** No setuid, launchd, service, or helper exists. |
| Recording component in a distinct failure domain | **Not met.** Single host, single process, no container. |
| Signing key outside the audited process's **writable filesystem** | **Not met.** `0600` file in the agent's own data directory (`sign.ts:61`, `:150`). |
| Signing key **not accessible** to the audited agent process | **Not met.** It is read and used in that process (`workbench/src/index.ts:1705`, `:1739`). |
| Verification outside the recorder's principal | **Not met.** The HTTP verifier runs in the recorder process (`server.ts:113`, `:331`). |
| `policy_digest` / `policy_version` recorded, digest of canonical policy | **Met on the proxy path** (`attribution.policyDigest` + `attribution.rule`, `forward/tools.ts:376`, `packages/policy/src/digest.ts`); **not** on workbench evidence or journal events, which still lack it. See `readLedgerReason` in `ledger/src/attribution.ts:162`. |
| Downgrade is an attributable recorded event | **Not applicable**, NOMO has no trust-level field to suppress. |
| `recording_component` URI distinct from `agent_id` | **Not met.** No `recording_component` field; `key_id` is derived from the same key that signs everything. |
| `signer_kid` distinct from the agent's key thumbprint | **Not met, and unmeetable in principle here**, there is only one key, used for both roles (`store.ts:99-104`). |
| Pre-execution record for denied decisions (§4.2) | **Met**, and deliberately (`forward/tools.ts:97-106`, record written before the verdict). |
| Pre-execution record before external-state modification (§4.3) | **Met** for the proxy path; **not** for the workbench path, which commits evidence after `mutateDocument` returns (`workbench/src/index.ts:1424-1441`, `:1693`). |

**The single most important qualification**, which the research pass states as
unconditional and the draft does not: §5.2 is scoped to *trust level L2 and
above*. At L0/L1 the draft explicitly permits self-recording (§5.1: "At trust
levels L0 and L1, the agent itself MAY write its own audit records"), requiring
only that the genesis record declare `recording_mode: "self"`.

NOMO's actual trust level is **L1**, self-signed identity, no trust
authority, no external attestation (§2 terminology, lines 388-399 of the
fetched text). Under the draft as written, NOMO **is not in violation**. It is
**not capable of claiming L2 or above**, and it must not market itself as
though it could. That is the correct, non-alarming framing of the finding: the
gap is a *ceiling*, not a breach.

---

## 5. The honest interim position

### 5.1 What is true today, stated so it survives contact with a sceptic

> The NOMO signature proves that the bytes in `~/.nomo/ledger/*.jsonl` were
> produced by a process that held a specific ed25519 key, and that no entry was
> reordered, removed from the middle, or altered after writing. It does not
> prove that any recorded event occurred, that any was omitted, that the policy
> in force was the policy that was applied, or that the recording process was
> not itself compromised. Verification uses the same key the writer used, so it
> detects a third party who can edit the ledger but cannot read the key
> directory, a population that, on a single-user host, is close to empty.

That is a defensible sentence to put in the README. It is roughly the sentence
`packages/security-notes.md:11-14` already writes for internal readers, and it
should be promoted to the user-facing documentation rather than left in a
review file.

### 5.2 The full fix, and its honest cost

Meeting §5.2 literally requires a component under a different OS principal that
holds a key the agent cannot read. On macOS and Windows that means a privileged
install: a `launchd` LaunchDaemon or a root-owned helper on macOS, a Windows
service under a service SID on Windows, with a signed identity stable across
rebuilds. Consequences:

- It breaks the current distribution model. The desktop app ships as an
  ad-hoc-signed, unnotarized `.app`/DMG with a bundled Node and no installer
  (`docs/RELEASE-1.0.1-MATRIX.md:16-17`, `:286`). A privileged helper is an
  installer, an entitlements story, and a signing identity.
- The key becomes non-exportable, which invalidates every current `KeyProvider`
  call site and the `NOMO_SIGNING_KEY` env path, and the "dev tier key" in
  `sign.ts` is explicitly designed to be swappable for a KMS ("In production
  the same interface is backed by KMS and no calling code changes",
  `sign.ts:12-14`), so the *interface* is ready and the *deployment* is not.
- It buys nothing against the agent itself, because in NOMO's topology the
  agent is the process being recorded. A compromised agent would simply stop
  recording and the absence would be the signal.

Estimate: weeks of work per platform, an installer, and a code-signing
identity the project does not currently have, to move NOMO from L1 to L2.

### 5.3 The single change that closes the most of the gap

**Publish the signed head outside the process that can write it, and pin the
public key outside the process that can read the private one.**

Concretely, two coupled pieces:

1. **Make the external anchor a shipped product surface.** `attestLedger`
   already computes a Merkle root over all entry hashes
   (`packages/ledger/src/attest.ts:53`, `:113-127`) and `storeAttestation`
   already writes a signed document (`:61-74`), and neither has a production
   caller. Ship a `nomo attest` command that emits the signed
   `{headSeq, headHash, treeDigest}` and push it to somewhere the agent
   process has no credentials for: the operator's cloud account
   (`cloud/store.mjs` already holds an append-only `void_cloud_ledger` table),
   or a syslog/`log(1)` forward, or a plain append-only file the agent cannot
   open. AAT §14.1 asks for exactly this, "Implementations SHOULD store
   `session_hash` values in a separate, append-only system to provide an
   independent verification point."
2. **Stop resolving the verification key from the private key file.** Emit the
   public key (`keyProviderFromSpki` → base64 SPKI) into the attestation
   document and into any exported bundle, and have `server.ts:85-102` and
   `cli/verify.ts:161-168` prefer a pinned, independently obtained public key
   over `~/.nomo/keys/dev-ed25519.pkcs8`. Today `--key base64-spki` already
   exists (`verify.ts:33`, `:165`); it is simply not the default.

Why this is the right single change:

- It is the one that makes **key substitution detectable**. Today, swapping the
  private key file silently redefines what "valid" means. With a pinned public
  key, a swapped key produces a `dev-<different thumbprint>` `key_id`, and
  `verifyChain` fails at `packages/ledger/src/verify.ts:135-137` with "has no
  public key for ...". That is a real detection primitive, cheaply obtained.
- It converts **truncation and omission** from undetectable to detectable , 
  currently the worst gap, because the anchoring machinery exists and is
  unwired.
- It is the only change in this list that puts a byte into a **different trust
  domain**: an operator-controlled remote endpoint the agent process does not
  hold credentials for. That is the property §5.2 is actually reaching for.
- It requires no installer, no privilege, no code-signing identity, and it
  composes with the existing `KeyProvider` abstraction.

What it does **not** give, and must be labelled honestly: an attacker with agent
code execution can still rewrite the *local* ledger coherently, and can still
withhold future records. It converts "history can be silently rewritten" into
"local history can be silently rewritten, and the divergence from the last
independently published anchor is detectable by whoever holds the anchor." That
is:

> **Detects tampering by a third party, not by the agent itself.**

which is a real and much better property than nothing, and it is honest.

### 5.4 Three smaller increments, in priority order

1. **Stop the verifier from minting a key.** One line:
   `devKeyProvider({ env, createIfMissing: false })` at
   `packages/cli/src/verify.ts:166`. A read-only command should not create
   signing capability.
2. **Bind the policy and the rule to the record.** Add `policyDigest`
   (sha256 of `canonicalJson(policyFile)`), `ruleIndex` and `rationale` to the
   proxy ledger entry at `packages/proxy/src/forward/tools.ts:34-40` and to
   `commitWorkspace` at `packages/workbench/src/index.ts:1709-1727`. The values
   are already in scope at the decision point (`forward/tools.ts:96`,
   `decide.ts:39-47`) and are being thrown away. This is a few dozen lines and
   it directly answers AAT §5.3 "Policy integrity" and makes `decision: "allow"`
   mean something an auditor can check.
3. **Bind the model identity.** Record model id and a digest of the outbound
   request at the point `session.provider.complete` is called
   (`packages/workbench/src/index.ts:2027`). This is the first step toward AAT
   §13.6 and it costs one field. It will not reach attestation closure, and it
   should not claim to.

Optionally, if a stronger-than-nothing local story is wanted on desktop without
any installer: store the signing key as a non-exportable `SecKey` (macOS) or
`NCrypt` key (Windows) rather than a PKCS#8 file. **This is not isolation** and
must not be described as such, the agent is in the same process and would call
the same API. What it does buy is real but narrow: it stops *malware running as
the same user in a different process* from silently copying the key to a
server, provided the key is created with a `SecAccessControl` requiring user
presence. That is a meaningfully different threat model from "compromised
agent", and the two should never be conflated in the documentation.

### 5.5 What should be said in public

- Say: "tamper-evident against a third party who can modify the audit file but
  not the key material", and "an external signed anchor is published so history
  cannot be rewritten without detection" once §5.3 ships.
- Do not say: "non-repudiable", "auditable", "tamper-proof", or anything
  implying the agent cannot influence its own record.
- Say which trust level the product targets, in the draft's own vocabulary. If
  the answer is L1, say L1, the draft permits it (§5.1), and a product that
  names its level is more credible than one that implies L3.

---

## 6. Is this a live vulnerability?

No. It is a **ceiling on a claim**.

The evidence for that reading:

- `packages/security-notes.md:11-14` states the threat model in these terms
  before any of this document: "Local development keys cannot protect against a
  compromise of that same user."
- `packages/security-notes.md:41` (S15) states: "Same-user key-file readability
  remains out of scope: no OS isolation is claimed and the finding is documented
  as defense in depth only."
- Six code paths already refuse to over-claim: `feed.ts:62`, `server.ts:337`,
  `server.ts:344`, the `signature NOT VERIFIED` standalone path
  (`cli/verify.ts:114-137`), the `keyStorage: "os-keychain"` label
  (`workbench/src/index.ts:276-278`, `:505`), and the pre-verdict ledger write
  (`forward/tools.ts:97-98`).
- The release evidence matrix grades Mac direct beta as "Ad-hoc signed Tauri
  app/DMG with bundled Node, not Developer ID notarization or App Sandbox"
  (`docs/RELEASE-1.0.1-MATRIX.md:16`) and the product signature as
  `adhoc`, `TeamIdentifier=not set` (`:286`). A project that grades its own
  signing story that way is not the project the research pass was describing.

The real risk is **messaging, not code**: a reader who hears "ed25519-signed
audit trail" and infers AAT §5.2-grade evidence will be wrong, and the gap
between the two is exactly the size of the §5.3 anchor work in §5.3. That work
is small, mostly already built, and worth doing.

The product is not unsound. It is a well-built L1 audit trail that has not yet
paid for the L2 upgrade, and whose strongest security property is currently
unpublished.

---

## 7. What I could not determine

Stated plainly rather than guessed.

1. **Whether the shipped binaries match this source.** I read
   `apps/desktop/src-tauri/` and `apps/desktop/runtime.mjs`; I did not run a
   build. A local generated bundle present when this audit was written contained
   `storeAttestation` matching the source. The bundle is generated by
   `apps/desktop/scripts/prepare.mjs` and is not tracked, so this historical
   observation does not show that a signed release artifact matches source.
2. **Whether `cloud/` is deployed with a real KMS or with an env-var key.**
   `cloud/store.mjs:101-104` reads `process.env.NOMO_SIGNING_KEY` and
   `scripts/src/provision-cloud.mjs:17` generates a keypair for it, so the
   deployment configuration is what decides this, and I have no access to it.
   If it is an env var, the hosted tier has the same class of problem at a
   different blast radius.
3. **The Apple companion's key custody.** `apps/apple/CompanionProtocolKit/
   Sources/CompanionProtocolKit/KeychainStore.swift` is a keychain wrapper with
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (`:23`) and no
   `SecAccessControl` (`:65-69`). I found **no production call site** for it in
   the audited tree, so I cannot say what it is currently used to protect. I did
   not establish whether the iOS/macOS companion reads, verifies, or holds any
   ledger signing material.
4. **Whether the `MacKeychain` item has any ACL in practice.**
   `apps/desktop/src-tauri/src/keychain.rs:145-160` sets no access control on
   `set_generic_password`, so it inherits the default login-keychain
   protection. I did not inspect a live keychain, deliberately, per the task
   constraints, so I cannot state the real-world protection level of a NOMO
   workspace key on an operator's machine.
5. **Key rotation and multi-key verification.** `packages/security-notes.md:35`
   (S09) flags that signature verification accepts any key an injected lookup
   returns, with no rotation transition and no validity window. I confirmed the
   finding is still accurate in `packages/ledger/src/verify.ts:130-137` and
   `packages/ledger/src/attest.ts:153-159`. A write-side drill has since landed
   (2026-10-03, `packages/ledger/src/rotation-drill.test.ts`): a `KeyProvider`
   over the current key plus retired public keys verifies a chain signed by two
   keys, while every shipped surface still resolves one verification key and
   still refuses the other key's entries with `entry N has no public key for
   dev-…`. Multi-key behaviour under a *multi-key trust decision* remains
   unassessed, because no such decision exists: the trust set, the rotation
   entry record and the re-signing decision are reserved for the owner.
6. **The `verify` key-minting behaviour was not executed.** I established
   `devKeyProvider({ env })` at `packages/cli/src/verify.ts:166` omits
   `createIfMissing`, and `packages/ledger/src/sign.ts:67` defaults it to
   `true`. I did not run `nomo verify` in a clean environment to observe the key
   being created, per the no-build instruction. The code path is unambiguous.
7. **Companion/remote-gateway authorisation** was read only far enough to
   confirm it runs in the same Node process
   (`apps/control-plane/api/companion/routes.ts`, `envelope.ts`,
   `auth.ts`). I did not audit the remote gateway's own trust model.
8. **Nothing in this document was validated by execution.** No build, no test
   suite, no runtime exercise. Every code claim is from reading the working
   tree; every architectural claim should be re-confirmed by the owner before it
   is published.

---

## 9. Harness eval runner and trajectory export, 2026-11-25

This section covers two offline harness artifacts added after the original
signature analysis: `scripts/src/harness-eval-runner.mjs` and
`scripts/src/trajectory-export.mjs`. It does not widen the signature ceiling in
sections 1 to 8.

### 9.1 Eval runner trust boundary

The eval runner is a deterministic fixture, not an agent runtime. It reads one
untrusted prompt on stdin, proposes a first action by fixed rules, validates the
tool name against the governed catalog, prints one JSON decision and exits. It
does not call a model, open a socket, read the taskset's expected answer, or
use a provider credential. Unknown tools, unsafe URL shapes and known
destructive patterns fail closed as `refused`. In `--with-args` mode its
decision can carry proposed arguments. Those arguments are input to the eval
harness only, are never printed in reports, and are not measurement output.

When `--execute-workspace` is explicitly selected, the eval harness executes a
proposed managed-document operation through the production
`executeWorkspaceTool` state machine against a fresh in-memory fixture state.
Only `void_workspace_list`, `read`, `write` and `delete` are executable there.
No host filesystem path, network, provider, model or approval authority is
available. Execution success becomes part of the task verdict, and only bounded
outcome metadata is written as `nomo.eval-tool.v1`: case, variant, run, tool
name, class and completion. Arguments, results, prompts and document content
are not written.

Security consequence: prompt text is adversarial input to a parser and, in the
explicit execution fixture, to a deterministic in-memory state transition. It
still cannot cause host execution. The important residual risk is future
misuse: if a real model adapter is added, the eval decision must remain a
measurement artifact and must not become automatic authority to execute the
action outside the fixture.

The deterministic pass rate is plumbing and governance evidence only. It is not
model capability evidence and it is not reinforcement learning.

### 9.2 Trajectory export trust boundary

The trajectory exporter reads local JSONL chain records as hostile content.
Its output schema is `nomo.trajectory.v1` and its field selection is an
allowlist: case id, variant id, tool name, class, completion outcome, verifier
result and reward. Prompt text, tool arguments, tool results, arbitrary chain
fields and digest-bearing internals are never copied. Tool names and classes
must match a bounded identifier shape, so whitespace or prompt text smuggled
into those fields is refused rather than exported. Reward records must
recompute exactly; a tampered or malformed reward drops the affected case.
Summary output prints counts only.

Security consequence: an untrusted chain cannot use the exporter as a confused
deputy to smuggle prompt or tool-output content into a training artifact.
`--out` writes the operator-selected path with ordinary same-user filesystem
semantics; it is not a privilege boundary and does not protect against malware
already running as the operator.

The exporter has one integrity limitation by design: legacy direct
production-chain entries without `harnessEval` are still segmented by position,
so interleaved legacy cases in one chain can be misattributed. New production
eval runs started through `startHarnessEval` bind validated case, variant and
run identity into the signed entries they cause, and the exporter groups those
entries without position. Explicit
`nomo.eval-tool.v1` measurements are matched by case id and, after ingestion,
by the signed ingestion file digest. They therefore override positional
grouping for their own measurement. Rewards ingested from bare eval files
without those explicit measurements export with empty tool calls rather than
adopting unrelated positional entries. Bare uningested measurement files can
match repeated measurements only by case id; ingestion provenance is the precise
link. This affects measurement correctness, not secrecy.
Trailing unattributed tool calls are reported and not silently attached to a
later case.

### 9.3 Remaining harness-specific risks

| Risk | Current control | Residual truth |
| --- | --- | --- |
| Prompt or output leaks into trajectory export | Field allowlist plus sentinel tests | No leak observed; positional misattribution remains only for legacy entries without `harnessEval` |
| Tampered reward is analyzed as valid | Exact recomputation, invalid case refused | Same-user chain/key compromise remains outside signature proof |
| Eval fixture is mistaken for capability evidence | Runner and docs call it plumbing only | Human misuse of the number cannot be prevented mechanically |
| Future model runner gains network or provider access | Not present; requires explicit approval | Must be reviewed as a new trust boundary before activation |
| Offline analysis becomes training authority | Export only, no training path | No gradient RL, model training or GPU path exists |

Conclusion: the two artifacts are safe as offline measurement plumbing under
the repository's existing same-user threat model. They do not create a fleet
boundary, execution authority, model capability evidence, or an RL system.
