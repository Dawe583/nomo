import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "./index.ts";
import { executeWorkspaceTool } from "./workspace.ts";

import type { PublicKeyLookup } from "../../ledger/src/verify.ts";

/**
 * `attest()` is a read path. It asks "show me a signed slice of this ledger",
 * and it must not hand out the power to sign in exchange for answering.
 *
 * Note what this cannot test: a workbench with no key and no pinned trust
 * already throws inside `this.ledger()`, which runs `retainedSigner` first.
 * That refusal predates the change and proves nothing about the attest body.
 *
 * The case that does is a workbench that holds evidence it cannot sign with:
 * the chain verifies against a key pinned out of band through
 * `VOID_VERIFY_KEY`, while the private key directory is not on disk. There the
 * old line called `devKeyProvider`, which creates a key when none exists — it
 * minted signing capability on the way to answering a read question, and
 * attested with a key that was not the pinned one. The invariant is simply that
 * the keys directory does not exist afterwards.
 *
 * It has to be two workbenches because the constructor snapshots `env`; the
 * pinned key must be present when the second one is built, not assigned later.
 */

/// `PublicKeyLookup` is either a fixed key or a resolver over key ids. What
/// matters here is the answer, not which form it arrived in.
async function answer(lookup: PublicKeyLookup, keyId: string): Promise<Uint8Array | null> {
  return typeof lookup === "function" ? lookup(keyId) : lookup;
}
const fetcher = async (url: unknown) =>
  String(url).endsWith("/models")
    ? Response.json({ data: [{ id: "fixture" }] })
    : Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] });

const internalsOf = (app: Workbench) =>
  app as unknown as {
    sessions: Map<string, { view: { workspace: string } }>;
    commitWorkspace(...a: unknown[]): Promise<void>;
  };

test("attest refuses to mint a key for a workbench that cannot sign", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "void-attest-read-"));

  // 1. Sign some evidence with the default dev key, so a key directory exists.
  const signer = new Workbench({ VOID_DATA_DIR: directory }, fetcher);
  await signer.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const first = await signer.start("Write", "fixture", undefined, undefined, undefined);
  await signer.settled();
  const args = { path: "note.md", content: "evidence" };
  const change = executeWorkspaceTool(signer.workspace(first.id), {
    id: "operation",
    name: "void_workspace_write",
    arguments: args,
  });
  const internals = internalsOf(signer);
  await internals.commitWorkspace(
    internals.sessions.get(first.id),
    change.state,
    "void_workspace_write",
    args,
    "execute:completed",
    change.operation,
  );
  const { workspace } = internals.sessions.get(first.id)!.view;

  // Read the public key back the way an operator would: out of the ledger.
  const verified = await signer.ledger(workspace);
  assert.ok(verified, "the fixture must sign verifiable evidence");
  assert.ok(verified.entries.length > 0, "an empty chain would attest nothing");
  const raw = await answer(verified.verification.publicKey, verified.verification.keyId);
  assert.ok(raw, "the ledger must expose the key that signed it");
  const pinned = Buffer.from(raw).toString("base64");
  await signer.shutdown();

  // 2. Take the private material away. This process can verify the chain and
  //    can never sign it — the public key is the only thing left.
  const keys = join(directory, "keys");
  await rm(keys, { recursive: true, force: true });

  // 3. A fresh workbench over the same data: same workspace, no keys on disk.
  const app = new Workbench({ VOID_DATA_DIR: directory, VOID_VERIFY_KEY: pinned }, fetcher);
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  // Shut down before the directory goes: `close()` persists, and after-hooks
  // run in registration order, so the removal cannot be registered first.
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  await app.start("Write", "fixture", undefined, undefined, undefined);
  await app.settled();
  // `start()` mints a fresh `agent-<uuid>` workspace, and a workbench only
  // verifies a ledger it has a document for. Point a session at the restored
  // workspace so the pinned key is genuinely exercised — otherwise attest
  // refuses for the wrong reason and proves nothing.
  const w2 = internalsOf(app);
  (w2.sessions as Map<string, unknown>).set("restored", { id: "restored", view: { workspace }, controller: { abort() {} } });

  await assert.rejects(() => app.attest("restored"), /verification key/i);
  await assert.rejects(access(keys), "attest must not recreate the key directory");

  // And the refusal is not a broken ledger: the pinned key still verifies it.
  const restored = await app.ledger(workspace);
  assert.ok(restored, "the pinned key must still verify the chain");
  assert.equal(restored.entries.length, verified.entries.length);
});