/**
 * The canonical content digest, defined once in the ledger package so a
 * digest means the same thing in a decision record, a recovery plan and a
 * retention approval. Re-exported under the name the runtime already uses.
 */
export { canonicalDigest as digest } from "../../ledger/src/sign.ts";
