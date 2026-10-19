/**
 * The absence sentences every vault engine and the CLI must agree on.
 *
 * The CLI's absent-half classifier matches these exact strings, so they live
 * in one named place instead of being retyped at each throw and re-spelled at
 * the call site. A genuine half failure, like a capacity worker or a
 * mismatched pin, names itself differently and refuses; only the healthy
 * store's two absence shapes may ever read as absent.
 */

/** A reference names a digest the store never held or no longer holds. */
export const REFERENCE_ABSENT = "Invalid or unavailable recovery reference.";

/** An artifact a healthy store proved by stat was gone when a transition ran. */
export const ARTIFACT_UNAVAILABLE =
  "Recovery artifact is unavailable; lifecycle was not recorded.";
