# NOMO upgrade checkpoint

One operational certification run, recorded for the reverse and recovery
upgrade programme. This file exists because the programme kept shipping
components and gates while no single run had been recorded end to end
(`docs/PLAN-GAPS.md` G-15, `docs/REVERSE-TOOL-UPGRADE-PLAN.md` WP-R14).

It is a record of one run on one machine. It is not a certification, and it
does not close any external gate. Where the run did not go, this file says so
rather than leaving the reader to assume it did.

## The run

Date: 2026-09-26. Tree: `main` at `263e396`. Host: macOS 27.0 on arm64,
Node v26.8.1, pnpm 10.33.0. No credential was read, printed or created. No
network service, provider, store, signing identity or physical device was
involved.

Command:

```
node --test scripts/src/agentic-reverse-exercise.test.mjs
```

Result: 3 tests, 3 pass, 0 fail, 0 skipped, 0 todo, 2.57 s.

The three arms and what each one actually did, as reported by the run itself:

**1. Real files on disk** (`scripts/src/agentic-reverse-exercise.mjs`, 8 steps,
158 ms). An agent inspects a real target file before proposing any change; a
refused destructive call leaves the target byte-identical; an approved call
captures first and then changes the real file; a reused operation identity is
refused rather than rebound to a different write; the signed journal verifies
over 7 entries; a restarted runtime acts on the same workspace and history; the
confirmed inverse restores the exact bytes and mode 600; a replayed inverse is
refused instead of applied again. The run asserts 11 original bytes, 40 patched
bytes and 38 human-edited bytes.

**2. A database row** (`packages/connectors/src/postgres/reverse-exercise.ts`,
5 steps, 1.1 s). A managed table is installed with its own capture metadata; a
refused row change leaves the row exactly as it was; an approved row change
lands and leaves every other row alone; the confirmed inverse restores the
captured row rather than a guess at it; the signed database journal verifies
over 9 entries. The server is PGlite, in-process. Nothing was provisioned,
signed or migrated on a real cluster.

**3. The transport an agent actually uses** (`packages/cli/src/mcp-reverse-exercise.ts`,
6 steps, 976 ms). A real stdio process negotiates 8 recovery tools under an
operator policy; a permitted mutation lands on the real file through the agent's
own transport; a previewed, applied inverse restores the exact bytes the agent
overwrote; the process wrote a 7-entry chained journal in its retained state; a
human edit after the capture is a conflict and Undo leaves the human's bytes
alone; the same mutation is refused once the operator policy says so, over the
same transport.

## What this run did not cover

Each line is an open item in `docs/OPEN-WORK-AUDIT.md`, not a defect found here.

- **No real PostgreSQL server.** PGlite is in-process. Cascade, tenant and RLS
  isolation, in-flight client kill, network partition and the v1-to-v2 metadata
  migration on a live cluster are all unrun. Row 36.
- **No crash or fault injection.** The restart in arm 1 is a clean runtime
  restart over retained state. Disk exhaustion, process kill and partition are
  unrun. Row 34.
- **No physical, signed or packaged artifact.** Nothing was notarized, stapled,
  installed from a build, or run on hardware. Rows 1-5, 54.
- **No provider, no credentials, no network.** Every arm is local and offline.
  Row 55.
- **No phone, no pairing, no TLS transport.** Rows 47, 48.
- **No staged hold, dependency barrier or cascading cancel.** The blocking hold
  is the only path exercised. Row 26.
- **No cross-host fencing and no cloud budget host.** One process, one journal.
  Rows 22, 27.
- **No S3, GitHub, Vercel, Supabase or managed-vault arm.** The three adapters
  with coverage are filesystem, in-process Postgres and the local MCP stdio
  server. Rows 31, 32, 33.
- **No legacy proxy binding in a production composition root.** Rows 40.

## How to reproduce

```
node --test scripts/src/agentic-reverse-exercise.test.mjs
```

The arms are also inside `pnpm test`, so a green gate includes them. A run that
did not execute is reported as skipped or todo with the reason named, never as a
pass; see the gate gap handling in `scripts/src/ui-layout.test.mjs` for the same
rule on the browser side.

## What would make the next run a stronger claim

In order of value: a disposable isolated PostgreSQL with the five remaining
cases made executable; a fault harness for disk exhaustion and an in-flight
client kill; and a packaged candidate that installs, captures, undoes and
upgrades. The first two are code. The third needs an Apple identity and a
provisioning profile, which is why it is not in this run.
