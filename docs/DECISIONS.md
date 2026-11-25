# NOMO: decision log

The seven decisions taken before any product code was written, why each was
taken, and what was rejected. Written 4 September 2026, at WP-00.

Three deciders wrote independent logs from three biases (fastest to a demo,
safest to operate, cheapest to run and maintain by one person) and four readers
mapped the repository. This file is the synthesis. It is not an average: each
decision names one winner, and where a losing log had the better answer for a
sub point, that sub point was grafted in and is marked as such.

Read this with `docs/CONTEXT.md` and `docs/STANDARDS.md`. Those three files are
the context pack. They are authoritative: when the code disagrees with the pack,
the code is wrong. When the pack is wrong, the fix is a work package that
updates the pack, never an agent that quietly diverges.

Everything below is evidence based where evidence was available. Claims marked
**verified** were run on this machine during WP-00 and the command is given.
Claims marked **unproven** cannot be checked without a deploy or an account, and
are called out so nobody later mistakes a guess for a measurement.

**Documents this log cites by name may be retired.** A work package may update
the pack; older sections are history and are not rewritten. On 2026-10-09,
commit 98d2261 retired the superseded sales and status documents from the active
branch, and this log's earlier sections still cite the words they were decided
against: GO-TO-MARKET-10K-MRR, COMPETITIVE-WEDGE, REVERSE-WEDGE, OPEN-WORK-AUDIT,
STATUS-INDEX, PLAN-STATUS and ROADMAP-2026-Q4 under `docs/`. Read those citations
as dated evidence for the decision they carry, not as pointers to live files;
their tier and pricing claims remain unvalidated hypotheses, and no decision
here depends on their current availability.

---

## 1. The wedge: one agent host, one tool surface

**Decision.** Which agent host and which tool surface the first end to end path
runs through, and what is explicitly out of scope until it works.

**Choice.** Agent host: any MCP capable client, with Claude Code as the
reference implementation, over the **stdio transport only**. Tool surface: one
Postgres MCP server, its write tools, against a non production database. The
default posture is **fail closed**: an unknown tool, an unclassified call, a
ledger append failure, a missing or invalid policy file, or a proxy internal
error all resolve to deny. Observe only mode is an explicit opt in flag, never a
fallback. Preconditions come from **declared configuration**, not probes.

Out of scope until an agent has been held on a real R3 Postgres write and the
write has been proven not to happen: the Streamable HTTP transport (WP-02),
every connector other than Postgres including S3, probing of any kind, the
speculative hold with provisional receipts, the taint graph, the hosted control
plane, Slack and Teams approvals, multi tenancy, billing, SSO, the SDK wrap, and
any expansion of the registry beyond the 89 entries that exist.

**Rationale.** BUILD-PLAN section 2 gives four reasons for Postgres and all four
hold, but the decisive one for this repository is the fourth plus a fifth the
plan does not state: you control both sides, and here both sides are already on
the machine. PostgreSQL 16.13 is installed, cluster 16/main is initialised at
`/var/lib/postgresql/16/main`, and `pg_ctlcluster 16 main start` brings it up
with nothing to install (**verified**). So every exit criterion in WP-03, WP-05
and WP-06 runs locally, for zero dollars, with the undo confirmed by opening a
database client rather than asserted against a mock. A reversibility layer whose
undo has only ever been observed through its own test doubles is not something a
reviewer can sign off. Stripe is the better demo and the worse first build for
the reason BUILD-PLAN gives, and for a second one: nearly every Stripe write is
R2 or R3, so a Stripe demo proves the hold and never proves the undo, and the
undo is the differentiated half.

The narrowing to stdio goes further than BUILD-PLAN, which puts both transports
in phase 1. Streamable HTTP means an inbound listener, session identifiers,
Origin and DNS rebinding validation, TLS and bearer auth sitting in front of
someone's database: a second security surface, opened in the same week the
forwarding logic is written for the first time. It is also the only shape where
NOMO holds no credentials at all, which keeps the first security conversation
short. EXECUTION-PLAN already splits this as WP-01 and WP-02, so the narrowing
costs nothing structurally.

Grafted from the losing logs: fail closed as the default posture and the non
production database rule (safest); `notifications/progress` stays in scope for
phase 1 even though the rest of the notification surface is thin, because a
blocking hold is a tool call that does not return for up to 120 seconds and
without progress the client's own timeout, not the operator, decides the outcome
of the demo (fastest); and the explicit statement of what the narrowing costs
(cheapest), below.

**What this narrowing costs, stated so nobody rediscovers it as a surprise.**
MCP only means agents calling tools through a raw SDK or LangChain are
unreachable until WP-14. Postgres only means the demo says database, not money,
which is the weaker story for selling. Stdio only means there is no shared team
gateway, so the Team tier in GO-TO-MARKET section 4, which is defined by a
hosted control plane, is structurally blocked until WP-02 and WP-10 exist.
Declared facts mean a classification is only as honest as the operator's config
file, which is the limitation BUILD-PLAN section 7.1 names and which must stay
visible in the product rather than buried. Fail closed means a NOMO crash
becomes an outage of the agent's write path: availability traded for safety,
which is the right direction here but must be documented for the first user.

**On phase 1's exit criterion.** Keep it as written: run a real agent session
twice, once direct and once through the proxy, and diff the transcripts. It is
the only check that catches silent divergence. Narrow the scope, not the rigour:
the session is a stdio Postgres session, and message types that session never
emits (`resources/*`, `prompts/*`, `list_changed`, reconnect) are still
forwarded and are proven by unit test rather than by transcript.

| Rejected                                                                    | Why not                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe or another payments surface first                                    | Needs an account, keys and an internet reachable webhook before line one, so it costs money and standing surface before the first user. Nearly every call in it is R2 or R3, so the product only ever says no and never says undone. A development mistake touches someone's real money.                              |
| Both transports in phase 1, as BUILD-PLAN writes it                         | Doubles the code under review in the riskiest week and adds an inbound listener, session state, Origin checks and an auth surface in front of a database. Deferred to WP-02 with localhost binding, Origin validation and a required bearer token as its own exit criteria.                                           |
| SDK wrap or a framework plugin first                                        | Binds NOMO to one framework's agent loop, which BUILD-PLAN section 8 names as the mistake that turns a framework agnostic layer into a competitor to the framework. It also defers the transport work rather than saving it. It is the natural second deployment shape, at WP-14.                                     |
| Filesystem or shell MCP server as the first surface                         | Fastest to intercept and impossible to compensate honestly. A file delete has no keyed before image you can restore without copying the payload, which collides with the rule that NOMO stores references and digests, never payloads. It produces a hold demo with no path to a replay demo.                         |
| A general purpose HTTP egress proxy classifying any outbound API call       | No tool identity, no arguments, no target state, so classification degrades to URL matching. 74 of the 89 registry entries change class with configuration, so URL matching is wrong most of the time.                                                                                                                |
| A gateway across several MCP servers at once                                | Every classification bug is then spread across surfaces with different auth, snapshot formats and failure modes. A plausible but wrong interceptor is worse than none.                                                                                                                                                |
| NOMO holding its own read only credentials per connector, to enable probing | BUILD-PLAN section 7.1 names this as the mistake that turns a proxy into an agent platform. It gives NOMO standing access to customer systems, which is a much larger security review and a much longer sale. Declared facts ship first, probing through the upstream server's own read tools is the phase 6 upgrade. |
| A production database for the first end to end run                          | Prohibited by BUILD-PLAN section 3 and by EXECUTION-PLAN section 2. The first run of an unproven interceptor is the least safe moment there has ever been to break that rule.                                                                                                                                         |

**Revisit when.** The phase 4 moment runs end to end (an agent attempts a real
R3 Postgres write, a human cancels it, the write never happens, the agent
recovers) **or** a design partner commits to paying for a surface NOMO does not
yet intercept. Either event reopens the tool surface. The transport reopens
separately, at the first request for a remote or shared proxy, which is WP-02.

---

## 2. Storage: where the ledger lives and what append only means

**Decision.** What the ledger writes to, how append only is enforced, and what
happens when there is no database.

**Choice.** Two stores behind one narrow interface, and **no memory mode at any
tier**. The interface is `append`, `read`, `head` and `verify`, and nothing
else: no `update`, no `delete`.

_Dev tier, the default:_ an append only JSONL file per workspace at
`NOMO_LEDGER_DIR` (default `~/.nomo/ledger/<workspace>.jsonl`), directory mode
0700, file mode 0600, opened `O_APPEND`, one JSON object per line, `fsync`
before the append is acknowledged. The signing public key and the latest signed
checkpoint are written beside it so the store is self contained for the
standalone verifier. No `DATABASE_URL` is read and none is needed.

_Hosted tier:_ Postgres, in a dedicated schema named `ledger`, **never** in
`public`. The DDL is raw SQL, applied forward only by `packages/ledger`'s own
migrator, with each migration file's sha256 recorded in a `ledger.migrations`
table. `drizzle-kit` never touches the `ledger` schema and may at most declare
the table for typed reads.

_Append only is four layers, in ascending order of what they actually protect:_

1. **The type system.** `packages/ledger` exports `append` and `read` and no
   mutation, per BUILD-PLAN line 167, so a caller cannot form the intent.
2. **Postgres grants.** Schema, table and trigger function are owned by a
   `NOLOGIN` `ledger_owner` role. The application role holding `DATABASE_URL`
   gets `USAGE`, `SELECT` and `INSERT` only.
3. **Triggers.** `BEFORE UPDATE` and `BEFORE DELETE` per row, `BEFORE TRUNCATE`
   per statement, all raising `restrict_violation`. Plus
   `UNIQUE (workspace, prev_hash)` so a chain fork is a database error rather
   than a quiet second branch, and a `CHECK` pinning `hash` to the form
   `sha256:` followed by 64 hex characters.
4. **The chain and the per entry signature.** The only layer that survives an
   attacker who owns the database.

_The append is one serialised transaction per workspace:_ begin,
`pg_advisory_xact_lock` on the workspace, read the head, compute, insert,
commit, with the unique constraint as the backstop and a single re-read and
retry on a unique violation.

_With no `DATABASE_URL`:_ resolve `NOMO_LEDGER_URL`, then `DATABASE_URL`, then
the local JSONL store if its directory is writable, and log which store was
chosen exactly once at startup. If none can be opened durably, `append` throws,
and because the proxy fails closed the intercepted call is denied with an MCP
error naming the reason. The ledger never returns a receipt for a record it did
not persist.

**Rationale.** The dedicated schema is not a preference, it was measured. With a
populated `ledger_entries` table in `public` that was not declared in
`lib/db/src/schema/index.ts`, this repository's own documented migration
command, `pnpm --filter @workspace/db run push-force`, dropped the table, its
row and all three append only triggers and printed `[done] Changes applied`,
because `DROP TABLE` does not fire a `BEFORE DELETE` trigger (**verified**). The
identical test with the table in a dedicated `ledger` schema reported
`No changes detected` and left everything intact (**verified**). So the
marketing site's tooling and the audit record are structurally unable to
collide, which is worth more than the tidiness of one schema.

The privilege split was tested too. As the application role, `UPDATE` and
`DELETE` were refused with `permission denied for table entries` before the
trigger even ran, `DROP TRIGGER` was refused with
`must be owner of relation entries`, and `ALTER TABLE ... DISABLE TRIGGER ALL`
with `must be owner of table entries` (**verified**). That is the property that
matters: the runtime `DATABASE_URL` is the credential most likely to leak, and
its holder must not be able to disarm its own audit trail. Grants stop the
ordinary path, triggers catch the privileged path, ownership stops the guard
being removed, and the chain plus the signature is what holds against a database
superuser, who bypasses all three. That last limitation is honest and belongs on
the `/docs/ledger` page in those words, and it is exactly why the record is
signed rather than merely constrained.

The JSONL default is what makes the free Dev tier in GO-TO-MARKET section 4
actually free, what makes install and try in sixty seconds possible, and what
lets a contributor run the test suite without provisioning a database. A ledger
is a sequential append and a whole file read, which is what a file is best at,
and JSONL is greppable, diffable and directly consumable by the standalone
verifier. The cheap tier is not the untrustworthy tier: because the chain and
the signature carry the guarantee, a JSONL ledger is exactly as tamper evident
as a Postgres one. It is not tamper _proof_, and the docs must say so in those
words.

Fail closed is the one place we refuse this repository's existing habit.
`api/_store.ts` degrades to memory with `stored: false` and `lib/db` throws at
import time, and both are wrong for a ledger: writing an audit record into a
process local array that dies with the process, while still returning a receipt,
manufactures false evidence, which is worse than a refusal.

Grafted from the losing logs: `fsync` before acknowledgement, the migrations
table with per file digests, and the per workspace advisory lock (safest); the
public key and checkpoint sidecar and the single startup line naming the chosen
store (cheapest); layer zero, the type system, stated first because it is the
layer that prevents the intent rather than catching it (fastest).

