/**
 * Who owns a row in the cloud database.
 *
 * Every statement in `cloud/store.mjs` names an owner, and the owner is part of
 * the primary key of all three tables. This module holds the two things that
 * decide what an owner is allowed to be: the reserved principals that are not
 * accounts, and the one validation every store function applies before it
 * builds a query.
 *
 * The value never comes from a request body, a query parameter or a header. It
 * comes from a verified session in the middleware in `cloud/server.mjs`, and the
 * two places that mint one are named in `cloud/owner.test.mjs` so a third one
 * cannot be added without that test noticing.
 *
 * There is no owner that means "everything". The operator's control token
 * resolves to `OPERATOR_OWNER` and reads exactly the rows owned by
 * `OPERATOR_OWNER`, which is one namespace and not the union of the others. That
 * is a decision, not a limitation to be removed later: a token that reads every
 * account's rows is the hole this whole change exists to close.
 */

/**
 * The operator's own namespace. Every row that existed before account ownership
 * was migrated belongs here, and the control token reaches nothing else.
 */
export const OPERATOR_OWNER = "operator";

/**
 * The public demo. It is reachable with no credential on purpose, and its rows
 * are still owned: an account can neither read them nor collide with them.
 */
export const DEMO_OWNER = "public-demo";

/**
 * Owner identifiers are compared as SQL parameters, never interpolated, so this
 * is a sanity bound rather than the injection defence. The shape is wide enough
 * for a Supabase user id and narrow enough that a value which is obviously not
 * an identity is rejected before it becomes a key.
 */
const OWNER_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

export const isOwner = (owner) =>
  typeof owner === "string" && OWNER_SHAPE.test(owner);

/**
 * The single gate every store function calls first. It is deliberately the first
 * statement in each of them, before the database client is resolved, so calling
 * a store function without an owner throws instead of quietly building a query
 * that would return another account's rows.
 */
export function assertOwner(owner) {
  if (!isOwner(owner))
    throw new Error(
      "Cloud state requires a verified owner. This request cannot be served without one.",
    );
  return owner;
}
