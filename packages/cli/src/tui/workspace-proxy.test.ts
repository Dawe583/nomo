import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devKeyProvider } from "../../../ledger/src/sign.ts";
import { jsonlStore } from "../../../ledger/src/store.ts";
import { savePending } from "../../../policy/src/approvals.ts";
import { ProxyWorkspace } from "./workspace-proxy.ts";

test("TUI proxy reads verify signatures, refuse tampering and queue identity-bound decisions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nomo-tui-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keys = join(root, "keys"),
    ledger = join(root, "ledger"),
    approvals = join(root, "approvals");
  const signer = await devKeyProvider({ dir: keys, env: {} });
  await jsonlStore(signer, { dir: ledger }).append({
    workspace: "fixture",
    at: new Date().toISOString(),
    tool: "fixture.write",
    klass: "r3",
    decision: "hold",
    argsDigest: "test",
  });
  const env = {
    NOMO_DATA_DIR: root,
    NOMO_LEDGER_DIR: ledger,
    NOMO_APPROVALS_DIR: approvals,
    NOMO_VERIFY_KEY: Buffer.from(
      (await signer.publicKey(await signer.currentKeyId()))!,
    ).toString("base64"),
  };
  const proxy = new ProxyWorkspace(env);
  savePending(approvals, [
    {
      holdId: "fixture-hold",
      decisionToken: "identity-token",
      status: "pending",
      expiresAt: Date.now() + 60000,
      call: {
        tool: "fixture.write",
        klass: "r3",
        workspace: "fixture",
        connector: "fixture",
        blastRadius: 1,
      },
      notify: [],
    },
  ]);
  await proxy.refresh(true);
  assert.equal(proxy.signed, true);
  assert.equal(proxy.entries.get("fixture")?.length, 1);
  proxy.decide("fixture-hold", "denied", "Testing");
  const decision = JSON.parse(
    await readFile(
      join(
        approvals,
        "decisions",
        (await readdir(join(approvals, "decisions")))[0]!,
      ),
      "utf8",
    ),
  );
  assert.equal(decision.decisionToken, "identity-token");
  assert.equal(decision.decision.kind, "denied");
  savePending(approvals, []);
  assert.throws(() => proxy.decide("fixture-hold", "approved", ""), /pending/);
  const file = join(ledger, "fixture.jsonl");
  await writeFile(
    file,
    (await readFile(file, "utf8")).replace("fixture.write", "forged.write"),
  );
  await proxy.refresh(true);
  assert.equal(proxy.entries.size, 0);
  assert.match(proxy.errors.join(" "), /Invalid proxy ledger/);
});
