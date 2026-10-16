# What to build next, and what not to

Written 2026-10-04, against `main` at the group-commit merge. This is a **ranking**, not a
plan: one row per candidate with the cost it would take and the value it would buy, so a
decision can be made without re-reading the repository. It sits beside `COMPETITIVE-WEDGE.md`
and does not replace it; where the two disagree, that document's `file:line` evidence wins.

Cost and value are both 1 (small) to 5 (large). "Value" is what a paying team would notice, not
what is technically interesting. Anything scored on cryptographic novelty rather than on a
buyer's decision is capped at 2 on purpose.

## The two things that changed the picture since 2026-09-26

**A signed, hash-chained action receipt is now an IETF draft.**
`draft-sahu-agent-action-receipts-00`, "Signed, Hash-Chained Action Receipts for AI Agents",
N. Sahu, 16 August 2026, Informational, with a companion compliance profile in progress
(`draft-marques-asqav-compliance-receipts`).

This is NOMO's central claim, written down by someone else, with a compliance profile attached.
It is the strongest validation the category has had, and it is also a warning: the shape is now
public, so "we sign the ledger" is no longer a differentiator by itself. The differentiator is
the sentence in `COMPETITIVE-WEDGE.md` §4.3, which none of the drafts claim: **the receipt lands
in the effect's own system**, so a third party verifies it without trusting NOMO, its key or its
ledger. That sentence is the moat, and it is narrower than the whole product.

**The audit-trail standard NOMO's format is aligned with has moved.**
`draft-sharif-agent-audit-trail` is at revision **-06**, Standards Track, 29 September 2026.
The documents in this repository carry revision -05. Nothing in the tree depends on the
revision number today, but any claim that NOMO "emits the standard format" needs re-checking
against -06 before it is made.

**Cloudflare can now force all MCP traffic through a gateway it controls.** MCP server
portals (Zero Trust AI Controls, page last updated 2026-10-02) centralise multiple MCP servers
onto one endpoint, curate and alias tools, collapse all tools into two via Code Mode, and
optionally route through Gateway for DLP. A third-party report dated 2026-09-19 adds shadow-MCP
detection and **portal-only enforcement**: blocking direct connections that bypass approved
portals.

`COMPETITIVE-WEDGE.md` §11.5 said Cloudflare can absorb guardrails but not a per-effect
before-image. That is still true and now more clearly so. What is new is the *position*: a portal
that can refuse a bypass is a chokepoint, and NOMO is a proxy in the same chokepoint. Being
better at one job in a place a competitor owns is a weaker position than being the only thing
that can undo an effect. *(Corrected 2026-10-04: Rubrik's Agent Rewind, live since
2025-08-12, is a competing undo product, so "the only thing that can undo an effect" is
not available as written. What remains distinct is undoing one effect in a live system with
concurrent writers and leaving the receipt in the effect's own system, see
`DEEP-RESEARCH-DIRECTION-2026-10-04.md` §3.)* See row 15.

## The candidates