**Three prior art defects fixed on the way in, none cosmetic.**
`api/_store.ts:90` reads the previous hash in one statement and inserts in
another with no transaction and no lock, so two concurrent requests link to the
same predecessor and the chain forks with nothing detecting it.
`api/_core.ts:64` returns a display string, `0x` plus 8 hex characters, and
`api/_store.ts:94` writes that into the `hash` column, so the persisted chain is
linked by 32 bits: birthday collidable in roughly 65 thousand attempts, and
impossible to verify independently because the full digest was never stored.
`api/_store.ts:57` memoises a null pool, so one transient failure at first
request pins the process to memory mode until restart, with one log line as the
only trace.

**Two adjacent fixes land with WP-03, because they are in the same code and are
cheap now and expensive later.** `lib/db/src/index.ts:7` throws at import time
on a missing `DATABASE_URL`, and `replit.md:88` says the mitigation lives in
`storage.ts`, which does not exist anywhere in the repository, so the guard rail
is gone while the hazard is intact: `packages/ledger` owns its own `pg` pool and
never imports `@workspace/db`, and that gotcha is corrected in the same commit.
`lib/db/drizzle.config.ts:4` throws on a missing environment variable, which
breaks the standing rule recorded twice in this repository: it falls back to a
placeholder URL and lets the connection fail with a real message.

**What this costs.** `fsync` is a millisecond or two per dev append on SSD. The
per workspace advisory lock serialises appends, so one workspace tops out in the
low thousands per second and does not scale by adding proxy instances; at the
Team tier's one million actions a month that is orders of magnitude of headroom,
and the alternative is a chain that forks under load. JSONL is single writer per
file, so two proxy processes on one workspace need the Postgres path. Reads are
linear, so a ledger browser over a million entries is a Postgres tier feature
and always will be. Raw SQL DDL means this repository now has **two** migration
mechanisms, which must be written into `replit.md` and `README.md` in the same
commit or the next agent will not know the second one exists.

| Rejected                                                            | Why not                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Postgres required in every tier                                     | Kills the free Dev tier that GO-TO-MARKET sells as a local ledger, forces every contributor and trial user to provision a database, and makes the trivial WP-00 test depend on infrastructure. Adoption of a safety layer is itself a safety outcome.                                                              |
| The ledger table in the `public` schema next to `waitlist_requests` | Verified destroyed by this repository's own documented migration command, with a success message and no error. A ledger that a routine developer command deletes is not a ledger.                                                                                                                                  |
| Declaring the ledger in Drizzle and pushing it with `drizzle-kit`   | `drizzle-kit` 0.31 cannot express a trigger, a grant or an owner, so it would reconcile the columns while silently leaving a mutable table wearing the name ledger. `push` is a live reconciler with no history, no reviewable artifact and no rollback, including `DROP`.                                         |
| Triggers alone, without the ownership and grant split               | A trigger is owned by the table owner and the table owner can drop it, so triggers alone are a speed bump for whoever holds the connection string. Verified: with the split, the application role cannot drop or disable them.                                                                                     |
| Memory fallback matching `api/_store.ts`                            | Correct for a marketing waitlist, catastrophic for an audit record: the append path stops being durable while every response still returns a receipt. Consistency with a policy that trades durability for uptime is not a virtue in the one component whose entire value is durability.                           |
| SQLite or libsql for the dev tier                                   | Either a native dependency added under the 1440 minute `minimumReleaseAge` gate, or `node:sqlite`, which is still experimental on Node 22. For an append only log that is only ever scanned forward, a file with one JSON object per line gives the same durability with zero install and a diff a human can read. |
| Object storage (S3, R2) as the ledger sink                          | No append semantics, so every entry is a PUT with per request cost and network latency inside the write path, and the free tier stops being free and offline.                                                                                                                                                      |
| A managed ledger service (QLDB, a hosted transparency log)          | Monthly cost, vendor lock, and it moves the root of trust to a third party at the exact moment the product's claim is that verification is offline and needs no trust in us.                                                                                                                                       |
| Filesystem immutability (`chattr +a`, WORM) for the dev tier        | Not portable, needs privileges a developer will not grant to try a tool, and it would imply a guarantee the free tier cannot make.                                                                                                                                                                                 |
| Reusing the `waitlist_requests` chain shape                         | A chain by convention only: `prev_hash` and `hash` are nullable non-unique text, nothing stops an `UPDATE`, the digest is truncated to 32 bits, and the read of the head is outside the insert's transaction.                                                                                                      |

**Revisit when.** A single workspace needs more than one concurrent proxy
process, **or** a customer asks for a ledger browser over more than roughly a
million entries, **or** the first paying Team tier customer exists. Any of those
makes Postgres the default rather than the hosted option. The JSONL store is
never removed: it is what the free tier and the test suite run on.

---

## 3. The signing key path

**Decision.** What signs a ledger entry, what the interface looks like, where
the key comes from in development and in production, and what is signed.

**Choice.** ed25519 through `node:crypto`, **zero new dependencies**, signing
**every entry** rather than only the head, plus a periodic signed checkpoint
over the head for the attestation export.

The interface is frozen now, is **asynchronous from the first line**, and never
returns private key material:

```ts
type Alg = "ed25519" | "ecdsa-p256-sha256";

interface KeyProvider {
  readonly alg: Alg;
  currentKeyId(): Promise<string>;
  sign(input: Uint8Array, keyId?: string): Promise<Uint8Array>;
  publicKey(keyId: string): Promise<Uint8Array | null>; // SPKI DER
}
```

`key_id` is derived from the key, not chosen: `ed25519:` plus the first 16 hex
characters of the sha256 of the SPKI public key, so an id cannot be silently
reused for a different key. It is a `NOT NULL` column on every entry.

The signed input is domain separated, versioned, and binds the algorithm and the
key: the ASCII bytes of `void.ledger.v1|<alg>|<key_id>|` followed by the full 64
character entry hash. The stored signature is tagged: the algorithm, a colon,
then base64. Signatures cover the hash rather than the body, so signature
checking is independent of canonicalisation once the verifier has recomputed the
hash from the body.

In development the private key comes from `NOMO_SIGNING_KEY` as base64 PKCS8 if
set. If unset, `packages/ledger` generates one on first append into
`~/.nomo/keys/<key_id>.pkcs8` at mode 0600, prints one loud line saying a
development key is in use, and gives the id a `dev-` prefix. The verifier
reports an entry signed by a `dev-` key as **valid, development key**, never as
plain valid. In production the same interface is backed by KMS and no calling
code changes. Rotation appends a rotation entry into the chain itself, signed by
the outgoing key and naming the incoming key id, alongside a keys record
carrying `key_id`, `alg`, SPKI, `not_before` and `not_after`.

**sealHash is rewritten, not lifted.** BUILD-PLAN line 218 says lift it and do
not reinvent it. Lifting it verbatim would be wrong three times over.
`api/_core.ts:62` canonicalises with
`JSON.stringify(payload, Object.keys(payload).sort())`. The second argument is a
replacer **allowlist**, not a sort order: it is computed from top level keys and
applied at every nesting depth, so `{email, meta: {ip, utm}}` canonicalises to
`{"email":...,"meta":{}}` and every nested value is erased from the preimage
(**verified** in node). Tool call arguments, snapshot descriptors, policy
decisions and connector metadata are all nested by nature, so the first real
ledger entry would be unauthenticated while looking sealed. `api/_core.ts:64`
then truncates to 8 hex characters. So `packages/ledger` gets a recursive
canonicaliser with explicit handling of `undefined`, non-finite numbers and key
order at every depth, a version tag and a domain separator in the preimage, and
the full 64 character digest persisted, truncated only at the render boundary.
This is half a day and it is not optional: WP-13's standalone verifier is
impossible against a truncated chain, and the tamper forger in WP-03 would
otherwise pass.

**Rationale.** **Verified** on this machine on Node 22.22.2:
`crypto.generateKeyPairSync("ed25519")`, `crypto.sign(null, ...)` returning a 64
byte signature, `crypto.verify` returning true, PKCS8 export and JWK public
export all work with nothing installed. That is the entire cryptographic
dependency budget for the product's central claim, which is the correct budget,
and in a security product a userland curve library is the single worst place to
spend supply chain risk.

The decisions that are expensive to reverse are the ones taken now for free:
`sign` is async because every KMS is a network call and turning a synchronous
signature asynchronous later is a change at every call site, at exactly the
moment production is being set up under time pressure. `sign` is the only
method, and there is no `getPrivateKey` or `exportKey`, so the unsafe code
cannot be written rather than merely being discouraged. `alg` is a field rather
than a hardcode because Ed25519 is not offered by every KMS (AWS KMS signs
ECDSA and RSA), and discovering that after a million signed entries would make
an algorithm change a break in the stored format. `key_id` is on every entry
because a signature you cannot attribute to a key is unverifiable after the
first rotation. Domain separating and binding `alg` and `key_id` into the
preimage defeats substitution and downgrade replay.

Signing every entry rather than only the head is a deliberate deviation from
BUILD-PLAN phase 2. It costs tens of microseconds and one text column, and it
means an exported slice verifies on its own, which is the whole of WP-13 and of
the per entry `signature` field the site already publishes at
`artifacts/nomo/src/pages/docs.tsx:106`.

Grafted from the losing logs: the `alg` field, the alg-bound preimage and the
in-chain rotation entry (safest); the `dev-` key id prefix and the verifier's
distinct verdict (fastest); the tagged signature string, the checkpoint, and the
honest limitation statement (cheapest).

**One correction to a published contract.** `/docs/ledger` lists `signature` but
not `key_id`. That is an omission, and the site copy is updated in the same
commit as WP-03, in both the English and Czech surfaces.

**What this cannot claim.** An environment or file key means whoever compromises
the host can forge future entries. Past entries are protected only to the extent
that a checkpoint was published somewhere the attacker does not control. The
honest claim is tamper evident against the database, against the operator's
future self, and against us, not against a live compromise of the machine the
proxy runs on. A KMS sign call is roughly 20 to 60 milliseconds in the write
path of every intercepted call; if that is measured to hurt, the growth path is
a session key, where KMS signs a short lived certificate binding a locally
generated public key to the workspace and a validity window. Build that only if
the latency actually hurts, because it adds a second thing for a reviewer to
check.

| Rejected                                                                  | Why not                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HMAC with a shared secret                                                 | Verification requires the secret, so anyone who can verify can forge. That makes "verifiable by someone who does not trust you" false and the attestation export in phase 9 worthless.                                                                                                     |
| Signing only the chain head, as BUILD-PLAN phase 2 literally says         | A partial or period export cannot then be verified without the whole chain, per entry attribution to a key is lost after a rotation, and it contradicts the per entry `signature` field already published on `/docs/ledger`. Signing is tens of microseconds, so there is nothing to save. |
| JOSE, JWS, COSE or a detached signature envelope                          | Standards weight and a dependency with a long history of algorithm confusion vulnerabilities, for one algorithm, one key and 64 bytes. It also buys a spec to implement in a verifier that is supposed to be small enough to read.                                                         |
| libsodium, tweetnacl, noble-ed25519                                       | A new dependency behind the 1440 minute release age gate for a primitive the platform already implements, and a supply chain surface in the one component whose job is to be trustworthy.                                                                                                  |
| A `KeyProvider` with `getPrivateKey`, `exportKey` or a synchronous `sign` | Exported key material eventually reaches a log or a crash dump, and a synchronous signature makes a KMS implementation impossible without rewriting every caller.                                                                                                                          |
| Hardcoding ed25519 with no `alg` field                                    | Blocks AWS KMS, the most common enterprise ask, and turns a later algorithm addition into a format break for every entry already written.                                                                                                                                                  |
| Requiring `NOMO_SIGNING_KEY`, with no auto generated development key      | Safer, and it puts a setup step in front of the demo and in front of every contributor's first test run. The `dev-` prefix plus a distinct verifier verdict recovers the safety at a fraction of the friction.                                                                             |
| Sigstore or a public transparency log                                     | An external service and an availability dependency in the write path, disproportionate at one user. Worth revisiting as a paid attestation feature.                                                                                                                                        |
| X.509 and a small PKI                                                     | Certificate lifecycle management for a solo operator, to solve a key distribution problem that one public key file next to the ledger already solves.                                                                                                                                      |
| One key shared between development and production, or a key with no id    | Rotation becomes unverifiable after the first rotation, and a development key that can sign production entries makes every entry's provenance a guess.                                                                                                                                     |

**Revisit when.** The first customer asks for bring your own KMS (an Enterprise
tier feature in GO-TO-MARKET section 4), **or** a measured KMS signing latency
exceeds the hold budget in the write path, **or** an auditor asks for an
algorithm this interface does not carry.

**WP-03 implementation notes, recorded because they sharpened the frozen
contracts.** `LedgerStore` grew its second type parameter into two: `Body`
is what the caller brings, `StoredEntry` is what the file holds, because the
append takes a payload and read yields the payload plus chain metadata, and
conflating the two let a type error through where the caller's body was
silently expected to carry seq and prev_hash. The dev key file is written
O_CREAT|O_EXCL after an adversarial review reproduced a pre placed symlink
capturing the private key through the write, and a concurrent first start
adopting a different key per process via last write wins; the loser of the
O_EXCL race now reads back the winner's key. A line with an unsupported
algorithm tag is a named finding at that entry, never a thrown TypeError,
because a verifier that crashes on line one of a hostile file stops checking
exactly where the hostility starts. The canonicaliser refuses payloads nested
deeper than a thousand levels with a named error rather than a RangeError
stack dump.

