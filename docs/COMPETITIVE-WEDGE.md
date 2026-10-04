# Where VOID is genuinely unclaimed, and what to build because of it

Written 2026-09-26 against commit `63dbd2c` on `main`, read alongside
`docs/VOID-FUTURE-DIRECTION.md` (1202 lines, same day, known error rate),
`docs/PREMISE-VERIFICATION.md` (the adversarial check on it) and
`docs/THREAT-MODEL.md`.

This document answers one question — *where is VOID genuinely unclaimed, and
what should be built next because of that* — and it exists to be acted on, not
to summarise the repository. It is deliberately written against the two
research documents rather than alongside them: where they are right I say what
made them right, where they are wrong I give the file:line, and I do not
repeat a claim I could not check.

No existing file was modified. Where an existing document is wrong, §2 names
it and leaves it alone.

---

## 1. The answer, first

**The attribution wedge is not unclaimed, and in VOID it is half-built.** Two
projects claim the same field set — one of them at the Linux Foundation, one of
them with a sentence that is almost VOID's own pitch — and VOID binds policy and
rule on only one of its two record shapes and binds no model and no prompt on
either. That is a false published claim, not a missing feature, and it is why
attribution is not the first thing to build.

**The effect-level wedge is unclaimed as a *decision surface*, and smaller than
today's research says.** `packages/policy/src/decide.ts:163` receives a
`PolicyCall` of `{tool, connector, workspace, klass, blastRadius, unclassified}`
and `MATCH_KEYS` is `{class, tool, connector, workspace, blast_radius}`
(`packages/policy/src/grammar.ts:17-23`). Effect, readiness, resource set,
registry inverse and validity window never cross into the decision. The
268-entry Reversibility Registry has **no effect-class field at all**
(`packages/registry/src/registry.ts:24-53`). So "VOID's contract decides on what
the action did" is not true today: it decides on what the action was *called*,
plus one pre-computed class string.

**The thing that is genuinely unclaimed is narrower and better than either
wedge: a provable inversion of a non-filesystem effect, proved in the system
that was inverted.** VOID already does this for one effect and already has the
receipt in the right place, undocumented and unexploited: after restoring
PostgreSQL rows it re-reads them, refuses unless they canonically equal the
capture, and writes the result into the customer's own database —
`INSERT INTO ${schema}.recoveries(...)` at
`packages/connectors/src/postgres/managed.ts:1489-1497`. That row lives outside
`~/.void`, outside the ledger, and outside the recording process's own store.
It is the only byte VOID puts in a different trust domain as a *consequence of
its own work*, and no competitor has any equivalent. Microsoft's toolkit says
outright that its audit trail records what the agent *attempted* and does not
verify whether the action succeeded in the external world; the others record the
call and stop.

### The three things to build, in order

1. **Make the inversion provable in the system you inverted.** Promote the
   PostgreSQL recoveries receipt from a side effect into the product: give the
   S3 path the same post-write re-read and receipt, and append a signed
   `reversal` record to the same chain that a third party can check against an
   independent read of the effect's own system. *This is the only capability no
   competitor has, and it is 80% built.* **Both halves shipped after this
   document was written; see §11.8.**
2. **Make the record that authorises the effect name what authorised it.** Bind
   policy digest, rule index and rationale on the workbench record as well as
   the proxy record, and bind model id plus a digest of the outbound request.
   *Ship this in the same release as #1, not before it — alone it is
   `trace-spec`'s field set and nothing more.*
3. **Put the effect in the decision, for the two effects that exist.** A
   machine-checkable `effect` on registry cases, produced by the evaluator,
   carried into `PolicyCall`, matched by a new `effect:` key, and written into
   the signed record. *This is the actual unclaimed decision surface; it is third
   because until #1 and #2 land it is invisible to the only person who would
   notice it.*

### The strongest argument that I am wrong about #1

It is one effect. The receipt is a row in a schema the operator had to opt into;
S3's inverse is explicitly not an inverse (`packages/connectors/src/s3/inverse.ts:21`
— "A true inverse that removes the delete marker is impossible without the
marker version id, so the data returns while the marker may remain"), so the
second effect is weaker than the first; and the before-image is becoming free,
because S3 versioning, PostgreSQL logical replication with `REPLICA IDENTITY
FULL`, and Kubernetes server-side apply all hand you the previous state for
nothing. If in twelve months every effectful platform retains its own history,
"byte-exact before-image" is a platform feature and VOID's proof is a receipt
about a platform feature. **[INFERENCE]** — the primitives are confirmed in the
vendors' own documentation; the commoditisation is my reading, not a
measurement. The mitigation is to build the *proof*, not the capture: the
capture is nearly free, the signed and independently checkable statement that
the inversion happened and was verified is not, and that is what the record is
for.

---

## 2. Claims in the existing documents that are now wrong

`docs/PREMISE-VERIFICATION.md` corrected `VOID-FUTURE-DIRECTION.md` on the
MCP version count, the signing cost and the 54-run denominator. Three further
corrections, all checked against source today, all of which change what is
worth building. **I am not editing these documents.**

| Document and line | Claim | What the source says |
|---|---|---|
| `docs/THREAT-MODEL.md:206-208` and `:481-486` | `storeAttestation` / `attestLedger` "have no production caller — only tests and `scripts/src/e2e-final.mjs`" | **False.** `void attest` is a shipped command: `packages/cli/src/operations.ts:145-160` calls `attestLedger` at `:147` and `storeAttestation` at `:148`, prints a signed head, and tells the operator to publish it out of band. `Workbench.attest` is a second production caller (`packages/workbench/src/index.ts:1660-1680`). |
| `docs/THREAT-MODEL.md:183-202` (§2.4) | "Every verification path resolves the *public* key by loading the *private* key file" | **False as of this tree.** `packages/ledger/src/verify.ts:1-7` imports only `readFile`/`stat`, `GENESIS_PREV`/`entryHash`, `readLedgerReason`, `sha256Hex`/`verifySignature` and `signingPreimage` — no key provider, no key file. The key comes from `packages/ledger/src/verify-key.ts`, which resolves it from `VOID_VERIFY_KEY` (pinned-env), a trust file, or — only under the explicit opt-in `VOID_VERIFY_ALLOW_SIGNING_KEY` (`verify-key.ts:53`) — the signing key, and then labels the result `degraded: true` and prints `DEGRADED` on every surface (`verify-key.ts:171-204`). There is a regression test asserting that substituting the key file is detected by a pinned key (`verify-key.test.ts:97`) and one asserting the opposite for the degraded path (`verify-key.test.ts:188-192`). |
| `docs/THREAT-MODEL.md:212-215` | "`void verify` can mint a key" | **Stale in effect.** The CLI resolves through `resolveVerificationKey` (`packages/cli/src/verify.ts:190`) and returns `signature NOT VERIFIED` when nothing resolves (`:192-198`); `retainedKeyProvider` exists precisely to open signing state without creating it (`packages/ledger/src/sign.ts:88-92`). I did not execute `void verify` on a clean machine, so I report the code path, not an observation. |
| `docs/VOID-FUTURE-DIRECTION.md` §1.9 and the task brief | "VOID's contract decides on what the action did — effect, reversibility, readiness and resource set" | **Half false.** `decide` sees `klass` and `blastRadius` and nothing else effect-shaped. See §4.2. |
| `docs/VOID-FUTURE-DIRECTION.md` §4 | "Byte-level capture and byte-exact restore of a non-filesystem effect" is offered as VOID's one capability with a real analogue, and §9 Release 2 says the `LEGACY_BINDING_NAMES` promotion "is a week" | **Understated and mis-costed respectively.** Byte-exact S3 restore is real and tested (`packages/connectors/src/reverse-engine.test.ts:390-394`), but S3 emits **no post-write verification receipt** — `packages/connectors/src/s3/apply.ts:71` returns `{applied:[stepId], refused:[]}` immediately after `putObject`. PostgreSQL does re-read and does write a receipt. And `LEGACY_BINDING_NAMES` is three names (`packages/proxy/src/legacy-root.ts:42-46`) covering two connectors (`packages/connectors/src/registry.ts:12`) plus `filesystem.managed` and `git.managed`, which are *not* in that list and are selected by CLI config, not tool name. |

