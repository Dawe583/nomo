# VOID operations runbook

This runbook is for the dev-tier product in this repository. For the operator
guide that walks through using the product end to end, see
[the VOID handbook](HANDBOOK.md) or [its Czech edition](HANDBOOK.cs.md).

## Policy grammar quick table

Policy files are YAML. Version 1 uses ordered rules. First match wins.

| Field | Required | Shape | Meaning |
| ----- | -------- | ----- | ------- |
| `version` | yes | `1` | Policy grammar version. Unknown versions fail closed. |
| `rules` | yes | list | Ordered rules. Put narrow rules before broad rules. |
| `match.class` | no | `r0`, `r1`, `r2`, `r3`, or list | Reversibility class after registry evaluation. |
| `match.tool` | no | string or list | Tool id, for example `postgres.row.delete`. |
| `match.connector` | no | string or list | Connector id, for example `postgres` or `s3`. |
| `match.workspace` | no | string or list | Workspace name. |
| `match.blast_radius` | no | `{ lt: n }` only; other operators are load errors | Measured blast radius comparison. |
| `decision` | yes | `allow`, `deny`, or `hold` | What the proxy does. |
| `seconds` | for hold | whole number from 1 to 900 | Hold timeout. |
| `notify` | no | `cli`, `slack`, or list | Approval channels. |
| `rationale` | recommended | string | Human reason shown in denials and holds. |

Unknown keys and unknown values are load errors. A missing or invalid policy denies startup in fail-closed posture.

Starter shape:

```yaml
version: 1
rules:
  - match:
      class: r0
    decision: allow
    rationale: fully reversible calls can proceed after ledger append
  - match:
      class: r1
      blast_radius: { lt: 100 }
    decision: allow
    rationale: small reversible writes are below the hold line
  - match:
      class: [r2, r3]
    decision: hold
    seconds: 120
    notify: [cli]
    rationale: visible or permanent damage needs a human decision
  - match: {}
    decision: deny
    rationale: deny anything the policy did not name
```

## Ledger directory layout

The dev-tier ledger is JSONL.

```text
<VOID_LEDGER_DIR>/
  <workspace>.jsonl
  attestations/
    <head-seq>.json
```

If `VOID_LEDGER_DIR` is not set, the default ledger directory is under the user's home directory. The development private key is not in the ledger directory by default. It comes from `VOID_SIGNING_KEY` or from the local development key path managed by `devKeyProvider`.

### The verification key is not the signing key

Verification reads a **public key**, and in every shipped default that public
key comes from a file inside `~/.void/`, the same directory tree as the
private signing key. The table below is the resolution order and, in the
last column, what each answer is actually **worth**. Read the last column
before treating any verification result as tamper-proofing.

| Source | How it is set | Worth |
| --- | --- | --- |
| `VOID_VERIFY_KEY` | base64 SPKI DER of the ed25519 public key | **pinned, out of band.** Supplied as a value, never written to a file. This is the only source that earns the word *pinned*. |
| `VOID_VERIFY_KEY_FILE` | path to a file holding that key | Trusted **because you named the path**. VOID infers the bytes are yours from the path alone and cannot prove who wrote them. Worth a pin only if the agent has no credentials for that path. |
| `VOID_TRUST_DIR` | directory holding `verify-ed25519.spki` | Same as above: trusted on the strength of the path, not the contents. |
| `~/.void/trust/verify-ed25519.spki` | written once by `void init --pin-verify-key` | **Not pinned.** This is the default, and it shares `~/.void/` with `keys/dev-ed25519.pkcs8`. See below. |
| `VOID_SIGNING_KEY` | base64 PKCS#8 private key | **Degraded.** The key that signs is the key that verifies. |
| `VOID_VERIFY_ALLOW_SIGNING_KEY=1` | explicit opt-in to the local `keys/dev-ed25519.pkcs8` file | **Degraded.** The same file, reached by opting in. Undocumented opt-ins are how operators end up in a mode they did not choose, so every surface now names this variable. |

#### Why the default trust file is not a pin

The trust file is created with mode `0400`. That refuses an in-place write by a
different user. It stops **nothing** for its own owner, who may `unlink` it and
create a new file in its place. An attacker who can replace
`~/.void/keys/dev-ed25519.pkcs8` can equally replace
`~/.void/trust/verify-ed25519.spki`, re-sign the entire local history with a key
of their own, and have it verify clean.