---

## 4. The policy format

**Decision.** How an operator expresses which calls are allowed, held or denied.

**Choice.** Declarative YAML match rules, exactly as BUILD-PLAN phase 4
sketches, first match wins by file order, parsed with the `yaml` package and
validated by a **strict** zod schema. No expressions, no regular expressions, no
boolean operators, no nesting, no interpolation, no evaluator.

The whole grammar for version one: a required top level `version: 1`, then an
ordered list of rules. Each rule has a required stable `id`, a `match` object,
and a decision.

Match keys, and there are exactly five: `class` (one of r0 to r3 or a list of
them), `tool` (an exact id or one **trailing** wildcard such as
`postgres.row.*`), `connector`, `workspace`, and `blast_radius` taking `lt`,
`lte`, `gt` or `gte`. Keys within one `match` are an implicit AND. A list of
values within one key is an OR. Decisions: `allow`, `deny`, or `hold` with
`seconds` and `notify`.

Four properties make it growable without a breaking change, and they are the
decision, not the grammar:

1. `version: 1` is required from the first file written, and an unknown version
   is a load error rather than a guess.
2. **An unknown key or an unknown value anywhere is a loud load error, never
   ignored.**
3. Because match keys AND together, adding a sixth key later is additive and
   cannot change what an existing file means.
4. Every rule carries an `id`, and every ledger entry records the matched rule
   id together with the sha256 of the policy file text.

Defaults, which is where the three logs disagreed and where the answer is split
rather than averaged:

- **No rule in a valid, loaded file matched: hold.** Hold is the only decision
  that is itself reversible, an unmatched call is precisely the case a human
  should look at once, and the notification tells the operator which rule they
  are missing, so the default teaches the policy file rather than either
  blocking work or silently permitting it. The schema nonetheless **requires**
  the file to end with an explicit terminal catch-all rule, so an operator reads
  the rule rather than inheriting a hidden one, and in a well formed file the
  implicit default never fires.
- **Policy file missing, unreadable, invalid, or of an unknown version: deny,
  loudly.** That is a broken configuration, not an unmatched call, and the two
  must not resolve the same way.
- **An unclassified call is treated as R3**, which makes registry coverage a
  safety property and creates the right pressure: BUILD-PLAN phase 3's exit
  already says more than a fifth unclassified means the registry has the wrong
  coverage for the wedge.

**Rationale.** BUILD-PLAN section 8 lists a policy DSL under what not to build,
and the cheapest reading of that is stronger than the plan states: a language is
not one project, it is a permanent one. It needs precedence rules, error
messages a non-programmer can act on, a security review of an evaluator that now
runs inside the interception path, and a compatibility promise on every future
syntax change. Five keys and four comparators is roughly forty lines of zod, has
no evaluation semantics to get wrong, and leaves a rule file as a document a
compliance reader can diff. Matching rules are also **total and inspectable**: a
reviewer can read the file top to bottom and know what happens to every call,
which is not true of any expression language.

Property 2 is the load bearing one and it is the one people skip. If unknown
keys are silently ignored, an operator's typo (`blast_radus`) quietly drops a
condition and widens a narrow rule to everything of that class, which in a tool
that gates writes means allowing what should have been held. Worse, the day the
real key is added, every file containing that typo changes meaning without
anyone editing it. Failing the load is what makes adding a key later a safe,
non-breaking act, and it is also what makes a newer policy file fail closed on
an older binary rather than silently allow.

Property 4 is what lets an audit answer, months later and after the file has
changed, which text produced a decision. Without it the ledger records a
decision nobody can reproduce. It also gives a cheap migration test: a later
format change can be replayed against real history to see what would have
changed.

The one dependency, `yaml`, is worth it. The format is going to be read and
diffed by people who are not its author, a policy file without comments is a
policy file nobody can explain six months later, and hand rolling a YAML subset
is the kind of task that looks like an hour and is not. Validation goes through
zod rather than a JSON Schema validator because zod is already a root
dependency, gives the parsed rules their TypeScript types for free, and produces
errors naming the path in the file. JSON is still accepted, since YAML is a
superset, so anyone generating policy programmatically loses nothing.

Grafted from the losing logs: the required rule `id`, the policy digest in the
ledger and the unclassified-as-R3 rule (safest); the split between an unmatched
call and a broken file, and the argument for hold as the unmatched default
(fastest); the ban on regular expressions in v1 and the trap below (cheapest).

**The trap for WP-05, which is not in the format at all.** It is the MCP error
body returned on a deny or a cancel. A generic error trains agents to retry with
a slightly reworded statement, which turns a safety tool into an evasion
trainer. The error must name the rule id, the class, and what approval would
require.

**What this cannot express, stated now so nobody bolts it on.** No rule can
relate two calls: nothing about rate over time, a running total, time of day, or
the identity of the human behind the agent beyond the workspace. Irreversibility
budgets, which GO-TO-MARKET sells on the Business tier, are exactly that class
of stateful rule and need a counter store and a decision that is a function of
history, not a sixth match key. Anything cross tool, such as hold any write that
follows a read of table X, is the taint graph in WP-12, not the policy engine.

| Rejected                                                     | Why not                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A small purpose built expression language                    | A parser, precedence, a type checker, error messages a non-programmer can act on, and a sandbox, sitting inside the component that holds credentials. You then cannot statically tell what a rule will do, which is the exact property needed in a component that gates writes. BUILD-PLAN section 8 names it explicitly. |
| An embedded evaluator (CEL, JSONLogic)                       | A dependency plus an evaluation surface to reason about in the write path, buying expressiveness nobody has asked for, and turning a rule file into something you debug rather than read. Kept as the shape of a possible optional `expr` field in v2.                                                                    |
| OPA and Rego                                                 | Genuinely the right answer at enterprise scale and wildly disproportionate here: a Go binary or a large wasm blob, plus a second language for the operator, for four rule kinds and three decisions. Keep as a documented enterprise escape hatch.                                                                        |
| Cedar                                                        | Models authorisation of a principal on a resource, not classification of a call against the state of its target, so the core concept has to be bent to fit, and it adds a wasm dependency for the privilege.                                                                                                              |
| Policy as TypeScript, an exported `decide` function          | Maximum expressiveness, zero auditability. A compliance reader cannot diff it, changing policy becomes a code deploy, the operator's policy runs with the proxy's privileges, and shared policies become a supply chain problem. The one option a security reviewer would refuse outright.                                |
| JSON instead of YAML, to avoid the dependency                | No comments, and a policy that cannot be annotated is a policy that does not get reviewed. JSON input is accepted anyway.                                                                                                                                                                                                 |
| Regular expressions in match fields in v1                    | ReDoS in the write path with no dependency free mitigation, and a regex is precisely where an accidentally over broad allow rule hides from review. A single trailing wildcard covers the real cases and is readable at a glance.                                                                                         |
| Match keys for everything the registry knows, added up front | Every key is a compatibility promise forever. Five keys that are all used beats twenty where six are, and the load time rejection of unknown keys makes adding the rest later free.                                                                                                                                       |
| Implicit allow when no rule matches                          | Inverts the product. The failure mode of an incomplete policy file becomes an unprotected write path, invisibly and permanently.                                                                                                                                                                                          |
| Implicit deny when no rule matches in a valid file           | The more obviously safe answer, and it makes an incomplete policy file indistinguishable from a deliberate refusal, teaches the operator nothing, and blocks work over a gap rather than surfacing it. Deny is kept for the genuinely broken cases: missing, unreadable, invalid or unknown version.                      |

**Revisit when.** A user states, in writing, a condition the five keys cannot
express and explains what they needed it for. That is the event BUILD-PLAN
section 8 asks for, and the response is a sixth key or a new comparator inside
the same structure, at version 2, or at most an optional `expr` field alongside
`match` so every v1 file keeps working. It is never a replacement of the format.

---

## 5. The licence line

**Decision.** What is open, what is paid, under which licence, and how the line
is kept credible.

**Choice.** Confirm GO-TO-MARKET section 3: **Apache 2.0** open core, with the
hard rule that **a feature never moves from open to paid**. Four amendments.

_Open, Apache 2.0:_ `packages/registry` (data, evaluator, schema),
`packages/ledger` (chain, canonicaliser, signing, both stores, verification),
`packages/proxy` (both transports when they exist), `packages/policy` (rules,
decide, hold, the approval **channel interface** and the CLI channel),
`packages/cli`, `packages/connectors/postgres`, `packages/connectors/s3`, and
the standalone verifier as its own separately installable package with **zero
dependency on any other NOMO package**.

_Paid and closed:_ `apps/control-plane`, `cloud` (added 2026-10-03, see the
amendment at the end of this file), the Slack and Teams channel
implementations, SSO, multiple workspaces, irreversibility budgets, the taint
graph, attestation exports with compliance frame mappings, premium connectors
(Stripe, Salesforce, HubSpot, Gmail, Kubernetes), retention beyond seven days,
SLA support, and the self hosted enterprise licence.

_Amendment one, a line collision resolved before the file exists._ WP-05 builds
`channels/slack.ts` inside `packages/policy`, which is open, while GO-TO-MARKET
sells Slack approvals as paid. Two of the three deciders caught this
independently. The channel interface and the CLI channel are **open** and live
in `packages/policy`, because an open policy package that cannot notify anyone
is not complete for its purpose and would break the hard rule in its first week.
The Slack and Teams implementations live in a separate paid package
implementing that interface.

_Amendment two, the verifier's independence is structural._ It ships as its own
installable package with no NOMO dependencies, the ledger format is documented
well enough that a second verifier can be written in another language, and the
commitment that it never moves is written into its own README.

_Amendment three, DCO sign off, not a CLA._ Apache 2.0 section 5 already
licenses inbound contributions under the same terms. A CLA is the specific
instrument that makes a future relicence possible, which is the move the hard
rule promises never to make, so refusing to collect one is a credible commitment
rather than a statement of intent. It is also friction placed exactly on the
registry contribution flow that GO-TO-MARKET depends on.

_Amendment four, a NOTICE requirement on the registry data_ carrying
`REGISTRY_DISCLAIMER` verbatim, so the "draft classifications, not vendor
certified" label travels with the data wherever it is embedded. Once someone
puts those classifications into their own policy engine, that label is the only
thing between an illustrative classification and a false assurance.

**Rationale.** The safety argument for the line is stronger than the commercial
one: nobody puts a closed proxy in front of their production database on a
stranger's word, so the component that intercepts, classifies and holds must be
readable by the person putting it in their write path. Apache 2.0 over MIT for
two clauses that cost nothing now and matter later: the express patent grant in
section 3, which is what a corporate legal reviewer looks for before allowing a
security component into a write path and is the question that stalls exactly
this kind of review, and the trademark reservation, which keeps the NOMO name
when a gateway vendor forks the proxy. Under a cheapest bias the same conclusion
arrives differently: an open, dependency light core is the only distribution a
solo operator cannot buy with money, and the MCP registry, GitHub search and the
registry entry pages only work for something installable without a sales call.

The operational test that makes the line decidable in the moment, and which
would have caught the Slack collision: **before anything merges into a paid
package, ask whether a solo developer protecting one Postgres could do their job
without it. If the answer is no, it belongs open.**

Grafted from the losing logs: the Slack channel split (independently in two
logs), the DCO amendment and the operational test (fastest), the registry NOTICE
requirement (safest), and the maintenance bound and the MIT correction below
(cheapest).

**Two housekeeping items this creates.** The root `package.json` currently
declares `"license": "MIT"` for the whole workspace. That is an inherited
default, not a decision, and it has to be resolved deliberately: the site stays
as it is, each new package carries its own Apache 2.0 `LICENSE` and header, and
a root `NOTICE` is added. Second, open source maintenance is real work for one
person and gets bounded up front rather than discovered: `CONTRIBUTING.md` says
registry data pull requests are welcome, connector pull requests are by prior
agreement only, and feature requests need a described use case, and the README
states there is no support obligation on the open packages.

**What this costs.** Approvals, budgets and the control plane must sit behind a
package boundary from day one rather than behind a feature flag inside an open
package, which costs a little structure in WP-10 and WP-11 and rules out the
shortcut of building them inline and separating later. Publishing the proxy and
the ledger means a competitor can lift the interception spine, so defensibility
sits in the registry data, the connectors and the hosted control plane, which is
the same conclusion the BUILD-PLAN risk register reaches about native approval
hooks commoditising the hold. And the free tier is genuinely sufficient for one
developer protecting one system, so conversion depends entirely on the team
features being good rather than on artificial limits.

