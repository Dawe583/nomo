# R02 Legacy Proxy Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Certify one real `postgres.row.update` legacy proxy path from durable before-image through upstream outcome and restart recovery.

**Architecture:** The proxy exposes an optional connector-agnostic binding resolver. A resolved binding captures durable evidence before send and records a digest-bound dispatched and terminal outcome around the translated JSON-RPC request. A cross-layer PGlite fixture supplies the Postgres connector and proves restart recovery without adding a connector import to the proxy.

**Tech Stack:** TypeScript, Node.js 24 `node:test`, MCP JSON-RPC, NOMO signed JSONL ledger, NOMO connector registry, PGlite.

**Spec:** `docs/superpowers/specs/2026-09-23-r02-legacy-proxy-binding-design.md`

## Global Constraints

- Work only in the isolated `feature/r02-legacy-binding` worktree.
- Use TDD with a failing `node:test` assertion before each behavior change.
- The proxy must not import `packages/connectors` or any concrete connector id.
- Raw arguments, SQL values and provider results must not enter lifecycle records.
- Use canonical JSON for argument digests.
- Capture failure must cause zero upstream dispatches.
- Any uncertain post-dispatch result is `unknown` and must never auto-retry.
- Observe posture must not create recoverability evidence.
- Only `postgres.row.update` in the conformance fixture is certified.
- Do not add a dependency.

---

### Task 1: Freeze the generic binding evidence contract

**Files:**
- Modify: `packages/proxy/src/forward/legacy-binding.ts`
- Create: `packages/proxy/src/forward/legacy-binding.test.ts`
- Modify: `packages/proxy/src/forward/tools.ts`
- Modify: `packages/proxy/src/forward/tools.test.ts`

**Interfaces:**
- Produces: `legacyArgsDigest(args): Promise<string>`.
- Produces: `LegacyCaptureEvidence`, `LegacyOutcomeEvidence`, `LegacyProxyBinding`, and `LegacyBindingResolver`.
- Produces: validation functions that compare tool, workspace, argument digest and capture digest without retaining raw values.
- Changes: `interceptCall` uses `legacyArgsDigest` instead of `JSON.stringify` hashing.

- [ ] **Step 1: Write contract tests**

Add tests that prove canonical key ordering has the same digest, capture validation rejects a changed tool, workspace or argument digest, and outcome validation rejects a changed capture digest or a terminal status inconsistent with the response kind.

```ts
assert.equal(
  await legacyArgsDigest({ b: 2, a: 1 }),
  await legacyArgsDigest({ a: 1, b: 2 }),
);
assert.throws(
  () => validateLegacyCapture(call, argsDigest, { ...capture, tool: "other" }),
  /tool/,
);
assert.throws(
  () => validateLegacyOutcome(capture, null, { ...outcome, status: "completed" }),
  /unknown/,
);
```

- [ ] **Step 2: Run the focused test and confirm red**

Run:

```bash
node --test packages/proxy/src/forward/legacy-binding.test.ts packages/proxy/src/forward/tools.test.ts
```

Expected: failure because the new exports and canonical digest behavior do not exist.

- [ ] **Step 3: Implement the minimum contract**

Keep `captureLegacyEnvelope` for backward compatibility. Add the new interfaces and pure validation helpers in the same focused module. Import `canonicalJson` and `sha256Hex` once there. Change `interceptCall` to await `legacyArgsDigest` so policy ledger and binding evidence use the same digest.

The binding shape must remain structurally connector neutral:

```ts
export type LegacyProxyBinding = {
  readonly tool: string;
  capture(call: InterceptedCall, argsDigest: string): Promise<LegacyCaptureEvidence>;
  dispatched(evidence: LegacyCaptureEvidence): Promise<void>;
  outcome(
    evidence: LegacyCaptureEvidence,
    response: JsonRpcResult | JsonRpcError | null,
  ): Promise<LegacyOutcomeEvidence>;
};
```

- [ ] **Step 4: Run focused tests and package typecheck**

Run:

```bash
node --test packages/proxy/src/forward/legacy-binding.test.ts packages/proxy/src/forward/tools.test.ts
pnpm --filter @nomo/proxy typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/proxy/src/forward/legacy-binding.ts packages/proxy/src/forward/legacy-binding.test.ts packages/proxy/src/forward/tools.ts packages/proxy/src/forward/tools.test.ts
git commit -m "Add canonical legacy binding evidence contract"
```

