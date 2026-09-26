import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider } from "../../../packages/ledger/src/sign.ts";
import { jsonlStore } from "../../../packages/ledger/src/store.ts";
import type { JsonlEntry } from "../../../packages/ledger/src/store.ts";
import { readLedgerEntries } from "../../../packages/ledger/src/verify.ts";
import { pinVerificationKey } from "../../../packages/ledger/src/verify-key.ts";
import { LocalStorage } from "../../../packages/workbench/src/storage.ts";
import { createWorkspace } from "../../../packages/workbench/src/workspace.ts";
import { listenControlPlane } from "./server.ts";

const workspace = "default";

const seed = async (root: string, dir: string, tools: readonly string[]) => {
  const key = await devKeyProvider({ dir: join(root, dir, "keys"), env: {} });
  const store = jsonlStore(key, { dir: join(root, dir) });
  for (const tool of tools)
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

const spkiOf = async (key: Awaited<ReturnType<typeof devKeyProvider>>) => {
  const spki = await key.publicKey(await key.currentKeyId());
  assert.ok(spki !== null);
  return spki;
};

const serve = async (
  ledgerPath: string,
  env: Readonly<NodeJS.ProcessEnv>,
  run: (origin: string) => Promise<void>,
) => {
  const dataDir = await mkdtemp(join(tmpdir(), "void-verify-key-workbench-"));
  const handle = await listenControlPlane({
    ledgerPath,
    webRoot: join(import.meta.dirname, "../web"),
    env: { VOID_DATA_DIR: dataDir, ...env },
  });
  try {
    await run(`http://127.0.0.1:${handle.port}`);
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
};

type VerifyBody = {
  readonly ok: boolean;
  readonly verified: boolean;
  readonly signed: boolean;
  readonly checked?: number;
  readonly reason?: string;
  readonly substitutionDetected?: boolean;
  readonly verificationKey?: {
    readonly keyId: string | null;
    readonly source: string;
    readonly authenticated: boolean;
    readonly substitutionDetected: boolean;
    readonly degraded: boolean;
    readonly operatorSupplied?: boolean;
    readonly note?: string;
  } | null;
};

const verify = async (origin: string, query = ""): Promise<VerifyBody> =>
  (await (await fetch(`${origin}/api/ledger/verify${query}`)).json()) as VerifyBody;

/**
 * Seed a workbench snapshot holding one session and its signed evidence, so
 * the server's own `Workbench` reconstructs it on construction. The state is
 * written through the real `LocalStorage`, so it decrypts exactly the way a
 * live one would rather than through a test-only back door.
 */
const seedWorkbench = async (dataDir: string, entries: readonly JsonlEntry[]) => {
  new LocalStorage(dataDir).save({
    preferences: {},
    requests: {},
    approvalHistory: [],
    config: undefined,
    profiles: {},
    catalog: [],
    connectors: [],
    documents: { managed: createWorkspace() },
    evidence: { managed: entries },
    sessions: [
      {
        view: {
          id: "session-1",
          workspace: "managed",
          model: "fixture",
          status: "idle" as const,
          events: [],
        },
        messages: [],
      },
    ],
    projects: [],
  });
};

/** Every path under a directory tree, for proving a read created nothing. */
const treeOf = async (dir: string, prefix = ""): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      found.push(...(await treeOf(join(dir, entry.name), relative)));
    else found.push(relative);
  }
  return found.sort();
};

/**
 * Any name that would mean signing capability exists on disk. A read path
 * that mints a key is a read path that created the ability to forge the very
 * history it just reported on, so this is asserted rather than assumed.
 */