The pattern matters: **the two documents describing the current state most
optimistically are the ones whose detail is most stale, and the one that
audited them hardest got the architecture right and the delivery status
wrong.** Read `VOID-FUTURE-DIRECTION.md` for the market and
`PREMISE-VERIFICATION.md` for the corrections, and read the source for anything
that decides what to build next.

---

## 3. The competitor set, verified, and the nine nobody named

All figures read from the GitHub REST API on 2026-09-26. Download counts are
npm's `downloads/point/last-month` (2026-08-26 → 2026-09-24) and pypistats
`recent` (last 30 days). **General web search was unavailable for this entire
research pass** (Codex 429; Google, Startpage, DuckDuckGo, Ecosia and Mojeek
all bot-walled), so every external finding rests on first-party pages, the
GitHub API, PyPI/npm registries and package download counts. That is a real
limitation and it is the same one `PREMISE-VERIFICATION.md` recorded.

### 3.1 The six named in the brief

| Project | Stars | Licence | Chain / signing | What it actually does | Adoption |
|---|---:|---|---|---|---|
| `microsoft/agent-governance-toolkit` | 6,347 | MIT | Hash-chained audit, "summary commitment (root hash) returned at session end"; a saga engine whose `undo_api` is developer-supplied | Policy enforcement, zero-trust identity, sandboxing, Agent SRE, compliance; 10/10 OWASP Agentic Top 10; public preview, breaking changes expected | Largest in the category. The only one shipping a compliance story |
| `NVIDIA/OpenShell` | 8,801 | Apache-2.0 | **Neither** — plain JSONL, "both sinks rotate daily and retain the three most recent files" | Kernel controls on files and syscalls; every network connection policy-checked. Governs OS primitives, not tool calls as a semantic unit | Largest star count, and it is not doing agent audit |
| `cisco-ai-defense/defenseclaw` | 851 | Apache-2.0 | **Neither** — structured audit plus export, zero hits for Ed25519 or hash chain | Capability scanning before use, runtime traffic inspection, durable audit evidence; 14 coding-agent connectors. Explicitly "the Cisco governance layer for AI coding agents" | Moderate |
| `PrismorSec/prismor` | 377 | Apache-2.0 | Hash chain + Ed25519 + `prev_hash` over all fields | Self-hosted runtime control plane: observe / HITL approve / block tool calls before execution, local dashboard | **3,330 PyPI downloads / 30d, 98 releases, version 1.54.1.** The most-used project in this table by an order of magnitude |
| `webpro255/agentlock` | 19 | AGPL-3.0 | Hash chain + Ed25519 | Pre-action authorisation gate deciding from **session provenance, not content**; deny-by-default; parameter lineage | 961 PyPI downloads / 30d |
| `blitzcrieg1/agentmetry` | 10 | Apache-2.0 | RFC 6962 Merkle proofs, **unsigned** in the OSS core | "Local-first flight recorder"; hash-chained JSONL forwarded to Splunk HEC / Elastic ECS / CloudEvents | 10 stars, 43 open issues. Its README says "**tamper-evident is not attributable**", which is the most accurate sentence in the category |

`AndrewDryga/emisar` is 339 stars, `NOASSERTION` licence, active. Two of the six
ship neither a chain nor a signature, so the brief's "four of six chain, three
sign" is right and should be read as *signing is table stakes, and for the two
largest-star projects it is not even that*.

### 3.2 The nine nobody named, and why each one matters

Found by reading `yzhao062/awesome-auditable-ai` (149 stars, CC0, 204 entries —
"102 GitHub repositories, 16 standards"), cross-checked against the API. This
list is itself a demand artefact: somebody spent months assembling it, and its
existence is the best available evidence that this field is legible to a
practitioner audience.

| Project | Stars | Licence | Downloads / 30d | Why it matters here |
|---|---:|---|---:|---|
| **`agentrust-io/trace-spec`** | 35 | Spec: Community Specification 1.0. Code: Apache-2.0 | `pip install agentrust-trace` | **The direct attack on the attribution wedge, and it is a specification.** A **Linux Foundation project in its own series**, launched at Confidential Computing Summit 23 June 2026, spec v0.2. A TRACE Trust Record answers "what model ran" (`model.model_id` + `model.weights_digest`), "under which policy" (`policy.bundle_hash` + `policy.enforcement_mode`), "what data did it touch" (`data_class`), "which tools were called" (`tool_transcript.hash`) — "signed so any third party can check it offline", anchored to a transparency log with a SCITT receipt. 28 forks, 29 open issues |
| **`yzhao062/auditable`** | 26 | Apache-2.0 | **138 PyPI / 30d, 20 / 7d** | **Claims VOID's intended wedge almost verbatim, three months earlier** (repo created 2026-06-16). "Your logs show what the agent did. `auditable` shows what it relied on, replays it under live state, and rolls it back." Records `model_id` + `decision_basis` + a dependency snapshot in a content-addressed, chained, signed record. Its `Rail` protocol is a pluggable commit/compensate backend and the **only implementation is an in-process `ReferenceLedger` — "For demo and tests"** (`src/auditable/harness/__init__.py`). Zero required dependencies, `Development Status :: 3 - Alpha`. The flagship demo reverses a $2,083.20 payment by adjusting an in-memory float |
| **`busabase/busabase`** | 240 | MIT | **4,744 npm / 30d** | The counter-evidence with adoption. An agent workspace where "every write travels as a Change Request, so it carries a message, a diff, an author, and a full history", with field-level diffs, comments, approvals, commits and audit trails. It answers "what did the agent write to my database" with **a reviewable diff and an approval inbox, not with a signature** — and it has more monthly installs than every signed-ledger project in this report combined |
| `bkuan001/halo-record` | 80 | Apache-2.0 | 1,023 npm / 30d | "Dependency-free recorder that seals tool calls, **model calls**, and approvals into a SHA-256 hash-chained JSONL log verifiable without trusting the operator", with optional RFC 3161 timestamping and OTel GenAI span ingestion. The most direct one-tool competitor to VOID's ledger, and it is 80 stars to VOID's zero |
| `Justin0504/Aegis` | 431 | MIT | 209 npm / 30d | Runtime policy enforcement as a wrapper around agent code, "zero code changes", cryptographic audit trail, kill switch. Closest in *shape* to VOID's proxy |
| `makerchecker/MakerChecker` | 54 | AGPL-3.0 | — | RBAC, HITL approvals, segregation of duties, cryptographically signed offline-verifiable log. Static scanner + gateway |
| `KongFangXun/sofagent` | 49 | MIT | 1,021 npm / 30d | Commit-time audit engine: checks git diffs against 25 rules and writes a local hash-chained history with optional HMAC. Notable design — it audits **the change**, not the call |
| `Continuum-AI-Corp/OrcaReplay` | 267 | Apache-2.0 | — | Records a run *below the harness*, then **re-executes the agent against the recorded model responses and reports divergence**, or forks from a filesystem checkpoint onto a different model. The closest thing to "re-derive rather than observe" |
| `speakeasy-api/gram` | 271 | AGPL-3.0 | — | Connect / Secure / Observe / Distribute for agents, MCPs and skills; records searchable tool calls and permission changes. Enterprise-shaped |

