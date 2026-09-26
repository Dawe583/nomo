import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { devKeyProvider } from "../../ledger/src/sign.ts";
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

test("init derives and pins a verification key on request, once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "void-init-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "wb");
  const keys = join(dir, "keys");
  const signer = await devKeyProvider({ dir: keys, env: {} });
  const trustFile = join(root, ".void", "trust", "verify-ed25519.spki");

  const c = collect();
  const code = await runInitCommand(["--data-dir", dir, "--pin-verify-key"], c.io, {
    env: { HOME: root },
  });
  const spki = await signer.publicKey(await signer.currentKeyId());
  assert.ok(spki !== null);
  const spkiBase64 = Buffer.from(spki).toString("base64");
  const keyId = await signer.currentKeyId();
  assert.equal(code, 0);
  assert.ok(
    c.out.some(
      (line) => line === `pinned verification key ${keyId} at ${trustFile}`,
    ),
  );
  // The pin prints the bytes it anchored, and says plainly that a pin derived
  // from the key file anchors whatever that file holds right now.
  assert.ok(c.out.some((line) => line === `  spki: ${spkiBase64}`));
  assert.ok(c.out.some((line) => /anchors whatever the local key file holds/.test(line)));
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
  assert.notEqual(dirname(trustFile), keys);

  const again = collect();
  assert.equal(
    await runInitCommand(["--data-dir", dir, "--pin-verify-key"], again.io, { env: { HOME: root } }),
    0,
  );
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