This was executed, not assumed. The attack lands: after `unlink` and recreate
of the `0400` trust file alongside a replaced key file, the resolved key reports
`source: trust-file`, `operatorSupplied: false`, `degraded: false`, and the
forged chain verifies `ok=true`. See `docs/EVIDENCE-FIXES-VERIFICATION.md` (F1).

The trust file stays at the default path on purpose. There is no location on a
single-user host that a same-uid attacker cannot also write, so moving it buys
no security and would silently strand every key already provisioned at the old
path. The honest response is to say so on every surface, which is what VOID
does.

#### What the one-key-id binding does and does not buy

A key is bound to the one key id the records carry. An entry signed by any other
key fails with `has no public key for <key id>`.

This detects key substitution **only when the verification key is itself out of
the agent's reach**. That means `VOID_VERIFY_KEY`, or a trust file at a path the
agent has no credentials for. It does **not** mean replacing
`dev-ed25519.pkcs8` is always detected: if the trust file is replaced alongside
it, the substituted key becomes the anchor and the forged chain verifies. The
original text of this section claimed the detection was unconditional. It is not,
and the correction is the point of this section.

Against the agent itself, every shipped default proves close to nothing. The
recorder, the signer and the verifier run as one OS principal, so the signature
establishes that the bytes came from a process holding a specific key, and
nothing more. See `docs/THREAT-MODEL.md` §1.1 and §2.4.

#### Provisioning

```sh
node packages/cli/bin/void.mjs init --pin-verify-key     # anchors ~/.void/keys/dev-ed25519.pkcs8
node packages/cli/bin/void.mjs init --from-spki <base64> # anchors a key you hold elsewhere
```

`--from-spki` is the one that anchors something the agent did not choose, and
the output says so. `--pin-verify-key` anchors whatever
`~/.void/keys/dev-ed25519.pkcs8` holds at that moment and detects only a *later*
change to it; if the key file was already replaced, it pinned the wrong key.
Compare the SPKI the command prints against the key you expect.

Two key files exist under `~/.void`, and only one of them is the trust anchor:

| Path | Signs | Trust anchor? |
| --- | --- | --- |
| `~/.void/keys/dev-ed25519.pkcs8` | the ledgers in `~/.void/ledger`, verified by `void verify` | **Yes.** The one `--pin-verify-key` anchors, and the key `void doctor`, `void watch` and the TUI proxy resolve against. |
| `<data dir>/keys/dev-ed25519.pkcs8` (default `~/.void/workbench/keys`) | the workbench document ledger | No. A second recorder identity, not a second location for the first. |

`--data-dir` chooses where workspace state lives. It does not choose which key
is anchored, and it did not used to: the command derived the anchor from
`<data dir>/keys`, so on the default path it anchored the document key while
every ledger under `~/.void/ledger` was signed with the other one. The trust
anchor changed identity without a ledger being written, and `void doctor` read
as an improvement. When the data dir holds a key of its own, the command now
prints both key ids and says which one it anchored.

The command never creates a key. If `~/.void/keys/dev-ed25519.pkcs8` does not
exist it refuses and names the path; a pin of a key whose only existence is the
act of pinning it anchors nothing and reads as a success.

The command also reports what the anchored key has signed, read from the
`key_id` the ledger entries carry rather than from the key file. An anchored
key that appears in no ledger entry is named as such, together with the key ids
that did sign, because `void verify` will refuse every existing ledger until
they are re-signed with it.

`pinVerificationKey` refuses to overwrite an existing trust file with a
different key, and says so. Removing it deliberately to repin is the supported
way to change the anchor; see "Key rotation" below for what a real rotation
story would need.

#### What every surface reports

With nothing configured, every surface reports
`verification key: none, signature NOT VERIFIED` and checks hash links only.
`void verify` and `void export`/`void attest` print the key line first,
`/api/ledger/verify` returns it as `verificationKey`, and the TUI and `void
watch` render it beside the signed boolean.

The word *pinned* appears only where it is earned, meaning a key supplied as
a value or on a command line. A trust file at any path is reported as `trust-file`,
because reading a file is not what makes verification strong or weak; sharing a
directory tree with the signing key is. Every trust-file answer carries a
caveat, and the API carries `substitutionDetected` next to `authenticated`
because "a signature checked out" and "key substitution would be detected" are
different claims.

#### Key rotation

Rotating the signing key is **not supported today**, and the failure is
asymmetric in a way worth knowing before you try it.

