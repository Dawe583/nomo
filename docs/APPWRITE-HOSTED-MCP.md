# The hosted VOID MCP surface

What this document records: what the hosted endpoint publishes, where every
published fact comes from, what has been verified against the live Appwrite
project, and the one step that blocks the endpoint from being reachable. It is
a record against a date, not a plan.

Read with `apps/appwrite-mcp/README.md` (the function's own operator note) and
`docs/DISTRIBUTION-PATH.md` (why the hosted route is not the install funnel).

## The boundary this endpoint holds

The hosted endpoint is **read-only reference surface**. It answers questions
about VOID and never performs a governed operation.

That boundary is not a limitation of the implementation, it is the product. A
recovery needs a local workspace, a local policy, and the retained signing key
that signed the record being reversed. Hosting the execution would mean
hosting the key, and a server that holds a customer's signing key is a
different product with a different trust model than the one this repository
builds. Every tool payload says so in its own response body rather than in a
comment, because a client reads payloads and does not read source.

## What it publishes

Six tools, all annotated `readOnlyHint: true`:

| Tool | Answers |
| --- | --- |
| `void_project_info` | What this endpoint is, where recovery runs, and the registry's current size |
| `void_registry_search` | Search the reversibility registry by id, vendor, surface, tag or class |
| `void_registry_entry` | One operation's preconditions, classes, inverses and validity windows |
| `void_registry_summary` | Registry totals, class distribution, vendor coverage, and its own disclaimer |
| `void_local_tools` | The local stdio tools with arguments and their read/write annotations |
| `void_cli_commands` | The CLI command surface, read from the dispatcher |

The registry is the interesting one. VOID's claim is that reversibility is not a
property of an API call but of the system state the call runs against: an S3
PUT is `r0` on a versioned bucket and `r3` on an unversioned one. A catalogue
that published one class per operation would therefore be wrong half the time,
which is why every registry answer is **one row per precondition** and why
`registry_cases` is a separate table from `registry_operations` in Appwrite.

Measured from the live project on 2026-09-30, registry `2026.09.2`:

- **268 operations**, **491 preconditions**, **48 vendors**, **170 surfaces**
- Classes: `r0` 57, `r1` 101, `r2` 156, `r3` 177

## Where every published fact comes from

Nothing in `app.py` is written by hand. The facts are read out of the VOID source
tree by `apps/appwrite-mcp/src/appwrite_mcp/void_data.py`:

| Published | Read from |
| --- | --- |
| Registry operations and preconditions | `packages/registry/src/registry.ts` |
| Registry version and disclaimer | the same file |
| Local tool names, arguments, `readOnlyHint` | `packages/cli/src/recovery-mcp.ts` |
| CLI commands | `packages/cli/src/dispatch.ts` |

**The previous implementation was hand-maintained and unenforced.**
`app.py` carried a literal list of eight recovery tool names. Nothing compared
it to the CLI, so when the CLI changed, the endpoint would have kept publishing
names that no longer existed and no test would have failed. That is the failure
this design exists to prevent, and it is worth stating plainly because the
repository had already had a version of it: the hosted endpoint was the one
place whose entire content was a claim about the product, maintained by hand,
with nothing comparing it to the product.

### The deployed function has no repository

An Appwrite Function receives a tarball, not a git checkout, so
`void_data.py` cannot read the source tree at run time. It falls back to
`void_snapshot.json`, which is generated from that same tree by
`apps/appwrite-mcp/scripts/generate-snapshot.py`.

The snapshot is only honest while it equals its source, and that is enforced
rather than assumed: `RegistryCoverageTest` in
`apps/appwrite-mcp/tests/test_hosted_endpoint.py` compares the committed
snapshot against a fresh build and fails if they differ. A stale snapshot
therefore fails the gate rather than being published as a current catalogue.

```
/tmp/void-mcp-venv/bin/python apps/appwrite-mcp/scripts/generate-snapshot.py
/tmp/void-mcp-venv/bin/python apps/appwrite-mcp/scripts/generate-snapshot.py --check
```

The generator calls `appwrite_mcp.snapshot_builder`, which lives in the function
package rather than in the script, so the gate and the generator cannot drift
apart by testing the snapshot against a builder that never wrote it.

## The Appwrite resources, and what they are not

`cloud/appwrite.mjs` is the manifest. `cloud/seed-appwrite.mjs` fills it.
Both were run against the live project on 2026-09-30.

Three tables were added to the existing `void_control_plane` database:

| Table | Rows | Purpose |
| --- | ---: | --- |
| `registry_operations` | 268 | one row per classified operation |
| `registry_cases` | 491 | one row per precondition, carrying the class |
| `mcp_tools` | 6 | one row per published tool, with its annotations |

All three have `rowSecurity` and `documentSecurity` on and **no row-level
permissions at all**, which means a client SDK cannot read them and only the
server API key can. That is the correct posture for a catalogue: it is
published by the function, not by a browser.

**A signed ledger is not published here, and must not be.** A ledger is a byte
chain on one machine whose integrity is the property that makes it evidence.
Copying its records into a hosted database would produce a second, unsigned
copy of something whose value is that it is signed and append-only, and a
reader who found the copy would reasonably ask which is authoritative. The
registry is public reference data; a ledger is evidence. They are not the same
kind of thing and the seeder keeps them apart.

### Indexes are declared, not assumed

Every column a published query filters or orders by carries an index, checked
by `cloud/appwrite.test.mjs` against a declared list of filtered columns. The
check is not "every column is indexed": indexing a summary or a precondition
string would write an index over hundreds of bytes per row to serve a lookup
nobody makes. The test names the query surface instead, and fails when a column
is added to it without an index.

### Row ids are digests

Appwrite caps a row id at 36 characters and the registry's own ids are longer —
`aws.ec2.securitygroup.authorize_ingress` is 39. `rowIdFor` uses a SHA-256
digest of the key rather than a truncation, because a truncation collides
(two ids sharing a 36-character prefix would overwrite each other silently,
and a catalogue that drops entries is worse than one that refuses to start) and
because a truncation is not stable under growth.

## What was verified, and what was not

Verified against the live project on 2026-09-30 with the project API key:

- Three tables created, enabled, `rowSecurity: true`, with 4 + 2 + 1 indexes
  present on the live resources.
- 268 / 491 / 6 rows written, and read back: an indexed lookup of
  `operation_id = aws.s3.object.put` resolves to exactly one row, and its three
  preconditions come back with the classes, inverses and windows the source
  declares.
- Class counts read back from the live `tone` index match the source exactly:
  `r0` 57, `r1` 101, `r2` 156, `r3` 177.

Not verified, and not to be inferred from the above:

- **The hosted endpoint has never answered a request.** No deployment of this
  work was performed; the live function still runs the previous two-tool build.
- **There is no public MCP URL.** See below.
- No Appwrite quota, cold-start or response-size claim is made. The Free-plan
  limits (1 bucket, 1 database, and either 2 or 5 functions depending on which
  page is read) are tight enough that a larger backend needs a paid plan, and
  the two Appwrite sources disagree about the function count.
- `mcp==2.0.0` is pinned exactly and every symbol the dispatcher imports exists
  in it, but two of them are private: `mcp.server._streamable_http_modern`
  and `server._lowlevel_server`. The pin is the only guard, and a minor SDK
  bump can break the import at load time with no other symptom.

## The one step that blocks the public endpoint

**The MCP function has no registered public domain, so it has no reachable
URL.**

Measured on 2026-09-30:

```
POST https://6abbae3e000f6f24ce2a.fra.appwrite.run
  -> 404 {"type":"router_rule_not_found","message":"This page is empty, but you can make it yours."}
```

The domain routes answer the project API key with `general_access_forbidden`,
which was also measured rather than assumed: `GET /v1/functions/{id}/domains`
returns `404` to that key. Adding a domain is a console action, not an API
call this repository can make.

Until a person does it:

- there is no hosted MCP URL to give a client,
- there is nothing to submit to `registry.modelcontextprotocol.io`, whose
  remote-server requirements state that the URL must be publicly reachable,
- and the endpoint's correctness rests entirely on the offline suite, which
  drives the real handler through a fake Appwrite context.

The step is recorded in `appwriteManifest.manualSteps` rather than only here,
because a blocker a reader cannot see in the manifest is a blocker they
discover by trying.

For the registry entry itself, `server.json` also needs `remotes[]` rather than
`packages[]`, because VOID is a hosted endpoint and not an npm package. The
npm `mcpName` ownership check applies to packages and is not required for a
remote-only server.

## What is deliberately absent

- **No writes.** The endpoint has no write tool, and `MCP_AUTH_MODE` still
  exists for operators who want a bearer gate on a read-only surface.
- **No repository file serving.** The repository is not anonymously readable
  and the function holds no GitHub credential.
- **No ledger, no keys, no execution.** Recovery is local. That is the product.
