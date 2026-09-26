import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAnchors } from "../../ledger/src/anchor.ts";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import { readLedgerEntries, verifyChain } from "../../ledger/src/verify.ts";
import { runOperation } from "./operations.ts";
import { runVerifyCommand } from "./verify.ts";

const workspace = "integrity";

const scratch = async (t: { after: (fn: () => unknown) => void }) => {
  const dir = await mkdtemp(join(tmpdir(), "void-integrity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const seed = async (dir: string, tools: readonly string[]) => {
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  for (const tool of tools)
    await store.append({
      workspace,
      at: "2026-09-26T00:00:00.000Z",
      tool,
      klass: "r0",
      decision: "allow",
      argsDigest: "a".repeat(64),
    });
  return { key, ledger: join(dir, `${workspace}.jsonl`) };
};

const collect = (env?: Readonly<NodeJS.ProcessEnv>) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => void out.push(line),
      stderr: (line: string) => void err.push(line),
      env,
    },
  };
};

describe("void attest publishes an anchor", () => {
  test("the anchor is retained locally and appended to the file the operator names", async (t) => {
    const dir = await scratch(t);
    const { key, ledger } = await seed(dir, ["fixture.one", "fixture.two"]);
    const env = { VOID_SIGNING_KEY: (await readFile(join(dir, "keys", "dev-ed25519.pkcs8"))).toString("base64") };
    const outOfBand = join(dir, "operator-held", "anchors.jsonl");
    const c = collect();
    assert.equal(await runOperation("attest", ["--ledger", ledger, "--anchor", outOfBand], env, (line) => void c.out.push(line)), 0);

    const printed = c.out.join("\n");
    assert.match(printed, /anchor: signed head 2 [0-9a-f]{64} over 2 entries/);
    assert.match(printed, /retained copy: .*attestations\/2\.json/);
    assert.match(printed, new RegExp(`anchor appended: ${outOfBand}`));

    // The retained local copy and the out-of-band file carry the same document.
    const retained = JSON.parse(await readFile(join(dir, "attestations", "2.json"), "utf8")) as Record<string, unknown>;
    const read = await readAnchors(outOfBand);
    assert.equal(read.ok, true);
    const anchors = read.ok ? read.anchors : [];
    assert.equal(anchors.length, 1);
    assert.deepEqual(anchors[0], retained);
    assert.equal(anchors[0]!.key_id, await key.currentKeyId());
  });

  test("the anchor is refused when the chain does not verify", async (t) => {
    const dir = await scratch(t);
    const { ledger } = await seed(dir, ["fixture.one"]);
    const env = { VOID_SIGNING_KEY: (await readFile(join(dir, "keys", "dev-ed25519.pkcs8"))).toString("base64") };
    await writeFile(ledger, (await readFile(ledger, "utf8")).replace("fixture.one", "s3.object.put"));
    await assert.rejects(
      runOperation("attest", ["--ledger", ledger], env, () => assert.fail("must not attest")),
      /verification failed/,
    );
  });
});

describe("void verify against a published anchor", () => {
  test("a truncated but internally consistent chain fails against the anchor", async (t) => {
    const dir = await scratch(t);
    const { key, ledger } = await seed(dir, ["fixture.one", "fixture.two", "fixture.three"]);
    const env = { VOID_SIGNING_KEY: (await readFile(join(dir, "keys", "dev-ed25519.pkcs8"))).toString("base64") };
    const outOfBand = join(dir, "anchors.jsonl");
    assert.equal(await runOperation("attest", ["--ledger", ledger, "--anchor", outOfBand], env, () => {}), 0);

    const entries = await readLedgerEntries(ledger);
    const truncated = entries.slice(0, 2);
    await writeFile(ledger, `${truncated.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    // The chain on its own is fine: a prefix is a valid chain.
    assert.equal((await verifyChain(truncated, { publicKey: (id) => key.publicKey(id) })).ok, true);

    const c = collect(env);
    const code = await runVerifyCommand(["--ledger", ledger, "--anchors", outOfBand], c.io);
    assert.equal(code, 1);
    assert.match(c.out.join("\n"), /anchor: mismatch .*shorter than the anchor/);
  });

  test("a chain re-signed with a substituted key fails the anchor even when it verifies", async (t) => {
    const dir = await scratch(t);
    const { ledger } = await seed(dir, ["fixture.one", "fixture.two"]);
    const env = { VOID_SIGNING_KEY: (await readFile(join(dir, "keys", "dev-ed25519.pkcs8"))).toString("base64") };
    const outOfBand = join(dir, "anchors.jsonl");
    assert.equal(await runOperation("attest", ["--ledger", ledger, "--anchor", outOfBand], env, () => {}), 0);

    // The attacker replaces the signing key, rewrites the ledger and re-signs
    // it. Checked against the substituted key the chain verifies clean, which
    // is exactly what the anchor exists to contradict.
    const attacker = await devKeyProvider({ dir: join(dir, "attacker-keys"), env: {} });
    const store = jsonlStore(attacker, { dir: join(dir, "attacker") });
    for (const tool of ["fixture.one", "s3.object.put"])
      await store.append({
        workspace,
        at: "2026-09-26T00:00:00.000Z",
        tool,
        klass: "r0",
        decision: "allow",
        argsDigest: "a".repeat(64),
      });
    const forgedLedger = join(dir, "attacker", `${workspace}.jsonl`);
    const attackerKey = await attacker.publicKey(await attacker.currentKeyId());
    assert.ok(attackerKey !== null);

    const c = collect({ VOID_VERIFY_KEY: Buffer.from(attackerKey).toString("base64") });
    const code = await runVerifyCommand(["--ledger", forgedLedger, "--anchors", outOfBand], c.io);
    assert.equal(code, 1);
    assert.match(c.out.join("\n"), /chain: 2 entries ok/);
    assert.match(
      c.out.join("\n"),
      /anchor: mismatch .*(the anchored head was|no public key for attestation key)/,
    );
  });

  test("the anchor is checked only when a verification key is available", async (t) => {
    const dir = await scratch(t);
    const { ledger } = await seed(dir, ["fixture.one"]);
    const outOfBand = join(dir, "anchors.jsonl");
    const withKey = { VOID_SIGNING_KEY: (await readFile(join(dir, "keys", "dev-ed25519.pkcs8"))).toString("base64") };
    assert.equal(await runOperation("attest", ["--ledger", ledger, "--anchor", outOfBand], withKey, () => {}), 0);

    const c = collect({ HOME: join(dir, "empty-home") });
    const code = await runVerifyCommand(["--ledger", ledger, "--anchors", outOfBand], c.io);
    assert.equal(code, 1);
    assert.match(c.out.join("\n"), /verification key: none, signature NOT VERIFIED/);
    assert.match(c.out.join("\n"), /anchor: not checked, an anchor needs a verification key/);
  });
});

