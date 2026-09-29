import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLedgerEntries, verifyChain, type PublicKeyLookup } from "./verify.ts";

import { devKeyProvider } from "./sign.ts";
import { jsonlStore } from "./store.ts";
import {
  PINNED_KEY_ENV,
  pinnedKey,
  pinVerificationKey,
  pinVerificationKeyFromSigner,
  publicKeyFromSpkiBase64,
  resolveVerificationKey,
  verificationKeyLine,
  verificationKeyNote,
  verificationStatus,
  type VerificationFacts,
} from "./verify-key.ts";

const workspace = "pin-ws";

const seed = async (dir: string) => {
  const key = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir });
  for (const tool of ["fixture.one", "fixture.two"])
    await store.append({
      workspace,
      at: "2026-09-26T00:00:00.000Z",
      tool,
      klass: "r0",
      decision: "allow",
      argsDigest: "a".repeat(64),
    });
  return key;
};

const scratch = async (t: { after: (fn: () => unknown) => void }, prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/// `PublicKeyLookup` is either a fixed key or a resolver over key ids. These
/// tests care about the answer, not which form it arrived in, so both forms
/// resolve through one helper rather than being cast apart at each call site.
async function answer(lookup: PublicKeyLookup, keyId: string): Promise<Uint8Array | null> {
  return typeof lookup === "function" ? lookup(keyId) : lookup;
}

describe("resolveVerificationKey", () => {
  test("a pinned public key is the answer, and it answers for one key id", async (t) => {
    const dir = await scratch(t, "void-pin-");
    const key = await seed(dir);
    const keyId = await key.currentKeyId();
    const spki = await key.publicKey(keyId);
    assert.ok(spki !== null);

    const resolved = await resolveVerificationKey({
      env: { [PINNED_KEY_ENV]: Buffer.from(spki).toString("base64") },
    });
    assert.equal(resolved?.keyId, keyId);
    assert.equal(resolved?.source, "pinned-env");
    assert.equal(resolved?.degraded, false);
    const lookup = pinnedKey(spki).publicKey;
    assert.deepEqual(await answer(lookup, keyId), spki);
    assert.equal(await answer(lookup, "dev-ed25519:0000000000000000"), null);
  });

  test("nothing configured means no key, never the private key file", async (t) => {
    const dir = await scratch(t, "void-pin-empty-");
    await seed(dir);
    const resolved = await resolveVerificationKey({
      env: {},
      home: dir,
      keyDir: join(dir, "keys"),
    });
    assert.equal(resolved, undefined);
  });

  test("the degraded path is opt in and reports itself", async (t) => {
    const dir = await scratch(t, "void-pin-degraded-");
    const key = await seed(dir);
    const resolved = await resolveVerificationKey({
      env: {},
      home: dir,
      allowDegraded: true,
      keyDir: join(dir, "keys"),
    });
    assert.equal(resolved?.keyId, await key.currentKeyId());
    assert.equal(resolved?.source, "signing-key-file");
    assert.equal(resolved?.degraded, true);
  });

  test("a substituted key file is rejected by a pinned public key", async (t) => {
    const dir = await scratch(t, "void-pin-attack-");
    const honest = await seed(dir);
    const honestId = await honest.currentKeyId();
    const honestSpki = await honest.publicKey(honestId);
    assert.ok(honestSpki !== null);
    const pinned = pinnedKey(honestSpki);

    // The attacker replaces the signing key file and re-signs a rewritten
    // chain with it. No record changes shape; only the key behind them does.
    const attacker = await devKeyProvider({ dir: join(dir, "attacker-keys"), env: {} });
    const attackerId = await attacker.currentKeyId();
    assert.notEqual(attackerId, honestId);
    const rewritten = jsonlStore(attacker, { dir: join(dir, "forged") });
    for (const tool of ["fixture.one", "s3.object.put"])
      await rewritten.append({
        workspace,
        at: "2026-09-26T00:00:00.000Z",
        tool,
        klass: "r0",
        decision: "allow",
        argsDigest: "a".repeat(64),
      });
    const entries = await readLedgerEntries(join(dir, "forged", `${workspace}.jsonl`));

    // The attacker's own key accepts the forged chain, which is the whole
    // defect: verification that resolves its key from the key file verifies
    // the attacker against the attacker.
    assert.equal((await verifyChain(entries, { publicKey: (id) => attacker.publicKey(id) })).ok, true);

    // The pinned key answers for one key id only, so the forged chain fails
    // at the key id lookup in verifyChain rather than verifying clean.
    assert.equal(entries[0]!.key_id, attackerId);
    assert.equal(await answer(pinned.publicKey, attackerId), null);
    const pinnedCheck = await verifyChain(entries, { publicKey: pinned.publicKey });
    assert.equal(pinnedCheck.ok, false);
    assert.match(pinnedCheck.reason ?? "", new RegExp(`entry 1 has no public key for ${attackerId}`));
  });

  test("an invalid pinned key is refused rather than ignored", async () => {
    assert.throws(
      () => publicKeyFromSpkiBase64("bm90LWEtkey", "VOID_VERIFY_KEY"),
      /not a valid base64 SPKI DER/,
    );
  });
});

describe("pinVerificationKey", () => {
  test("provisions a trust file the verifier then reads by default", async (t) => {
    const dir = await scratch(t, "void-pin-write-");
    const key = await seed(dir);
    const keyId = await key.currentKeyId();
    const spki = await key.publicKey(keyId);
    assert.ok(spki !== null);

    const pinned = await pinVerificationKeyFromSigner({
      env: {},
      keyDir: join(dir, "keys"),
      home: dir,
    });
    assert.equal(pinned.keyId, keyId);
    assert.equal(pinned.created, true);
    assert.equal(pinned.path, join(dir, ".void", "trust", "verify-ed25519.spki"));
    // What this file is for is that it cannot be written back, so the mode
    // number is only the encoding of that claim on one platform. `open(...,
    // "wx", 0o400)` does set the read-only attribute on Windows, but Windows has
    // no owner write bit for chmod to clear, so the mode reads back as 0o444
    // and a test hardcoding 0o400 asserts a POSIX spelling of a claim both
    // platforms make. The claim itself, asserted directly: no write bit is set
    // for anyone, and the operating system refuses an overwrite of the bytes.
    const pinnedMode = (await stat(pinned.path)).mode;
    assert.equal(
      pinnedMode & 0o222,
      0,
      `pinned verification key is writable, mode ${(pinnedMode & 0o777).toString(8)}`,
    );
    assert.equal((await readFile(pinned.path, "utf8")).trim(), Buffer.from(spki).toString("base64"));
    // The refusal is only assertable for an unprivileged process: a root user
    // bypasses POSIX permission bits by design, so there the overwrite would
    // succeed and would be a fact about root rather than about this file.
    if (process.getuid?.() !== 0)
      await assert.rejects(
        writeFile(pinned.path, "replacement\n"),
        (error: NodeJS.ErrnoException) => error.code === "EPERM" || error.code === "EACCES",
        "the pinned verification key was written back in place",
      );

    const resolved = await resolveVerificationKey({ env: {}, home: dir, allowDefaultTrustFile: true });
    assert.equal(resolved?.keyId, keyId);
    assert.equal(resolved?.source, "trust-file");
    assert.equal(resolved?.degraded, false);
    // The default trust file is inside the VOID tree the signing key is in, so
    // it is not reported as a key the agent could not have chosen.
    assert.equal(resolved?.operatorSupplied, false);
  });

  test("a trust file the agent can replace is reported as not operator supplied", async (t) => {
    const dir = await scratch(t, "void-pin-substitute-");
    const honest = await seed(dir);
    const honestId = await honest.currentKeyId();
    const trustFile = join(dir, ".void", "trust", "verify-ed25519.spki");
    await pinVerificationKeyFromSigner({ env: {}, keyDir: join(dir, "keys"), home: dir });
    const before = await resolveVerificationKey({ env: {}, home: dir, allowDefaultTrustFile: true });
    assert.equal(before?.keyId, honestId);
    assert.equal(before?.operatorSupplied, false);

    // The attack the review confirmed: mode 0400 blocks an in-place write but
    // not unlink-then-create, and the attacker's key then becomes the anchor.
    const attacker = await devKeyProvider({ dir: join(dir, "attacker-keys"), env: {} });
    const attackerSpki = await attacker.publicKey(await attacker.currentKeyId());
    assert.ok(attackerSpki !== null);
    await rm(trustFile, { force: true });
    await writeFile(trustFile, `${Buffer.from(attackerSpki).toString("base64")}\n`, { mode: 0o400 });
    const after = await resolveVerificationKey({ env: {}, home: dir, allowDefaultTrustFile: true });
    assert.equal(after?.keyId, await attacker.currentKeyId());
    // This is the point: the substitution is not detectable here, and the
    // answer says so rather than reporting a clean pin.
    assert.equal(after?.operatorSupplied, false);
    assert.equal(after?.source, "trust-file");
  });
  test("repinning a different key is refused", async (t) => {
    const dir = await scratch(t, "void-pin-repin-");
    const first = await devKeyProvider({ dir: join(dir, "a-keys"), env: {} });
    const second = await devKeyProvider({ dir: join(dir, "b-keys"), env: {} });
    const a = await first.publicKey(await first.currentKeyId());
    const b = await second.publicKey(await second.currentKeyId());
    assert.ok(a !== null && b !== null);
    const file = join(dir, "trust", "verify-ed25519.spki");
    assert.equal((await pinVerificationKey(a, { file, anchoredFrom: "operator-spki" })).created, true);
    assert.equal((await pinVerificationKey(a, { file, anchoredFrom: "operator-spki" })).created, false);
    await assert.rejects(pinVerificationKey(b, { file, anchoredFrom: "operator-spki" }), /already pinned/);
  });

  test("a trust file holding junk is an error, not an absent key", async (t) => {
    const dir = await scratch(t, "void-pin-junk-");
    const file = join(dir, "verify-ed25519.spki");
    await writeFile(file, "not-a-key\n");
    await assert.rejects(
      resolveVerificationKey({ env: { VOID_VERIFY_KEY_FILE: file } }),
      /is not a valid base64 SPKI DER/,
    );
  });
});

describe("the verification vocabulary", () => {
  const key = (facts: Partial<VerificationFacts> & Pick<VerificationFacts, "source">): VerificationFacts => ({
    keyId: "dev-ed25519:0123456789abcdef",
    degraded: false,
    operatorSupplied: true,
    ...facts,
  });

  // The word `pinned` is a claim, and this is the claim it makes: that the
  // operator handed the bytes over somewhere the agent cannot reach. The
  // default trust file does not, so it must never render the word — the exact
  // defect the audit found in `void verify`.
  test("pinned is reserved for keys supplied out of band", () => {
    assert.match(
      verificationKeyLine(key({ source: "pinned-env" })),
      /^verification key: pinned dev-ed25519:0123456789abcdef \(pinned-env\)$/,
    );
    // A trust file at the default path shares `~/.void/` with the signing key.
    const atDefaultPath = key({ source: "trust-file", operatorSupplied: false });
    assert.doesNotMatch(verificationKeyLine(atDefaultPath), /pinned/);
    assert.match(verificationKeyLine(atDefaultPath), /shares ~\/\.void\//);
    // A trust file outside the tree is trusted on the strength of its path
    // alone, which is weaker than knowing who wrote it, and says so.
    const outOfTree = key({ source: "trust-file", operatorSupplied: true });
    const outOfTreeNote = verificationKeyNote(outOfTree);
    assert.ok(outOfTreeNote, "an out-of-tree trust file must say something");
    assert.doesNotMatch(outOfTreeNote, /shares ~\/\.void\//);
    assert.match(outOfTreeNote, /cannot prove who wrote the bytes/);
  });

  test("a degraded key is DEGRADED and names the opt-in that caused it", () => {
    const degraded = key({ source: "signing-key-file", degraded: true, operatorSupplied: false });
    const line = verificationKeyLine(degraded);
    assert.match(line, /^verification key: DEGRADED /);
    // F10: an operator who lands in this mode by accident has to be able to
    // find the switch from the surface that reported it, and the switch leads
    // the line rather than ending it, because every one of these surfaces
    // truncates to terminal width and the tail is what gets cut.
    assert.match(line, /DEGRADED dev-ed25519:[0-9a-f]+ \(signing-key-file\): VOID_VERIFY_ALLOW_SIGNING_KEY/);
    assert.doesNotMatch(line, /pinned/);
    assert.match(verificationStatus(degraded), /^DEGRADED/);
  });

  test("a status line never says only that something was verified", () => {
    // The TUI headline rendered the bare word "verified" for every one of
    // these. Three different claims, three different strings.
    const claims = [
      verificationStatus(key({ source: "pinned-env" })),
      verificationStatus(key({ source: "trust-file", operatorSupplied: false })),
      verificationStatus(key({ source: "signing-key-env", degraded: true, operatorSupplied: false })),
    ];
    for (const claim of claims) {
      assert.notEqual(claim, "verified");
      assert.ok(claim.length > "verified".length, claim);
    }
    assert.equal(new Set(claims).size, 3, "two states rendered identically");
  });

  test("a clean pin carries no caveat at all", () => {
    // Nothing to disclose is not the same as disclosing something. An
 // operator who did the right thing should not have to read a warning.
    assert.equal(verificationKeyNote(key({ source: "pinned-env" })), undefined);
    assert.equal(verificationKeyLine(key({ source: "pinned-env" })), "verification key: pinned dev-ed25519:0123456789abcdef (pinned-env)");
  });
});