| Rejected                                                      | Why not                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT, matching the current root `package.json`                 | No patent grant and no trademark clause, and no compensating benefit. For a component in a regulated buyer's write path, that omission turns a one afternoon legal review into a long one.                                                                                                                                              |
| AGPL for the proxy and the ledger                             | Puts a copyleft question in front of every security review of a component that must be read before it is installed, and deters the platform teams who should adopt it into reimplementing interception badly. It also defends the wrong asset: what a reseller would take is the control plane, which is paid and closed anyway.        |
| BSL or the Elastic License with a delayed conversion          | Not open source, so distribution through the MCP registry and package channels weakens and the registry loses its contributors. It also invites precisely the licence change story the hard rule exists to prevent.                                                                                                                     |
| SSPL                                                          | Not OSI approved, rejected by several distribution channels, and it undermines the "read the code before you put it in your write path" argument the open core exists to make.                                                                                                                                                          |
| Closed core with an open SDK                                  | Inverts the readability requirement: the parts that must be auditable, the interceptor and the ledger, would be the closed parts.                                                                                                                                                                                                       |
| Fully open with no paid line                                  | No revenue path, and the organisational features (hosted approvals, SSO, retention, exports) are the ones with real running cost, so giving them away means paying to serve users who cannot pay back.                                                                                                                                  |
| A CLA, to keep future licensing options open                  | Keeping that option open is the thing the hard rule promises not to do. Declining a CLA is what makes the promise cost something and therefore mean something.                                                                                                                                                                          |
| Two repositories from the start                               | The cleanest long term boundary and a direct tax now. One repository with a root Apache 2.0 `LICENSE`, a per-directory `LICENSE` under `apps/control-plane`, and SPDX headers where the line actually runs gives the same clarity. Splitting is a day whenever it becomes necessary, which is when a paying customer's legal team asks. |
| Opening the taint graph, budgets and attestation mappings now | They are organisational features and belong on the paid side from day one. Moving them across later would be the exact licence change the model forbids, so the line has to hold before there is pressure on it.                                                                                                                        |

**Revisit when.** A cloud provider ships a hosted NOMO, **or** a customer's
procurement rejects Apache 2.0 for a reason that is not the patent grant. The
hard rule itself is not revisitable: open features stay open. New organisational
features may land paid.

---

## 6a. The test runner

**Decision.** What runs `pnpm test`, which is the first exit criterion in the
whole build.

**Choice.** `node:test` with the runtime's native TypeScript type stripping, and
**no flag**. Zero new dependencies. Each package gets `"test": "node --test"`,
the root gets `"test": "pnpm -r --if-present run test"`. Assertions come from
`node:assert/strict`.

Four rules follow and go into `STANDARDS.md`:

- Every package declares `"type": "module"`, otherwise Node reparses each test
  file as ESM after failing to read it as CommonJS and warns on every run.
- Every package tsconfig sets `erasableSyntaxOnly` and `verbatimModuleSyntax`,
  so `tsc` rejects at typecheck time the syntax Node cannot strip, rather than
  letting it fail at run time. No `enum`, no `const enum`, no `namespace`, no
  parameter properties, no `import =`. Type only imports are written
  `import type`.
- Relative imports inside the new packages carry an explicit `.ts` extension.
- Do not pass a directory as the argument. Use bare `node --test` or a quoted
  glob.

**Rationale.** **Verified** on this machine, Node 22.22.2, during WP-00: a
`.test.ts` file with a type alias and a type annotation runs and passes under
bare `node --test` with **no flag and no warning on stderr**; a failing
assertion exits 1, so CI gating is real; and an `enum` is rejected at load with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Type stripping has been on by default since
Node 22.18.

Two of the three deciders reached for `--experimental-strip-types`. The flag is
omitted deliberately: passing an experimental flag that a future runtime removes
turns a green test command into a hard startup error, whereas relying on the
pinned engine's default degrades to a one word fix if an older 22.x is ever
used. The flag is also unnecessary here, which is the stronger argument.

Against that, `vitest` brings a dependency tree into a workspace whose root
`node_modules` holds six entries today, plus a config file per package, plus a
1440 minute wait on any future version bump including an urgent one, because
`pnpm-workspace.yaml` sets `minimumReleaseAge` and its own comment calls that a
critical supply chain defence and tells you not to disable it. The cheapest way
to honour that setting is to add nothing that needs excluding. And this is a
security product whose tests will eventually run with a live Postgres, a signing
key and real credentials in the process: zero new packages is the choice a
reviewer signs off without reading a lockfile diff, and it means the test
harness can never be the thing that compromises the ledger it is testing.

Grafted from the losing logs: `erasableSyntaxOnly` and `verbatimModuleSyntax` in
the shared tsconfig, which makes the stripping constraint a compile error rather
than a runtime surprise (fastest and safest); the verified directory-argument
caveat (safest); the recursive root script (safest).

**What this costs, honestly.** No `expect` API, no snapshot testing, no watch
mode UI, no built in DOM, and mocking limited to `mock.fn`, `mock.method` and
`mock.timers`, which does cover the injectable clock the rate limiter needs but
makes module substitution awkward. Packages therefore take their dependencies as
parameters, which is what `packages/ledger` should be doing anyway. Expect
slower authoring for roughly the first week and one or two small assertion
helpers. The switching cost is low in both directions: `describe`, `it` and
`test` map onto vitest almost one to one, so a later move is a script change and
an import rename, not a rewrite.

**One discrepancy to fix while in this code.** `README.md:81` says Node.js 24,
`package.json` `engines` says `22.x`, and the installed runtime is 22.22.2. Pick
one and correct the other two.

| Rejected                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| vitest                                          | The better runner by a wide margin, and it is a large new dependency tree entering under a 1440 minute release age gate, in the repository of a security product, for tests that will hold credentials and drive a live database, plus a second config file and a second module resolver next to `tsc`, `esbuild` and `vite`. The ergonomics do not pay for the supply chain surface at WP-00, and the decision is cheap to reverse later. |
| `tsx` plus `node:test`                          | Adds a runtime transform dependency to do what the runtime now does natively and verifiably. It was the right answer before Node 22.18 and is not any more, and it would only buy `enum`, which STANDARDS bans anyway.                                                                                                                                                                                                                     |
| Jest                                            | Heaviest of the three, needs `ts-jest` or a babel transform, and has the most fragile ESM story in a workspace that is ESM by default everywhere except `api/`.                                                                                                                                                                                                                                                                            |
| uvu, tape or another micro runner               | Still a dependency, with less maintenance behind it than the Node core runner, and no discovery or coverage story that `node --test` does not already have.                                                                                                                                                                                                                                                                                |
| Compiling with `tsc` before every test run      | A build step in front of every test invocation, stack traces pointing at generated code, and an emit directory to keep out of git, with no benefit over stripping types in process.                                                                                                                                                                                                                                                        |
| Passing `--experimental-strip-types` explicitly | Unnecessary on the pinned engine, and it makes the test command fail hard on any future runtime that removes the flag.                                                                                                                                                                                                                                                                                                                     |
| No test harness until a later package           | WP-00's exit criterion is a passing test command, and WP-03's verification (1000 entries, tamper, drop, and four forger attacks) runs through this harness. The ledger cannot be signed off without it.                                                                                                                                                                                                                                    |

**Revisit when.** WP-11, when the control plane UI needs component and browser
testing. The answer there is more likely Playwright than a unit test framework,
because WP-11's exit criteria are keyboard and tap behaviour that a DOM shim
cannot honestly test. Also revisit if the repository moves to Node 24, where
nothing changes but the note about the flag becomes moot.

---

## 6b. Where the registry lives

**Decision.** Whether WP-00 physically moves `api/_registry.ts` into
`packages/registry`, as EXECUTION-PLAN's builder line says.

**Choice.** **Do not move it in WP-00.** Invert the direction instead.

`api/_registry.ts` and `api/_registry_http.ts` stay physically where they are,
byte for byte unchanged. `packages/registry` is created now as the package
boundary, with its `package.json`, `README.md` contract and tests, and
`packages/registry/src/index.ts` is a thin re-export pointing **into** `api/`:

```ts
export * from "../../../api/_registry.ts";
```

`packages/registry` stays `noEmit` until the flip, precisely because that
relative import raises its own inferred emit root above the package. That is
harmless while nothing is emitted and it is the reason the package cannot be
built or published yet, which is fine because there is nothing to publish until
the evaluator exists.

No consumer changes: `registry.tsx` keeps `@shared/_registry`, the Express route
keeps `@shared/_registry_http`, `api/registry.ts` keeps `./_registry_http`.

**Two permanent guards land in WP-00 instead, and they are the actual value of
this decision.**

1. Add `"rootDir": "."` to `api/tsconfig.json` `compilerOptions`.
2. Make `pnpm run typecheck` assert the emit **layout**, not only the exit code:

```
rm -rf .tsc-api-emit \
  && tsc -p api/tsconfig.json --outDir .tsc-api-emit \
  && test -f .tsc-api-emit/registry.js \
  && test -f .tsc-api-emit/waitlist.js \
  && ! test -e .tsc-api-emit/api \
  && rm -rf .tsc-api-emit
```

**Rationale.** The failure mode here is silent, it has already broken this
repository's deploy once, and two readers contradicted each other about it, so
the contradiction is settled on the record.

`api/tsconfig.json` sets no `rootDir` and includes `**/*.ts`, so TypeScript
infers the emit root as the common source directory of every non `node_modules`
file in the program. Today that is `api/`, and the emit is flat: 22 files,
`_core.js` through `waitlist.js`, no `api/` subdirectory (**verified** at WP-00
by `npx tsc -p api/tsconfig.json --outDir /tmp/emit`, exit 0). That flat layout
is load bearing: `api/registry.ts` must land at `<out>/registry.js` or Vercel
cannot find the entrypoint for **any** route.

Reader B recommended `export * from "../packages/registry/src/index"` in
`api/_registry.ts`, reasoning that `api/tsconfig.json` has no `paths` and no
`baseUrl` so a bare specifier will not resolve. **That reasoning is wrong**: a
bare specifier resolves through `node_modules`, not through tsconfig paths. And
Reader A **proved by isolated experiment** that this exact form is the
regression that breaks the deploy: `tsc` exits 0 with zero diagnostics while the
layout becomes `<out>/api/registry.js` plus `<out>/packages/registry/src/...`,
because pulling one file outside `api/` raises the inferred common source
directory to the repository root and re-parents every compiled function at once.
It passes typecheck, passes lint, passes `build:web`, and fails only when Vercel
cannot find the function. `pnpm run typecheck` runs the real emit into
`.tsc-api-emit` and deletes it without ever looking at the shape, which is why
the regression is silent. **So the relative shim out of `api/` is rejected on
evidence, permanently.**

That leaves the safe move against not moving yet. The bare specifier form
(`export * from "@nomo/registry"`, package declared as a root dependency) is
**proven safe on the emit half**, even when the package's types resolve to
TypeScript source through a pnpm style symlink, because TypeScript treats
anything resolved through `node_modules` as an external library file and
excludes it from both emit and the common source directory calculation. But the
install and trace half is **unproven** and cannot be proven on this machine. It
has three moving parts that must all be right at once on a platform only
testable by deploying: the package's top level `main` and `types` must point at
CommonJS loadable JavaScript, because `api/tsconfig.json` uses `moduleResolution`
`node` (node10) which never reads an `exports` map, and the api emit is CommonJS
and will `require()` it; that JavaScript must exist **before** the Vercel Node
builder compiles the functions; and `vercel.json`'s `buildCommand` is
`pnpm run build:web`, which filters to `@workspace/nomo` and would not run a
build script in `packages/registry` at all. So the safe move costs a root
dependency, a dual CommonJS and ESM build, `main`, `module`, `types` and
`exports` kept correct for three resolvers simultaneously (node10 for `api/`,
bundler for vite, esbuild for api-server), a change to `build:web`, a lockfile
change, and a preview deploy to validate Vercel's file tracing of a root
workspace symlink. That is five new failure modes on the deploy path of the
whole API, added inside the scaffolding package everything else depends on, to
buy a file living in a nicer directory.

Nothing needs the move yet. At WP-00 the only consumers are `api/`, vite and
esbuild, and all three read TypeScript source. The inversion is also not novel
here: `artifacts/api-server` has mapped `@shared/*` to `../../api/*` for the
whole life of the site, and its built output proves it works,
`dist/index.mjs:38247` carrying a `// ../../api/_registry.ts` banner with the
entry data inlined.

The guards are verified and permanent. `"rootDir": "."` is a no op with the tree
as it stands (identical flat emit, zero errors) and raises `error TS6059` naming
the offending file the moment a relative import leaves `api/`. That converts a
silent, deploy-breaking re-parent into a typecheck failure forever, for one
line. One caveat to record: `api/tsconfig.json` deliberately does not set
`noEmitOnError`, so a violating build still emits and writes the offending `.js`
next to its source, which wants a `packages/**/*.js` gitignore entry.

**When the move happens, and in exactly what form.** At WP-04a, when the
evaluator lands, the package has to be built and published anyway, and the CLI
imports the registry at runtime where Node's type stripping deliberately does
not apply inside `node_modules`. Then, and only then:

- `api/_registry.ts` becomes, as its entire contents,
  `export * from "@nomo/registry";` with a header comment explaining that the
  bare specifier is deliberate.
- `@nomo/registry` is declared in the **root** `package.json` dependencies as
  `"workspace:*"`, in the slot `zod` and `pg` occupy.
