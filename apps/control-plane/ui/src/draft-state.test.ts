import test from "node:test";
import assert from "node:assert/strict";
import { loadDraft, saveDraft, submitDraft } from "./draft-state.ts";
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
const key = "void-draft:workspace:session";

test("queuing and editing preserves exact user text across a reload", () => {
  const store = storage();
  const text = "  Queued draft: user-authored\nSecond line  ";
  saveDraft(store, key, text, true);
  assert.deepEqual(loadDraft(store, key), { text, queued: true });
  const edited = text + "\nEdited while the run is active";
  saveDraft(store, key, edited, true);
  assert.deepEqual(loadDraft(store, key), { text: edited, queued: true });
  assert.equal(store.getItem("void-queued:workspace:session"), edited);
  assert.deepEqual(loadDraft(store, "void-draft:workspace:other"), {
    text: "",
    queued: false,
  });
});

test("existing queued content is recoverable when the ordinary draft is absent", () => {
  const store = storage();
  store.setItem("void-queued:workspace:session", "Preserved text");
  assert.deepEqual(loadDraft(store, key), {
    text: "Preserved text",
    queued: true,
  });
  store.setItem(key, "User edited the saved draft");
  assert.equal(loadDraft(store, key).text, "User edited the saved draft");
});

test("provider failure preserves both queued marker and draft without a retry", async () => {
  const store = storage();
  saveDraft(store, key, "Do not lose this", true);
  let calls = 0;
  await assert.rejects(
    submitDraft(store, key, async () => {
      calls++;
      throw new Error("Provider unavailable");
    }),
    /Provider unavailable/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(loadDraft(store, key), {
    text: "Do not lose this",
    queued: true,
  });
});

test("only a successful explicit submission clears the draft and queued marker", async () => {
  const store = storage();
  saveDraft(store, key, "Explicit submission", true);
  let calls = 0;
  assert.deepEqual(loadDraft(store, key), {
    text: "Explicit submission",
    queued: true,
  });
  assert.equal(calls, 0);
  assert.equal(
    await submitDraft(store, key, async () => {
      calls++;
      return "accepted";
    }),
    "accepted",
  );
  assert.equal(calls, 1);
  assert.deepEqual(loadDraft(store, key), { text: "", queued: false });
});
