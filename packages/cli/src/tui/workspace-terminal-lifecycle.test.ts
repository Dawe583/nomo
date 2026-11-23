import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { createWorkspaceTerminal } from "./workspace-terminal.ts";

test("workspace terminal routes bracketed paste as one payload and restores terminal modes", async () => {
  const input = new PassThrough() as unknown as NodeJS.ReadStream;
  let raw = false;
  input.isRaw = raw;
  input.isTTY = true;
  input.setRawMode = (enabled: boolean) => {
    raw = enabled;
    input.isRaw = enabled;
    return input;
  };
  const output = new PassThrough() as unknown as NodeJS.WriteStream;
  output.isTTY = true;
  output.columns = 80;
  output.rows = 24;
  let written = "";
  output.on("data", (chunk: Buffer) => { written += chunk.toString(); });
  const keys: string[] = [];
  const pastes: string[] = [];
  const terminal = createWorkspaceTerminal(input, output);
  let resized = 0;

  terminal.start(
    (value) => keys.push(value ?? ""),
    (value) => pastes.push(value),
    () => { resized++; },
  );
  input.write(Buffer.from("a\x1b[200~first\n"));
  input.write(Buffer.from("second\x1b[201~b"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(keys, ["a", "b"]);
  assert.deepEqual(pastes, ["first\nsecond"]);
  output.emit("resize");
  assert.equal(resized, 1);
  terminal.render("frame");
  terminal.suspend();
  assert.equal(raw, false);
  terminal.resume();
  assert.equal(raw, true);
  terminal.destroy();
  terminal.destroy();

  assert.equal(raw, false);
  const restoredModes = written.split("\x1b[?1049l").length - 1;
  assert.equal(restoredModes, 2, "destroy restores modes once after suspend and resume");
  assert.match(written, /\x1b\[\?1049h/);
  assert.match(written, /\x1b\[\?2004h/);
  assert.match(written, /\x1b\[\?1049l/);
  assert.match(written, /\x1b\[\?2004l/);
  assert.match(written, /frame/);
});
