/**
 * The anchor: a signed head kept where the recorder cannot rewrite it.
 *
 * `nomo attest` produces the document (`attestLedger`), keeps a retained local
 * copy under `<ledger dir>/attestations/`, and appends the signed head to an
 * anchor file the operator names. That file is the only part of NOMO's evidence
 * story that leaves the agent's trust domain, and it is only an anchor for as
 * long as the agent process cannot write it: a read-only mount, an off-host
 * copy, a path the OS denies the runtime, or a copy a third party holds. An
 * anchor file the agent can rewrite detects nothing that the local chain check
 * did not already detect, and the CLI says so on every write.
 *
 * What an anchor does and does not buy, stated once so no caller has to infer
 * it: it makes **truncation and rewriting of the anchored prefix detectable by
 * whoever holds the anchor**. It does not stop the agent from rewriting local
 * history, and it does not stop the agent from never writing the records it
 * omits — an attacker who runs the agent can simply decline to anchor, and the
 * absence of a newer anchor is the signal. This is "detects tampering by a
 * third party, not by the agent itself".
 *
 * The anchor file is an **anchor set**, not an append-only log. Nothing in it
 * records how many anchors there were, so deleting lines satisfies every rule
 * `checkAnchors` enforces: the ordering and head rules only hold across the
 * anchors still present. Detecting a shrink means comparing against a copy
 * held somewhere the agent cannot write, which is the same caveat the CLI
 * prints on every anchor write.
 */

import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  parseAttestationDocument,
  verifyAnchor,
  type AnchorMatch,
  type AttestationDocument,
} from "./attest.ts";
import type { JsonlEntry } from "./store.ts";
import type { PublicKeyLookup } from "./verify.ts";

/** The conventional name when an operator anchors into a directory. */
export const ANCHOR_FILE_NAME = "anchors.jsonl";

/**
 * Append one signed anchor. O_APPEND only: an anchor that already exists is
 * added to, never replaced, and the file is flushed before the call returns so
 * a crash cannot lose the head that was just published.
 */
export async function appendAnchor(path: string, doc: AttestationDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(doc)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type AnchorsRead =
  | { readonly ok: true; readonly anchors: readonly AttestationDocument[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Read an anchor file. A malformed or half-written line is a failed read with
 * a reason, not an exception: a caller holding an anchor set expects the same
 * result shape whether the file is empty, truncated mid-line, or complete, and
 * a raw `JSON.parse` message is not a diagnosis.
 */
export async function readAnchors(path: string): Promise<AnchorsRead> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `the anchor file ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const anchors: AttestationDocument[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      anchors.push(parseAttestationDocument(JSON.parse(line), `anchor line ${index + 1}`));
    } catch (error) {
      return {
        ok: false,
        reason: `anchor line ${index + 1} of ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true, anchors };
}

export type AnchorCheck =
  | {
      readonly ok: true;
      readonly headSeq: number;
      readonly headHash: string;
      readonly at: string;
      readonly key_id: string;
      readonly grown: number;
      readonly anchors: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Every anchor in the set, against one ledger. All of them are checked, not
 * only the newest: a prefix that was rewritten after the first anchor was
 * taken is caught by that first anchor, because the head hash and Merkle root
 * cascade back through it.
 *
 * What is enforced about the anchor set itself is narrower than "append-only":
 * heads do not go backwards, and two anchors cannot claim the same head with
 * different hashes. That catches an in-place contradiction. It does not catch
 * a *shrink*, because deleting a line satisfies both rules and nothing here
 * records how many anchors the file used to hold. Detecting a shrink means
 * comparing against a copy of the anchor set the agent cannot rewrite.
 */
export async function checkAnchors(
  anchors: readonly AttestationDocument[],
  ledgerEntries: readonly JsonlEntry[],
  options: { readonly publicKey: PublicKeyLookup },
): Promise<AnchorCheck> {
  if (anchors.length === 0)
    return { ok: false, reason: "the anchor file holds no anchors" };
  for (const [index, doc] of anchors.entries()) {
    const previous = anchors[index - 1];
    if (previous === undefined) continue;
    if (doc.headSeq < previous.headSeq)
      return {
        ok: false,
        reason: `anchor ${doc.headSeq} follows anchor ${previous.headSeq} in the file: the anchor set is out of order`,
      };
    if (doc.headSeq === previous.headSeq && doc.headHash !== previous.headHash)
      return {
        ok: false,
        reason: `two anchors claim head ${doc.headSeq} with different hashes: the anchor file was rewritten`,
      };
  }
  let latest: AnchorMatch = { ok: false, reason: "the anchor file holds no anchors" };
  for (const doc of anchors) {
    const match = await verifyAnchor(doc, ledgerEntries, options);
    if (!match.ok) return { ok: false, reason: `anchor ${doc.headSeq}: ${match.reason}` };
    latest = match;
  }
  if (!latest.ok) return latest;
  return {
    ok: true,
    headSeq: latest.headSeq,
    headHash: latest.headHash,
    at: latest.at,
    key_id: latest.key_id,
    grown: latest.grown,
    anchors: anchors.length,
  };
}
