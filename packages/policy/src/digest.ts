import { canonicalDigest } from "../../ledger/src/sign.ts";

import type { PolicyFile } from "./rules.ts";

/**
 * The digest a record binds when it claims which policy decided it.
 *
 * It is the digest of the policy *content*, not of the file bytes, so a
 * reviewer who parses the same file to the same rules gets the same value
 * whatever comments, key order or YAML style the operator wrote it in. The
 * ledger entry hash already covers this string, so the record's claim and the
 * policy it names are bound by the same signature: rewriting either one
 * without the other breaks the chain.
 *
 * A format constant such as `version` is part of the content and therefore
 * part of the digest, which is the point: a policy that changes only its
 * declared version is a different policy.
 */
export const policyDigest = (policy: PolicyFile): string =>
  canonicalDigest(policy);