**The honest summary of the whole set: fifteen projects, and not one of them
has more than 6,347 stars or more than 4,744 monthly installs.** Measured
downloads, where I could measure them: busabase 4,744 (npm), Prismor 3,330
(PyPI), halo-record 1,023 and sofagent 1,021 (npm), AgentLock 961 (PyPI), Aegis
209 (npm), `auditable` 138 (PyPI). For scale, `numpy` has roughly forty
million a month. Signing, chaining and policy enforcement in this category are
not a market. They are a set of good projects that nobody has bought, and the
two largest by stars — NVIDIA OpenShell at 8,801 and Microsoft's toolkit at
6,347 — are the two that ship no signed chain at all. That is the single most
important fact in this report, and it cuts against the whole thesis, not for it.

---

## 4. The two claimed wedges, tested

### 4.1 Attribution: claimed twice, and half-built here

**What is claimed elsewhere.** `agentrust-io/trace-spec` specifies the field set
explicitly, at the LF, with a conformance test suite and a reference
implementation (`agentrust-io/cmcp`). `yzhao062/auditable` implements a
narrower version in software, and it records `model_id` and `decision_basis`
where **VOID records no model at all**. Agentmetry names the gap in so many
words and then does not close it. So: *the attribution wedge is not unclaimed,
and the claim is held by a standards body and by a package with 138 monthly
downloads.* Neither has a product. Both have the vocabulary.

**What VOID has.** `attribution` is present on **the proxy decision record
only**. The type at `packages/ledger/src/attribution.ts:38-57` is
`{policyDigest, rule?: {index, rationale}}`, built by `buildAttribution`
(`:71-88`) and read by `readLedgerReason` (`:95-140`), which correctly keeps
"names no policy", "names a policy and no rule" and "a rule fired with no
rationale" apart.

**What VOID is missing, precisely.** Verified against source:

1. **The workbench record binds no policy and no rule.** The signed body literal
   is `packages/workbench/src/index.ts:1746-1764`: `approvedBy`,
   `approvalReason`, `workspace`, `at`, `tool`, `klass`, `decision`,
   `argsDigest`, `operationId`, `captureDigest`, `...metadata`. There is no
   `attribution` key. **This is the path that dispatches the tools.** The proxy
   record — the intercepting path — is the one that names the rule.
2. **No model identifier** in any ledger body on any path.
3. **No digest of the outbound prompt or conversation** anywhere in `packages/`.
   The session's messages are hashed only for a byte-budget check and that hash
   is not persisted.
4. **No digest of the tool result.** The proxy writes the decision *before* the
   upstream is called, by design, and discards the result. The workbench records
   a free-text `decision` string and not the result. So the chain commits to
   *what was asked for* and never to *what came back*.
5. **No AAT fields at all**: no `trust_level`, no `record_phase`, no
   `sequence_number`, no deny reason code, no heartbeat, no tombstone, no
   crosswalk document.

So the claim "VOID binds a specific claim to specific evidence, model version
and prompt" is **one fifth true on one of two paths**: it binds a policy digest
and a rule index, on the proxy path, and nothing else anywhere. That is not a
wedge, it is a defect in a published claim — and it is cheap to fix, which is
exactly why it is worth doing and exactly why it is not a moat.

### 4.2 Effect-level policy: unclaimed, and smaller than advertised

`MATCH_KEYS` is `{class, tool, connector, workspace, blast_radius}`
(`packages/policy/src/grammar.ts:17-23`). `PolicyCall`
(`packages/policy/src/decide.ts:16-34`) carries `tool`, `connector`,
`workspace`, `klass`, `blastRadius`, `unclassified`. `decide`
(`decide.ts:163`) walks rules first-match-wins. **There is no code path in
`decide.ts` that reads an effect, a readiness, a resource list, a registry
`inverse` string or a validity `window`.** Those types exist
(`packages/connectors/src/recovery.ts:4-13`,
`packages/registry/src/registry.ts:29-41`) and never cross the boundary.

`klass` is not nothing: the registry evaluator produces a tone from declared
facts plus call arguments (`packages/registry/src/evaluate.ts:15-21, 56-72`),
and `blast_radius` supports only `{lt: number}`. But it arrives as an opaque
string, and the two adapters that *do* emit effect and readiness
(`postgres/managed.ts:1232-1236`, `git/managed.ts:387-395`,
`filesystem/managed.ts:296-300`) are not on the `LEGACY_BINDING_NAMES` path and
never feed `decide`.

**The Reversibility Registry.** 268 entries, 48 vendors, 10 groups,
`REGISTRY_VERSION = "2026.09.2"` (`packages/registry/src/registry.ts:55, 70-2991`).
Per case it carries `when` (prose), `tone` (r0-r3), `inverse` (prose or null),
`window` (prose: "unbounded", "35 days"), `note`, and an optional
machine-checkable `if: Precondition`. **There is no effect-class field.** And
`case.inverse` is *display prose that nothing reads* — `searchRegistry` and
`findEntry` (`registry.ts:3053-3080`) never touch it. The repo's own docs say
270 entries; the static count is 268 and the doc's own arithmetic (163 + 107)

does not match its own arrays (161 + 107). I could not resolve which is right
and it does not matter.

So: the effect-level *decision* surface is genuinely unclaimed — every
allowlist in the surveyed market is a name matcher, and Prismor is the only
project visibly moving toward semantics (below) — but the knowledge that would
feed it is prose, and the plumbing to carry it does not exist. This is a
**week of work for two effects and a quarter of work for the registry**, which
is why it is third and not first.

### 4.3 The inverse: real for three tools, proved for one

Wired capture + inverse implementations, in full:

- `packages/connectors/src/s3/` → **`aws.s3.object.delete` only**
  (hard-coded at `s3/capture.ts:23`). Capture is `getObject`, the body is kept
  as opaque bytes and independently re-hashed (`s3/capture.ts:44-57`). Inverse
  is a `putObject` with `ifMatch`/`ifNoneMatch` (`s3/inverse.ts:16-23`). Apply
  refuses on ETag drift and re-puts with CAS (`s3/apply.ts:47-69`), and since
  `c5d32fc` (2026-09-30) the apply path returns `proveRestore(...)`
  (`s3/apply.ts:115`), which re-reads the object, compares the bytes against
  the capture and refuses rather than reporting a step it could not read back.
  *This line said "no post-write re-read" and was false against the tree by the
  time this section was amended; §11.8 has the correction.*
- `packages/connectors/src/postgres/` → **`postgres.row.update`,
  `postgres.row.delete`** (legacy capture path) **plus** the `managed` adapter
  (id `postgres-managed-<workspace>`, not a registry id). The managed path
  re-reads after writing, throws `"Restored rows did not match the capture."`
  unless the rows canonically equal the capture
  (`postgres/managed.ts:1475-1484`), then **writes a durable receipt into the
  customer's database** (`:1489-1497`).
- `packages/connectors/src/filesystem/managed.ts`, `git/managed.ts` →
  filesystem and git effects. Not a moat: git-as-undo is what Cline, Cursor,
  Aider and OpenCode all ship.
- `packages/workbench/src/managed-documents.ts` → the workspace's own documents.

That is the whole executable surface. The other ~265 registry entries —
Stripe, GitHub, Kubernetes, Twilio, SendGrid, Slack, Supabase, Azure, GCP,
Cloudflare, Vercel, Notion, Datadog, PagerDuty, IAM and more — are **description
only**. There is no capture or inverse for any of them.

**No compensation planner exists.** The adapter contract
(`packages/connectors/src/recovery.ts:43-73`) has no `compensate` method;
`compensated` is a status the adapter returns, propagated by
`runtime/src/journal.ts:22` and `runtime/src/execute.ts:939-948`. Job plans
are caller-authored and only validated (`runtime/src/recovery/plan.ts:166-168`).
The word "saga" does not occur in `packages/`. Microsoft's saga engine is the
same shape: "The Saga pattern solves this by pairing every forward action with
a *compensating action*", where `undo_api` is developer-supplied and
"`None`" means the step cannot be compensated. **On compensation, VOID's design
and Microsoft's are the same design, and neither one captures anything.**

