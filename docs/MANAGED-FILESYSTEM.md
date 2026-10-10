# Managed filesystem recovery

The `filesystem.managed` adapter implements create, write and delete for one
regular file inside an explicitly configured cooperative workspace. It also
supports rename between two validated file paths when the
source is a regular single-link file and the destination is absent. Git,
directory mutations and arbitrary shell side effects are not covered.

A successful inverse restores exact bytes and POSIX permission bits on Unix.
Windows supports writable regular files only (mode 0666), restores bytes, and
refuses read-only files and other explicit modes before dispatch. It does not
restore inode identity, ownership, timestamps, ACLs, extended attributes or
external observers. The declared scope is included in the signed runtime flow
and approval digest. Binary data uses canonical base64, limited to 1 MiB decoded.

## Ownership and conflicts

The operator must exclude concurrent external writers during dispatch and Undo.
Node's filesystem API does not provide atomic conditional path replacement.
The adapter verifies observed revisions, uses atomic no-clobber creation and
same-directory replacement, and syncs file contents. Unix also syncs directory
changes; Windows lacks Node directory-handle flushing, so directory-entry
durability across power loss is not guaranteed. It does not
claim protection against a malicious process racing path resolution.

Revisions include content, mode, device/inode, nanosecond ctime and ownership.
Observed ABA edits and later chmod operations conflict. On POSIX, rename binds
both source and destination revisions and refuses a destination observed before
dispatch. It then uses the native filesystem rename. A writer outside the
cooperative boundary can create a destination after the check, and POSIX rename
can replace it. Undo has the symmetric race if an outside writer recreates the
source. Undo requires the source to remain absent when checked and the
destination to match the recorded result. Missing files include the parent directory revision,
so unrelated directory changes can conservatively block Undo of a deletion or
rename. This is a deliberate refusal, not permission to force
a restore. Existing files must have one hard link and no special permission bits.

Traversal, symlinks, non-regular files, oversized captures, `.git`, `.ssh`, `.aws`,
`.env*` and `.nomo*` path segments are refused. The configured runtime state
must live outside the managed root, including through symlinks/junctions and
native Windows paths. Alternate data streams, reserved device names, trailing
dots/spaces and Windows-invalid characters are refused on every platform to
keep portable paths unambiguous. A managed path is not a general sandbox for
other tools installed on the machine.

## Configuration and CLI

```json
{
  "workspace": "my-project",
  "stateDir": "recovery-state",
  "encryptionKeyEnv": "NOMO_PROJECT_RECOVERY_KEY",
  "agentId": "coding-agent",
  "policyPath": "recovery-policy.yaml",
  "filesystem": {
    "root": "project",
    "cooperative": true
  }
}
```

Paths are relative to the configuration file. Set the encryption key through a
private environment variable containing 32 random bytes encoded as base64.
Never place the key in the request, policy, public build or source control.
The existing root must contain only files authorized for this agent to change.

An execution request identifies the exact operation and run:

```json
{
  "workspace": "my-project",
  "operationId": "edit-001",
  "agentId": "coding-agent",
  "runId": "run-001",
  "adapterId": "filesystem.managed",
  "arguments": {
    "action": "write",
    "path": "notes.md",
    "base64": "SGVsbG8K"
  }
}
```

Use `nomo recovery inspect --config config.json --input request.json`, review
the observation, then execute the identical request with `--approve` and the
returned approval digest. `plan` returns a recovery plan for the operation;
`apply` requires that exact plan and its digest. Changed requests or state
invalidate the approval. Delete accepts only `action` and `path`. Rename accepts
only `action`, `path` and `to`. Both rename paths use the same traversal, protected-path and symlink
validation.

For local MCP, run `nomo recovery serve --config config.json`. The existing five
managed recovery tools remain available; `nomo_execute` advertises the configured
filesystem mutation schema. Operator policy must explicitly allow these tools.
A connected MCP client does not bypass the approval policy.

## Crash behavior

The encrypted vault captures the before image before dispatch. The signed
journal records the lifecycle. Confirmed operations can be recovered after a
runtime restart, and repeating the same operation ID does not redispatch it.

Filesystem replacement and journal persistence cannot commit atomically. A
process loss after dispatch but before durable outcome persistence remains
unknown. The adapter does not infer success from matching content and does not
retry an inverse after an uncertain result. This is intentionally narrower than
the PostgreSQL adapter's transactional receipt reconciliation.

## Verification

```sh
node --test packages/connectors/src/filesystem/managed.test.ts packages/cli/src/recovery-filesystem.test.ts
```

The checks use real temporary directories, binary content, permission bits,
restart, idempotence, rename, user edits, ABA, source recreation, destination
conflicts, links, traversal and over-limit files. The CLI test executes inspect, approval, write, plan and approved Undo with encrypted
on-disk state. They do not certify concurrent hostile writers, Git, full R05
or Windows rename behavior. Windows rename is explicitly refused until separate
CI evidence supports equivalent readiness.

On POSIX, `nomo recovery conformance` additionally runs 32 disposable
create/write/delete/rename checks. Windows runs the existing 24
disposable create/write/delete checks and emits a versioned JSON report. See [Adapter conformance](ADAPTER-CONFORMANCE.md).
