# NOMO: context

With `DECISIONS.md` and `STANDARDS.md` this is the context pack and it is
authoritative. When code disagrees with the pack, the code is wrong; when the
pack is wrong, a work package updates it. Never diverge quietly.

NOMO is a process that sits between an AI agent and the tools it can write to.
For each call it decides a reversibility class from the state of the target,
applies a policy, and appends a signed record to a hash chained ledger. Later it
can replay the inverses. Everything else follows from that sentence. The
marketing site here sells the finished idea; BUILD-PLAN.md section 1 names the
three places it is ahead of what is buildable.

**The sharp half, stated here so nothing else has to restate it.** An inverse
runs against a live system and touches only the effect it names: the other rows,
and the writes other people made in the meantime, are left alone. A point in
time restore cannot do that, which is why a restore is not a substitute for an
inverse. And for a managed Postgres restore the record of the reversal is
written into the customer's own schema, so a third party confirms it by querying
that database, without trusting NOMO, its signing key or its ledger.
`scripts/receipt-demo/` runs both halves against a real PostgreSQL server, and
`docs/RECEIPT-VERIFY.sql` is the check a third party runs; it prints FAIL when
the database and the receipt disagree.

The managed Postgres adapter re-reads the rows it wrote and refuses unless they
canonically equal the capture
(`packages/connectors/src/postgres/managed.ts:1393`), and only then writes the
record into `${schema}.recoveries` in the customer's database
(`packages/connectors/src/postgres/managed.ts:1399`).

What the signature does not add: it establishes that the bytes came from a
process holding that key, and nothing more, because the recorder, the signer and
the verifier run as one OS principal (`OPERATIONS.md`). The placement of the
receipt is the claim; the cryptography is a limit to state, not a moat.

This is a narrower claim than "undo for AI agents", and the narrower one is the
defensible one: undo for agent actions has been sold since August 2025. See
`COMPETITIVE-WEDGE.md` for what is contested and what is not.

## Vocabulary, used precisely

- **Intercept**: terminate the agent's tool call, decide, then forward, hold or
  refuse it. NOMO does not invent business intent. Its authorized managed
  executor performs the requested mutation and later its verified recovery.
- **Classify**: assign a class to one call by evaluating that tool's registry
  cases against the target's state.
- **Class R0 to R3**: fully reversible, reversible with trace, mitigable only,
  irreversible. A class belongs to a call, never to a tool.
- **Precondition**: a fact about the target that must hold for a case to apply,
  such as bucket versioning enabled. Declared, not probed.
- **Case**: one verdict in a registry entry, valid only while its precondition
  holds. Cases are ordered, first match wins.
- **Inverse**: returns the target to its prior state exactly. Only R0 and R1
  have one.
- **Compensation**: reduces the harm of a call with no inverse. R2 has
  compensations, not inverses.
- **Hold**: pause a call and wait for a human decision. Version one blocks.
- **Blast radius**: the count of resources affected, with explicit exact,
  bounded or unknown precision. Sampling cannot prove an exact count or satisfy
  an exact policy limit. Unknown is not zero.
- **Ledger**: the append only, hash chained, per entry signed record of every
  intercepted call.
- **Taint**: a later call's tracked dependency on an earlier one's result, which
  orders a replay correctly.
- **Attestation**: a ledger slice a third party verifies offline, without our
  software and without trusting us.

## Layout after WP-00

The executable recovery contract and current coverage are maintained in
`RECOVERY-CONTRACT.md` and `RECOVERY-COVERAGE.md`. Registry metadata, a connected
account and a working inverse are distinct capabilities. The managed runtime
in `packages/runtime` is being integrated incrementally; legacy hosts are not
automatically covered by its guarantees.

```
api/          Vercel Functions, and still the registry data (DECISIONS 6b)
artifacts/    the site, and the Express layer that serves it
docs/         the context pack and the plans
lib/          site support packages, not product
packages/
  registry/   class data, case evaluator, schema
  ledger/     canonical JSON, chain, signing, stores, verification
  proxy/      MCP proxy: server side, client side, transports
  policy/     match rules, decide, hold, approval channel interface
  connectors/ one per tool surface: facts, snapshot, inverse
  cli/        run, ledger verify, replay, attest
apps/
  control-plane/  approvals, live feed, ledger browser. Paid, later
```