const keyMaterial = (paths: readonly string[]): string[] =>
  paths.filter((path) => /\.pkcs8$/.test(path) || /(^|\/)keys\//.test(path));

describe("control plane verification key", () => {
  test("a private key file in the operator's home is not read as a verification key", async (t) => {
    // The defect: resolving verification from the signing key file lets anyone
    // who replaces that file redefine what "valid" means. The server reports
    // integrity only, and says that is what it did.
    const root = await mkdtemp(join(tmpdir(), "void-verify-key-home-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await seed(root, "ledger", ["fixture.one", "fixture.two"]);
    await mkdir(join(root, ".void", "keys"), { recursive: true, mode: 0o700 });
    await copyFile(
      join(root, "ledger", "keys", "dev-ed25519.pkcs8"),
      join(root, ".void", "keys", "dev-ed25519.pkcs8"),
    );

    await serve(join(root, "ledger", `${workspace}.jsonl`), { HOME: root }, async (origin) => {
      const body = await verify(origin);
      assert.equal(body.ok, true);
      assert.equal(body.signed, false, "a private key file must not authenticate the feed");
      assert.equal(body.verified, false);
      assert.equal(body.verificationKey?.source, "none");
      assert.equal(body.verificationKey?.keyId, null);
    });
  });

  test("a pinned public key rejects a chain re-signed with a substituted key", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "void-verify-key-attack-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const honest = await seed(root, "honest", ["fixture.one"]);
    const honestId = await honest.currentKeyId();
    const trustFile = join(root, "trust", "verify-ed25519.spki");
    await pinVerificationKey(await spkiOf(honest), { file: trustFile, anchoredFrom: "operator-spki" });

    // The attacker replaces the signing key file and re-signs a rewritten
    // ledger with it. Every hash link still checks out.
    const attacker = await seed(root, "attacker", ["fixture.one", "s3.object.put"]);
    const forged = join(root, "ledger", `${workspace}.jsonl`);
    await mkdir(join(root, "ledger"), { recursive: true, mode: 0o700 });
    await copyFile(join(root, "attacker", `${workspace}.jsonl`), forged);
    const entries = await readLedgerEntries(forged);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.key_id, await attacker.currentKeyId());
    assert.notEqual(entries[0]!.key_id, honestId);

    await serve(forged, { HOME: root, VOID_VERIFY_KEY_FILE: trustFile }, async (origin) => {
      // The API reports the refusal without the verifier's internal reason;
      // the reason itself is asserted where the verifier is called directly.
      const body = await verify(origin);
      assert.equal(body.ok, false);
      assert.equal(body.verified, false);
      assert.equal(body.signed, false);
    });
  });
  test("a configured signing key is honoured and reported as degraded", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "void-verify-key-degraded-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const key = await seed(root, "ledger", ["fixture.one"]);
    const keyId = await key.currentKeyId();
    const material = (await readFile(join(root, "ledger", "keys", "dev-ed25519.pkcs8"))).toString(
      "base64",
    );

    await serve(
      join(root, "ledger", `${workspace}.jsonl`),
      { HOME: root, VOID_SIGNING_KEY: material },
      async (origin) => {
        const body = await verify(origin);
        assert.equal(body.signed, true);
        assert.equal(body.verificationKey?.keyId, keyId);
        assert.equal(body.verificationKey?.source, "signing-key-env");
        assert.equal(body.verificationKey?.degraded, true);
        assert.match(body.verificationKey?.note ?? "", /cannot be detected/);
      },
    );
  });

  // F12: this is the primary workbench-backed API path, and until now nothing
  // reached it. It is the branch that hardcodes `signed: true`, so the claim
  // that survived every earlier fix is the one this proves.
  test("the workbench-backed path reports a trust file as authenticated without claiming substitution is detected", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "void-verify-key-workbench-path-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    await mkdir(join(home, ".void", "trust"), { recursive: true, mode: 0o700 });
    const key = await devKeyProvider({ dir: join(root, "signer", "keys"), env: {} });
    const store = jsonlStore(key, { dir: join(root, "signer") });
    await store.append({
      workspace: "managed",
      at: "2026-09-26T00:00:00.000Z",
      tool: "fixture.one",
      klass: "r0",
      decision: "allow",
      argsDigest: "a".repeat(64),
    });
    const keyId = await key.currentKeyId();
    // The default trust file, at the default path inside `~/.void/`. This is
    // the configuration the audit substituted against.
    await pinVerificationKey(await spkiOf(key), {
      file: join(home, ".void", "trust", "verify-ed25519.spki"),
      anchoredFrom: "signing-key-file",
    });

    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    // The workbench holds a managed session whose evidence is the chain above.
    // It verifies through the same `~/.void/trust/` file, because that is the
    // resolution every workbench read uses.
    const entries = (await readLedgerEntries(join(root, "signer", "managed.jsonl"))) as JsonlEntry[];
    assert.equal(entries.length, 1);
    await seedWorkbench(dataDir, entries);

    const handle = await listenControlPlane({
      webRoot: join(import.meta.dirname, "../web"),
      env: { VOID_DATA_DIR: dataDir, HOME: home },
    });
    try {
      const origin = `http://127.0.0.1:${handle.port}`;
      const body = await verify(origin, "?workspace=managed");
      // The chain really was signature-checked, so `signed` is earned.
      assert.equal(body.signed, true);
      assert.equal(body.verified, true);
      assert.equal(body.checked, 1);
      // And the response must not let a client read that as tamper-proofing.
      // The key came from a file the agent can also replace, so substitution is
      // not detected here and the response says so in a field of its own.
      assert.equal(body.verificationKey?.source, "trust-file");
      assert.equal(body.verificationKey?.authenticated, true);
      assert.equal(body.verificationKey?.operatorSupplied, false);
      assert.equal(body.verificationKey?.substitutionDetected, false);
      assert.equal(body.substitutionDetected, false);
      assert.match(body.verificationKey?.note ?? "", /shares ~\/\.void\//);
      assert.equal(keyId, entries[0]!.key_id);
    } finally {
      await handle.close();
    }
  });

  // F12: the second gap. The audit had to prove this by directory listing, so
  // it had no regression guard. Asserting the response looks right is not the
  // claim; asserting no key material appeared is.
  test("a read-only GET mints no key material, on either API path", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "void-verify-key-no-mint-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    // A signed ledger on disk and a workbench holding the same entries, and
    // no key configured anywhere. A verifier that wants something to verify
    // with here has exactly one way to get it: mint it.
    const key = await devKeyProvider({ dir: join(root, "signer", "keys"), env: {} });
    const store = jsonlStore(key, { dir: join(root, "signer") });
    await store.append({
      workspace: "managed",
      at: "2026-09-26T00:00:00.000Z",
      tool: "fixture.one",
      klass: "r0",
      decision: "allow",
      argsDigest: "a".repeat(64),
    });
    const ledgerPath = join(root, "signer", "managed.jsonl");
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await seedWorkbench(
      dataDir,
      (await readLedgerEntries(ledgerPath)) as JsonlEntry[],
    );

    const handle = await listenControlPlane({
      ledgerPath,
      webRoot: join(import.meta.dirname, "../web"),
      env: { VOID_DATA_DIR: dataDir, HOME: home },
    });
    try {
      const origin = `http://127.0.0.1:${handle.port}`;
      // The construction-time baseline: `workspace.key` is the workbench
      // encryption key and legitimately exists before any request.
      const before = await treeOf(dataDir);
      assert.deepEqual(keyMaterial(before), [], "the fixture must start with no signing key");

      for (const path of [
        "/api/feed?workspace=managed",
        "/api/ledger/verify?workspace=managed",
        "/api/ledger/export?workspace=managed",
      ]) {
        const response = await fetch(`${origin}${path}`);
        assert.equal(response.status, 200, path);
        await response.json();
      }

      // The claim under test: reading a ledger never grants the ability to
      // sign one. Asserted on the whole tree, recursively, not on one file.
      const after = await treeOf(dataDir);
      assert.deepEqual(
        keyMaterial(after),
        [],
        "a read-only GET created signing capability on disk",
      );
      assert.deepEqual(after, before, "a read-only GET wrote to the data directory");
      // And with nothing to verify with, the response says so rather than
      // reporting the absence of a key as an absence of degradation.
      const body = await verify(origin, "?workspace=managed");
      assert.equal(body.signed, false);
      assert.equal(body.verificationKey?.source, "none");
      assert.equal(body.verificationKey?.authenticated, false);
      assert.match(body.verificationKey?.note ?? "", /no signature was checked/);
    } finally {
      await handle.close();
    }
  });
});
