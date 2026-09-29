import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_BYTE_LIMIT,
  BUDGET_VISIBLE_AT,
  MESSAGE_BYTE_LIMIT,
  MESSAGE_CHAR_LIMIT,
  attachmentBytes,
  clearDraftFiles,
  loadDraftFiles,
  messageSize,
  saveDraftFiles,
} from "./chat-composer.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
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

test("an ordinary message is far from the bound the send guard enforces", () => {
  const text = "Popiš prosím migrační plán.";
  const size = messageSize(text);
  assert.equal(size.chars, text.length);
  assert.ok(size.bytes > size.chars, "the bound is measured in encoded bytes too");
  assert.ok(size.bytes < MESSAGE_BYTE_LIMIT);
  assert.equal(size.over, false);
  assert.ok(
    size.pressure < BUDGET_VISIBLE_AT,
    "a short message must not raise the budget line",
  );
});

test("the visible budget and the blocking guard read the same numbers", () => {
  const overChars = messageSize("a".repeat(MESSAGE_CHAR_LIMIT + 1));
  assert.equal(overChars.over, true);
  assert.equal(overChars.chars, MESSAGE_CHAR_LIMIT + 1);
  assert.ok(overChars.pressure > 1);

  // Multi-byte text trips the byte bound before the character bound: 2 bytes
  // per character against a limit eight times the character limit.
  const overBytes = messageSize("ě".repeat(MESSAGE_BYTE_LIMIT / 2));
  assert.equal(overBytes.chars < MESSAGE_CHAR_LIMIT, true);
  assert.equal(overBytes.over, true);

  const pressure = messageSize("a".repeat(Math.ceil(MESSAGE_CHAR_LIMIT * BUDGET_VISIBLE_AT)));
  assert.equal(pressure.over, false);
  assert.ok(pressure.pressure >= BUDGET_VISIBLE_AT);
});

test("attachment bytes are summed, not counted, against the 24 KB budget", () => {
  assert.equal(attachmentBytes([]), 0);
  assert.equal(attachmentBytes([{ bytes: 1024 }, { bytes: 2048 }]), 3072);
  // The boundary has to be the limit itself: a sum of exactly the limit fits,
  // one byte more does not. A literal here would pass on the wrong edit and
  // fail on the right one, so the bound is exercised through the same
  // arithmetic the two attachment paths in chat.tsx use.
  assert.equal(attachmentBytes([{ bytes: ATTACHMENT_BYTE_LIMIT }]) > ATTACHMENT_BYTE_LIMIT, false);
  assert.equal(attachmentBytes([{ bytes: ATTACHMENT_BYTE_LIMIT + 1 }]) > ATTACHMENT_BYTE_LIMIT, true);
  // Two files share one budget, not one each.
  assert.equal(
    attachmentBytes([{ bytes: ATTACHMENT_BYTE_LIMIT / 2 }, { bytes: ATTACHMENT_BYTE_LIMIT / 2 }]) <= ATTACHMENT_BYTE_LIMIT,
    true,
  );
  assert.equal(
    attachmentBytes([{ bytes: ATTACHMENT_BYTE_LIMIT / 2 + 1 }, { bytes: ATTACHMENT_BYTE_LIMIT / 2 }]) > ATTACHMENT_BYTE_LIMIT,
    true,
  );
});

test("attachments survive the same route change the draft text survives", () => {
  const store = storage();
  const files = [
    { name: "plan.md", content: "# Plan\n", bytes: 8 },
    { name: "notes.csv", content: "a,b\n", bytes: 4 },
  ];
  saveDraftFiles(store, key, files);
  assert.equal(store.values.get("void-files:workspace:session") !== undefined, true);
  assert.deepEqual(loadDraftFiles(store, key), files);
  // A different conversation must not inherit another conversation's files.
  assert.deepEqual(loadDraftFiles(store, "void-draft:workspace:other"), []);
});

test("an accepted send clears the files even if the route changes first", () => {
  const store = storage();
  const files = [{ name: "plan.md", content: "# Plan\n", bytes: 8 }];
  saveDraftFiles(store, "void-draft:workspace:new", files);
  assert.equal(attachmentBytes(loadDraftFiles(store, "void-draft:workspace:new")), 8);
  // The imperative clear is what send() runs inside the accepted block; the
  // mirroring effect never gets the chance to run against the new key.
  clearDraftFiles(store, "void-draft:workspace:new");
  assert.equal(store.getItem("void-files:workspace:new"), null);
  assert.deepEqual(loadDraftFiles(store, "void-draft:workspace:new"), []);
  // And a different conversation is untouched by it.
  saveDraftFiles(store, "void-draft:workspace:other", files);
  clearDraftFiles(store, "void-draft:workspace:new");
  assert.equal(attachmentBytes(loadDraftFiles(store, "void-draft:workspace:other")), 8);
});

test("a sent or cleared draft does not leave its files behind", () => {
  const store = storage();
  saveDraftFiles(store, key, [{ name: "plan.md", content: "# Plan\n", bytes: 8 }]);
  saveDraftFiles(store, key, []);
  assert.equal(store.getItem("void-files:workspace:session"), null);
  assert.deepEqual(loadDraftFiles(store, key), []);
});

test("a corrupt attachment record loses the file, not the conversation", () => {
  const store = storage();
  store.setItem("void-files:workspace:session", "{not json");
  assert.deepEqual(loadDraftFiles(store, key), []);
  store.setItem("void-files:workspace:session", JSON.stringify([{ name: 5 }]));
  assert.deepEqual(loadDraftFiles(store, key), []);
});
