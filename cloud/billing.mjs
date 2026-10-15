/**
 * Billing: Polar as merchant of record.
 *
 * Polar collects the money, issues the invoice, carries the sales tax and takes
 * the chargeback, so nothing in this repository handles a card. What arrives
 * here is a signed statement about a subscription and a document in the owner's
 * own namespace. Five properties are load bearing and each has a test in
 * `cloud/billing.test.mjs`.
 *
 * **The credential is server side only.** `vercel.json` sets `connect-src
 * 'self'`, and nothing here changes it. The browser never holds a Polar access
 * token, a webhook secret or a customer id; it asks this origin what the caller
 * already is entitled to and is told a boolean and a date.
 *
 * **Verification is delegated, never reimplemented.** The signature is
 * Standard Webhooks over `${webhook-id}.${timestamp}.${rawBody}`, and Polar's
 * SDK derives two candidate keys from one secret: the raw UTF-8 bytes and the
 * base64 remainder after `whsec_`. A spec-derived implementation gets that
 * wrong (polarsource/polar#13519), so `webhooks.validateEvent` from
 * `@polar-sh/sdk` does the work and this module only classifies what comes
 * back. The import is dynamic, so a deployment with no Polar configuration
 * never loads the package and a test can inject the verifier instead.
 *
 * **The raw bytes have to survive to here.** `express.json()` re-parses a body
 * into an object, and a signature over bytes no longer in the request cannot
 * match one. So the webhook is mounted above `express.json()` in
 * `cloud/server.mjs` and takes `express.raw()` for itself, exactly as the
 * integration callback is mounted for the same class of pre-auth request.
 *
 * **A webhook carries no owner.** It carries a Polar customer id. The owner is
 * resolved from a mapping document in the operator's namespace, and the request
 * never contributes one: `cloud/owner.test.mjs` names the two places that may
 * put an owner on a request, and this module is not one of them.
 *
 * **Delivery is idempotent, because Polar retries.** A non-2xx makes Polar send
 * the same event again, so the `webhook-id` is recorded under the owner inside
 * the same transaction that applies the event, and that transaction's advisory
 * lock is what makes two concurrent deliveries of one event apply once.
 *
 * Not built here, deliberately: checkout, a customer portal, usage metering,
 * seats, and any price. The NOMO MVP spec at
 * `docs/superpowers/specs/2026-10-08-nomo-agent-identity-fleet-mvp-spec.md`
 * separates customer qualification from engineering and says pricing and tiers
 * remain unvalidated hypotheses. No amount, tier or limit is encoded in this
 * module.
 */
import express from "express";
import { envValue as readEnvValue } from "./env.mjs";
import { read, write, transaction } from "./store.mjs";
import { assertOwner, isOwner, OPERATOR_OWNER } from "./owner.mjs";

/**
 * The three headers Standard Webhooks signs over. They are checked here, before
 * the SDK is reached, because a request missing one was never signed at all and
 * deserves an answer that says so rather than a generic rejection.
 */
const SIGNED_HEADERS = Object.freeze([
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
]);

/** Documents this module owns. Every one of them is under an owner. */
const SUBSCRIPTION_KEY = "billing:subscription";
const CUSTOMER_KEY = "billing:customer";
const WEBHOOKS_KEY = "billing:webhooks";

/**
 * The forward index lives in the operator's namespace because a webhook
 * arrives naming a Polar customer and has to become an owner in one lookup, and
 * `cloud/store.mjs` has no scan over keys that would find it any other way. It
 * is a deployment registry rather than a person-keyed record: it maps a Polar
 * customer to an owner and is written only by an authenticated route acting on
 * its own caller.
 */
const indexKey = (customerId) => `billing:index:${customerId}`;

/**
 * The statuses that mean somebody is paying right now. `past_due` is not in it:
 * a failed payment is not a subscription, and what a deployment should do about
 * the retry window is a policy decision this change does not make. Failing
 * closed is the honest default, and nothing is gated on the answer yet, so no
 * person is refused anything by it today.
 */
const LIVE_STATUSES = Object.freeze(["active", "trialing"]);
const live = (status) => LIVE_STATUSES.includes(status);

/** A Polar customer id and a webhook id are both bounded tokens, never free text. */
const IDENTIFIER = /^[\w-]{1,200}$/;

/** How many webhook ids are remembered per owner before the oldest is dropped. */
const WEBHOOK_MEMORY = 200;

