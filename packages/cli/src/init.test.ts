import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { devKeyProvider } from "../../ledger/src/sign.ts";
import { jsonlStore } from "../../ledger/src/store.ts";
import { resolveVerificationKey } from "../../ledger/src/verify-key.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInitCommand } from "./init.ts";

function collect() {
  const out: string[] = [],
    err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => {
        out.push(line);
      },
      stderr: (line: string) => {
        err.push(line);
      },
    },
  };
}

test("init creates fresh workspace storage and reports paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const c = collect();
  const code = await runInitCommand(["--data-dir", join(root, "wb")], c.io, {
    env: { HOME: root },
  });
  assert.equal(code, 0);
  assert.ok(existsSync(join(root, "wb", "tui", "workspace.key")));
  assert.ok(c.out.some((line) => line.startsWith("created: ")));
  assert.ok(c.out.some((line) => line.includes("void doctor")));
});

/**
 * A signing key in the shared location, with a real signed ledger beside it.
 *
 * Every key here is generated fresh in a temp directory by `devKeyProvider`.
 * No key material is committed, and none of these keys has ever signed
 * anything outside this test's own throwaway tree.
 */
const seedSignedLedger = async (root: string) => {
  const env = { HOME: root };
  const signer = await devKeyProvider({ dir: join(root, ".void", "keys"), env: {} });
  const keyId = await signer.currentKeyId();
  const entry = await jsonlStore(signer, { dir: join(root, ".void", "ledger") }).append({
    workspace: "demo",
    at: new Date().toISOString(),
    tool: "fixture.echo",
    klass: "r0",
    decision: "allow",
    argsDigest: "a".repeat(64),
  });
  return { signer, keyId, entry, ledger: join(root, ".void", "ledger", "demo.jsonl") };
};

test("pinning without --data-dir anchors the key the default ledger was signed with", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { keyId, entry, ledger } = await seedSignedLedger(root);

  const c = collect();
  assert.equal(await runInitCommand(["--pin-verify-key"], c.io, { env: { HOME: root } }), 0);

  // The anchor is the key id the entry actually carries. Asserting against the
  // id read back out of the ledger, not against the id the signer reported,
  // is the whole test: a pin of any other key passes the second and fails this.
  assert.equal(entry.key_id, keyId);
  assert.ok(c.out.some((line) => line === `pinned verification key ${entry.key_id} at ${join(root, ".void", "trust", "verify-ed25519.spki")}`));

  // And it is the key `void verify` would be given: resolving a verification
  // key now names the same id, because both read the one location.
  const resolved = await resolveVerificationKey({ env: { HOME: root } });
  assert.equal(resolved?.keyId, entry.key_id);

  // The claim about what is anchored points at the file the ledger was signed
  // with, not at a data dir that happens to be nearby.
  assert.ok(c.out.some((line) => line.includes(`${join(root, ".void", "keys", "dev-ed25519.pkcs8")}, the signing key the ledgers`)));
  assert.equal(
    c.out.some((line) => /anchors whatever the local key file holds/.test(line)),
    false,
  );
  // And it says the truth about having signed something.
  assert.ok(c.out.some((line) => line === `  signed 1 ledger entry in ${join(root, ".void", "ledger")}`));
  assert.ok(c.out.some((line) => /has not signed anything yet/.test(line) === false));
  assert.ok(existsSync(ledger));
});

test("pinning refuses when no key exists anywhere, and creates none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-nokey-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const c = collect();
  const code = await runInitCommand(["--pin-verify-key"], c.io, { env: { HOME: root } });

  assert.notEqual(code, 0);
  // The refusal names the file it looked for and says it will not create it.
  assert.match(c.err.join("\n"), /does not exist/);
  assert.match(c.err.join("\n"), /never creates one/);
  assert.ok(c.err.join("\n").includes(join(root, ".void", "keys", "dev-ed25519.pkcs8")));
  assert.deepEqual(c.out, []);

  // A command that anchors a key must never be what makes it. Both the key and
  // the trust file stay absent, so a later pin cannot "succeed" against a key
  // this one quietly invented.
  assert.equal(existsSync(join(root, ".void", "keys", "dev-ed25519.pkcs8")), false);
  assert.equal(existsSync(join(root, ".void", "trust", "verify-ed25519.spki")), false);
});