So the real, checkable claim is this, and it is much narrower than either
document claims:

> For a PostgreSQL row mutation, VOID captures the row, restores it, re-reads it,
> refuses unless it matches the capture byte for byte, and writes a durable,
> signed receipt **into the database it just mutated** — and a third party can
> verify the restoration by querying that database, without trusting VOID, its
> key, or its ledger at all.

No competitor has any part of that sentence. That is the wedge.

---

## 5. Second-order competitors: what forms behind each wedge in twelve months

The prompt's own test: a wedge with a visible competitor forming behind it is
worth less than one nobody has noticed, and the difference is time. So here is
what is forming, dated.

**Attribution — the spec already exists and a vendor is implementing the crypto
now.**
`agentrust-io/trace-spec` published the field set on 23 June 2026. What is
missing is an implementation anyone runs. That gap closes the moment a
Linux-Project spec acquires a reference implementation with users, and
`agentrust-io/cmcp` exists as a repository. **Timing: [INFERENCE] twelve months,
low confidence, because LF incubation timelines are not public.** Microsoft's
Agent Governance Toolkit already ships a "Decision BOM" with control mappings to
OWASP Agentic Top 10, NIST AI RMF 1.0, the EU AI Act and SOC 2, and its
compliance module is the reason it has 6,347 stars. The field names are taken
in every direction at once.

**Effect-level policy — Prismor is already building facets, in the open.**
`PrismorSec/prismor#398`, opened 2026-09-11 and still open: *"Match rules on
what a command does, not on the text it carries."* It introduces
`prismor/runtime/effects.py`, which reads a shell command into four facets a
rule can name — `exec` (comments and heredoc bodies stripped), `reads`,
`writes` (redirect targets, `sed -i` targets, `tee`, `cp`/`mv`/`install`
destinations, `dd of=`, `rm`) and `net_dst` (with loopback, RFC 1918 and
link-local excluded and cloud-metadata addresses deliberately kept) — and
renders them as `<verb> <operand>` lines. The motivating evidence is good: 731
blocking findings in two live sessions, of which every inspected one was a
false positive of exactly the text-vs-effect kind. **This is the single most
threatening thing I found for the effect-level wedge, and it is not a
rumour — it is an open pull request with a diff.** It is still a shell-text
facet model with no reversibility, no readiness, no resource set and no inverse,
so VOID's *policy* claim survives it; but "decide on what the command did, not
what it carries" will be a shipped checkbox in Prismor long before it is a
default anywhere else.

**Signing and replay protection — Microsoft shipped it two days ago.**
`microsoft/agent-governance-toolkit#4132` (open, 2026-09-24) replaces ambiguous
MCP signed-field concatenation with a fixed, domain-separated v2 JSON array,
because "delimiter joining allowed different nonce/timestamp/sender/payload
tuples to produce the same HMAC input", and `#4131` makes replay-nonce claims
atomic across concurrent verifications. **This closes the loop on the brief's
"signing is no longer a differentiator": as of 24 September 2026 it is not even
a roadmap item, it is merged and hardened at a company with 6,347 stars.**

**The before-image becomes free — this is the threat to the effect wedge that
nobody is talking about.** S3 versioning is already the substrate of VOID's own
S3 inverse. PostgreSQL logical replication with `REPLICA IDENTITY FULL` gives
old row values natively. Kubernetes server-side apply makes desired state
declarative, which makes it invertible by construction. **[INFERENCE]** Every
effectful platform is converging on retaining its own history, at which point
"we captured the before-image" is a commodity claim and "we can prove the
inversion to a third party" is the only thing left to sell. That is the
strategic argument for building #1 as a *proof* rather than a *capture*, and
it is the reason the effect-level wedge is smaller than today's research says.

**The sideways attack: somebody answers the question with a diff and a human.**
`busabase` has 4,744 npm downloads a month and answers "what did the agent
change" with field-level diffs, a submitter, comments, an approval inbox and a
commit history. `sofagent` (1,021/month) audits a git diff against 25 rules and
hash-chains the results. `OrcaReplay` (267 stars) records below the harness and
re-executes to find divergence. **None of them signs anything, and all of them
have more users than the signed-ledger category combined.** If the market
converges on "show me the diff, a human approves", then the entire evidence
thesis — signed or not — is answering a question nobody is urgently asking.

---

## 6. The demand side: corroboration, and the counter-evidence

**Corroboration, in descending order of how much it should move you:**

1. **A security vendor stating on its own page that agentic testing does not
   satisfy auditors.** Bugcrowd's Savant Pathseeker page, read directly today,
   in its own comparison table: *"May not meet auditor requirements for some
   controls (e.g., PCI-DSS) on its own."* This is a vendor selling agentic
   security software telling a buyer the artefact is not auditor-acceptable.
   Note precisely what it is about: **the coverage claim, not the action
   record.** It is evidence that auditors reject an agent's own account of what
   it did. It is not evidence that they want a signed ledger.
2. **A curated list of 204 entries exists at all**, maintained by someone who
   also built `auditable`. A field that needs a 204-entry list has an audience.
3. **The regulatory clock**, carried forward from the two existing documents
   and not independently re-verified here: EU AI Act Article 12 record-keeping,
   with the Digital Omnibus moving high-risk application to 2 December 2027
   (Annex III) and 2 August 2028. Article 12 is a logging duty, not a
   cryptographic one, and a logging duty is the easiest thing in the world to
   satisfy with a JSONL file — which is what every competitor already ships.
4. **The two evidence points both existing documents lean on** — Anthropic's
   2026-09-09 incident assessment (the trail existed and was not interpretable)
   and ProjectDiscovery's behavioural audit — are first-party or
   sponsor-adjacent and were corrected in part by `PREMISE-VERIFICATION.md`
   (54 was targets, not runs; it was a third-party eval misconfiguration, not a
   sandbox escape). They survive as argument. They are not demand.

**Counter-evidence, and it is stronger:**

1. **The most-adopted product in the category answers with a human.** Busabase:
   4,744 monthly installs, a review inbox, zero cryptography. A diff plus an
   approver is what a real buyer is using to answer "what did the agent write".
2. **The most-adopted signed-ledger product is nobody.** Prismor — hash chain,
   Ed25519, `prev_hash` over all fields, pre-execution enforcement — has 3,330
   PyPI downloads a month and 377 stars. Meanwhile `numpy` has 40 million a
   month. A category where the best-solved project has three thousand monthly
   installs and one vendor has 85 open issues on a repo created in March is a
   category where **nobody is shopping**, and the honest reading of "nobody has
   built it" may be "nobody wants it."
3. **AgentLock's design position is the opposite of VOID's.** It "decides from
   provenance, not content", deny-by-default. The thesis is *prevent the
   action*, not *prove what happened after*. 19 stars, 961 downloads a month.
   Prevention is cheaper to sell and easier to demo than evidence.
4. **Microsoft's answer is to let the developer write the compensation**, not to
   capture a before-image. If the deepest-pocketed team in this market decided
   that capture is not the product, that is evidence about capture.
5. **Nobody in this market has a support ticket about this.** I found no
   security team, platform team or vendor publicly asking for signed, externally
   verifiable agent action records. `PREMISE-VERIFICATION.md` recorded the same
   absence and correctly labelled it the weakest load-bearing assumption in its
   subject. Two independent passes have now failed to find it, which makes it a
   stronger negative: **the demand is regulatory and reputational, not
   operational.** Nobody's agent run is being rolled back because the audit
   trail was not signed.

I am not recommending abandoning the product on this basis. I am recording that
the burden of proof sits on the *evidence* thesis, not on the *effect* thesis,
and that the effect thesis can be sold to someone who wants to *undo* an
effect — a need that exists today, independent of auditors.

---

## 7. The three things to build