What happens: entries signed by the retired key carry its `key_id`, the
verification key is the new one, and the chain is refused with
`entry 1 has no public key for dev-ed25519:<old id>`. `void attest` exits 1 with
that error naming a key id the operator never asked about. `void export
--ledger` does not verify, so it can still succeed, and a workflow that
exports after a rotation and then attests will discover the problem at the
second step.

There is no in-command way out. `pinVerificationKey` refuses a different key,
and there is no key-id allowlist in the pin.

Deliberately not built here, and why. A rotation story needs all of the
following, and each one changes a persisted artifact or a trust decision:

1. **A trust set in the pin.** The trust file holds one base64 SPKI. A
   rotation needs a *set* of key ids the verifier will accept, with a
   transition where old and new overlap. That is a format change to a file
   operators already have on disk, with its own migration and its own backup
   story.
2. **A decision about re-signing.** Either the ledger is rewritten under the
   new key, which destroys the very history the anchor set was protecting, or
   the old entries keep the old `key_id` and both keys stay trusted, which
   means a compromised old key stays valid forever. There is no obviously
   correct answer here, and picking one silently is worse than not shipping.
3. **Anchor and attestation interaction.** Anchors and attestations are signed
   by a named key id. After a rotation, an existing anchor names a key the
   verifier no longer trusts, and `void verify --anchors` starts failing on
   anchors that were valid when written. That is a second format decision.
4. **Revocation.** "Accepted" and "still trusted" are different. Without a
   revocation story, an allowlist only ever grows.
5. **A `void` command for it.** Not a library function. `void init
   --rotate-verify-key` would have to print what it is about to stop trusting,
   because the operator is trading a guarantee for a different one.

Until those exist: pin out of band with `void init --from-spki`, keep the old
public key somewhere you control, and treat a rotation as a deliberate
re-anchoring: re-provision the trust file with the new key and accept that the
pre-rotation entries will not verify against it. That is a documented cost, not
a supported flow, and it is why the surfaces above say what the key is worth
rather than that it is pinned.

**Drill evidence, 2026-10-03.** None of the above is shipped, and nothing in
this drill changes any of it. What landed is the write side and a test that
pins the exact line between the two. `packages/ledger/src/sign.ts` gained
`devKeyRing(dir)`, a `KeyProvider` that answers `publicKey(id)` for the
current key and for every retired public key under `<dir>/retired/<keyId>.spki`,
and `rotateDevKey(dir)`, which retires the outgoing key's public SPKI and
installs a freshly generated private key through the same O_EXCL 0600 path as a
first run. `sign(input, keyId)` now honours the key id its own interface
declares and throws a named error instead of signing with whatever key it
holds. In `packages/ledger/src/rotation-drill.test.ts`, a chain of two entries
under key A, a rotation, and two entries under key B verifies as one chain
(`checked === 4`, key ids `[A, A, B, B]`) through the ring and through
`jsonlStore.verify`. What still fails, in that same file, is the shipped
trust decision: resolving the verification key the way every surface does, one
key, refuses the same chain with `entry 1 has no public key for dev-…`. The
test asserts that refusal rather than working around it, so the follow-up
cannot move the boundary quietly. The trust set in the pin, the decision about
re-signing pre-rotation entries, the rotation entry record, revocation and the
`void` command remain open and reserved: each one changes a persisted artifact
or a trust decision, and none of them is implied by a signer that can produce
a two-key chain. The ring only grows: a retired key stays answerable for as
long as its `.spki` is on disk, and nothing in this drill removes one, so a key
retired here is retired, not revoked.

Each JSONL line is one stored entry with:

- workspace
- sequence number
- body, containing time, tool, class, decision, and argument digest
- previous hash
- entry hash
- key id
- algorithm
- signature

The ledger stores argument digests, not payloads.

## Fail-closed guarantees

In `fail-closed` posture, VOID denies when it cannot keep the safety contract.

It denies on:

- unknown tool
- unclassified call
- unreadable or invalid policy
- ledger append failure
- invalid facts file
- internal proxy error
- missing ledger directory at startup

It also refuses to start when the fail-closed posture has no ledger directory. A call cannot forward without its decision being recorded.

## What fail-closed does not guarantee

Fail-closed is not an identity system, a backup product, or a production KMS.

It does not guarantee:

- that declared facts are true
- that a human approval was authenticated
- that a local JSONL store is safe for multiple writers
- that R2 or R3 calls can be undone
- that a replay is safe after target drift
- that connector credentials exist
- that production Postgres or S3 is wired by default

