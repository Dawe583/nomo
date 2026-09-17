import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const script = fileURLToPath(
  new URL("./verify-ledger-standalone.mjs", import.meta.url),
);

test("standalone selftest proves roundtrip, tamper refusal and wrong key refusal", async () => {
  const result = await exec(process.execPath, [script, "--selftest"]);
  assert.match(result.stdout, /SELFTEST PASS roundtrip: 3 entries/);
  assert.match(result.stdout, /SELFTEST PASS tamper refused/);
  assert.match(result.stdout, /SELFTEST PASS wrong key refused/);
  assert.match(result.stdout, /SELFTEST PASS integrity-only/);
  assert.match(result.stdout, /SELFTEST PASS all four checks/);
});

test("missing bundle and half key options fail with usage, not a crash", async () => {
  await assert.rejects(
    exec(process.execPath, [script, "/no/such/bundle.jsonl"]),
    /FAILED: cannot read bundle/,
  );
  await assert.rejects(
    exec(process.execPath, [
      script,
      "/no/such/bundle.jsonl",
      "--public-key",
      "eA==",
    ]),
    /together/,
  );
});

test("standalone verifier agrees with the real ledger on a real export", async (t) => {
  // The replicated canonicaliser, entry hash and preimage must match the
  // repository byte for byte, or offline verification is decoration.
  const root = await mkdtemp(join(tmpdir(), "void-standalone-cross-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const generator = join(root, "generate.mts");
  await writeFile(
    generator,
    `import { jsonlStore } from "/Users/dawe/Developer/Claude-Projects/VOID/packages/ledger/src/store.ts";
import { devKeyProvider } from "/Users/dawe/Developer/Claude-Projects/VOID/packages/ledger/src/sign.ts";
const dir = ${JSON.stringify(join(root, "ledger"))};
const keys = ${JSON.stringify(join(root, "keys"))};
const key = await devKeyProvider({ dir: keys });
const store = jsonlStore(key, { dir });
await store.append({ workspace: "cross", tool: "void_workspace_write", klass: "r1", decision: "execute:completed" });
await store.append({ workspace: "cross", tool: "void_workspace_undo", klass: "r1", decision: "execute:completed" });
const keyId = await key.currentKeyId();
const spki = await key.publicKey(keyId);
console.log(JSON.stringify({ bundle: dir + "/cross.jsonl", keyId, spki: Buffer.from(spki).toString("base64") }));
`,
  );
  const generated = await exec(process.execPath, [generator]);
  const { bundle, keyId, spki } = JSON.parse(generated.stdout);
  const result = await exec(process.execPath, [
    script,
    bundle,
    "--public-key",
    spki,
    "--key-id",
    keyId,
  ]);
  assert.match(result.stdout, /VERIFIED 2 entries/);
  assert.match(result.stdout, /signatures and hash links/);
});