Each one names a capability, a surface, a claim, the files, the proof of done,
and the cost. None requires money, a signing identity, hardware, a rewrite, or
a new dependency.

### #1 — Make the inversion provable in the system you inverted

- **Capability.** Every effect that has a real inverse emits a **reversal
  record**: `{reverses: operationId, effect, beforeImageDigest, verification:
  {method, observedDigest}, receiptRef, at}`. It is appended to the same
  hash-chained ledger, so the forward authorisation and the reversal sit in one
  chain. The verifier can check the reversal against an **independent read of
  the effect's own system** — for PostgreSQL, a query of the
  `${schema}.recoveries` table, which is the one artefact VOID puts outside its
  own trust domain. S3 has since taken the post-write re-read and a durable
  receipt of the shape Postgres already has (`s3/apply.ts:115` and `:166`);
  *this paragraph said it was still to be built.*
- **Surface.** `void export --bundle` carries the reversal; `void verify` says
  *"this effect was authorised, inverted, and the inversion was verified after
  it was applied; here is the field that disagrees if it was not."* That line
  is the product.
- **Claim.** *"A third party holding the bundle, the public key, and read access
  to the affected system can re-derive that a named effect was inverted to a
  byte-exact before-image and that the inversion was checked after it was
  applied — without trusting VOID's key, VOID's store, or VOID's process."*
- **Why this is next and not something else.** It is the only capability in
  this document that no competitor has any part of. It is 80% built: the
  PostgreSQL half exists and works, and the S3 half is missing a re-read and a
  receipt. It is the only recommendation that creates an asset rather than
  removing a defect. And it is the only one whose failure mode is *visible* —
  if the proof is wrong, the verifier says so.
- **Files.** `packages/runtime/src/execute.ts:497-506` (the vault slot
  `"recovery"` becomes a ledger append), `packages/connectors/src/s3/apply.ts`
  (re-read after `putObject`), `packages/connectors/src/postgres/managed.ts`
  (receipt shape, digest over the re-read),
  `packages/ledger/src/index.ts` (entry type),
  `packages/connectors/src/recovery.ts` (the `RecoveryOutcome` contract),
  `packages/ledger/src/verify.ts` (reversal check),
  `packages/cli/src/export-bundle.ts`,
  `packages/connectors/src/reverse-engine.test.ts`.
- **Proof of done.** Export a bundle containing a PostgreSQL row delete and an
  S3 object delete, plus both inversions. On a second machine holding only the
  public key and read access to the database, `void verify` reports both
  reversals verified and prints the receipt ids. Corrupt one byte of the
  `verification.observedDigest` and the verifier refuses, naming the field.
  Query `${schema}.recoveries` directly and the row is there with the same
  digest. All three agree; make them disagree and it must notice.
- **Cost.** Roughly three to five days. No new dependency, no new surface, no
  migration: a ledger written before this still verifies, and a record with no
  reversal says so rather than inventing one.

### #2 — Make the record that authorises the effect name what authorised it

- **Capability.** `attribution` on the **workbench** record as well as the proxy
  record; `model_id` and a `requestDigest` over the outbound request bound into
  both. `readLedgerReason` keeps its four-way distinction and gains the
  model/answer, so "names a policy but no model" is reportable as itself.
- **Surface.** The same `void verify` line, extended: *"this decision was made
  by rule 7 of policy sha256:…, on model X, against request sha256:…"* — and,
  for a record that predates it, *"this record names no policy"*, which is
  already how it reads.
- **Claim.** *"For every effect VOID authorised, the signed record names the
  policy, the rule, the model and a digest of the request — or says plainly
  that it does not."*
- **Why this is next and not something else — and why it is second, not first.**
  The reason it must happen at all is that the claim is currently false on the
  path that dispatches the tools, and a security reviewer can produce that in
  five minutes with `void verify`. The reason it is *not first* is adversarial
  and, I think, decisive: **done alone, this ships `trace-spec`'s field set.**
  TRACE has specified `model.model_id`, `policy.bundle_hash`,
  `tool_transcript.hash` and offline verification at the Linux Foundation since
  23 June; `auditable` has recorded `model_id` and `decision_basis` in a
  chained record since June; halo-record has sealed "tool calls, model calls,
  and approvals" since June. A vendor shipping this as a checkbox is the
  expected next twelve months. **Ship #1 and #2 as one schema change in one
  release**, so the artefact that emerges is *authorised + attributed +
  reversed*, and no single competitor has that conjunction. If you must ship
  them apart, ship #1 first and take #2 immediately after.
- **Files.** `packages/workbench/src/index.ts` (`commitWorkspace` body
  `1746-1764`; the `session.provider.complete` site at `:2072-2074` for
  `model_id` and `requestDigest`), `packages/ledger/src/attribution.ts` (extend
  `ATTRIBUTION_KEYS` and `RULE_KEYS`, keep the old bodies valid),
  `packages/proxy/src/forward/tools.ts:334-353` (same fields on the proxy
  record), `packages/ledger/src/canonical.ts` (no change — the hash already
  covers the body recursively), `packages/ledger/src/feed.ts:124` (the
  projection), plus the attribution tests.
- **Proof of done.** A workbench-written record verifies and names policy, rule,
  model and request digest. A record written before the change still verifies
  and reports "names no policy" — no migration, none invented. Tampering with
  `model_id` breaks the chain. `void verify --bundle` on a machine with no
  private key reports `integrity only` and names where the key came from, which
  is what `verificationStatus` (`packages/ledger/src/verify-key.ts:200-205`)
  already does.
- **Cost.** Roughly one to two days. One field at one call site, one shared
  builder, one test. It is the cheapest item in this document and the only one
  that fixes a published falsehood.

### #3 — Put the effect in the decision, for the two effects that exist

- **Capability.** A machine-checkable `effect` on `RegistryCase` (today: `when`
  prose, `tone`, `inverse` prose, `window` prose, `if?: Precondition`),
  produced by `packages/registry/src/evaluate.ts`, carried into `PolicyCall` as
  a new field, matched by a new `effect:` key in `MATCH_KEYS`, and written into
  the signed record beside the rule. **Start with the postgres and s3 entries
  only** — the ones that have a working capture — and say so in the registry
  version bump.
- **Surface.** `policy.yaml` gains `effect: "row.delete" | "object.delete"`, and
  a new `void policy explain <file> --tool <id> --args <json>` prints the
  effect the rule saw, not the tool name — the missing half of
  `packages/cli/src/operations.ts:58-66`, which today offers only
  `list | show | validate` and has no way to ask "what would you do with this
  call, and why". The demo: *the same tool, one read allowed and one write
  denied by effect, with the ledger record naming which effect the rule
  matched.*
- **Claim.** *"VOID's policy decides on what the action did. The same tool is
  allowed to read and denied to write, and the record says which effect the
  rule saw."*
- **Why this is third.** It is the actual unclaimed decision surface — and it is
  unclaimed only for about a year, because Prismor is already shipping
  text-vs-effect facets in an open pull request. It is third because (a) until
  #1 lands, the effect is not in the record, so nobody can see the decision
  being made; (b) until #2 lands, the record does not say who decided, so an
  effect decision is unauditable; and (c) doing it for 268 entries is not
  affordable for a single maintainer, while doing it for two is the smallest
  honest instance and is the one that makes the claim testable.
- **Files.** `packages/registry/src/registry.ts:24-53` (the `RegistryCase`
  type), `packages/registry/src/evaluate.ts:15-21, 56-72`,
  `packages/policy/src/grammar.ts:17-23` (`MATCH_KEYS`),
  `packages/policy/src/decide.ts:16-34` (`PolicyCall`) and `:163-190`,
  `packages/policy/src/rules.ts`, `packages/runtime/src/journal.ts:25-47`,
  `packages/proxy/src/forward/tools.ts:334-353`,
  `packages/cli/src/operations.ts:58-66` (the new `explain` subcommand).