test("--data-dir holding a different key does not change which key is anchored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-datadir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { keyId } = await seedSignedLedger(root);
  const dir = join(root, "wb");
  const dataKeyId = await (
    await devKeyProvider({ dir: join(dir, "keys"), env: {} })
  ).currentKeyId();
  assert.notEqual(dataKeyId, keyId);

  const c = collect();
  assert.equal(
    await runInitCommand(["--data-dir", dir, "--pin-verify-key"], c.io, { env: { HOME: root } }),
    0,
  );

  // The ledger key, not the data dir's. A test asserting only "the pinned id is
  // one of these two" would pass with the defect in place.
  assert.ok(c.out.some((line) => line.startsWith(`pinned verification key ${keyId} `)));
  assert.equal(c.out.some((line) => line.startsWith(`pinned verification key ${dataKeyId} `)), false);

  // ...and it says why the other key was passed over rather than leaving the
  // divergence to be discovered by a later `void verify` failure.
  assert.ok(c.out.some((line) => line.includes(join(dir, "keys", "dev-ed25519.pkcs8")) && line.includes(dataKeyId)));
  assert.ok(c.out.some((line) => line.includes("--data-dir did not change which key is anchored")));
});

test("the not-signed-yet report names the ids the ledger actually carries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { entry, ledger } = await seedSignedLedger(root);
  // Anchor a different key from an out-of-band SPKI, so the anchored key id
  // and the ledger's key id genuinely differ.
  const other = await devKeyProvider({ dir: join(root, "other", "keys"), env: {} });
  const otherSpki = await other.publicKey(await other.currentKeyId());
  assert.ok(otherSpki !== null);

  const c = collect();
  assert.equal(
    await runInitCommand(["--from-spki", Buffer.from(otherSpki).toString("base64")], c.io, {
      env: { HOME: root },
    }),
    0,
  );

  // Ground truth read straight out of the ledger file, independent of the
  // code under test, so the printed line is checked against the bytes on disk.
  const onDisk = (await readFile(ledger, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { key_id: string });
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0]?.key_id, entry.key_id);

  assert.ok(c.out.some((line) => line === `  this key has not signed anything yet. The 1 key id in ${join(root, ".void", "ledger")} are: ${entry.key_id} (1 entry)`));
  assert.ok(c.out.some((line) => line.includes("anchoring this key makes `void verify` refuse every existing ledger")));
});

test("init pins a key derived from the shared location, once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-pin-once-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { signer, keyId } = await seedSignedLedger(root);
  const trustFile = join(root, ".void", "trust", "verify-ed25519.spki");

  const c = collect();
  assert.equal(await runInitCommand(["--pin-verify-key"], c.io, { env: { HOME: root } }), 0);
  const spki = await signer.publicKey(keyId);
  assert.ok(spki !== null);
  const spkiBase64 = Buffer.from(spki).toString("base64");

  // The pin prints the bytes it anchored, and says plainly that a pin derived
  // from the key file anchors whatever that file holds right now.
  assert.ok(c.out.some((line) => line === `  spki: ${spkiBase64}`));
  assert.ok(c.out.some((line) => /anchors whatever that key file holds right now/.test(line)));
  assert.ok(c.out.some((line) => line.includes("--from-spki")));

  // The trust file holds only a public key, and it is a separate file from the
  // private key. It is not a separate trust domain: `~/.void/` holds both, so
  // the resolution reports `operatorSupplied: false` and does not call itself
  // a pin.
  const pinned = await resolveVerificationKey({ env: { HOME: root } });
  assert.equal(pinned?.keyId, keyId);
  assert.equal(pinned?.source, "trust-file");
  assert.equal(pinned?.degraded, false);
  assert.equal(pinned?.operatorSupplied, false);
  assert.notEqual(dirname(trustFile), join(root, ".void", "keys"));

  const again = collect();
  assert.equal(await runInitCommand(["--pin-verify-key"], again.io, { env: { HOME: root } }), 0);
  assert.ok(again.out.some((line) => line.includes(`was already pinned at ${trustFile}`)));
});

test("init refuses an initialized directory without touching it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-twice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "wb");
  const first = collect();
  assert.equal(
    await runInitCommand(["--data-dir", dir], first.io, {
      env: { HOME: root },
    }),
    0,
  );
  const second = collect();
  const code = await runInitCommand(["--data-dir", dir], second.io, {
    env: { HOME: root },
  });
  assert.equal(code, 0);
  assert.ok(second.out.some((line) => line.includes("already initialized")));
});

test("init rejects unknown flags with usage and exit two", async () => {
  const c = collect();
  const code = await runInitCommand(["--force"], c.io, { env: {} });
  assert.equal(code, 2);
  assert.match(c.err[0] ?? "", /usage: void init/);
});
