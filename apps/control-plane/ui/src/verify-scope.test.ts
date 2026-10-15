import test from "node:test";
import assert from "node:assert/strict";

import {
  cacheMatchesHead,
  readCachedVerify,
  verifyScope,
  writeCachedVerify,
  type CachedVerify,
} from "./verify-scope.ts";

function memoryStore(): Storage {
  const cells = new Map<string, string>();
  return {
    getItem: (key: string) => cells.get(key) ?? null,
    setItem: (key: string, value: string) => {
      cells.set(key, value);
    },
    removeItem: (key: string) => {
      cells.delete(key);
    },
    clear: () => cells.clear(),
    key: (index: number) => [...cells.keys()][index] ?? null,
    get length() {
      return cells.size;
    },
  };
}

test("scope reads the server fields and shortens the head", () => {
  const scope = verifyScope({
    checked: 41,
    head: "sha256:abcdef0123456789abcdef",
    keyId: "ed25519:01ab",
    verified: true,
  });
  assert.equal(scope?.checked, 41);
  assert.equal(scope?.head, "sha256:abcdef0123456789abcdef");
  assert.equal(scope?.headShort, "sha256:abcdef0123456…");
  assert.equal(scope?.keyId, "ed25519:01ab");
  assert.equal(scope?.verified, true);
});

test("scope stays honest when the server omits fields", () => {
  const scope = verifyScope({ ok: false, checked: 0 });
  assert.equal(scope?.checked, 0);
  assert.equal(scope?.head, "");
  assert.equal(scope?.headShort, "");
  assert.equal(scope?.keyId, undefined);
  assert.equal(scope?.verified, false);
  assert.equal(verifyScope(undefined), undefined);
});

test("proof state distinguishes complete, partial, failed and unavailable verification", () => {
  assert.equal(
    verifyScope({ verified: true, signed: true, integrity: true })?.proof,
    "verified",
  );
  assert.equal(
    verifyScope({ verified: true, head: "sha256:aa" })?.proof,
    "partial",
  );
  assert.equal(
    verifyScope({ verified: false, signed: true, integrity: false })?.proof,
    "failed",
  );
  assert.equal(verifyScope({ checked: 0 })?.proof, "unknown");
  assert.equal(verifyScope(undefined)?.proof, undefined);
});

test("cache round trips per query and matches by head", () => {
  const store = memoryStore();
  assert.equal(readCachedVerify(store, "workspace=a"), undefined);
  const entry: CachedVerify = {
    query: "workspace=a",
    head: "sha256:aa",
    checked: 10,
    at: "2026-09-22T00:00:00.000Z",
  };
  writeCachedVerify(store, entry);
  assert.deepEqual(readCachedVerify(store, "workspace=a"), entry);
  assert.equal(readCachedVerify(store, "workspace=b"), undefined);
  assert.equal(
    cacheMatchesHead(readCachedVerify(store, "workspace=a"), "sha256:aa"),
    true,
  );
  assert.equal(
    cacheMatchesHead(readCachedVerify(store, "workspace=a"), "sha256:bb"),
    false,
  );
});

test("a corrupt cache reads as empty, never throws", () => {
  const store = memoryStore();
  store.setItem("nomo-ledger-verify", "{broken");
  assert.equal(readCachedVerify(store, "workspace=a"), undefined);
});