Use it as a safety gate for the agent write path. Do not treat it as proof that the target system is healthy.

## Verify a ledger or export

Use `verify` before trusting any feed, replay, taint graph, or attestation.

```sh
node packages/cli/bin/void.mjs verify --ledger <ledger-dir-or-file>
```

To verify a ledger against an attestation:

```sh
node packages/cli/bin/void.mjs verify --ledger <ledger-dir-or-file> --attestation <attestation-json>
```

To verify a ledger against a published anchor file:

```sh
node packages/cli/bin/void.mjs verify --ledger <ledger-dir-or-file> --anchors <anchors.jsonl>
```

The verifier checks sequence order, previous hash links, body hashes, and
signatures when a key is available. A failure exits non-zero and names the
first bad entry. An anchor is only checked when a verification key is
available: without one, the command refuses rather than accept a claim it
cannot authenticate.

## Export bundles with a completeness proof

`export --bundle` writes a bundle of four sections and a manifest. The manifest
is written last, so a directory that exists always describes bytes that are on
disk.

```sh
node packages/cli/bin/void.mjs export --ledger <ledger-file> --state <state-dir> --bundle <bundle-dir>
```

`--state` is the recovery state root the backup script reads: it holds
`journal/<workspace>.jsonl` and `vault/`. It is required, because a bundle that
cannot declare its journal and vault sections is not a complete bundle.

The sections are:

- `ledger.jsonl`: the verified workspace ledger
- `journal.jsonl`: the operation journal, replayed through the transition tables on export and on load
- `vault-manifest.json`: the vault inventory, by digest and byte length; artifact bytes stay encrypted at rest and are not copied
- `capability.json`: what this build can export, the ledger read limits, and the operation and recovery-job stage universe read from the journal transition tables

Each section carries its own record count, byte length and SHA-256, and each
signed section carries the sequence range it claims. Record the printed
`manifest sha256` out of band. That anchor is the completeness proof: a
history whose tail was cut is still internally consistent, so a reviewer
without an anchor cannot tell an honest bundle from a rewritten one.

```sh
node packages/cli/bin/void.mjs export verify --bundle <bundle-dir> --anchor <manifest-sha256> [--state <state-dir>]
```

Verification is fail closed. A missing section, a digest or byte-length
mismatch, a record count that disagrees with the bytes, a sequence range the
section does not carry, a journal that does not replay, or an anchor that does
not match exits non-zero and prints no `complete true`. Export refuses the same
way when the journal is missing, and writes no bundle directory at all.

Without `--state` the verifier still checks digests, counts, ranges, chains and
transitions, and reports `journal signatures not checked` rather than implying
an authentication it did not perform. With `--state` the retained key is used
and the journal signatures are checked.

This proves what the bundle contains. It does not prove the vault bytes are
recoverable, and it is not an operational certification.

## Metrics

`metrics` recomputes counters from the ledger, journal and vault that already
exist. Nothing new is persisted, so the numbers can be thrown away and
recomputed at any time.

```sh
node packages/cli/bin/void.mjs metrics --ledger <ledger-file> --state <state-dir> [--format text|json]
node packages/cli/bin/void.mjs metrics --ledger <ledger-dir> [--format json]
```

Counter families: ledger files, entries and bytes, decisions by the closed
`allow`/`deny`/`hold`/`other` set, the transition table sizes, journal events,
operations and per-stage counts for every stage in the table, open operations,
and vault artifacts, bytes and reservations.

The label sets are closed and there is no PII, no secret and no workspace label
in a sample name. A named ledger must verify before it is counted, and a
command that cannot read the journal fails rather than reporting a quiet zero.
A directory scan is the exception and the reason it exists: it counts the
ledgers that could not be read (`void_ledger_files_unreadable_total`) apart from
the ones that were read and did not verify
(`void_ledger_files_rejected_total`). Stages that never happened are reported as
zero, so failed, unknown and conflict work cannot be hidden by omission.

Not covered: capture latency, reconciliation time, recovery success rate and
connector coverage. They need timestamps and receipts this surface does not
claim to read.

## Attestation flow

An attestation is a signed summary of a ledger slice. It lets a reviewer check a head sequence, head hash, entry count, Merkle digest, key id, algorithm, and signature without trusting a VOID process.

### The anchor is what makes truncation detectable