- The package carries top level `main` and `types`, not only an `exports` map.
- `main` points at CommonJS that exists before the functions compile; ship dual
  output so vite consumes the ESM entry.
- Build ordering is added to `build:web`.
- It is gated on a preview deploy that curls `/api/registry` and loads
  `/registry` before merge.

**A note for whoever reads the tree.** The registry data physically lives in
`api/` for longer than BUILD-PLAN section 4's picture implies. That reads
backwards and is deliberate. It is stated in `docs/CONTEXT.md` so nobody treats
it as an oversight.

| Rejected                                                                                                                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move the source and leave a **relative** re-export in `api/_registry.ts` (Reader B's recommendation, and EXECUTION-PLAN's literal builder line) | Proven fatal and proven silent. `tsc` exits 0 with zero diagnostics while every function moves from `<out>/registry.js` to `<out>/api/registry.js`, so Vercel cannot resolve any route. Typecheck, lint and `build:web` all pass through it. This is the exact regression that broke this repository's deploy before.                                                                                   |
| Move the source now and reach it through the bare specifier `@nomo/registry`                                                                    | The correct long term answer and proven safe on the emit half. Rejected only for sequencing: it costs a root dependency, dual CJS and ESM output, `main`/`types` correct for three resolvers, build ordering in `build:web`, and a preview deploy to validate a trace behaviour that cannot be tested locally, all inside the scaffolding package, to buy nothing until WP-04a. Right form, wrong time. |
| Add a `paths` mapping to `api/tsconfig.json` so a bare specifier resolves without a real package                                                | `paths` affects typechecking only. The emitted CommonJS still `require()`s the literal specifier at runtime, so it resolves during the build and fails at function invocation. That is the worst failure mode, because it looks green.                                                                                                                                                                  |
| Copy the registry into `packages/registry` and keep both                                                                                        | Two sources of truth for the classification data. `replit.md` states the reason the registry is one module: the page, the endpoint and the intercept time classification must not be able to disagree about what a class means. A classifier that disagrees with the published registry is the single worst bug this product can have.                                                                  |
| Generate a JSON artifact into `api/` from a package source                                                                                      | A build step in front of the Vercel function build and a generated file in git that can be stale, for no safety gain, and a second way for the site and the runtime to disagree.                                                                                                                                                                                                                        |
| Leave the registry in `api/` permanently and never create the package                                                                           | The CLI and the proxy will import it at runtime, type stripping does not apply inside `node_modules`, and decision 5 makes it a published open source package. It has to become a real package eventually.                                                                                                                                                                                              |
| Do not create `packages/registry` until WP-04a                                                                                                  | The package boundary and its README are part of the context pack that WP-04a's agents read first. Creating the shell now costs nothing, forces the contract to be written down, and leaves the risky physical move as a separate, independently reviewable commit.                                                                                                                                      |
| Move `_registry_http.ts` as well                                                                                                                | Its only consumers are `api/registry.ts` and the Express route, and the browser deliberately never imports it so URL parsing and `MAX_LIMIT` stay out of the site bundle. Moving it adds risk and buys nothing.                                                                                                                                                                                         |
| Keep WP-00's stated trap check (`tsc -p api/tsconfig.json --outDir /tmp/emit`) as the gate                                                      | Insufficient and demonstrably so: the broken variant exits 0. The gate must assert the shape of the emit, not the exit code.                                                                                                                                                                                                                                                                            |

**Revisit when.** WP-04a lands the case evaluator, **or** anything outside this
repository needs to `import` the registry by package name. Either event triggers
the physical move, in the bare specifier form above, as its own commit gated on
a preview deploy.

---

## Where these decisions are proven, and where they are not