### Task 2: Bind proxy dispatch and terminal outcomes

**Files:**
- Modify: `packages/proxy/src/bin.ts`
- Modify: `packages/proxy/src/bin.test.ts`
- Modify: `packages/proxy/src/index.ts`

**Interfaces:**
- Consumes: Task 1 `LegacyBindingResolver` and evidence validators.
- Produces: optional `ProxyOptions.legacyBinding`.
- Produces: pending lifecycle keyed by the translated upstream request ID.
- Preserves: existing `ProxyOptions.legacyCapture` behavior for hosts without a resolver.

- [ ] **Step 1: Write failing lifecycle tests**

Add real `runProxy` tests with a controlled upstream. Prove these observable sequences:

```ts
assert.deepEqual(events, ["capture", "dispatched", "upstream", "completed", "agent"]);
assert.equal(upstreamCalls, 0); // capture failure
assert.equal(outcomes.at(-1)?.status, "failed"); // JSON-RPC error
assert.equal(outcomes.at(-1)?.status, "unknown"); // close after dispatch
```

Also send concurrent calls whose agent IDs are `1` and `"1"`. Return responses in reverse order and assert each outcome retains its own capture digest. Add an observe-posture test whose resolver throws if called and prove the call still forwards without lifecycle evidence.

- [ ] **Step 2: Run the focused proxy test and confirm red**

Run:

```bash
node --test packages/proxy/src/bin.test.ts
```

Expected: failure because `legacyBinding` and pending lifecycle handling do not exist.

- [ ] **Step 3: Add the binding path to `runProxy`**

Resolve the binding only in fail-closed posture. During the existing capture gate, retain and validate the returned evidence. For a bound call, translate first, await `dispatched`, store `{ binding, evidence }` under the translated numeric ID, then send exactly once.

Process upstream messages through a serialized promise queue. Before relaying a matching response, await `binding.outcome`, validate it against the capture and response, then remove the pending entry. On close, error or send failure after `dispatched`, call `outcome(evidence, null)` and require `unknown`. Never call `sendUpstream` again for that operation.

Preserve the unbound and legacy capture paths byte-for-byte where practical. Export the new public types from `packages/proxy/src/index.ts`.

- [ ] **Step 4: Run proxy tests and typecheck**

Run:

```bash
node --test packages/proxy/src/bin.test.ts packages/proxy/src/forward/legacy-binding.test.ts packages/proxy/src/forward/tools.test.ts
pnpm --filter @nomo/proxy typecheck
```

Expected: all pass, including prior proxy behavior.

- [ ] **Step 5: Commit proxy lifecycle binding**

```bash
git add packages/proxy/src/bin.ts packages/proxy/src/bin.test.ts packages/proxy/src/index.ts
git commit -m "Bind legacy proxy outcomes to durable captures"
```

### Task 3: Prove real Postgres restart recovery

**Files:**
- Modify: `packages/connectors/src/reverse-engine.test.ts`

**Interfaces:**
- Consumes: Task 2 `runProxy` and `LegacyProxyBinding`.
- Consumes: existing `makeConnector`, `LocalSnapshotStore`, `manifestWriter`, `manifestReader`, signed JSONL ledger and PGlite executor.
- Produces: a cross-layer conformance fixture for only `postgres.row.update`.

- [ ] **Step 1: Replace the manual cross-layer fixture with a failing real proxy fixture**

Use a temporary workspace, PGlite table and controlled upstream. The binding's `capture` calls the real Postgres connector, writes the manifest and returns the snapshot digest. Its `dispatched` and `outcome` callbacks append signed lifecycle records. The upstream executes the SQL and returns the accepted result schema.

After the proxy exits, recreate `makeConnector({ store, exec })`, read the manifest, require the matching signed completed outcome, build the inverse, apply it, and assert the original rows.

- [ ] **Step 2: Run the conformance test and confirm red**

Run:

```bash
node --test --test-name-pattern="cross-layer fixture" packages/connectors/src/reverse-engine.test.ts
```

Expected: failure until the fixture is wired to the new proxy binding lifecycle.

- [ ] **Step 3: Complete the fixture and negative recovery assertions**