A chain verifies clean on any prefix, so a dropped tail is invisible to
`verifyChain`. An anchor is a signed `{headSeq, headHash, treeDigest}` that
somebody else holds. Publish one with:

```sh
node packages/cli/bin/void.mjs attest --ledger <ledger-file> --anchor <anchors.jsonl>
```

`attest` verifies the chain against the verification key above, signs the head,
writes the retained local copy under `<ledger dir>/attestations/<head-seq>.json`,
and appends the signed head to the anchor file you name. The anchor file is
appended to, never rewritten, and a head that goes backwards or conflicts in it
is refused.

**Where the anchor file lives decides what it is worth.** It is an anchor only
for as long as the agent process cannot write it: a path the OS denies the
runtime, a read-only mount, a copy a third party keeps, or a file forwarded out
of band. An anchor file inside the directory the agent already writes detects
nothing the local chain check did not, and the command says so on every write.

What an anchor does: it makes truncation, omission and rewriting of the
anchored prefix detectable by whoever holds the anchor, and it survives the
ledger being rewritten because the attacker would have to re-sign the anchor
too. What it does not do: it does not stop the agent rewriting local history,
and it does not stop the agent from never writing records it omits. An
attacker who runs the agent can decline to anchor, and the missing newer
anchor is the signal. This is **detects tampering by a third party, not by the
agent itself**, not non-repudiation, and not a claim of trust level L2.

`export verify` accepts the same document against a bundle, where the manifest
digest anchor and the signed head compose: the digest proves the bundle is the
one that was published, the head proves the ledger inside it is the one that
was anchored.

```sh
node packages/cli/bin/void.mjs export verify --bundle <bundle-dir> --anchor <manifest-sha256> --attestation <anchor.json>
```

Operational flow:

1. Stop or quiesce the write path for the slice you want to attest.
2. Verify the ledger.
3. Generate the attestation document with the ledger package.
4. Store it under the ledger directory.
5. Send the ledger slice, attestation, and public key material to the reviewer.
6. The reviewer runs verify with the attestation path.

The local product sweep exercises this path:

```sh
node scripts/src/e2e-final.mjs all
```

## Feed

The feed prints only after the ledger verifies.

```sh
node packages/cli/bin/void.mjs feed --ledger <ledger-file>
```

Use JSON for scripts:

```sh
node packages/cli/bin/void.mjs feed --ledger <ledger-file> --json
```

Use `--follow` for a live local view. It stays attached until the process is closed.

## Approvals

The proxy surfaces held calls through a per-run state directory. One proxy owns a directory at a time.

Start the proxy with a state directory:

```sh
node packages/proxy/bin/void-proxy.mjs --upstream node --args fixtures/e2e-server.mjs --policy fixtures/e2e-policy.yaml --ledger-dir /tmp/void-ledger --approvals-dir /tmp/void-approvals --workspace demo
```

Without `--approvals-dir`, the proxy defaults to `$VOID_APPROVALS_DIR`, then `~/.void/approvals/<workspace>`.

List pending holds from a second terminal:

```sh
node packages/cli/bin/void.mjs approvals --dir /tmp/void-approvals
```

Approve or deny a hold:

```sh
node packages/cli/bin/void.mjs approve <holdId> --by <actor> --reason <text> --dir /tmp/void-approvals
node packages/cli/bin/void.mjs approve <holdId> --by <actor> --deny --dir /tmp/void-approvals
```

The CLI writes a decision file and prints that the decision is queued. The running proxy polls the directory and resolves the hold. The CLI cannot know whether the proxy was still running when the decision landed, so it never claims the release.

State directory layout:

```text
<approvals-dir>/
  pending.json
  proxy.lock
  decisions/
    <nonce>.json
```

Recovery: `proxy.lock` exists while a proxy owns the directory. If the proxy crashed, remove the stale `proxy.lock` by hand and start a new proxy. A live second proxy refuses the directory with `ApprovalStateInUseError` rather than sharing state.

Every hold carries a per-hold nonce. A stale decision file cannot be replayed onto a later hold with the same id after a restart.

In this repository, approvals are development surfaces. They are not authenticated. In process, the SDK exposes hold handles that can decide a pending hold through the approval broker, and the local control-plane pages can render and decide them over HTTP for development use.

## Replay and drift refusal

Replay is only valid for R0 and R1 calls with a captured inverse. The connector must find a snapshot manifest entry that matches the ledger argument digest and tool.

The binary wires the static connector set. Check what is wired and which executors are available:

```sh
node packages/cli/bin/void.mjs replay --list-connectors
```

Executors come from the host environment. For Postgres, set `VOID_PG_URL` before apply. Without it, apply fails with a typed `ExecutorNotConfigured` error that names the missing variable. S3 replay additionally needs a host adapter and persisted replay metadata, which the local binary does not write yet. The connector end-to-end script proves replay and drift refusal in process:

```sh
node scripts/src/e2e-connectors.mjs
```

Drift refusal means the current target no longer matches the captured before image. Operationally:

1. Do not retry the same replay blindly.
2. Inspect the drift report.
3. Decide whether the later human or system change is now the source of truth.
4. If the original change still needs rollback, create a new manual plan against current state.
5. Record that manual action separately.

VOID refuses drift to avoid overwriting later human work.

## Taint

Taint uses the verified ledger to show what later calls depend on a prior call.

```sh
node packages/cli/bin/void.mjs taint --ledger <ledger-dir-or-file> --seq <n>
```

Use JSON for tooling:

```sh
node packages/cli/bin/void.mjs taint --ledger <ledger-dir-or-file> --seq <n> --json
```

Data edges require `outputDigest` on a producing ledger entry. Entries without output digests can still produce resource edges.

## Policy packs

Three ready-made policies ship in `packages/policy/packs`. Load them with `loadPack` from the policy package, or point the proxy at the YAML file directly.

- `dev.yaml`: R0 to R2 allowed, every R3 held for 60 seconds with CLI notification.
- `balanced.yaml`: R0 and R1 allowed, R2 held for 300 seconds, R3 denied.
- `strict.yaml`: only R0 allowed, everything else denied.

Packs fail closed: a broken pack file is a load error, never a silent fallback to a default policy.

## Control-plane pages

The local control-plane serves dashboard pages that poll the feed, the approvals surface, and chain verification:

```sh
node --input-type=module -e "import { listenControlPlane } from './apps/control-plane/api/server.ts'; const h = await listenControlPlane({}); console.log(h.port);"
```

The pages are development surfaces with no authentication. Approve and deny buttons post to the decision endpoint of the running server instance.

## Local benchmark

The smoke benchmark measures the proxy write path on this machine. Its numbers are smoke-grade, not release benchmarks:

```sh
node scripts/src/bench.mjs --scale 200
```

## Proxy startup

Stdio fixture command:

```sh
node packages/proxy/bin/void-proxy.mjs --upstream node --args fixtures/e2e-server.mjs --policy fixtures/e2e-policy.yaml --ledger-dir /tmp/void-ledger --workspace demo
```

HTTP upstream builds in wave 4 use this shape:

```sh
node packages/proxy/bin/void-proxy.mjs --transport http --upstream-url <url> --policy <policy-yaml> --ledger-dir <ledger-dir> --workspace <workspace>
```

Use `observe` only for trials:

```sh
node packages/proxy/bin/void-proxy.mjs --upstream node --args fixtures/e2e-server.mjs --policy fixtures/e2e-policy.yaml --posture observe --workspace demo
```

## Web and cloud production build

Run `pnpm run build` from the repository root. Vercel uses the same command
but on its own Node runtime: Vercel offers 20.x, 22.x, and 24.x (default),
so Node 26 is a local and CI target only, never the Vercel runtime
(source: `vercel.com/docs/functions/runtimes/node-js/node-js-versions`,
fetched 2026-09-16). It builds the Vite GUI, bundles the Nitro cloud
backend and workflows, and validates `.vercel/output` before deployment.
The validator requires the frontend entrypoint and its referenced assets, the
Node API handler, the API route, and response streaming support.

`pnpm build:web` remains the frontend-only command used by desktop packaging.
A successful frontend build alone does not establish that the cloud build works.

## Secret rotation boundary (no production KMS)

Local secrets live in the AES-256-GCM snapshot, macOS Keychain, Windows
Credential Manager, or a mode-0600 key file. There is no production KMS in
this tree. Rotating `VOID_SIGNING_KEY` today means generating a new key,
redeploying, and running `scripts/src/provision-cloud.mjs`; old signed rows
verify only against the key that signed them. A KMS-backed rotation drill
is an open release gate (`docs/RELEASE.md` blocker 10, `docs/PLAN-GAPS.md`
item 10), not a procedure documented here.
The frontend launcher also supports direct `node scripts/src/build-web.mjs`
invocation without `npm_execpath`, as used by older Vercel project settings.
