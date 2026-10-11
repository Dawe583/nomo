/**
 * The Node half of the canonical JSON cross check.
 *
 * Reads a JSON array of sample payloads on stdin and writes one JSON object
 * per sample to stdout: the canonical text, its sha256 in `sha256:<hex>`
 * form, and the exact bytes as a latin1-safe base64 of the UTF-8 encoding.
 * The Python test compares every field byte for byte, so a divergence in key
 * order, number format, escaping or the digest prefix fails the suite.
 *
 * It imports the real `packages/ledger/src/canonical.ts`, not a copy: a copy
 * would only prove that two copies agree.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "../../../../packages/ledger/src/canonical.ts";

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk);
}
const samples = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out = [];
for (const sample of samples) {
  let text;
  let error = null;
  try {
    text = canonicalJson(sample.value);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
    text = null;
  }
  out.push({
    name: sample.name,
    canonical: text,
    digest: text === null ? null : `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    bytesBase64: text === null ? null : Buffer.from(text, "utf8").toString("base64"),
    error,
  });
}
process.stdout.write(JSON.stringify(out));