- **Proof of done.** A policy with one `effect: row.read` allow and no write
  allow, against the same tool: `void policy explain` prints the effect and
  the rule index for the read and the refusal for the write; dispatching both
  through the proxy produces a ledger record for the read that carries the
  effect and the rule. A pre-existing policy file with no `effect:` key still
  loads and decides exactly as before. `blast_radius` keeps its `{lt: number}`
  shape; nothing is rewritten.
- **Cost.** About a week for two effects. The 268-entry migration is explicitly
  *not* in this item; `REGISTRY_VERSION` says what is and is not classified, and
  the evaluator already has an `unclassified` path that fails closed, so a
  partial migration is safe and honest.

---

## 8. Two things to drop from the roadmap

`VOID-FUTURE-DIRECTION.md` §9 has thirteen items across three releases and
§"What should be stopped now" has four. A roadmap that only grows is not a
strategy, so here are two more, with the reason each is costing more than it
returns.

### Drop 1 — the analysis-artefact / decompiler adapter (Release 2, direction I)

This is the item most likely to be defended emotionally, because it is the one
that makes the project's name true, and it is the one with the weakest evidence
in the entire corpus.

- **The evidence for it is one blog post.** A Hex-Rays community lead in July
  2026 saying RE tooling should be "closer to making reversing progress
  inspectable". That is a signal about supply, not demand — and
  `PREMISE-VERIFICATION.md` correctly notes the six-shard field it rests on
  (Hex-Rays' MCP server, Binary Ninja Sidekick, Ghidra 12.1.4) is the largest
  unchecked gap in the parent document.
- **The work is not "a week".** It needs an effect taxonomy for artefacts VOID
  has never touched (a function rename, a patch application, a script
  decompilation and a "mark as commented" genuinely are four effects with four
  inverses) *and* a capture/inverse for a proprietary decompiler database
  (IDB/BNDB) whose format is undocumented. The parent document's own estimate of
  "a week, not a year" is an estimate made without having opened either.
- **It re-imports the ambiguity that is the project's most expensive problem.**
  `VOID-FUTURE-DIRECTION.md` §1 and `PREMISE-VERIFICATION.md` both conclude that
  "reverse engineering" in the framing sends the distribution plan toward
  conferences and the App Store instead of `npm` and procurement. This item
  re-litigates the framing instead of resolving it.
- **And there is no inverse to be had.** A decompiler database is not a file you
  can before-image cleanly, which means the one thing VOID does well is the one
  thing it would struggle to do here.

If the flank matters, it is reached by #1 and #3 with a real database and a
real S3 bucket. Not with an IDB.

### Drop 2 — the "standardise" cluster: the OpenTelemetry GenAI proposal, MCPS tool-definition signing, and P-256 as a goal

Three items, one reason, and the reason is checkable in an afternoon.

- **You cannot standardise a record shape your own writer does not produce.**
  VOID's ledger has no `trust_level`, no `record_phase`, no `sequence_number`,
  no deny reason code, no heartbeat, no tombstone, no effect class, and no
  AAT crosswalk. Proposing those field names to a CNCF repository *before*
  emitting them would be proposing names for fields the product does not have.
  Once #1, #2 and #3 land, there is a record worth proposing — and at that
  point it is a small erratum, not a Release-3 deliverable.
- **Being the naming committee is the opposite of the strategy.** A wedge is
  being the only implementation of something. A standards proposal converts a
  capability into a *compatibility* argument, which is the definition of a
  checkbox — the exact outcome §2.3 of the parent document warns about when it
  says a vendor shipping "signed hash-chained audit" as a checkbox collapses
  the differentiator.
- **MCPS tool-definition signing is a claim MCPS makes, not one VOID makes.**
  It answers "did the client's tool definitions change under it", which is a
  proxy-routing concern. Microsoft's gateway will do it, and is already doing
  the adjacent half (PRs #4131 and #4132, 24 September 2026). P-256 is a
  procurement checkbox for FIPS-bound enterprises — and no such enterprise is a
  user of this project yet, so it is speculative compliance.

Keep the *code* if it falls out of a change you are making anyway. Drop the
*goal*.

**Also drop, if a third is wanted** (I am naming it so the omission is
deliberate, not an oversight): the Mac App Store track and the frozen
`void.companion.v1` v1.1 work, which the parent document already drops. The
companion protocol's `device.pair` defect — implemented and dispatchable but
absent from the capability catalog, because the catalog is derived from the
frozen `operations` set — is a bespoke protocol paying the tax bespoke protocols
pay, and the fix is to stop extending it.

---

## 9. Differentiator, table stakes, liability-that-looks-like-a-feature

**Differentiator, and worth building on:**

- A **verified, post-write-checked inversion of a non-filesystem effect**,
  receipted in the effect's own system. Exists for PostgreSQL; unexploited;
  nobody else has it (§4.3, §7 #1).
- A **268-entry reversibility knowledge base** with precondition, inverse
  description and validity window per case. The knowledge is the part that took
  the work; the executability is the part that has not been built. It is
  currently a liability in disguise — a reader who sees 268 entries and then
  finds three executable ones has been misled.
- **Honest reporting as a design property.** `verifyChain` verifies signatures
  only when a key is supplied and every consumer propagates the difference
  (`feed.ts:69`, `server.ts:375`); destructive operations refuse without a key
  (`server.ts:382`); `verificationStatus` prints `integrity only, verified
  against a key supplied out of band` and never says only that something was
  verified (asserted by `verify-key.test.ts:262-272`); `void attest` prints
  "retained copy … same trust domain as the ledger, so not an anchor on its
  own". **This is the most underrated asset in the repository and it is worth
  more externally than it is internally.**

**Table stakes, arriving this quarter, do not build a moat on it:**

- Hash chaining. Four of six named projects ship it.
- Signing. Three of six, and Microsoft shipped MCP message signing and atomic
  replay nonces on 24 September 2026.
- `model_id` + `policy_digest` + `tool_transcript` in a signed record. TRACE
  specified it in June; halo-record and `auditable` implement it.
- MCP dual-era. Mechanical, one revision behind, and every client currently
  speaks legacy anyway.

**Liabilities that look like features:**

- **The signed ledger in its current trust domain.** One principal records,
  signs, executes and verifies on every shipped surface. VOID already says so
  in six code paths and in `THREAT-MODEL.md`, and every one of those
  qualifications should be promoted to the README rather than buried in a review
  file. A reader who hears "ed25519-signed audit trail" and infers AAT §5.2-grade
  evidence is wrong, and the distance between the two is the whole of §5.3 of
  that document.
- **The 268-entry registry as advertised.** Knowledge that no code path reads is
  a claim, not a capability. `case.inverse` is prose that `searchRegistry` never
  touches.
- **The `attribution` claim as advertised.** True on one of two record shapes,
  with no model and no prompt on either. A defect wearing a differentiator's
  clothes.
- **The `void.companion.v1` frozen envelope.** A bespoke protocol with a
  self-declared defect that cannot be fixed without a version bump.
- **The "agentic reverse-engineering for security" framing.** Security engineers
  arrive expecting Ghidra, find a compensating-transaction runtime, and leave —
  and the cost is measurable, because it is why the distribution plan aimed at
  the Mac App Store instead of `npm`.
- **Windows.** Source-inspected only, `CredReadW`/`CredWriteW` unexercised, no
  packaging, no installed smoke. Half-claimed is worse than unclaimed: either
  produce the evidence or delete the surface from the README.

---

## 10. What I could not determine

1. **Any revenue, user-count or installed-base figure** for Microsoft AGT,
   NVIDIA OpenShell, Prismor, busabase or any other project here. Stars, forks,
   package versions and registry download counts are what I measured. Stars are
   a popularity signal, not an adoption signal, and I have no way to convert one
   into the other.
2. **Whether any security team is actually buying signed, attributable agent
   action.** Two independent research passes, mine and
   `PREMISE-VERIFICATION.md`'s, failed to find one. That is now a reasonably
   strong negative, not an absence of evidence — but I cannot rule out a private
   deal, and I did not attempt to.
3. **The general web.** Rate-limited for the whole pass (Codex 429; Google,
   Startpage, DuckDuckGo, Ecosia, Mojeek all bot-walled). Every external finding
   rests on first-party pages, the GitHub REST API, and package registries. I
   found no third-party analysis, no conference talk, no Reddit or Hacker News
   thread, and no practitioner survey on this question. If someone has publicly
   said "we evaluated signed agent ledgers and decided not to use them", that is
   exactly the evidence this report is missing and I did not see it.
4. **Antigravity CLI's governance model** — the same unexamined gap
   `VOID-FUTURE-DIRECTION.md` §10.3 named, and it could still change §3.
5. **The `trace-spec` roadmap.** Whether `agentrust-io/cmcp` is a reference
   implementation, a demo, or a stub; and what the v0.3 runtime evidence profile
   would add. I read the top-level README, not the spec or the RFC.
6. **Whether Microsoft's "Decision BOM" already binds model and prompt.** I read
   the toolkit's claims at second hand, through the awesome list and the parent
   document, not from its source. If it does, §4.1's twelve-month estimate is
   optimistic.
7. **Pricing, licensing terms and any paid tier** for every project here. I read
   licences from the API; I did not read a EULA, and several of these projects
   may restrict commercial use in a way the SPDX identifier does not show.
8. **Whether anything is currently in the repository that I did not look at.**
   I verified the two record shapes, the policy decision inputs, the registry
   type, the three wired inverses and the key-resolution path. I did not audit
   the cloud tier, the companion routes, the Windows surface, or the recovery
   planner. Every claim above is from source read today or from a named public
   page fetched today.

---

## 11. Four go-to-market objections, answered against this tree (2026-10-03)

Added 2026-10-03 after a positioning review raised four objections. Three were
already answered above with file and line; the fourth, latency, had no measured
answer anywhere in this repository, and the measurement does not say what the
pitch assumed. Nothing below changes the conclusion in §1 or the demand
reading in §6.

### 11.1 "Sell write-path blast radius, not AI safety"

Half-true today, and the half that is false is measurable. `PolicyCall` carries
`klass` and `blastRadius` into `packages/policy/src/decide.ts:163` as *inputs*
(`grammar.ts:17-23`), and §4.2 already shows the registry has no effect field,
so the decision reads a number rather than computing one. The one path that
measures radius is the Postgres cascade capture, which is also the only place
the number can be wrong in the dangerous direction. "Blast radius control" is
therefore true for Postgres and a claim elsewhere. Closing that is §7 #3, not
a copy change.

### 11.2 "Universal undo is impossible; yours is Postgres and S3"

Agreed, and §4.3 already says it with the count: `aws.s3.object.delete`,
`postgres.row.update`, `postgres.row.delete` plus filesystem and git, proved for
one (Postgres, with the receipt written into the customer's own database). The
other ~265 registry entries are description only. The adapter contract
(`packages/connectors/src/recovery.ts:43-73`) has no `compensate`, so "the
inverse of a Stripe charge" is not a gap in the implementation, it is a gap in
the design, and the honest pitch is prevent-or-bound-and-prove, never undo.

### 11.3 "Prove sub-millisecond overhead"

Measured, and it is not sub-millisecond. `node scripts/src/bench.mjs --scale
200`, this machine, in-process echo, real signed fsynced ledger:

| | ops/sec | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| forward | 69.49 | 14.01 ms | 17.98 ms | 19.98 ms |
| ledger-append | 151.21 | 6.39 ms | 8.28 ms | 9.96 ms |
| classify | 1352684 | 0.0004 ms | 0.0021 ms | 0.0028 ms |

Ledger serialization is a separate probe at p50 0.0025 ms and is not part of
the append figure. Read the table this way: **the policy decision is free**
(classify runs 1.35M times a second, four orders of magnitude under a
millisecond), and **the durable write is the cost**: 6.4 ms p50 on this disk,
about 45% of a forward call. The rest of the forward figure is the in-process
echo and the per-call clock the harness adds.

So the claim to make is not "VOID is free". It is "the decision costs nothing
measurable, and the durability write costs 6.4 ms". The lever is the fsync
policy, batching or a durability tier, which is a product decision with a
compliance trade-off attached and not a performance bug in the proxy. No latency
figure should leave this repository until the tier exists and the number is
taken on a named disk.

### 11.4 "Sell the ledger as audit compliance; keys can be compromised"

The tree is stricter than the pitch and already says so. `packages/security-notes.md`
row S08 records that the default trust file shares a directory tree with the
private key, that substituting both together is silent, and that the attack was
executed. `docs/OPERATIONS.md` says a signature proves the bytes came from a
process holding a specific key and little more. Anchors exist
(`packages/ledger/src/anchor.ts`) and nothing publishes them, so no independent
party holds a root hash. The dependency-free checker
`packages/verifier/verify-ledger.mjs` is the honest third-party story and it is
fed its keys by the operator, which is the same trust boundary in a different
hat. "Audit compliance" is sellable today only for the Postgres receipt,
because that is the one artefact a third party can verify without VOID.

### 11.5 Cloudflare, and what it can and cannot absorb

Cloudflare appears in neither §3.1 nor §3.2, so this is additive. **Re-read
2026-10-04 against the product documentation itself** (Zero Trust AI Controls,
MCP server portals, page last updated 2026-10-02; fetched and cited in the
Appendix), which says more than the review under test assumed.

It is a distribution threat rather than a feature competitor: MCP traffic
governance at the edge, bundled into an account a team already pays for. It can
absorb guardrails, per-tool policy and request audit into that bundle, which is
most of §9's table stakes, without writing a connector. The portal also curates
and aliases tools and prompts, collapses every upstream tool into two via Code
Mode, and can route through Gateway for DLP.

The part that changes the assessment is enforcement rather than features. A
portal that refuses a bypass is a **chokepoint**, and VOID is a proxy inside that
chokepoint rather than beside it.

What it cannot get from an edge is the part that has to understand the write: a
per-effect before-image for a customer's table, an inverse that re-reads and
refuses on drift, and a receipt the customer can verify without us. That is a
seat in the data path with database semantics, which is a different company
from the one that terminates TLS.

But §6 binds harder than this does. The category has no buyers at this install
count, so a competitor arriving with distribution does not take a market that
does not exist. Fixing the latency claim is worth more than answering
Cloudflare.

### 11.6 "Nobody has built this exact combo"

Not true as written, and the correction matters. `yzhao062/auditable` claims the
same wedge almost verbatim three months earlier (§3.2), `Justin0504/Aegis` is
the same shape as VOID's proxy (runtime wrapper, cryptographic trail, kill
switch), and `PrismorSec/prismor` is the most-installed signed project measured,
at 3,330 downloads a month. What is true is narrower: **none of them captures a
before-image and publishes a verifiable inverse.** VOID has that for Postgres
row mutations and nothing else. The wedge is the inverse, not the ledger, and
the ledger is the part fifteen projects already ship.

### 11.7 What this changes

1. The sellable claim is Postgres: capture, restore, re-read, refuse on drift,
   and a receipt written into the customer's own database, which a third party
   can check without trusting us. S3 now proves the write the same way
   (§11.8), but its receipt stays inside VOID's own evidence, so it is not yet
   the same claim. Everything else is roadmap, and §4.3's count says how much.
2. Publish a latency figure only with a named disk and a durability tier.
   Today's honest line is "6.4 ms of fsynced append, decision cost
   unmeasurable", not "sub-millisecond".
3. Distribution risk is real and is not the first-order risk. Per §6 the
   first-order risk is that nobody is shopping, and no objection in this section
   changes that.

### 11.8 Two of this document's own build recommendations have shipped

This document was written against `63dbd2c` on 2026-09-26 and its own method
says to read the source, not the documents. Re-running that method finds that
§7's first two recommendations were built four days later, in `c5d32fc`
(2026-09-30), and this document was never updated to say so. `c5d32fc` is the
commit that shipped both the S3 post-write re-read and the signed reversal
records; it is an ancestor of `main` and of every branch since.

**§7 #1, "make the inversion provable in the system you inverted".** The S3
apply path returns `proveRestore(...)` (`packages/connectors/src/s3/apply.ts:115`),
which re-reads the object through the same client, compares the bytes against
the capture, and refuses rather than reporting an applied step it could not
read back; the durable `RestoreReceipt` is written at `:166`. Signed reversal
records exist (`packages/ledger/src/reversal.ts:55-65`) and every verifier
enforces them: a reversal naming a record this run has not already proven is
refused (`packages/ledger/src/verify.ts:125-134`,
`packages/ledger/src/store.ts:186-195`). So §9's differentiator line, "the
post-write-checked inversion exists for PostgreSQL", now holds for S3 too.

**§7 #2, "make the record that authorises the effect name what authorised
it".** Shipped with the same change: the policy digest, rule and request digest
on the workbench record, read back on the verification path above.

**§7 #3, "put the effect in the decision", is the one still open**, and §4.2
still holds against the current tree: `PolicyCall` carries no effect,
readiness or resource set, so the decision reads a class string rather than
the effect.

What this does *not* change is §11.4. The Postgres receipt is still the only
artefact written into the customer's own system, and therefore still the only
one a third party can verify without trusting VOID, its key or its ledger. The
S3 receipt lives in VOID's own evidence and proves what its own docblock says:
the code compares what it wrote against what it reads back, over an in-memory
client in every test in this repository.

---

## Appendix — sources

**This repository, at `63dbd2c` (read directly, not via documentation):**
`packages/policy/src/decide.ts`, `grammar.ts`; `packages/registry/src/registry.ts`,
`evaluate.ts`; `packages/ledger/src/attribution.ts`, `canonical.ts`, `verify.ts`,
`verify-key.ts`, `verify-key.test.ts`, `sign.ts`, `store.ts`, `feed.ts`,
`attest.ts`, `anchor.ts`; `packages/proxy/src/forward/tools.ts`, `bin.ts`,
`legacy-root.ts`; `packages/workbench/src/index.ts` (`:1660-1788`, `:2041-2104`);
`packages/connectors/src/recovery.ts`, `registry.ts`, `s3/{capture,inverse,apply}.ts`,
`postgres/managed.ts`, `filesystem/managed.ts`, `git/managed.ts`,
`reverse-engine.test.ts`; `packages/runtime/src/execute.ts`, `journal.ts`,
`recovery/plan.ts`; `packages/cli/src/verify.ts`, `operations.ts`,
`export-bundle.ts`; `apps/control-plane/api/server.ts`.

**Competitors, verified 2026-09-26 via the GitHub REST API and their own pages:**
- `microsoft/agent-governance-toolkit` — repo metadata; PRs
  [#4132](https://github.com/microsoft/agent-governance-toolkit/pull/4132) and
  [#4131](https://github.com/microsoft/agent-governance-toolkit/pull/4131),
  both 2026-09-24
- `NVIDIA/OpenShell`, `cisco-ai-defense/defenseclaw`, `webpro255/agentlock`,
  `blitzcrieg1/agentmetry`, `PrismorSec/prismor`, `AndrewDryga/emisar` — repo
  metadata and READMEs
- `PrismorSec/prismor` PR
  [#398](https://github.com/PrismorSec/prismor/pull/398), "Match rules on what
  a command does, not on the text it carries", opened 2026-09-11, open
- `agentrust-io/trace-spec` — repo metadata and README; the LF-project claim
  and the 23 June 2026 launch date are the project's own statements
- `yzhao062/auditable` — repo metadata, README, `src/auditable/harness/__init__.py`,
  `record.py`, `chain.py`, `pyproject.toml`; `yzhao062/awesome-auditable-ai` —
  full README, four sections read
- `busabase/busabase`, `bkuan001/halo-record`, `Justin0504/Aegis`,
  `makerchecker/MakerChecker`, `KongFangXun/sofagent`, `Continuum-AI-Corp/OrcaReplay`,
  `speakeasy-api/gram`, `agentkitai/agentlens`, `wavect/semaprax`,
  `slopstopper/plumb-line`, `FU-max-boop/agentrunproof`, `ceodaradigu/proofline-agent`
  — repo metadata and READMEs

**Demand, fetched directly 2026-09-26:**
- <https://www.bugcrowd.com/products/pathseeker/> — the "May not meet auditor
  requirements for some controls (e.g., PCI-DSS) on its own" line, present
  verbatim in the page's own comparison table
- npm `downloads/point/last-month` for `busabase`, `halo-record`, `sofagent`,
  `aegis`, `agentlens`, `agentlock`; pypistats `recent` for `auditable`
  (138/30d), `prismor` (3,330/30d), `agentlock` (961/30d)
- <https://www.postgresql.org/docs/current/logical-replication-publication.html>
  (REPLICA IDENTITY); <https://kubernetes.io/docs/reference/using-api/server-side-apply/>
  (server-side apply) — the platform-native before-image primitives

**Measured 2026-10-03 on this machine:** `node scripts/src/bench.mjs --scale
200` — smoke-grade, in-process echo upstream, real signed fsynced ledger, no
warmup, no network, no subprocess transport. The §11.3 table is this run. Also
read today for §11.8: `packages/connectors/src/s3/apply.ts` (`:115` `proveRestore`,
`:166` `RestoreReceipt`), `packages/ledger/src/reversal.ts` (`:55-65`),
`packages/ledger/src/verify.ts` (`:125-134`),
`packages/ledger/src/store.ts` (`:186-195`).

**Fetched 2026-10-04:** Cloudflare MCP server portals, Zero Trust AI Controls,
<https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/>
(page last updated 2026-10-02), read directly. It covers centralised portals, tool and prompt
curation and aliasing, Code Mode, optional Gateway routing for DLP, and shadow-MCP detection
with portal-only enforcement that blocks direct connections bypassing approved portals (reported
2026-09-19). §11.5 is answered against this page rather than against the review under test.

**Carried forward from the two existing documents and not re-verified here:**
Anthropic's 2026-09-09 alignment assessment; ProjectDiscovery's behavioural
audit; the EU AI Act Article 12 dates; the MCP `2026-07-28` revision and what
it changed; MCPS
`draft-sharif-mcps-secure-mcp-01`; the Hex-Rays / Binary Ninja / Ghidra 2026
timeline. These are the claims `PREMISE-VERIFICATION.md` corrected, and I have
used them as corrected rather than re-deriving them.

**Standards re-read 2026-10-04, both moved since this document was written:**

- `draft-sharif-agent-audit-trail` is at revision **-06** (Standards Track, 29 September 2026),
  where the documents in this repository carry -05. Nothing in the tree depends on the revision
  number today, but any claim that VOID emits the standard format has to be re-checked against
  -06 before it is made.
- `draft-sahu-agent-action-receipts-00`, "Signed, Hash-Chained Action Receipts for AI Agents",
  N. Sahu, 16 August 2026, Informational, with `draft-marques-asqav-compliance-receipts` in
  progress. **This is VOID's central claim written down by someone else.** It validates the wedge
  and removes "we sign the ledger" as a differentiator in the same stroke, because the shape is
  now public. What survives is §4.3's sentence: the receipt lands in the effect's own system, so
  a third party verifies it without trusting VOID, its key or its ledger. No draft claims that.
