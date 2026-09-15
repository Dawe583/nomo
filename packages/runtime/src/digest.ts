import { createHash } from "node:crypto";
import { canonicalJson } from "../../ledger/src/canonical.ts";

export const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