`packages/registry` imports nothing: not the ledger, not node builtins. A
connector never imports another connector. The proxy resolves connectors by id,
never imports one. The ledger exposes `append` and `read`, never `update`.

## The test for whether a change belongs

Does this make the write path more accountable, or is it a feature that happens
to be nearby? If the second, it does not ship. (BUILD-PLAN.md section 1.)

Cloud workspace login uses a Secure, HttpOnly, same-site cookie with a 400-day lifetime renewed on authenticated use. The workspace token remains in server configuration and survives deployments. Logout clears this browser session; token rotation revokes all sessions. Browser data removal or browser expiry policies can still require login. Never embed the token in public assets, source, or URLs.

## Frozen legacy identifiers

The product was renamed VOID to NOMO. The identifiers below deliberately keep
the old spelling. They are wire contracts, live deployed state, or third-party
semantics: renaming any of them breaks a stored ledger, orphans live state, or
makes an already-written record unreadable. A rename is not a cleanup here; it
is a data-loss or an outage. Do not "tidy" these.

**The one rule.** Any dotted identifier matching `\bvoid\.[a-z0-9_]+(\.[a-z0-9_.-]+)*`
is frozen. The only exception is `void.mjs`, which is a filename and does get
renamed (to `nomo.mjs`).

Wire protocol and schema ids:

| Identifier | Why it stays |
| --- | --- |
| `void.companion.v1`, `void.companion.v2` | iOS/executor handshake, persisted in `apps/apple/Fixtures/Protocol/`. The deployed executor speaks v1. |
| `void.signed-ledger.v1` | Format tag on exported ledger bundles. Renaming desyncs every existing export. |
| `void.snapshot.v1` | Schema id at the end of `apps/appwrite-mcp/src/appwrite_mcp/nomo_snapshot.json`. The file is renamed; its schema id is not. |
| `void.adapter-capability.v1`, `void.adapter-capability.v2` | Adapter capability handshake, asserted in both protocol fixture sets. |
| `void.adapter-conformance-run.v1` | Conformance run record shape. |
| `void.ledger.v1`, `void.ledger.entry.v1`, `void.ledger.*` | Signed ledger chain format. Stored ledgers reference these. |
| `void.chats.v1` | gui-web localStorage chat store key. |
| `void.theme`, `void.booted` | gui-web localStorage keys for theme and first-run banner. |
| `void.github` | gui-web localStorage key holding a masked token. |
| `void.provider.v1`, `void.models.cache.v1` | gui-web localStorage caches. |
| `void.operation.v1` | Durable operation status records on disk. |
| `void.recovery-job.v1` | Recovery job records on disk. |
| `void.metrics.v1` | Exported metrics document format. |
| `void.taint.v1` | Taint journal format. |
| `void.export-bundle.v1` | Export bundle envelope. |
| `void.retention.index.v1` | Retention index format. |
| `void.demo.*`, `void.auth.*` | Log/audit event namespaces emitted by the cloud runtime. |
| `void.legacy.capture.v1`, `void.legacy.envelope.v1`, `void.legacy.outcome.v1` | Pre-rewrite capture records already written to durable storage. Re-reading them under a new id returns unknown. |
| `void.postgres.capture.v1`, `void.s3.capture.v1`, `void.s3.restore.v1` | Capture record shapes for the Postgres and S3 recovery sources. |
| `void.recovery.v1`, `void.recovery-plan.v1`, `void.recovery-lineage.v1`, `void.recovery.key-check.v1`, `void.managed-recovery.v1`, `void.recovery-backup.v1` | Recovery job records, plans, lineage edges and backups written to disk before a rewrite. |
| `void.budget.account.v1` | Per-account budget record on disk. |
| `void.ledger.attestation.v1`, `void.ledger.merkle.v1` | Attestation and merkle proof shapes inside signed ledger bundles. |
| `void.export-capability.v1`, `void.export-vault-manifest.v1` | Capability and vault manifest envelopes on exported bundles. |
| `void.adapter-conformance.v1` | Adapter conformance record shape. |
| `void.retention.lock.v1` | Retention lock record. |
| `void.workbench.request.v2` | Workbench request envelope version tag. |
| `void.invalid`, `void.policy.yaml` | Reserved-TLD host and legacy policy filename recorded in existing docs. |
| `void.tenant_id` | Postgres RLS session setting (`current_setting`). Not mine; listed for completeness. |

