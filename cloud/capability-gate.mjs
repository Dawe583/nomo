/**
 * The paid side of the licence line, as one function.
 *
 * `docs/DECISIONS.md` section 5 lists what VOID sells and what it gives away.
 * The Polar layer in `cloud/billing.mjs` reads and publishes an entitlement
 * honestly; before this module, nothing read it, so a subscription granted no
 * capability at all. An entitlement that gates nothing is worse for the buyer
 * than no paywall at all, because they have already paid.
 *
 * This module is the enforcement point. It answers two questions, and the
 * second one is the one that has to hold:
 *
 *   1. What does this owner's `GET /api/capabilities` say?
 *   2. May this owner's request reach a paid route at all?
 *
 * The second question is what makes the first one worth anything. A capability
 * flag the server ignores is a label, not a gate, so `cloud/server.mjs` calls
 * `entitled()` on the paid route itself and refuses with `402` when the answer
 * is no.
 *
 * The paid decision lives here, in `cloud/`, which is not Apache 2.0 open core.
 * `packages/workbench/src/gui.ts` is never edited and never imports this file,
 * so no paid decision can reach the open licence line.
 */

import { capabilities } from "../packages/workbench/src/gui.ts";
import { isOwner, OPERATOR_OWNER } from "./owner.mjs";

/**
 * The capabilities DECISIONS section 5 puts on the paid side of the line, in
 * the spelling `GET /api/capabilities` publishes them.
 *
 * Two entries today, and each is a decision rather than a convenience:
 *
 * - `verifiedRecovery`, the hosted EXECUTION of a recovery job. The split is
 *   the decision, and it is deliberately narrower than the feature:
 *
 *   `POST /api/sessions/:id/recovery-jobs/plan` and
 *   `GET /api/sessions/:id/recovery-jobs/:job` stay open. The capture and the
 *   receipt stay open so the proof is free and the receipt format stays
 *   inspectable, and so the open-core CLI keeps running the same recovery
 *   locally against the operator's own machine forever. What the paywall
 *   holds is `POST .../apply`: the hosted execution, which is the thing that
 *   touches a customer's system from a server somebody else runs. Gating the
 *   plan instead would withhold the evidence and leave the execution as the
 *   cheap part, which is the opposite of what is being sold.
 *
 *   `cloud/` is already the closed, paid directory, so no code moves across a
 *   licence line at all: this is a flag inside a closed package, which is the
 *   boundary the licence can actually hold. See `cloud/recovery-routes.mjs`
 *   for where the route refuses, and `cloud/server.mjs` for where the gate is
 *   handed to it.
 *
 * - `taintGraph`, the recorded cross-record dependency graph. Section 5 settles
 *   it against its own operational test in the rejected table: "Opening the taint
 *   graph, budgets and attestation mappings now | They are organisational
 *   features and belong on the paid side from day one. Moving them across later
 *   would be the exact licence change the model forbids, so the line has to hold
 *   before there is pressure on it." The test in the same section asks whether a
 *   solo developer protecting one Postgres could do their job without it, and the
 *   answer is yes: the hold, the approval, the ledger, the verification and the
 *   captured inverse all stay open, so gating the graph costs that developer
 *   nothing they need to protect the one database they have.
 *
 * The other five section 5 names are absent here on purpose, and each absence is
 * a different reason rather than an oversight:
 *
 * - `apps/control-plane` exists as a closed directory, not as an entitlement
 *   in this capability set. SSO does not exist in this tree.
 * - Multiple workspaces do not exist either, for the same reason.
 * - Irreversibility budgets live in `packages/runtime/src/budget.ts`, an open
 *   package, so gating them would be a feature flag inside Apache 2.0 code
 *   rather than a boundary the licence can hold.
 * - Premium connectors are enumerated by configuration rather than shipped as
 *   code, so the honest gate is which connectors the operator has configured,
 *   not which subscription somebody holds.
 * - Retention beyond seven days does have time-based enforcement in this tree,
 *   and it belongs on the OPEN side. The one surface that enforces an age is
 *   the file recovery vault: `validateRetentionPolicy` and `collectVaultGarbage`
 *   in `packages/runtime/src/retention.ts` compare a policy TTL in milliseconds
 *   against each artifact's mtime. That package is Apache 2.0, the TTL is
 *   already operator-selected with no upper bound, and the shipped default is
 *   `MANUAL_RETENTION_POLICY` (`mode: "manual"`, every TTL null), so nothing is
 *   ever collected implicitly and an operator may already select any retention
 *   length they like, seven days or seven years. Putting a bound on that would
 *   not withhold a capability that is absent; it would take a capability the
 *   free tier already has and move it behind the paywall. Section 5's own hard
 *   rule is that a feature never moves from open to paid, and its revisit clause
 *   says the rule itself is not revisitable: open features stay open. A
 *   retention cap here would be that forbidden move, and §5 is what has to
 *   change, not this list.
 *
 *   The operational test in the same section reaches the same answer from the
 *   other direction: could a solo developer protecting one Postgres do their
 *   job without retention beyond seven days? No. The vault holds the encrypted
 *   before-images that make an intercepted write reversible, and a cap expires
 *   the exact artifact that would undo a bad migration discovered a month
 *   later. Section 1 sells the undo as "the differentiated half"; a seven-day
 *   cap deletes that half on a timer the operator never set.
 *
 *   Two other candidates were checked and ruled out rather than assumed. The
 *   signed ledger and the recovery journal are append-only by construction:
 *   `LedgerStore` in `packages/ledger/src/index.ts` exposes `append`, `read`,
 *   `head` and `verify` and no mutation, `JournalTransaction` in
 *   `packages/runtime/src/journal.ts` exposes `append` and no delete, and
 *   `void_cloud_ledger` carries a BEFORE UPDATE OR DELETE trigger that raises.
 *   Age is not representable there, so a retention bound would have to begin by
 *   dismantling the append-only guarantee. And `events.slice(-200)` in
 *   `cloud/store.mjs` is not a retention bound at all: those events are written
 *   to `void_cloud_events` in the same transaction before the slice, so the
 *   slice bounds one document's size and loses nothing.
 *
 * The signed ledger export is deliberately NOT in this list. Section 5 pays for
 * "attestation exports **with compliance frame mappings**", and
 * `/api/ledger/export` emits a raw `void.signed-ledger.v1` document with no
 * compliance frame mapping in it. Gating that route would move an open
 * capability to the paid side, which is the one move section 5 forbids
 * outright, so it stays open.
 */