| Claim                                                                                                | Status                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `api/` emit is flat, 22 files, no `api/` subdirectory                                                | Verified at WP-00, `npx tsc -p api/tsconfig.json --outDir /tmp/emit`, exit 0        |
| A relative import out of `api/` silently re-parents every function                                   | Verified by Reader A in an isolated copy with real `node_modules`                   |
| A bare specifier leaves the flat layout untouched                                                    | Verified by Reader A, including through a pnpm style symlink to TypeScript source   |
| `"rootDir": "."` is a no op today and raises TS6059 on a violation                                   | Verified by Reader A                                                                |
| Vercel resolves a root `workspace:*` link and traces the built CJS main                              | **Unproven.** Needs a preview deploy. This is why 6b defers the move                |
| `push-force` drops an undeclared ledger table in `public`, triggers and all                          | Verified by Reader C against live PostgreSQL 16.13                                  |
| A dedicated `ledger` schema is invisible to `drizzle-kit push`                                       | Verified by Reader C, same server, `No changes detected`                            |
| The grant and ownership split refuses `UPDATE`, `DROP TRIGGER` and `DISABLE TRIGGER` to the app role | Verified by Reader C                                                                |
| The append only triggers refuse UPDATE, DELETE and TRUNCATE                                          | Verified by Reader C, error `ledger_entries is append only: UPDATE denied on seq 1` |
| `sealHash`'s replacer allowlist erases nested fields from the preimage                               | Verified in node                                                                    |
| `node --test` runs `.test.ts` on Node 22.22.2 with no flag and no warning                            | Verified at WP-00                                                                   |
| `enum` is rejected with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`                                          | Verified at WP-00                                                                   |
| A failing assertion exits 1                                                                          | Verified at WP-00                                                                   |
| `node:crypto` signs and verifies ed25519 with no dependency                                          | Verified by two deciders on Node 22.22.2                                            |
| PostgreSQL 16.13 starts here with `pg_ctlcluster 16 main start`                                      | Verified by Reader C, no install needed                                             |

## Local hardening continuation, 11 September 2026

Remove the argument fallback for blast radius. The prior rollout compatibility
rule let an agent claim a small `rows`, `count`, `limit`, or `n` and satisfy an
allow rule without a measurement. This conflicts with the context pack's
measured-count definition. Only a nonnegative safe-integer probe result supplies
a radius. Missing or failed measurements stay unknown and radius rules do not
match. The binary currently has no probe provider, so this can move calls to a
later hold or deny rule; it must not silently authorize an unmeasured write.

Reject malformed policy structures at load time, including null rules, array
matches, unknown classes and invalid count thresholds. YAML parser diagnostics
must not echo the policy source into an agent-visible error.

The control plane remains a local development surface. Enforce a loopback peer,
an explicit local Host with the listening port, and same-origin browser
requests. This blocks DNS rebinding and hostile cross-origin requests without
claiming authentication between local users. Remote authenticated serving is
still a separate feature. Feed verification means signatures checked; hash
integrity alone is stated separately and remains inspectable in the UI.

The root check now includes control-plane typechecking plus its tests and the
script test suite. Script tests run from the repository root because their
fixtures resolve relative paths there. No dependencies or lockfile changes.

## Beta workbench and web gateway, 2026-09-11

The user's ASCII direction from Dawe583/void-empty takes precedence over literal
Apple branding in GUI-RULES.md. Keep Apple's touch sizing, hierarchy and keyboard
accessibility while sharing one paper/CRT stylesheet across GUI pages.

The optional workbench originates model requests through the SDK; the proxy
itself remains an interceptor. Provider/session logic lives in @nomo/workbench.
Vercel hosts a stateless authenticated gateway, while a persistent runtime owns
MCP sessions, approval brokers and signed JSONL storage. There is no claim that
function-local disk is durable. See BETA.md for configuration and open scope.

Replay gains pg and AWS SDK transport adapters. PGlite is a development-only SQL
engine used to validate real foreign-key behavior during cascade restoration.
The reviewed core checks pass; external customer resources remain unverified.

## Entire web application on Vercel, 2026-09-11

The user clarified that the web app includes its backend on Vercel. This
supersedes the external runtime gateway decision above. Nitro and Vercel
Workflow host the cloud API and agent loop; Neon from Vercel Marketplace holds
durable state and signed evidence. The old gateway is retained as an optional
local module and is no longer a root Vercel API route.

Keep provider and tool secrets encrypted in Neon with a separate environment
key. Hold decisions persist across functions. Before dispatch, persist an
execution marker and authorization record. If execution becomes ambiguous,
refuse automatic retry. Model calls use Vercel AI Gateway OIDC by default or a
validated custom provider. Catalog discovery alone does not prove billing or
account verification permits generation.

## Desktop and managed agent workspace, 2026-09-11

Tauri 2 is the native shell, with a bundled, hash-verified Node 24 sidecar so the
existing local policy and workbench remain the execution boundary. Its isolated
package adds the Tauri CLI and esbuild to build the native app and transpile the
shared backend; it preserves the minimum package release age. The webview has
no Node integration or general shell IPC. Native macOS Keychain retains the
workspace encryption key. The shell owns the backend lifecycle.

Default agent actions operate on managed documents. A captured mutation and its
signed evidence are persisted atomically (local encrypted snapshot or cloud SQL
transaction). Undo verifies the full captured operation against signed history
and rejects drift, duplicate inverses and newer changes. This does not imply
that arbitrary external MCP tools or host files are reversible. Native Anthropic
is normalized to the same model/tool interface as compatible providers.

## Managed recovery runtime, 2026-09-11

Executable adapters share one prepare/capture/execute/reconcile/recover contract
in `packages/runtime` and `packages/connectors/src/recovery.ts`. The first
integration uses structured PostgreSQL mutations with transactionally recorded
outcomes and row revision triggers. Arbitrary SQL and legacy capture-only
connectors do not inherit these guarantees.

Local durability reuses the signed JSONL ledger and an authenticated encrypted
artifact vault. An uncertain external outcome remains unknown until durable
provider evidence resolves it. Recovery has its own signed receipt and can also
be reconciled without repeating the inverse. The first MCP entry point is local
stdio with operator-owned workspace and policy; interactive holds, cloud
transport and multi-operation recovery are separate integration work.

## Cooperative filesystem and public demo, 2026-09-13

The first filesystem adapter covers one regular file in an operator-owned
cooperative directory. Bytes and POSIX mode are its explicit scope. Node cannot
provide an atomic conditional replace against hostile external writers; those
writers are excluded by configuration contract. Observed drift conflicts,
and missing durable outcomes remain unknown without automatic redispatch.

Public testing uses a separate visitor namespace with managed documents only.
It does not distribute the private workspace token or inherit Prime/OAuth/MCP
capabilities. TokenRouter credentials remain server-side and the demo fixes the
model and endpoint. Admission and model-run limits are durably reserved.

Mobile toolbar controls use SVG instead of font-dependent symbols. Options use
the shared native dialog with explicit accessible naming and 52-pixel rows.
The native macOS shell continues using WKWebView; a SwiftUI migration remains
separate from this bundled-interface update. Research: GUI-DESIGN-RESEARCH.md.

## Apple 1.0.1 scope, 2026-09-24

The user authorized implementation of
`docs/superpowers/plans/2026-09-23-nomo-1.0.1-apple-release.md`.
Keep the TypeScript recovery engine and existing Tauri Mac presentation until
a signed App Sandbox experiment proves a blocker. Build a native SwiftUI
iPhone/iPad companion for one explicitly paired Mac over a trusted local
network. No iOS-local shell/recovery core, public relay, mandatory Mac SwiftUI
rewrite, or universal Undo claim belongs to the first release. The older
`APPLE-APPS-PLAN.md` remains historical and is superseded on these decisions.

The measured Apple development selection is Command Line Tools, not full Xcode.
Mac App Store signing, native physical-device verification, product design
approval and external beta remain separate gates; no version label closes them.
See `docs/RELEASE-1.0.1-MATRIX.md` for the item-level evidence contract.

## Four scope answers, 2026-09-26

Taken after `docs/OPEN-WORK-AUDIT.md` reconciled the planning and evidence
documents against the tree and found that the largest remaining blocks of work
were each waiting on an answer only the user could give. Each is recorded here
with what it closes and what it does not.

**One status index, not one status ledger.** The repository has three status
ledgers in three unrelated id namespaces and no crosswalk, so "is this one thing
done?" has no answer. Collapsing them into one was considered and rejected for
now: it is a migration of every cross-reference in the tree, and a reader who
has an index can already find the gap and read the source. `docs/STATUS-INDEX.md`
is the index, and it is explicitly not a fourth ledger. `docs/PLAN-STATUS.md` is
not deleted; it is dated and marked as not current, because deleting the record
of what a work package was supposed to deliver loses the reason the work exists.

**The phone companion stays read-only.** The shipped app is read-only by
construction: `apps/apple/NOMOApp/AppCopy.swift` already tells the user that
approval and Undo happen on the Mac, and pairing a device with write scope is an
operator opt-in that is off by default. That is the answer, so the P05.03,
P06.03 and P07.01-P07.04 rows that assume a phone-side approval or Undo are
struck rather than built. What stays open is the read-only half: paired-device
races, a real TLS round trip on hardware, and the cache and removal work, which
is now implemented and recorded in `docs/IOS-CACHE-AND-REMOVAL-POLICY.md`.

**`certification: false` is the permanent honest answer.** Every published
capability profile carries it, and `void.adapter-capability.v2` refuses a bare
`certification: true` as "not evidence". Rather than widen the schema for a state
that does not exist, the field stays false and the reason is written down. The
gap this exposed is real and stays visible: the schema has no way to say "this
adapter has no bound at all", which is why a profile lists the bound it measured
and names the absence in `excluded` instead of leaving the field to be read as a
limit.

**No hardcoded default provider.** The matrix says the model is the operator's
choice and the surface is provider-agnostic, while
`packages/workbench/src/provider-defaults.ts` made one vendor the default. Both
cannot be the position, and the provider-agnostic reading is the one taken: the
product asks on first use rather than shipping a vendor's endpoint as a default.
The presets remain, because offering a choice is not the same as choosing for
the operator.

## Platform direction, 2026-09-28

Taken after the Apple design research and after reading the Human Interface
Guidelines directly. This section is dated after the 2026-09-24 Apple scope
answer above and replaces its platform half. Where they disagree, this one
governs.

**The platform surfaces take the system look.** The iOS app, the macOS client
and the web control plane adopt the platform's own typography, semantic colours,
materials, navigation patterns and accessibility behaviour. The warm paper
palette, the `Inter` interface face and the custom orange accent leave the
platform surfaces. The iOS app was already close, because
`apps/apple/NOMOApp/ChatTheme.swift` was built on system colours; the web was the
outlier, with seventeen hand-maintained colour properties, no spacing token and
two stylesheets that override the third. The contract is
`docs/APPLE-DESIGN-SYSTEM.md`, which quotes the guideline tables rather than
paraphrasing them, and the work is sequenced in
`docs/PLATFORM-REDESIGN-PLAN.md`.

**macOS becomes a SwiftUI target in the same project as iOS.** The 2026-09-24
answer kept the Tauri presentation until a signed sandbox experiment proved a
blocker. That is reversed: the macOS client is a native target sharing one
codebase and one design system with iOS. What the reversal does not change is
the packaging question. The Tauri shell still exists as the desktop
distribution that carries the Node sidecar and the recovery engine, because that
is where the executor runs, and a sandboxed Mac app is still gated on evidence
this repository does not have. The two are different decisions and the earlier
one conflated them.

**The terminal is not part of this.** The ASCII identity of the TUI is
deliberate, it is a different medium with its own ergonomics, and it is excluded
from the redesign. No part of the platform work may migrate the terminal toward
the platform look, and no part of the platform look may be read back as a
proposal to restyle it.

**What this costs, stated here because the strategy documents say otherwise.**
`docs/NOMO-FUTURE-DIRECTION.md` argued for dropping the Apple product and
shipping the ledger. That argument is overridden, not refuted, and the override
has a price: the redesign is roughly a quarter of the available sessions for two
months, and the sequence in `docs/ROADMAP-2026-Q4.md` exists so that reaching a
first user does not wait for the macOS client to exist.

## Package names, 2026-09-29

Taken because `docs/ROADMAP-2026-Q4.md` lists the package name as its own
unresolved item, and because the same roadmap makes the scope the longest-lead
external gate in the quarter. What follows is a rule. It is not a name, and it
does not claim one exists.

**Product packages keep the `@nomo/<package>` convention, and owning the scope is
a human action that has not happened.** All eleven packages under `packages/` are
named `@void/agent-policy`, `@void/cli`, `@void/connectors`, `@void/ledger`,
`@void/policy`, `@void/proxy`, `@void/registry`, `@void/runtime`, `@void/sdk`,
`@void/verifier` and `@void/workbench` today, and nothing in this section renames
any of them. (Corrected 2026-10-20: this paragraph previously said the packages
are named `@nomo/*`; a read of every `packages/*/package.json` measured `@void/*`
and one package more than the ten this paragraph listed. `@nomo/*` remains the
public target and no package carries it yet.) A
scope is owned by an account, so owning `@nomo` means an organisation, a
verified account and a publish authorization, and none of the three exists yet.
That is the item the roadmap calls B2, and it is a person with a credit card
rather than an engineer with a branch. The consequence is stated here because it
is easy to read past: until the scope is owned, no package in this repository is
publishable, and no build, packaging or workflow work changes that.

**The unscoped name is chosen at publication time and written down then, with
the reason.** `void` and `void-cli` are both taken on npm: `npm view void`
returned 0.21.2 and `npm view void-cli` returned 1.0.0 when measured on
2026-09-29. The decision is therefore not which unscoped name to use, but that
the choice belongs to whoever is authorized to publish, is made at the moment of
publication, and is recorded in this log with the name, the reason and the date.
A name picked now would be a name nobody has checked, and the whole argument of
this repository is that a claim without a measurement is not a claim. Until
that entry exists, this repository has no unscoped name, and any document that
reads as though it does is wrong.

**This settles the shape of the question and not its answer.** In
`docs/ROADMAP-2026-Q4.md` the scope gates B1, B3, B4, B5 and B6, and the
ordering there already says to start it first. What this section removes is the
possibility of treating the name as engineering work to be closed alongside the
scope, which is the failure a roadmap invites when it lists a decision and its
prerequisite on the same page.

## A ledger is resolved once, and a refusal names the argument, 2026-10-03

Taken because issues #63 and #62 were both found by using the product rather
than through its tests, and both are the same mistake: a command reported a
derived path instead of the path the caller gave it.

**The ledger path is resolved in one helper that returns a result, and no
command resolves it on its own.** `packages/cli/src/ledger-target.ts` is used by
`nomo verify`, `nomo export`, `nomo attest` and `nomo metrics`. It returns a
result rather than throwing because the failure is an answer, not an exception:
`absent`, `empty-directory`, `workspace-absent`, `unreadable` and `not-a-file`
are five different operational problems and were one `ENOENT`. The standalone
verifier cannot import that helper and does not: it keeps its own resolution
because zero dependencies is the property that makes it checkable by a third
party, and the duplication is the cost of that promise rather than an accident.

**Every message echoes what the caller passed.** When nothing was passed the
default location is named and labelled as the default, because that is what was
resolved. A message naming `<dir>/default.jsonl` to someone who passed `<dir>`
is the defect, not the detail.

**`nomo metrics` exits non-zero when it cannot measure.** An empty directory is
a measurement of zeroes and exits zero; an absent or unreadable path is not a
measurement and exits 1 with nothing on stdout. A counter surface that prints an
error and exits zero is a false pass, and a false pass on the machine-readable
surface is the one a dashboard records forever.

**A refusal names a field, and a configuration is inspectable.**
`packages/cli/src/recovery-config.ts` describes every field `nomo recovery`
reads, every required field it did not find and every field it ignores, and
`nomo recovery doctor --config <file>` prints that description and exits 1 when
it is not usable. The same description is the text of the refusal, so the
diagnostic and the report cannot drift apart. A config carrying an adapter this
executor does not read is answered with the adapter name and a pointer at
`nomo recovery conformance`, which does read it: "unsupported" and "malformed"
are different problems and an operator cannot fix either one from a sentence
that names neither.

**What this does not establish.** The refusal text is covered by tests that
assert the named field and the named adapter, and those tests fail when the
naming is broken; that is evidence about this text and not about an operator
finding it. No test here runs a real PostgreSQL recovery, and none of this
changes what the executor does once a configuration is accepted.

---

## `cloud/` is the paid side, and every directory now has a status, 2026-10-03

Amendment five to section 5, added because issue #55 found that the paid
entitlement decision had moved into a directory no decision named and no test
read. The operational test in section 5 is undecidable for a directory with no
declared status, and an undeclared status is indistinguishable from an open one
to every reader and to every tool. This names it.

**`cloud/` is paid and closed, as one directory.** It carries its own `LICENSE`
declaring `LicenseRef-VOID-Proprietary`, which is the same identifier
`apps/control-plane` declares, so there is one dialect of closed in this
repository rather than two.

**The operational test, applied.** The test asks, of anything proposed for a
paid package: _before anything merges into a paid package, ask whether a solo
developer protecting one Postgres could do their job without it. If the answer
is no, it belongs open._ The question has to be asked of each file, not of the
directory, and the answers split cleanly:

- `cloud/capability-gate.mjs` is the paid entitlement decision itself and
  `cloud/billing.mjs` is the merchant of record behind it. A solo developer has
  no entitlement to grant and no subscription to bill. Could they do their job
  without them: **yes**, so they belong paid.
- `cloud/account.mjs` is the identity broker, its sealed session cookies and its
  provider round trips. `cloud/store.mjs` is the transactional owner-scoped
  encrypted store holding customer documents and provider credentials.
  `cloud/integrations.mjs` and `cloud/oauth.mjs` are the round trips that put a
  provider token behind that store. `cloud/recovery-routes.mjs`,
  `cloud/demo.mjs` and `cloud/prime.mjs` are the hosted surfaces on top of it.
  A solo developer protecting one Postgres needs none of these: they run the
  proxy, the policy engine and the ledger locally, and every one of those is
  open. Could they do their job without this directory: **yes**, so it belongs
  paid.
- `cloud/mcp.mjs` is a one-line re-export of `packages/workbench`, so nothing in
  `cloud/` re-implements an open capability. `cloud/steps.mjs` and
  `cloud/server.mjs` read the registry, the policy engine, the ledger and the
  runtime rather than replacing them.

Nothing in `cloud/` fails the test in the direction that would force it open, so
one status for the whole directory is the honest answer rather than a tidy one.
A split was considered and rejected on the test's own terms: the files a split
would have to leave open are the ones with no capability in them at all
(`cloud/mcp.mjs` is a re-export), and the files carrying a real capability are
the ones a developer can plainly do without. Splitting would have produced a
boundary that a reader could not act on.

**Nothing in `cloud/` is the interception spine.** Section 5's safety argument
is that nobody puts a closed proxy in front of their production database on a
stranger's word, so the component that intercepts, classifies and holds must be
readable by the person putting it in their write path. That component is
`packages/proxy`, `packages/policy`, `packages/registry` and `packages/ledger`,
all Apache 2.0. `cloud/` reads all four and is imported by none of them, so a
reader who cannot see `cloud/` can still read everything that decides whether an
agent's write is allowed. Closing the deployed server does not close the hold.

**Every other directory is now classified too.** The gate scans the whole tree
and every tracked top-level directory, plus every child of `apps/`, appears in
it with a status. `apps/apple`, `apps/desktop`, `apps/appwrite-mcp`,
`apps/tui-preview`, `gui-web`, `python/nomo-transport`, `scripts/`, `docs`,
`fixtures`, `policy`, `marketing`, `site` and the tool directories are open,
each with the reason it is not closed. They were open before this amendment
under the root licence; naming them narrows nothing and makes it impossible for
a reader to guess. The same status applies to `.devin`, `.github`, `.nomo` and
`.ua`: agent tooling, disabled workflow definitions, the tracked work graph and
generated repository indexes. None makes a paid entitlement decision.

**Undecided now fails instead of passing.** The classification in
`scripts/src/licence-line.test.mjs` is a partition, not a list. A top-level
directory or an `apps/` child with no entry fails the gate with its name in the
message. That is the assertion this amendment exists to justify: the defect was
never that `cloud/` was open, it is that nothing would have noticed either way.

**What this does not establish.** This names a status; it does not move any code
across the boundary. Two known leaks are named rather than fixed, because fixing
either means moving code and that is a separate work package. First,
`packages/ledger/src/taint/graph.ts` is still Apache 2.0 while `taintGraph` is
on the paid side, so the paid capability currently ships in open code; the
capability gate in `cloud/capability-gate.mjs` names this and the gate asserts
only that the decision lives in a closed directory. Second, `packages/cli` and
`packages/workbench` import `desktop-setup.ts` and `commands.ts` out of the
closed `apps/control-plane`, which is the reverse of the direction this
amendment asserts for `cloud/`. Both are recorded here so they are visible
rather than discovered.

---

## The taint graph is paid at the surface and open in the builder, 2026-10-03

Amendment six to section 5, added because issue #55 named a leak that the tree
does not have in the shape the leak was described in. Amendment five above
records `packages/ledger/src/taint/graph.ts` as "still Apache 2.0 while
`taintGraph` is on the paid side, so the paid capability currently ships in open
code". That sentence was accurate about the file and wrong about the
consequence, and this amendment says which of the two is which. It moves no
code, and it is written after the tree rather than before it.

**The boundary is the productised surface, and it was already held.** PR #61
(`c41012b`) put `taintGraph` into `PAID_CAPABILITIES` in
`cloud/capability-gate.mjs` and refused `GET /api/records/:seq/taint` with `402
capability_not_included` before a ledger row is read. That is the paid part.
This amendment is the document catching up to a decision the tree had already
made, not a decision directing the tree, and the §5 rejected table is what made
it that way: "Opening the taint graph, budgets and attestation mappings now |
They are organisational features and belong on the paid side from day one."
From day one is load-bearing. The line had to be drawn before there was a user to
move it across, and it was.

**The builder stays open, and the reason is that it cannot be un-opened.**
`packages/ledger/src/taint/graph.ts` and `query.ts` have been in an Apache 2.0
package and in this repository's history since the graph landed. Removing them
now would not un-license them: anyone holding an earlier clone, a tarball from
a previous release or a fork keeps Apache 2.0 rights to those files, and §5
amendment two commits the ledger format to remaining independently
reimplementable, which an Apache 2.0 package that has withdrawn its own graph
reader no longer is. So the move would yield no legal benefit and would cost a
hole in an open package where a capability used to be. The hard rule settles it
from the other direction anyway: a feature never moves from open to paid, and
taking the builder away from a reader who already has it is that move. This is
not the Slack case, and the difference is worth being exact about.

**Where the two differ.** Amendment one split the channel _interface_ from the
Slack _implementation_ because the collision was caught "before the file
exists": WP-05 was about to build `channels/slack.ts` inside the open
`packages/policy`, so there was nothing to withdraw and the open package would
have shipped a policy engine that could not notify anyone. That reasoning holds
a boundary drawn in advance. It cannot move a boundary already crossed, and
`graph.ts` was crossed on the day it was written, under a licence already
granted, in a package whose completeness §5 amendment two promises. The
operational test in this section reaches the same answer from its own direction:
could a solo developer protecting one Postgres do their job without the
cross-record dependency graph? Yes, the hold, the approval, the ledger, the
verification and the captured inverse all stay open, and
`docs/RECOVERY-CONTRACT.md` records that the taint graph is an inspection-only
neighbourhood whose output the retained planners never consume. Nothing a solo
developer needs is on the paid side of this particular line.

**The three kinds of taint surface, and which one is paid.** Only one of them is
the product, and the distinction is the whole amendment:

- `packages/ledger/src/taint/graph.ts`, `query.ts` and `capture.ts` are the
  builder, its three traversal queries and the ledger reader. Apache 2.0, in
  the open package, tested by `graph.test.ts`, `query.test.ts` and
  `capture.test.ts` without any entitlement.
- `nomo taint` in `packages/cli` is the local operator command. Open, and
  correct: it reads a ledger file the operator already holds on their own disk.
  `docs/HANDBOOK.md` and `README.md` document it and this amendment changes
  neither.
- `GET /api/records/:seq/taint` in `cloud/server.mjs` is the paid surface, and
  it is the only one. It is the multi-tenant hosted product: it reads another
  owner's ledger across an account boundary, which the local command never does.

**What is actually enforced, checked rather than asserted.**
`apps/control-plane` also serves a taint graph, at
`apps/control-plane/api/server.ts:353` and
`apps/control-plane/api/server.ts:374`, and that directory has no entitlement
gate at all. That is not a hole in the gate: `apps/control-plane` is a closed,
`LicenseRef-VOID-Proprietary` directory, it grants nothing under the root
licence, and it serves a single operator workspace with no multi-tenancy and no
billing (`docs/PLAN-STATUS.md`, the WP-10 row). A surface inside the closed side
cannot leak open code, because nothing there is open. The allowlist at
`apps/control-plane/api/remote-gateway.mjs:50` forwards the same path to a
self-hosted runtime behind `NOMO_CONTROL_TOKEN`, which is the deployment
authority the capability gate already exempts as `OPERATOR_OWNER`. So the paid
line is enforced everywhere an account boundary exists, and the two ungated
surfaces are ungated because there is no account boundary to enforce it across.
`scripts/src/licence-line.test.mjs` asserts the decision lives in a closed
directory and that no open package imports from `cloud/`; it does not assert
that the builder is closed, and this amendment is why that is not a gap in the
gate but a statement about what the gate is for.

**The rest of the paid list has the same shape.** Every item on it is now
answered for, because a paid list entry with no answer is how the first one went
unnoticed for as long as it did. Two are paid by name and shipped open:

- **The Slack channel implementation.** `paid/channels/slack.ts` is the real
  thing, `postHoldToSlack`, `slackPayload`, `SlackChannel`, and it now lives
  in a closed `paid/` directory carrying `LicenseRef-VOID-Proprietary`, rather
  than in the Apache 2.0 policy package it used to sit in. This was amendment
  one's collision, and it was fixed on 2026-10-03: the implementation moved
  from `packages/policy/src/channels/slack.ts` to `paid/channels/slack.ts` with
  its test, and the re-export is gone from the `packages/policy` barrel. The
  channel **interface** stayed open, as amendment one requires:
  `packages/policy/src/hold.ts` and `packages/policy/src/channels/cli.ts` are
  unchanged and still re-exported. The move is enforced rather than asserted:
  `scripts/src/licence-line.test.mjs` classifies `paid/` as closed, checks that
  no open package imports it or defines the implementation, and fails if the
  file is put back under `packages/policy`. This one was movable for the reason
  given below, a webhook client nothing has ever depended on reading, which is
  why moving it cost no consumer.
- **Irreversibility budgets.** `packages/runtime/src/budget.ts` is 30 kB of
  accounting in an Apache 2.0 package, which `cloud/capability-gate.mjs` lines
  51 to 54 already records as a known consequence: gating them "would be a
  feature flag inside Apache 2.0 code rather than a boundary the licence can
  hold."
- **Retention beyond seven days.** There is no seven-day bound anywhere in the
  code: `packages/runtime/src/retention.ts` has no `604800`, no `7 * 24 * ...`
  and no `SEVEN_DAY` of any kind, and `MANUAL_RETENTION_POLICY` at line 30 is
  `mode: "manual"` with every TTL null. The capability gate already reached this
  and held it open, on the ground that an operator may already select any
  retention length and a cap would take away something the free tier has.

The rest are absent rather than leaked: `apps/control-plane` and `cloud` are
closed directories that exist; SSO and multiple workspaces do not exist in this
tree at all, which is why `cloud/capability-gate.mjs` says so; the Teams
channel has no implementation (`grep -rn teams packages/policy/src` is empty,
and `channels/` holds only `cli.ts` and `slack.ts`); attestation exports exist
in `packages/ledger/src/attest.ts` and are open, and no compliance frame mapping
exists anywhere in the tree, so the paid half of "attestation exports **with
compliance frame mappings**" is genuinely unbuilt rather than leaked; premium
connectors appear only as registry data, and `packages/connectors/src/registry.test.ts`
line 20 asserts `connectorFor("stripe.refund_create")` is `null`; SLA support and
the self-hosted enterprise licence are commercial terms with no code.

**What this does not establish.** It closes no leak. The Slack implementation is
still in Apache 2.0 code and still could be moved, by a separate work package
that weighs the same argument again. It adds no gate, because the gate that
exists is enforcing the line in the one place the line runs, and a new assertion
would either restate this paragraph or forbid the move this paragraph says is
forbidden anyway. And it asserts nothing about whether anyone will pay: the paid
line for the taint graph is one hosted route on one plan, and whether that is
worth a paywall is a question for a buyer, not for this file.

## Hosted recovery execution is the paid side; the proof stays free, 2026-10-04

**Amendment seven to section 5. The owner delegated this decision and it is
recorded here with the date it was taken, so a later reader does not mistake it
for something the tree did on its own.** It moves no code across a licence line
either, and the reason it does not is the point.

**What was wrong.** `PAID_CAPABILITIES` in `cloud/capability-gate.mjs` held
exactly one entry, `taintGraph`, while `docs/GO-TO-MARKET-10K-MRR.md:116` sells a
Team tier whose included work is a "signed export and verification workflow".
The product was selling verification and gating the recorded dependency graph.
Those are not the same thing, and the second is the weaker of the two as a
boundary: `packages/ledger/src/taint/graph.ts` has been Apache 2.0 since the day
it landed and cannot be un-licensed by moving it, which is exactly the argument
`cloud/capability-gate.mjs` already makes about the irreversibility budgets when
it refuses to gate them. A flag inside published code is not a boundary the
licence can hold.

**What the paid list becomes, and why this one.** `verifiedRecovery` joins
`taintGraph`. The thing no competitor offers is not the ledger and it is not the
signature: it is that a reverted Postgres row leaves a durable receipt **in the
customer's own database**, so a third party verifies the restoration without
trusting NOMO, its key or its ledger. That sentence is
`docs/COMPETITIVE-WEDGE.md` §4.3. _(This entry said "nobody else has" and "the
only claim in this repository that no competitor touches". Both were corrected
on 2026-10-04: Rubrik shipped Agent Rewind on 2025-08-12
claiming rollback of "files, databases, configurations, or repositories", so
the undo itself is not exclusive. What still holds is the placement and the
mechanism, the receipt lands in the customer's own database rather than the
vendor's cloud, and the inverse is per-effect rather than a point-in-time
restore, which a live system with concurrent writers cannot use.)_

**The split inside it, and it is the whole decision.** Capture and the receipt
stay open. `packages/connectors` is Apache 2.0 and stays that way: the CLI
continues to capture, restore, re-read and refuse on drift against the
operator's own machine, permanently, with no entitlement anywhere in that path.
What the paywall holds is the **hosted execution**, the route that runs an
inverse against a customer's system from a server somebody else operates, which
lives in `cloud/` and is already the closed, paid directory.

That means nothing moves between licence tiers. No module is relocated, no
`packages/connectors` import is pointed at `cloud/`, and the gate is a flag
inside a closed package rather than inside published open code. It is the same
shape amendment six already settled for the taint graph, applied to the
capability that is actually the product.

**Which routes.** `POST /api/sessions/:id/recovery-jobs/apply` returns `402
capability_not_included` before a job is written. `POST
/api/sessions/:id/recovery-jobs/plan` and `GET
/api/sessions/:id/recovery-jobs/:job` stay open, so an unentitled owner can
still read the plan, the digest and the receipt and confirm for themselves that
the shape is what they would be buying. A paywall you cannot inspect from
outside is the thing §6 of the wedge document warns about, and the cost of
inspecting it is zero.

**What this does not decide.** It does not set a price, name a Polar product,
or move the Slack implementation, the irreversibility budgets or the attestation
compliance mappings. Those stay exactly where they were, and the second of them
still refuses to be gated for the reason recorded in `capability-gate.mjs`. It
does not claim anyone will pay: the paid line is one hosted route on one plan,
and whether that is worth a paywall is a question for a buyer, not for this
file.

## External agent binaries: provenance recorded, no vendoring, 2026-10-05

Decision A from `docs/VENDORING-DECISION.md`, taken by the agent on the
owner's behalf and recorded here so it is not relitigated.

`oh-my-pi` (`omp` 18.6.1) and `prime-agent` (`prime` 0.9.1) stay external
binaries resolved from `~/.local/bin`, invisible to the pnpm lockfile and to
`scripts/src/check-tests.mjs`. No source is copied. The evidence behind the
refusal to vendor: the `@oh-my-pi` scope is neither an npm org nor an npm
user, `pnpm-workspace.yaml` matches only `packages/*` so a vendored tree is a
partial capture that fails `pnpm install --frozen-lockfile` and routes
`pnpm test` into `bun` on runners with no bun, and the local clones
(`omp-src` 18.6.2, `prime-src` 0.9.8) are ahead of anything published, so
vendoring would ship code nobody has installed.

The usage question the evidence pack left open is now answered, measured
2026-10-05 and recorded in full in `docs/VENDORING-DECISION.md`: `omp` is
consumed nowhere in code (operator config under `.omp/` only), and
`prime-agent` is consumed as an external process through exactly three
surfaces, `scripts/src/prime-bridge.mjs`, `cloud/prime.mjs` plus
`scripts/team/prime-spawn.sh`, and the TUI `/harness` switch. There is no
source-level dependency to vendor; there is a process contract.

## Harness spec section 7: three questions closed, 2026-10-17

**Mined rules never bind by construction, and that is deliberate.** The policy
grammar requires a terminal catch-all (`match: {}`) as the last rule and
`decide` is first-match-wins, while `policyWithLearned` appends mined rules after
it, so no mined rule can reach a decision. A placement before the catch-all
would let a model-mined hold override an operator allow, which is authority, not
evidence, and which `docs/NOMO-AGENT-HARNESS-SPEC.md` section 7 already refuses.
The binding surface for learned material is the lessons path: bounded,
same-workspace context injection that cannot change `decide`. This matches the
MVP spec Milestone C item 6, which says retrieved entries never change `decide`.

**The host execution surface stays deferred, by design.** Adding a
model-callable shell, filesystem or git tool is a product-security decision, not
a work package: an operator-configured upstream runs as the proxy OS user and is
not sandboxed, so a "host untouched" canary would fail by design. `toolCatalog`
keeps `policy` as the honest resolution for connector and stdio tools, because a
preview class computed from name and shape can disagree with the execution-time
classification that has the real tool facts.

**Skill drift is undefined, and therefore not a work package.** "Workspace
versus global store" names no defined store in this repository. Defining drift
is a requirement or pilot decision; implementing it silently would invent a
target store and a bigger claim than the item itself.

All three were recorded in the harness workstream graph as D-14, D-15 and D-16.
None is a defect: each is a deliberate boundary, and the guard tests pin the
first two.

## NOMO Agent Identity and Fleet Control Plane: active direction, 2026-10-08

This decision records the product direction the owner selected on 2026-10-08.
It supersedes the earlier recovery-first product recommendation and any
conflicting strategy or sales plan. It does not silently repeal the technical,
security, privacy, compatibility, recovery or operations contracts below.

**Choice.** Make NOMO an Agent Identity & Fleet Control Plane for MCP-capable
agents. Bind each tool call to a trusted principal, workspace, registered agent
and run. Apply identity and scope checks to every call. Use a measured fast path
for reads and low-risk calls. Apply the complete policy and durable-evidence
path to high-risk writes. Give operators agent and run visibility, exact-digest
approval, and truthful stop and revocation state.

**Required host integration.** The coding-agent Harness remains in scope and is
a product-v1 release gate, not a separate product pitch. Harness runs use the
same identity, token, proxy, policy and ledger path. Learning proposals stay
inert until an operator approves the exact proposal digest. Later-session
retrieval is bounded, same-workspace and sourced only from approved, verified
records. It never changes policy, permissions or credentials.

**Local demo.** The target for 2026-10-11 is one trusted local Workbench run, one
workspace, one loopback inbound HTTP MCP endpoint, one disposable target and an
opaque local token with a maximum 60-second lifetime and a proxy audience. The
current proxy accepts agents over STDIO and uses HTTP only as an upstream client,
so inbound HTTP is new work. This local test token is not MCP OAuth. The demo is
not production, a distributed fleet, fleet-wide kill or revocation
acknowledgement, or customer validation.

**Product-v1 authorization.** HTTP MCP authorization must follow the current MCP
specification, including Protected Resource Metadata, Authorization Server
discovery, PKCE, `resource`, audience and scope validation, expiry, revocation
and proper unauthorized responses. STDIO requires a separate process and
environment trust design. The NOMO proxy token is never forwarded upstream.

**Market position.** Identity, credential brokerage, MCP gateways and runtime
controls are active competitive areas. No empty-market, first or only claim is
authorized. The capability map and MVP spec define a qualification test based on
a real write incident or blocked write, four named owners, a specific pilot
environment and a dated next step. Positive reaction alone is not demand proof.
Pricing and tiers remain unvalidated hypotheses, and no price claim is approved.

**Compatibility.** NOMO is the product name and `@nomo/*` is the public package
target. Existing `@void/*` imports, environment names, CLI commands, state and
ledgers remain compatible through a tested, explicit, versioned migration.
Never silently rename or delete user state.

**Documents and authority.** The capability map, MVP spec and implementation
plan are the active product-design references. Conflicting older product
strategy and sales documents will be removed from the active feature branch
after valid evidence is migrated. Keep `DECISIONS.md` history, current technical
contracts and valid operations documentation. Do not rewrite Git history.

## Appwrite removed; Apple app work out of plans, 2026-11-21

The owner decided on 2026-11-21 to stop maintaining Appwrite, which the product
does not use, and to take Apple app work out of every plan, because the owner
works on Linux and cannot build or test an iOS or macOS app.

**Appwrite removed completely.** The hosted MCP function directory
`apps/appwrite-mcp`, the Appwrite auth provider `cloud/auth.mjs`, the
provisioner `cloud/appwrite.mjs` and the seeder that only its test imported are
deleted, together with their tests, their documentation and the `appwrite-mcp`
entry in the gate suite list. `cloud/server.mjs` never imported the auth
provider or the provisioner, and its account routes are the Supabase broker in
`cloud/account.mjs`, so no hosted route and no deployment path reached
Appwrite, and hosted behaviour is unchanged. The licence line, the
environment-variable gate and the documentation inventory were updated with
the deletions.

**Apple app work is out of the plans.** The Apple apps plan
`docs/APPLE-APPS-PLAN.md` and the 1.0.1 Apple release plan
`docs/superpowers/plans/2026-09-23-nomo-1.0.1-apple-release.md` are deleted, and
the Apple, iOS, iPadOS, Swift, SwiftUI, Xcode, TestFlight and App Store work
items, phases, acceptance rows and stop rules are removed from the plans that
remain. `docs/PLATFORM-REDESIGN-PLAN.md` is predominantly Apple work, so it is
retired whole with the superseded marker at its head instead of being
rewritten; web GUI work is planned in `docs/GUI-UPGRADE-PLAN.md`. The
`apps/apple` sources, the Swift packages, the `apple:*`
package scripts and the Swift and Apple gate suites are untouched: they stay in
the tree and report UNRUN on a machine without the Apple toolchain, which is
what a suite nobody could run has to report. A mention of macOS or Linux as an
operating system the CLI or the Tauri desktop app runs on is a platform fact
and stays in the plans.

## Terminal component library: not adopted, 2026-11-25

**Decision.** Whether the interactive workspace should be rendered by a
terminal component library (Ink or `@opentui/core`) instead of the hand-written
renderer in `packages/cli/src/tui/`.

**Choice.** Not adopted. The renderer stays hand-written and the frame string
stays the contract: `renderWorkspace(ui, columns, rows, input, editing, busy,
visuals)` returns exactly `rows` lines, each padded to `columns`, and that one
string is what the snapshots, the accessibility tests and the PTY matrix pin.
No migration is started by this decision.

**Why the library would not buy what this renderer needs.** The renderer is a
pure function from `WorkspaceTui` state to a width-exact frame, not a retained
widget tree. Every requirement below is a property of the frame, and each one
is the thing a React reconciler with its own layout and paint model abstracts
away:

- **Width-exact rails.** `composerTopRail` must emit exactly 40 cells at 40
  columns, and a test asserts the cell count. The slot ladder drops a chip whole
  rather than clipping it. A library's flexbox wrapping is a second width model
  that has to be reconciled with this one on every row.
- **Its own cell-width table.** `layout.ts:34` records the package's
  "no dependency rule" and implements East Asian wide, combining, emoji and
  symbol-block widths by hand, because a wrong model "made the model undercount
  real terminal rows while agreeing with itself". That is the worst failure
  shape for a border-drawing renderer.
- **Glyph presets.** `NOMO_TUI_SYMBOLS=unicode|ascii|nerd` selects from three
  glyph sets with ASCII parity, and 59 bundled icon files plus the Kitty
  graphics path in `brand.ts` sit behind them. `brand.ts` still carries the
  measured Ink defect: "Ink drops Kitty escapes from frames".
- **Monochrome and motion guarantees.** `a11y.test.ts` holds that every fact a
  frame prints is a string: a monochrome terminal, the ASCII preset and a
  frozen motion frame carry the same words as truecolour, Unicode and animated
  ones. Colour, glyph weight and motion are decoration, never the only carrier
  of meaning.
- **Deterministic snapshots.** 40 frames across five sizes are pinned by
  SHA-256 of the ANSI-stripped frame plus row count and widest row, with a
  pinned clock, cwd, git cache and fixtures.
- **The PTY matrix.** `scripts/src/verify-tui-terminal.py` is 1,280 lines with
  10 scenario bodies and 54 passing assertions across 40x12, 80x24, 120x40,
  160x45 and 200x48, matching exact text at exact positions.

**There is no measured performance pressure to relieve.** `perf-budget.test.ts`
measured a steady-state p95 of 2.98 ms at 200x48 over a 12,799-row transcript
and 2.41 ms at 80x24, against a 50 ms regression ceiling (run 2026-11-25). The
adapter already compares rows and writes only changed lines with cursor
addressing (`workspace-terminal.ts:221-255`), so the native-renderer argument
for `@opentui/core` does not apply to a workload that is already 16x inside
budget.

**What it would replace.** All 49 production files in `packages/cli/src/tui/`
(32,207 lines, 1.16 MB). The load-bearing ones are `workspace.ts` (16,430),
`workspace-runner.ts` (3,274), `pet.ts` (1,526), `theme-config.ts` (623),
`brand.ts` (474), `watch.ts` (459), `run-timeline.ts` (454), `palette.ts` (450),
`activity.ts` (421), `motion.ts` (404), `layout.ts` (385), `charts.ts` (383),
`workspace-terminal.ts` (383), `session-tree.ts` (378), `tool-browser.ts` (365),
`inspector.ts` (362), `blocks.ts` (344), `cheatsheet.ts` (330) and
`diff-panel.ts` (307). It would not replace Workbench, the ledger, policy, the
proxy or the registry: those own behaviour, and the renderer only reads their
state. The domain content (what each row says and why) lives inside the same
files, so a migration has to extract it before it can repaint it.

**Measured cost of the two attempts already made.**

- Ink `^8.0.0` was a `packages/cli` dependency from 2026-10-28 (`0748d41e`) and
  was gone from the mainline by 2026-11-04 (`14a77b36`). Its known defect is
  still documented in `brand.ts`.
- `@opentui/core` 0.6.8 with `@opentui/react` and React 19.3.1 arrived in
  `dd1e3dd4` (2026-11-01) as an additive adapter over the existing state:
  `workspace-app.tsx` 518 lines, `workspace-app-model.ts` 160,
  `workspace-app.render.test.tsx` 635, `workspace-app.test.ts` 95, plus
  `workspace-runner.ts` +298, `bundle-cli.mjs` +52, `rollup.config.mjs` +19 and
  179 lockfile lines. It rendered the same `workspaceSurface` rows and kept the
  text renderer for one-shot snapshots, which is the cheapest possible shape.
- It was deleted whole in `d3252367` (2026-11-23): -2,286 lines across four
  files, with `react`, `@types/react`, `@opentui/core` and `@opentui/react`
  removed from `packages/cli/package.json`, and no replacement capability kept.
  `scripts/src/verify-opentui-terminal.py` remained orphaned until T12 retired
  it with no caller.
- A real replacement is therefore not "port `workspace.ts`". It is 32,207
  production lines and 20,191 test lines, with all 40 snapshot hashes and all
  54 PTY assertions re-derived against a different wrapping, width and paint
  model. The two earlier attempts are the only local measurement of that cost,
  and neither survived.

**What would be gained, stated fairly.** A JSX component model that new
contributors can read; library-maintained key, paste and mouse parsing; a native
renderer with damage tracking and scroll regions; and less bespoke code per new
screen. None of these is a current defect: the key, paste, mouse and terminal
lifecycle paths are already covered by `workspace-input-parity.test.ts`,
`workspace-terminal-lifecycle.test.ts` and the PTY matrix.

**Re-open triggers.** This decision is not permanent. Re-open it when one of
these becomes measurable:

1. A steady-state frame p95 exceeds the 50 ms ceiling at 200x48 on the target
   machine and profiling puts the cost in painting rather than row building.
2. NOMO needs continuous partial redraws or scroll regions the full-frame plus
   row-diff model cannot meet, such as a live view above roughly 10 frames per
   second.
3. New-screen throughput becomes the bottleneck, measured as screens shipped
   against review cost, not as an opinion about JSX.
4. A candidate library can reproduce all 40 snapshot hashes and the 54 PTY
   assertions byte for byte behind an adapter, with the Kitty graphics path and
   the monochrome guarantees intact.

**Cheapest bounded experiment if someone insists.** Render one screen (Help or
Models) through the candidate library behind an adapter and diff its bytes
against the existing snapshot at the five sizes. No production switch, no
re-baseline, no dependency added to `packages/cli/package.json` until that diff
is empty. If it is not empty, this decision stands.

**T11 experiment result, 2026-11-25.** The bounded experiment failed at the
renderer boundary before any layout porting was needed. A temporary spike,
since removed, fed the exact current Help frame through Ink 8.0.0 with React
19.3.1 and ink-testing-library 4.0.0. Even with the correct frame as input,
Ink did not preserve the bytes: at 40x12, 52x16, 80x24, 120x40 and 160x45
every snapshot hash differed, every line differed, and 246, 461, 1,114, 2,856
and 4,894 trailing cells were missing. The 120x40 and 160x45 outputs also
doubled their row counts to 80/40 and 90/45 because width-padded input was
wrapped before padding was discarded. Ink's own `output.js` ends each line
with `trimEnd()`, so this is structural rather than a spike tuning mistake.
No dependency or production file was added, and the spike directory was
removed as the experiment requires. This decision stands.

## Composer slot ladder and no mode chip, 2026-11-25

**Decision.** Whether the Chat composer rail gets a mode chip, and which
optional rail slot is dropped first when cells run out.

**Choice.** Keep the mode in its status-row pill and do not add a composer
mode chip. The rail has about one spare slot at 40 columns, and a second copy
of the mode would spend it on a claim the status row already makes. The
optional slots follow one ladder, highest first: queue > attachment > model >
context > pet dock (`COMPOSER_SLOT_LADDER` in
`packages/cli/src/tui/workspace.ts`, documented in
`packages/cli/src/tui/DESIGN.md`). The label and the action hint are required;
a long label gives up whole trailing words before the hint is lost. A slot that
does not fit is dropped whole, never clipped, and a shorter lower slot may still
use the cells a longer higher one could not.

**Why this order.** A queued prompt will send on its own, so it is the fact the
operator most needs to see; an attachment is part of the draft being written;
model and context are repeated in the status row; the pet dock is reaction, not
state, so it goes first.

**Proven by.** `workspace.test.ts` rail-cell assertions at 40, 80, 120, 160 and
200 columns, and the composer-hint check in
`scripts/src/verify-tui-terminal.py` at 40x12 through 200x48.

**Rollback.** Revert the ladder constant and the label rule; this decision
stays unless a mode chip is wanted, in which case remove the status-row pill
first.