Live deployed state. Renaming these orphans real state on a running system:

| Identifier | Live surface |
| --- | --- |
| `com.void.companion`, `.tests`, `.uitests`, `.device` | iOS bundle ids. Renaming invalidates every installed build and every provisioned device. |
| `dev.void.desktop`, `dev.void.desktop.workspace` | Tauri bundle id and the Keychain/CredMan service name in `apps/desktop/src-tauri/src/keychain.rs`. Renaming orphans every stored credential. |
| `__Host-void-auth`, `__Host-void-account`, `__Host-void-session`, `__Host-void-demo`, `__Host-void-oauth-` | `__Host-` cookie prefixes. A changed prefix silently drops every live session cookie. |
| `x-void-worker-token` | Deployed worker auth header. |
| `void_cloud_state`, `void_cloud_ledger`, `void_cloud_events`, `void_cloud_events_immutable`, `void_cloud_immutable()` | Deployed Postgres objects (`cloud/schema.sql` and its migrations). |
| `refs/void/operations/`, `refs/void/recoveries/` | Git refs holding durable execution and recovery receipts. Recovery re-reads them by exact path. |
| `void_test`, `void_gui_upgrade_preview`, `void_demo`, `void_dev` | Provisioned database names. |
| `void_control_plane`, `void_documents`, `void_web`, `void_local_web` | Appwrite resource ids in the project provisioned 2026-09-30, declared `existing: true`. |
| `void_revision_<hash>` | Postgres trigger-name prefix. Renaming installs a second trigger beside the old one on every existing managed install. |
| `void-demo-v1:${id}.${expires}` | HMAC input for cloud demo cookies. Renaming invalidates every live demo cookie. |
| `VOID Managed Git <managed-git@void.invalid>`, `VOID managed commit <hex>`, `VOID managed recovery <hex>` | Git author/committer identity and commit subjects. `recoveryResult()` re-parses already-written recovery commits by exact author/subject regex. |
| `void_prime`, `void-prime-dogfood` (path form) | Local dev MCP project paths already provisioned on developer machines. |
| `%LOCALAPPDATA%\VOID\`, `/Library/VOID/` | Existing install locations. |

Third-party semantics that must stay verbatim:

| Identifier | Owner |
| --- | --- |
| `POST /v1/invoices/:id/void`, `stripe.invoice.void`, the `"void"` tag and the note "voiding keeps the invoice number consumed", "Void a finalized Stripe invoice." | Stripe's invoice-void API, inside the registry snapshot. |
| `pg.transaction.void_controlled` | Postgres transaction-control fact. |
| `void` and `void-cli` as npm package names, `void@0.20.3`, `voidzero-dev/void`, the `npm view void` measurements | Third-party npm packages that are already taken. Records of that measurement stay; our own command name is renamed. |
| `LicenseRef-VOID-Proprietary` | SPDX id asserted by `scripts/src/licence-line.test.mjs`. |

External URLs. These repositories and deployments keep the name `void`:
`github.com/Dawe583/void`, `gitlab.com/sitespot1/void`, `dawe583.github.io/void/`,
`void-tui.vercel.app`, `void-neon-ten.vercel.app`, `chat.voidagent.tech`,
`voidzero-dev/void`, `bible.void/reader`, `io.github.VoidNullable/lific`,
`Dawe583/void-empty`, and every `.../void/releases/download/...` URL including
its asset filenames (`VOID_0.1.0_aarch64.dmg`, `VOID_0.1.0_x64-setup.exe`).

Also frozen, because it is not the product: the English noun "void" (as in
"null and void"), TypeScript's `void` operator and return type, and Swift's
`Void` type in `-> Void` and `Task<Void, Never>`.