Add focused subcases for JSON-RPC failure, unknown close, digest mutation and human drift. Each recovery attempt must check verified terminal evidence before calling `inverse`. Failed or unknown evidence must refuse. Drift must be reported by existing connector logic and preserve the human value.

- [ ] **Step 4: Run cross-layer and package checks**

Run:

```bash
node --test packages/proxy/src/bin.test.ts packages/connectors/src/reverse-engine.test.ts
pnpm --filter @nomo/proxy typecheck
pnpm --filter @nomo/connectors typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit conformance proof**

```bash
git add packages/connectors/src/reverse-engine.test.ts
git commit -m "Prove Postgres recovery through the legacy proxy"
```

### Task 4: Document the exact support boundary

**Files:**
- Modify: `docs/RECOVERY-COVERAGE.md`
- Modify: `docs/REVERSE-ENGINE-VALIDATION.md`
- Modify: `docs/PLAN-GAPS.md`
- Modify: `docs/PLAN-STATUS.md`
- Add: `docs/superpowers/specs/2026-09-23-r02-legacy-proxy-binding-design.md`
- Add: `docs/superpowers/plans/2026-09-23-r02-legacy-proxy-binding.md`

**Interfaces:**
- Consumes: verified outcomes from Tasks 1 through 3.
- Produces: honest support claims scoped to one tool and fixture.

- [ ] **Step 1: Update coverage and validation evidence**

State that `postgres.row.update` has a tested injected host binding over `runProxy`. State that standalone `nomo-proxy`, arbitrary external MCP tools, S3 and distributed atomicity remain unsupported. Record the exact focused commands and results.

- [ ] **Step 2: Update plan status without closing the broader gap**

Mark the R02-bind slice complete for the named Postgres tool. Keep G-08 partially open for general external tool conformance.

- [ ] **Step 3: Run documentation and diff checks**

Run:

```bash
git diff --check
python -c 'from pathlib import Path; files=[Path(p) for p in "docs/superpowers/specs/2026-09-23-r02-legacy-proxy-binding-design.md docs/superpowers/plans/2026-09-23-r02-legacy-proxy-binding.md docs/RECOVERY-COVERAGE.md docs/REVERSE-ENGINE-VALIDATION.md docs/PLAN-GAPS.md docs/PLAN-STATUS.md".split()]; assert not any(chr(c) in p.read_text() for p in files for c in (8211,8212))'
```

Expected: `git diff --check` passes and the dash scan prints nothing.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/RECOVERY-COVERAGE.md docs/REVERSE-ENGINE-VALIDATION.md docs/PLAN-GAPS.md docs/PLAN-STATUS.md docs/superpowers/specs/2026-09-23-r02-legacy-proxy-binding-design.md docs/superpowers/plans/2026-09-23-r02-legacy-proxy-binding.md
git commit -m "Document the certified legacy Postgres binding"
```

### Task 5: Full verification and independent review

**Files:**
- Review only: all branch changes relative to `main`.

**Interfaces:**
- Consumes: the complete branch.
- Produces: evidence suitable for fast-forward integration.

- [ ] **Step 1: Run focused verification**

```bash
node --test packages/proxy/src/forward/legacy-binding.test.ts packages/proxy/src/bin.test.ts packages/connectors/src/reverse-engine.test.ts
pnpm --filter @nomo/proxy typecheck
pnpm --filter @nomo/connectors typecheck
```

- [ ] **Step 2: Run repository quality gates**

```bash
pnpm run check
node scripts/src/run-tests.mjs
node scripts/src/run-tests.mjs --reverse
pnpm run build
pnpm audit --prod
```

Use the repository TAP runner convention if `run-tests.mjs` exposes a reporter option. All commands must exit zero. Existing documented optional integration skips are allowed only if unchanged.

- [ ] **Step 3: Request the second and final subagent review**

Give the reviewer the spec, plan and `git diff main...HEAD`. Require severity-ranked findings for correctness, crash states, evidence validation, package boundaries, secret leakage and claim accuracy. Apply valid findings with a new red test first.

- [ ] **Step 4: Re-run affected focused tests and full gates**

Repeat Step 1 and every full gate affected by review fixes. Do not claim success from earlier output.

- [ ] **Step 5: Verify branch state**

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline main..HEAD
```

Expected: clean feature branch containing only the scoped commits.
