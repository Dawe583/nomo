import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider } from "./sign.ts";
import { jsonlStore } from "./store.ts";
import { verifyLedgerFile } from "./verify.ts";

const workspace = "verify-ws";

type Body = {
  readonly workspace: string;
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
};

async function seedLedger(count = 4): Promise<{
  readonly dir: string;
  readonly file: string;
  readonly key: Awaited<ReturnType<typeof devKeyProvider>>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-verify-"));
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  for (let index = 1; index <= count; index += 1) {
    const body: Body = {
      workspace,
      at: `2026-09-0${index}T00:00:00.000Z`,
      tool: `postgres.row.update.${index}`,
      klass: "r1",
      decision: "allow:resolved",
      argsDigest: `${index}`.repeat(64),
    };
    await store.append(body);
  }
  return { dir, file: join(dir, `${workspace}.jsonl`), key };
}

describe("verifyLedgerFile", () => {
  test("verifies an exported JSONL file with the public key only", async () => {
    const { file, key } = await seedLedger();
    const keyId = await key.currentKeyId();
    const publicKey = await key.publicKey(keyId);
    assert.ok(publicKey !== null);
    const result = await verifyLedgerFile(file, { publicKey });
    assert.equal(result.ok, true);
    assert.equal(result.checked, 4);
    assert.equal(result.lines.length, 4);
    assert.equal(result.lines.every((line) => line.ok), true);
  });

  test("a tampered middle hash fails with the seq named", async () => {
    const { file, key } = await seedLedger();
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1]!) as { hash: string };
    second.hash = "f".repeat(64);
    lines[1] = JSON.stringify(second);
    await writeFile(file, `${lines.join("\n")}\n`);
    const keyId = await key.currentKeyId();
    const publicKey = await key.publicKey(keyId);
    assert.ok(publicKey !== null);

    const result = await verifyLedgerFile(file, { publicKey });
    assert.equal(result.ok, false);
    assert.equal(result.checked, 2);
    assert.match(result.reason!, /entry 2/);
  });

  test("a corrupted signature fails at its own seq, and later entries are not marked verified", async () => {
    const { file, key } = await seedLedger(3);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const second = JSON.parse(lines[1]!) as { signature: string };
    const [alg, encoded, extra] = second.signature.split(":");
    assert.ok(alg === "ed25519" && encoded !== undefined && extra === undefined);
    // Flip one bit of the real signature and re-encode it. The tag stays
    // well formed and the body, hash and links stay untouched, so the only
    // thing wrong with entry 2 is the signature itself. A made-up signature
    // string would prove less: it could fail on parsing rather than on
    // verification, and this test is about the verification finding.
    const signature = Buffer.from(encoded, "base64");
    signature[signature.length - 1] = signature[signature.length - 1]! ^ 0x01;
    second.signature = `${alg}:${signature.toString("base64")}`;
    lines[1] = JSON.stringify(second);
    await writeFile(file, `${lines.join("\n")}\n`);
    const keyId = await key.currentKeyId();
    const publicKey = await key.publicKey(keyId);
    assert.ok(publicKey !== null);

    const result = await verifyLedgerFile(file, { publicKey });
    assert.equal(result.ok, false);
    assert.equal(result.checked, 2);
    assert.deepEqual(result.lines[0], { seq: 1, ok: true });
    assert.equal(result.lines[1]!.seq, 2);
    assert.equal(result.lines[1]!.ok, false);
    assert.match(result.lines[1]!.reason!, /entry 2 fails signature verification/);
    // A corrupted signature must not be reported as a broken chain: that
    // would send an operator to repair the wrong record.
    assert.doesNotMatch(result.lines[1]!.reason!, /does not match digest/);

    // Verification stops at the finding. Entry 3 is never checked, so it
    // must not appear as a verified line: reporting the rest of the chain as
    // ok would launder an unverified tail into evidence.
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines.some((line) => line.seq === 3), false);
    assert.equal(result.lines.filter((line) => line.ok).length, 1);
  });

  test("the wrong public key fails signature verification", async () => {
    const { file } = await seedLedger();
    const wrongDir = await mkdtemp(join(tmpdir(), "nomo-wrong-key-"));
    const wrongKey = await devKeyProvider({ dir: wrongDir, env: {} });
    const wrongKeyId = await wrongKey.currentKeyId();
    const publicKey = await wrongKey.publicKey(wrongKeyId);
    assert.ok(publicKey !== null);

    const result = await verifyLedgerFile(file, { publicKey });
    assert.equal(result.ok, false);
    assert.match(result.reason!, /signature verification/);
  });
});
