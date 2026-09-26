/**
 * The owner an OAuth round trip belongs to, carried in the `state` parameter.
 *
 * The OAuth callback is the one route that has to work before anybody is
 * signed in: the browser arrives from a third party, so the strict workspace
 * cookie is not sent and the account cookie is not there either. It still has
 * to know which account's integration row it is about to write, because that
 * row is a cloud row and every cloud row has an owner.
 *
 * The owner therefore travels inside the `state`, sealed. That value is minted
 * by `/api/integrations/:id/start`, which runs behind the session gate, so the
 * owner in it came from a verified session. It is opaque to the provider, it is
 * bound to the browser by the separate `binding` cookie, it is single use
 * because the pending record is marked used, and it expires with the flow.
 *
 * The key is derived from the cloud secret with a purpose string of its own, so
 * this can never open a value sealed for another purpose with the same key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assertOwner, isOwner } from "./owner.mjs";
import { derivedKey } from "./account.mjs";

const PURPOSE = "oauth-owner-state";
const NONCE_SHAPE = /^[\w-]{43}$/;

const seal = (plaintext) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(PURPOSE), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64url"))
    .join(".");
};

const unseal = (value) => {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derivedKey(PURPOSE),
      Buffer.from(parts[0], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[1], "base64url"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(parts[2], "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    );
  } catch {
    return null;
  }
};
export function sealOwnerState(owner, flow) {
  assertOwner(owner);
  if (typeof flow?.state !== "string" || !NONCE_SHAPE.test(flow.state))
    throw new Error("Invalid OAuth state.");
  const sealed = seal({ owner, nonce: flow.state });
  const redirect = new URL(flow.url);
  redirect.searchParams.set("state", sealed);
  // The whole flow comes back, not just the two fields that changed. The
  // browser binding has to survive this or the callback can no longer prove the
  // flow returned to the browser that started it.
  return { ...flow, state: sealed, url: redirect.href };
}

/**
 * The inverse. A state this module did not seal, or one that names no owner,
 * returns null and the callback fails the flow rather than guessing an owner.
 */
export function openOwnerState(value) {
  const opened = unseal(value);
  if (!opened || typeof opened !== "object") return null;
  if (!isOwner(opened.owner)) return null;
  if (typeof opened.nonce !== "string" || !NONCE_SHAPE.test(opened.nonce))
    return null;
  return { owner: opened.owner, nonce: opened.nonce };
}