| # | candidate | cost | value | what it depends on |
|---:|---|---:|---:|---|
| 1 | **Publish the action-receipt mapping against `draft-sahu-agent-action-receipts`.** Emit the same receipt shape from the existing `RestoreReceipt`, and document where NOMO's is stronger (it lives in the effect's system) and where it is weaker (no published checkpoint). | 2 | 5 | The drafts are Informational and unaudited. The mapping is documentation plus a serialiser, not new cryptography. |
| 2 | **The effectiveness half of A3, not the policy half.** §4.2 shows `PolicyCall` carries no effect, readiness or resource set, so the decision reads a class string. Put the measured effect in the decision for the two effects that already exist. | 3 | 5 | `PLAN-GAPS` G-24-adjacent item; the code path exists, the field does not. |
| 3 | **A published checkpoint.** An append-only hash root published on a schedule, so a third party can anchor NOMO's chain without running NOMO. | 4 | 4 | Nothing exists: `anchor.ts` signs and checks anchors and nothing publishes them. Needs a cheap hosting answer, which is a distribution decision, not a code one. |
| 4 | **Make `captureKey` semantics explicit before more adapters land.** The capture maps were deleted because the store is the only reader; the next adapter author will reach for a map again unless the seam says why. | 1 | 3 | Follows from the retention work. A comment plus one test, not a design. |
| 5 | **Bound `#usedIds` or state why it is not bounded.** | 2 | 2 | Same class as the retention work; the cost of a collision has to be established before it can be bounded. |
| 6 | **A paid capability that matches the price table.** `PAID_CAPABILITIES` is `['taintGraph']` while `GO-TO-MARKET-10K-MRR.md:116` sells a "signed export and verification workflow". This is a decision, not code, and it decides what the product is. | 1 | 5 | `DECISIONS.md` §5 amendment. The code to gate `verifiedRecovery` exists; the licence line and the price are the owner's call. |
| 7 | **A durability tier, named.** The write path costs 5.0 ms p50 of which the fsync is most of it. A named tier trades durability for latency, and the ledger's whole claim rests on which tier is default. | 3 | 4 | Must be recorded in `security-notes.md` as a claim that stops holding. Never ship it unrecorded. |
| 8 | **Fix the demand evidence, not the product.** §6 is unambiguous that the category has no buyers at these install counts. One public write-up of a real rollback, with the receipt a third party checked, is worth more than another surface. | 1 | 5 | No code. The blocker is a customer who will let it run. |
| 9 | **A second proven inverse.** §4.3 says three surfaces exist and one is proved. S3 now re-reads and writes a durable receipt (`c5d32fc`), so the gap is narrower than the document says. | 5 | 3 | Real per-adapter work. Only worth it if a named customer wants that adapter. |
| 10 | **Refundable, `compensate` semantics for the adapter contract.** `recovery.ts:43-73` has no `compensate`; `compensated` is a status the adapter returns. This is the difference between "cannot be undone" and "refunded". | 5 | 3 | A design decision affecting every adapter. Microsoft landed on the same shape, per §4.3, so there is no default to copy. |
| 11 | **A page ceiling on the S3 object-count probe.** `probes/s3.ts:11-15` loops `listObjectsV2` with no page limit and no deadline; a bucket an attacker can write to can hang it. | 1 | 3 | Small and isolated. The sibling probe in `probes/postgres.ts` has the same shape over FK edges. |
| 12 | **A row ceiling on cascade capture.** `postgres/capture.ts` caps the table count at 100 and not the row count, and one high-fan-out delete can produce a very large plan. | 2 | 3 | Follows the audit's finding 13. Independent of the probes. |
| 13 | **Drop the client-app surface from the readme, not only from the plan.** `apps/apple` and `apps/desktop` are still in the tree and still build, with 12 unit and 18 UI cases, while `ROADMAP-Q4` says they are out of plan. A reader meets the code first. | 1 | 2 | Pure communication. The owner decided to keep the code, so this is only about not implying it is supported. |
| 14 | **An `unsigned mode` nobody has asked for.** Recorded here because it comes up in every sales conversation and because the answer should be a sentence, not an improvisation. | 1 | 2 | The answer already exists in `OPERATIONS.md`: a signature proves a process holding a key wrote the bytes. What is missing is whether to sell it at all. |
| 15 | **Decide the Cloudflare position before building into it.** Portals plus portal-only enforcement make Cloudflare the chokeepoint. NOMO's options are to be the best tool inside someone else's chokepoint, to be the thing that can undo a single effect in a live system regardless of who owns the chokepoint, or to sell the Cloudflare integration itself. The middle option is narrowed: "the only thing that can undo an effect" is not true as of Rubrik Agent Rewind, 2025-08-12. | 2 | 5 | This is a positioning decision with three real answers, not a feature list. Row 1 is the version of "third option" that is code. |

## What I would not build

- **More ledger signing variants.** Fifteen projects ship a signed chain (§3.2 of the wedge
  document). P-256 in particular is named in the wedge document's own drop list.
- **A decompiler or analysis adapter.** Dropped on 2026-09-26 for reasons that have not changed.
- **A prompt-level guardrail.** Lakera and Aporia own it and it is not the write path.
- **Anything whose only claim is "tamper-evident".** `agentmetry`'s README says the honest
  version: tamper-evident is not attributable.

## How to read the cost column

Cost 1 means one file and one test. Cost 5 means an adapter, a schema or a contract change
that every caller has to move. Value 5 means it changes what a buyer can do, not that it makes
the product more impressive.