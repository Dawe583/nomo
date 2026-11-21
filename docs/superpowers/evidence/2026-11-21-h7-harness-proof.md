# H7 End-to-End Harness Proof Transcript (2026-11-21)

This record captures the observed output of the local end-to-end harness proof
implemented in `packages/workbench/src/harness-proof.test.ts`, covering both
the loopback HTTP MCP connector path (hold + operator denial) and the real
stdio `packages/proxy` path (`fixtures/e2e-server.mjs` + fail-closed policy
denials), through H10 outcome feedback, H11 descriptive refinement effects,
rollback and standalone offline ledger verification.

## Reproduction command

```bash
NO_COLOR=1 node --test packages/workbench/src/harness-proof.test.ts
```

Observed result on Linux, Node v24.21.0, branch
`devin/h10-refinement-outcome-feedback` at base `1195506`:

- `H7: a refused call, a mined rule, an approved activation, a rollback and an offline verify`: PASS (533.6ms)
- `H7: real stdio proxy closed loop with H10 outcome feedback, H11 refinement effect and offline verify`: PASS (226.3ms)
- Summary: `2 pass, 0 fail`

## Observed stdio proxy closed-loop transcript

1. **Proxied allow + policy denials (`packages/proxy` + `fixtures/e2e-server.mjs`)**:
   - Proxied `echo` executed cleanly (`decision: allow`) and synced into the
     workspace chain with `source: "stdio-proxy"` after cryptographic
     `verifyChain` verification.
   - Proxied `orders_delete` was denied 3 times by policy (`decision: deny` and
     `decision: deny:resolved` receipts with canonical `argsDigest`), synced as
     8 signed `stdio-proxy` entries in the workspace chain.
   - Bug found and fixed during H7: `Workbench.execute` in
     `packages/workbench/src/index.ts` previously recognized only
     `HoldDeniedError` (`hold:denied` / `hold:expired`) and turned verified
     direct stdio proxy policy denials (`deny` / `deny:resolved`) into
     `UnknownToolOutcome`. It now returns `{ isError: true }` when a fresh,
     signature-verified `deny` or `deny:resolved` receipt matches the tool and
     canonical `argsDigest`.
2. **Deterministic rule mining**:
   - `mineLearnedRules` minted 1 rule: `tool: "orders_delete"`, `class: "r3"`,
     `repeats: 6`, `derivedFromSeq: [3, 4, 5, 6, 7, 8]`.
3. **Digest-approved activation**:
   - Two-edit proposal citing `derivedFromSeq: [3, 4, 5, 6, 7, 8]` created
     proposal digest prefix `28de3f2d649f`.
   - Operator approved that exact digest (`approveHarnessProposal`), signing
     `proposal:activated` at `seq: 10`.
4. **Bounded retrieval**:
   - With `contextEntryLimit: 1`, the next turn received
     `NOMO learned-entry digest` with exactly `1` `[lesson]` row.
5. **H11 descriptive refinement effect (decision D1)**:
   - `Workbench.harnessEffects` compared strictly disjoint windows around
     `activationSeq: 10`: `beforeCases: 2`, `afterCases: 1`,
     `verdict: "insufficient-data"`,
     `unmeasuredGuardrails: ["deny_rate", "rollback_count", "unknown_tool_rate"]`,
     `denyBefore: { n: 1, mean: 1, half: null, unmeasured: 2 }`,
     `denyAfter: { n: 0, mean: null, half: null, unmeasured: 2 }`.
   - Measuring effects wrote zero records to the signed ledger and never
     entered `harnessEntries`, `decide` or policy.
6. **Rollback + H10 repeat refusal**:
   - `rollbackHarnessProposal` signed `refinement:rolled-back` at `seq: 13`.
   - `Workbench.harnessOutcomes` recorded `status: "rolled-back"`,
     `activatedSeq: 10`, `settledSeq: 13`.
   - Re-proposing the identical edits with no newer citations was refused
     before the chain with:
     `An operator already rolled back this refinement at sequence 13, and the proposal cites nothing recorded after that decision. Cite newer records that support it, or leave it.`
7. **Standalone offline verification (`packages/verifier/verify-ledger.mjs`)**:
   - Exported workspace ledger:
     `VERIFIED 13 entries, head 6db64763e8a2d8e375201e950911aa7b496dab5c2a413360e5175953a6531a4a (signatures and hash links)`
   - Raw `packages/proxy` stdio ledger:
     `VERIFIED 10 entries, head 7d9b194fe47bea87b758a70e216277af5ef9536b2f2ec7c88c7eda35e2f6bc90 (signatures and hash links)`

## Scope boundaries (what this transcript does not prove)

- The model provider in this proof is a local test double; live third-party
  provider quality, pricing and coding-benchmark parity are not claimed here.
- No secrets, credentials or raw private transcripts are stored in this record.