/**
 * One entitlement bit maps to one flat paid-capability set. The gate cannot
 * distinguish product tiers, so a future tier needs a product-to-capabilities
 * map and tier-aware entitlement before this narrowing step.
 *
 * The NOMO MVP spec at
 * `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-mvp-spec.md`
 * requires a qualified pilot and says pricing and tiers remain unvalidated
 * hypotheses. This gate contains no price and makes no pricing claim.
 *
 * Recorded 2026-10-04, when `verifiedRecovery` became the second entry and the
 * mismatch stopped being hypothetical.
 */
export const PAID_CAPABILITIES = Object.freeze(["taintGraph", "verifiedRecovery"]);

/**
 * The open cloud capability surface, exactly as `cloud/server.mjs` answered it
 * before any gate existed, plus the paid keys at their ungated value.
 *
 * Kept here rather than inline in the route so that `narrowCapabilities` has one
 * subject to narrow and the test can state the invariant against a real base
 * object rather than a hand-written stand-in.
 */
export const openCapabilities = () => ({
  ...capabilities("cloud"),
  projects: false,
  customAgents: false,
  hooks: false,
  contextCompaction: true,
  recoveryJobs: true,
  // `recoveryJobs` stays true for a free owner and `verifiedRecovery` goes off,
  // because that split IS the decision: capturing and reading a recovery stays
  // free, executing it on a server somebody else runs does not. A client that
  // saw `recoveryJobs: false` would hide the plan it is entitled to.
  backgroundQueue: false,
  ...Object.fromEntries(PAID_CAPABILITIES.map((name) => [name, true])),
});

/**
 * Apply an entitlement to an open capability surface.
 *
 * **The invariant: this only ever narrows.** For every key, the returned value
 * is either the input value unchanged, or `false` where the input said `true`.
 * There is no branch here that can turn a `false` into a `true`, so a bug in the
 * billing read, a subscription document somebody edited by hand, or a
 * `subscribed` that a future status string slips through all fail in the same
 * direction: the paid capability is withheld. A gate that can widen is not a
 * gate, it is a second way to be wrong.
 *
 * `entitled` is compared against `true` rather than merely checked for
 * truthiness on purpose: an entitlement that answers `undefined`, `null`,
 * `"yes"` or `1` has not proved a live payment, and the four must all read the
 * same way.
 */
export function narrowCapabilities(open, entitled) {
  const narrowed = { ...open };
  if (entitled === true) return narrowed;
  for (const name of PAID_CAPABILITIES) narrowed[name] = false;
  return narrowed;
}

/**
 * The gate itself, bound to a billing service that may be absent.
 *
 * `service` is the object `billingFromEnv()` returns, or `undefined` when this
 * deployment has no Polar account. Absent is not an error: a self-hosted
 * deployment is simply a deployment nobody is paying, and it is answered with
 * the free tier rather than a 503 that would take the whole capability surface
 * down with it.
 */
export function createCapabilityGate(service) {
  /**
   * Is this owner inside the paid line right now?
   *
   * Fails closed in every direction that is not a yes. Nobody who is not an
   * owner is not entitled. A deployment with no billing configured is not
   * entitled. A read that throws is not entitled.
   *
   * Failing narrow rather than throwing is deliberate and is the difference
   * between a gate and an outage. `/api/capabilities` is read by every screen
   * in the product, so a 503 here would refuse chat, projects and the permission
   * mode along with the paid capability. The failure is still visible, because
   * `/api/billing` answers `503` for the same failed read rather than the empty
   * answer a client would otherwise read as "you are on the free tier".
   */
  async function entitled(owner) {
    if (!isOwner(owner)) return false;
    // The operator's own namespace is deployment authority, not a customer
    // identity: the control token already reaches every document this server
    // holds, so withholding a capability from it would be withholding it from
    // the person who runs the instance. It is the one owner whose answer does
    // not come from a subscription document, and it is stated here rather than
    // left implicit because it is the single place the gate is not a payment.
    if (owner === OPERATOR_OWNER) return true;
    if (!service) return false;
    try {
      return (await service.entitlement(owner))?.subscribed === true;
    } catch {
      return false;
    }
  }

  return {
    entitled,
    /** The capability answer for one owner, narrowed or not. */
    capabilities: async (owner) =>
      narrowCapabilities(openCapabilities(), await entitled(owner)),
  };
}
