import assert from "node:assert/strict";
import test from "node:test";
import {
  OSC52_CLIPBOARD_MAX_BYTES,
  osc52ClipboardSequence,
} from "./clipboard.ts";

test("OSC52 clipboard sequence carries exact UTF-8 text as base64", () => {
  const value = "line 1\nunicode žluť 🐈\n";
  const sequence = osc52ClipboardSequence(value);
  assert.ok(sequence?.startsWith("\x1b]52;c;"));
  assert.ok(sequence?.endsWith("\x1b\\"));
  const encoded = sequence!.slice("\x1b]52;c;".length, -"\x1b\\".length);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), value);
  assert.doesNotMatch(encoded, /[\x00-\x1f\x7f]/);
});

test("OSC52 clipboard sequence refuses empty and oversize copies", () => {
  assert.equal(osc52ClipboardSequence(""), undefined);
  assert.equal(
    osc52ClipboardSequence("x".repeat(OSC52_CLIPBOARD_MAX_BYTES + 1)),
    undefined,
  );
  assert.notEqual(
    osc52ClipboardSequence("x".repeat(OSC52_CLIPBOARD_MAX_BYTES)),
    undefined,
  );
});