const ENVIRONMENT = new Set(["sandbox", "production"]);

/**
 * The shared lookup answers "which name is set". Billing additionally refuses
 * a blank or untrimmed value, because a half configured deployment is not a
 * deployment that can be charged, and reporting `configured: false` for it is
 * more honest than serving an entitlement nobody can manage.
 */
const envValue = (name, env) => {
  const raw = readEnvValue(env, name);
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
};

/**
 * The answer for an owner this deployment cannot say anything about: billing
 * unconfigured, or no subscription document. It says `configured: false`
 * rather than a bare `subscribed: false`, because "you have nothing" and "this
 * server is not set up to bill" are different facts and the client has to be
 * able to tell them apart.
 */
const nothing = () => ({
  configured: false,
  subscribed: false,
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  product: null,
});

/**
 * Load the SDK's webhook verifier.
 *
 * Dynamic, and memoised only on success: a failed load is not cached, so a
 * deployment that installs the package while running does not need a restart to
 * start verifying, and a deployment that never configures Polar never loads it.
 */
const loadWebhooks = (() => {
  let pending;
  return () => {
    pending ??= import("@polar-sh/sdk/2026-10")
      .then((module) => module.webhooks)
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
})();

/**
 * What the SDK says, restated in vocabulary this module owns, so the route never
 * depends on an SDK class name and a test can inject the three outcomes it
 * cares about. The three failures mean different things operationally and are
 * answered differently: bytes that are not what Polar signed, or a timestamp
 * outside the replay window, are a 400; an event type the SDK does not know is
 * a Polar release this deployment has not caught up with, which is not a
 * forgery and must not be a 4xx, because that would make Polar redeliver a
 * valid event forever; a body that is not JSON is a 400.
 *
 * `instanceof` is checked narrowest first, because `PolarWebhookVerificationError`
 * and `PolarWebhookUnknownTypeError` both extend `PolarWebhookError`.
 */
export function classifyWebhookError(error, errors) {
  if (errors.Verification && error instanceof errors.Verification)
    return "signature_rejected";
  if (errors.UnknownType && error instanceof errors.UnknownType)
    return "unknown_event_type";
  if (errors.Base && error instanceof errors.Base) return "payload_malformed";
  // An error that is none of the SDK's is treated as a failed verification,
  // because that is the only reading of it that does not let a request
  // through, and the alternative would be a 500 that hides the difference.
  return "signature_rejected";
}

/**
 * The event type is echoed back so an operator reading Polar's delivery log
 * can see which type this deployment has not caught up with, and bounded so a
 * type is never reflected at any length.
 */
const EVENT_TYPE = /^[A-Za-z0-9_]{1,40}\.[A-Za-z0-9_]{1,80}$/;
const unknownType = (error) =>
  typeof error?.eventType === "string" && EVENT_TYPE.test(error.eventType)
    ? error.eventType
    : null;

/**
 * The entitlement, as the read path publishes it.
 *
 * The status string is Polar's own, so a subscription in a state this file has
 * never heard of reads as itself rather than as a guess. `subscribed` is true
 * only for a status that means a live payment, and only for the product the
 * operator named: a product filter is unset by default rather than guessed, so
 * no product id means any subscription this deployment billed for counts, and
 * setting one means only that one does.
 */
const view = (stored, productId) => {
  if (!stored || typeof stored !== "object") return nothing();
  const status = typeof stored.status === "string" ? stored.status : null;
  const product = typeof stored.product === "string" ? stored.product : null;
  const wanted = !productId || (product !== null && product === productId);
  return {
    configured: true,
    subscribed: live(status) && wanted,
    status,
    currentPeriodEnd:
      typeof stored.currentPeriodEnd === "string" ? stored.currentPeriodEnd : null,
    cancelAtPeriodEnd: stored.cancelAtPeriodEnd === true,
    product,
  };
};

/**
 * The stored form of a subscription. Written from the verified payload only.
 * `customerId` stays in the document because the index resolves through it,
 * and it is not published: the read path drops it.
 */
const stored = (data, type) => ({
  subscriptionId: typeof data.id === "string" ? data.id : null,
  customerId: typeof data.customer_id === "string" ? data.customer_id : null,
  product: typeof data.product_id === "string" ? data.product_id : null,
  status: typeof data.status === "string" ? data.status : null,
  currentPeriodEnd:
    typeof data.current_period_end === "string" ? data.current_period_end : null,
  cancelAtPeriodEnd: data.cancel_at_period_end === true,
  lastEvent: typeof type === "string" ? type : null,
});

/**
 * The three SDK error classes, under the short names the classifier uses.
 *
 * They are read out of whatever the loader returned rather than imported, so
 * an injected verifier can hand back a namespace carrying the same three names
 * and the distinction stays reachable with the SDK absent. A namespace missing
 * one of them degrades to the safe reading inside `classifyWebhookError`
 * instead of throwing here.
 */
const errorClasses = (namespace) => ({
  Base: namespace?.PolarWebhookError,
  Verification: namespace?.PolarWebhookVerificationError,
  UnknownType: namespace?.PolarWebhookUnknownTypeError,
});

/**
 * Build the service. Everything it needs arrives as a parameter, so a test can
 * hand it an in-memory store and an injected verifier, and the real thing is
 * the same object with the real functions.
 */
export function createBillingService(config, overrides = {}) {
  const deps = { read, write, transaction, loadWebhooks, ...overrides };
  let errors;
  /**
   * Read through the environment on every call rather than copying the value
   * into this object, so rotating the secret takes effect without a restart and
   * so no copy of it exists anywhere it could be printed by accident.
   */
  const secret = () => envValue("NOMO_POLAR_WEBHOOK_SECRET", config.env);

  return {
    /**
     * Verify the exact bytes Polar signed. Returns a discriminated result
     * rather than throwing, because the route has to tell three failure modes
     * apart and a thrown error invites a catch-all that cannot.
     */
    async verify(rawBody, headers) {
      try {
        errors ??= await deps.loadWebhooks();
      } catch {
        // The verifier could not be loaded. That is this deployment's problem
        // and not the request's, so it is a retryable 503 rather than a 400
        // that would accuse Polar of forgery, and never a 500 that hides both.
        return { ok: false, failure: "verifier_unavailable" };
      }
      if (typeof errors?.validateEvent !== "function" || !secret())
        return { ok: false, failure: "verifier_unavailable" };
      try {
        return {
          ok: true,
          event: await errors.validateEvent(rawBody, headers, secret()),
        };
      } catch (error) {
        const failure = classifyWebhookError(error, errorClasses(errors));
        const eventType = unknownType(error);
        return {
          ok: false,
          failure,
          ...(failure === "unknown_event_type" && eventType ? { eventType } : {}),
        };
      }
    },

    /**
     * What this owner is entitled to. One document, under that owner, so an
     * answer cannot be assembled out of two owners' rows.
     */
    async entitlement(owner) {
      assertOwner(owner);
      return view(await deps.read(owner, SUBSCRIPTION_KEY), config.productId);
    },

    /**
     * Bind an owner to a Polar customer, in both directions.
     *
     * The owner's namespace records which customer is theirs, and the operator's
     * index records which owner a customer belongs to, because the webhook has
     * only the second one to start from. An existing binding to a different
     * owner is refused rather than replaced: without that, one account could
     * claim another's customer id and start receiving their subscription events.
     *
     * The two documents answer different durability questions, and the split is
     * deliberate. A Polar customer id is not a durable identity here: it is not
     * a Supabase user id, and `docs/APPWRITE-AUTH.md` describes a second
     * provider that is written but not imported, so a provider migration
     * changes the owner and orphans the index entry that named the old one. The
     * owner's own document is the half that travels with the account, and the
     * index is derived from it, so recovery is one authenticated call from the
     * new owner rather than anything Polar has to confirm. The refusal above is
     * the honest cost of it: until an operator clears the stale entry, a
     * migrated owner cannot re-link, and clearing it deliberately requires
     * confirming with Polar that they hold the customer. That confirmation is
     * the first thing `NOMO_POLAR_ACCESS_TOKEN` is for, and it is not built in
     * this change.
     */
    async linkCustomer(owner, customerId) {
      assertOwner(owner);
      if (typeof customerId !== "string" || !IDENTIFIER.test(customerId))
        throw Object.assign(new Error("That Polar customer id is not one."), {
          status: 400,
        });
      await deps.transaction(owner, CUSTOMER_KEY, async (client) => {
        const claimed = await deps.read(OPERATOR_OWNER, indexKey(customerId), client);
        if (claimed && claimed.owner !== owner)
          throw Object.assign(
            new Error("That Polar customer is linked to another account."),
            { status: 409 },
          );
        const mine = await deps.read(owner, CUSTOMER_KEY, client);
        // A different customer for the same owner releases the old index entry,
        // so events for a customer this owner has moved on from cannot keep
        // landing in this namespace.
        if (mine?.customerId && mine.customerId !== customerId)
          await deps.write(
            OPERATOR_OWNER,
            indexKey(mine.customerId),
            { owner: null, releasedAt: new Date().toISOString() },
            client,
          );
        await deps.write(OPERATOR_OWNER, indexKey(customerId), { owner }, client);
        await deps.write(owner, CUSTOMER_KEY, { customerId }, client);
      });
      return { linked: true };
    },

    /**
     * Apply one verified subscription event.
     *
     * The owner is resolved from the customer id the payload names, through the
     * operator's index. It is never taken from the request, because there is no
     * request identity here, and never taken from the payload as a claim about
     * who somebody is. A customer nobody has linked is not an error to report
     * to Polar: reporting it would have Polar redeliver an event this
     * deployment will never be able to apply, so it is recorded as ignored and
     * nothing is written.
     */
    async applySubscription(event, webhookId) {
      if (typeof webhookId !== "string" || !IDENTIFIER.test(webhookId))
        return { applied: false, ignored: "webhook_id_invalid" };
      const data = event?.data;
      if (!data || typeof data !== "object")
        return { applied: false, ignored: "payload_not_applicable" };
      if (typeof data.customer_id !== "string" || !IDENTIFIER.test(data.customer_id))
        return { applied: false, ignored: "payload_not_applicable" };
      const mapping = await deps.read(OPERATOR_OWNER, indexKey(data.customer_id));
      if (!isOwner(mapping?.owner))
        return { applied: false, ignored: "customer_not_linked" };
      return deps.transaction(mapping.owner, SUBSCRIPTION_KEY, async (client) => {
        // Read inside the transaction and under its advisory lock: two
        // deliveries of one event serialise here, so the second reads the id
        // the first wrote and stops. Checked outside, both would pass.
        const seen = await deps.read(mapping.owner, WEBHOOKS_KEY, client);
        if (Array.isArray(seen?.ids) && seen.ids.includes(webhookId))
          return { applied: false, duplicate: true };
        await deps.write(mapping.owner, SUBSCRIPTION_KEY, stored(data, event.type), client);
        const ids = [...(Array.isArray(seen?.ids) ? seen.ids : []), webhookId];
        await deps.write(
          mapping.owner,
          WEBHOOKS_KEY,
          { ids: ids.slice(-WEBHOOK_MEMORY) },
          client,
        );
        return { applied: true };
      });
    },
  };
}

/**
 * The service, read out of the environment, or `undefined` when this deployment
 * has no Polar account.
 *
 * All five variables are read here, at call time, and never at module load, so
 * a process that starts before its environment is complete still reads the
 * truth at the moment it asks. The access token and the organization id are
 * required even though this change makes no Polar API call: a deployment
 * holding a webhook secret without them is half configured, and answering
 * `configured: false` for it is more honest than serving an entitlement from an
 * account nobody can manage.
 */
export function billingFromEnv(env = process.env, overrides = {}) {
  const environment = envValue("NOMO_POLAR_ENVIRONMENT", env) ?? "production";
  const complete =
    ENVIRONMENT.has(environment) &&
    Boolean(envValue("NOMO_POLAR_ACCESS_TOKEN", env)) &&
    Boolean(envValue("NOMO_POLAR_ORGANIZATION_ID", env)) &&
    Boolean(envValue("NOMO_POLAR_WEBHOOK_SECRET", env));
  if (!complete) return undefined;
  // Only what is read later is kept: `env`, because the secret is read through
  // it on every verification, and `productId`, because it decides which of
  // Polar's products this deployment counts as paid. The access token and the
  // organization id are deliberately not held on the service: nothing in this
  // change uses them, and a credential carried on an object is a credential one
  // careless log statement can print. They are required to be present anyway,
  // because a deployment holding only a webhook secret cannot manage the
  // account that secret belongs to.
  return createBillingService(
    { env, productId: envValue("NOMO_POLAR_PRODUCT_TEAM", env) },
    overrides,
  );
}

/**
 * The webhook, mounted above `express.json()` in `cloud/server.mjs`.
 *
 * It sits with `mountIntegrationCallback` and for the same two reasons: it must
 * read the signed bytes before any JSON parser re-parses them, and it must
 * answer without an owner, because a Polar delivery carries neither a control
 * token nor an account cookie, and would be refused by the origin and
 * `sec-fetch-site` checks before it reached any route at all.
 */
export function mountBillingWebhook(app, service) {
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json", limit: "64kb" }),
    async (req, res) => {
      res.set({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
      if (!service)
        return res.status(503).json({
          error: "billing_not_configured",
          message: "Billing is not configured on this server.",
        });
      const missing = SIGNED_HEADERS.filter(
        (name) => typeof req.headers[name] !== "string" || req.headers[name] === "",
      );
      if (missing.length)
        return res.status(400).json({ error: "webhook_headers_missing", missing });
      // Not a Buffer means no parser claimed the body, so the bytes Polar signed
      // are not the bytes this server received.
      if (!Buffer.isBuffer(req.body))
        return res.status(400).json({ error: "webhook_body_unread" });
      const verified = await service.verify(req.body, req.headers);
      if (!verified.ok) {
        // An event type outside the SDK's known set got here through a
        // signature that verified: Polar sent it correctly, and this
        // deployment simply has not heard of it. That is a 2xx with the type
        // recorded. Answering 4xx here would make Polar redeliver a valid
        // event forever, against an endpoint that can never accept it. It is
        // kept strictly to this one failure: a signature that did not verify
        // falls through to the 400 below and must.
        if (verified.failure === "unknown_event_type")
          return res.json({
            ok: true,
            applied: false,
            ignored: "unknown_event_type",
            ...(verified.eventType ? { unhandled: verified.eventType } : {}),
          });
        return res
          .status(verified.failure === "verifier_unavailable" ? 503 : 400)
          .json({ error: verified.failure });
      }
      const event = verified.event;
      // An event this deployment does not apply is not an error. Polar adds
      // event types, and answering 4xx to one it has not heard of would make
      // it redeliver a valid event until somebody turned the webhook off.
      if (typeof event?.type !== "string" || !event.type.startsWith("subscription."))
        return res.json({ ok: true, applied: false, ignored: "not_a_subscription_event" });
      const outcome = await service.applySubscription(
        event,
        req.headers["webhook-id"],
      );
      if (outcome.ignored)
        return res.json({ ok: true, applied: false, ignored: outcome.ignored });
      return res.json({
        ok: true,
        applied: outcome.applied === true,
        ...(outcome.duplicate ? { duplicate: true } : {}),
      });
    },
  );
}

/**
 * The authenticated routes, mounted beside the other owners' routes in
 * `cloud/server.mjs`, behind the middleware that resolves an owner.
 *
 * They take the application first because every other route module in this
 * directory does, and a mount function that cannot mount is a function that
 * cannot be tested in isolation.
 *
 * `GET /api/billing` answers for the caller and nobody else: the owner is the
 * one the middleware resolved, the answer is the one subscription document under
 * that owner, and nothing in the published shape is a credential, a customer
 * id, or a field belonging to anybody else.
 */
export function billingRoutes(app, service) {
  const refuse = (res) =>
    res.status(401).json({
      error: "authentication_required",
      message: "Sign in to read your billing state.",
    });
  app.get("/api/billing", async (req, res) => {
    if (!isOwner(req.owner)) return refuse(res);
    try {
      return res.json(
        service ? await service.entitlement(req.owner) : nothing(),
      );
    } catch {
      // A read that cannot be answered is not an empty answer: "you have
      // nothing" would hide the failure behind a shape the client already
      // understands as free.
      return res.status(503).json({
        error: "billing_unavailable",
        message: "Billing state could not be read.",
      });
    }
  });
  app.post("/api/billing/customer", async (req, res) => {
    if (!isOwner(req.owner)) return refuse(res);
    if (!service)
      return res.status(503).json({
        error: "billing_not_configured",
        message: "Billing is not configured on this server.",
      });
    try {
      return res.json(await service.linkCustomer(req.owner, req.body?.customerId));
    } catch (error) {
      // A refused identifier is the caller's mistake and is answered as one; a
      // storage failure is this deployment's and is not dressed as either.
      const conflict = error?.status === 409;
      const invalid = error?.status === 400;
      return res.status(conflict ? 409 : invalid ? 400 : 502).json({
        error: conflict
          ? "customer_already_linked"
          : invalid
            ? "invalid_customer_id"
            : "billing_unavailable",
        message: conflict
          ? "That Polar customer is linked to another account."
          : invalid
            ? "That Polar customer id is not one."
            : "Billing could not be updated.",
      });
    }
  });
}
