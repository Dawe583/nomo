import assert from "node:assert/strict";
import test from "node:test";
import { OSC52_CLIPBOARD_MAX_BYTES } from "./clipboard.ts";
import { copyWorkspaceText } from "./workspace-runner.ts";

const failingSystemCopy = async () => {
  throw Error("system clipboard down");
};

test("system clipboard wins when it works and never writes terminal control", async () => {
  let terminalWrites = 0;
  const path = await copyWorkspaceText(
    "exact text",
    () => {
      terminalWrites += 1;
      return true;
    },
    async () => undefined,
  );
  assert.equal(path, "system");
  assert.equal(terminalWrites, 0);
});

test("OSC52 fallback sends exact text only after system clipboard failure", async () => {
  const written: string[] = [];
  const value = "selection žluť\nsecond line";
  const path = await copyWorkspaceText(
    value,
    (sequence) => {
      written.push(sequence);
      return true;
    },
    failingSystemCopy,
  );
  assert.equal(path, "terminal");
  assert.equal(written.length, 1);
  const encoded = written[0]!.slice("\x1b]52;c;".length, -"\x1b\\".length);
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), value);
});

test("terminal-unavailable fallback preserves the original clipboard error", async () => {
  await assert.rejects(
    copyWorkspaceText("text", () => false, failingSystemCopy),
    /system clipboard down/,
  );
});

test("oversize fallback fails closed without partial terminal clipboard text", async () => {
  let terminalWrites = 0;
  await assert.rejects(
    copyWorkspaceText(
      "x".repeat(OSC52_CLIPBOARD_MAX_BYTES + 1),
      () => {
        terminalWrites += 1;
        return true;
      },
      failingSystemCopy,
    ),
    /too large for the terminal clipboard fallback/,
  );
  assert.equal(terminalWrites, 0);
});
