import test from "node:test";
import assert from "node:assert/strict";
import { renderToolCard } from "./tool-card.ts";
import { stripAnsi, visibleLength } from "./layout.ts";

test("tool cards name real lifecycle states and keep untrusted content inert", () => {
  const requested = renderToolCard(
    { name: "write_file", state: "requested", body: "Requested write_file." },
    48,
  );
  const complete = renderToolCard(
    { name: "read_file", state: "complete", body: "Read 2 lines." },
    48,
  );
  const error = renderToolCard(
    {
      name: "write_file",
      state: "error",
      body: "refused\nline 2\nline 3\nline 4\nline 5",
    },
    48,
    true,
  );

  assert.match(requested.join("\n"), /REQUESTED/);
  assert.match(complete.join("\n"), /COMPLETE/);
  const unknown = renderToolCard(
    { name: "custom_tool", state: "unknown", body: "unrecognized lifecycle" },
    48,
  );
  assert.match(unknown.join("\n"), /UNKNOWN/);
  assert.match(error.join("\n"), /ERROR/);
  assert.match(error.join("\n"), /line 5/);
  assert.ok(!error.join("\n").includes("more lines"));

  const hostile = renderToolCard(
    { name: "x\x1b[2J", state: "complete", body: "ok\u202e" },
    24,
  );
  assert.ok(hostile.every((line) => !line.includes("\x1b")));
  assert.ok(hostile.every((line) => visibleLength(line) <= 24));
  assert.ok(!stripAnsi(hostile.join("\n")).includes("\u202e"));
});

test("tool cards wrap at spaces before splitting a word", () => {
  const rows = renderToolCard(
    {
      name: "read_fixture",
      state: "error",
      body: "Fixture path is unavailable. No data was modified.",
    },
    36,
  );
  assert.equal(
    rows.slice(1).map((row) => row.trim()).join(" "),
    "Fixture path is unavailable. No data was modified.",
  );
  assert.ok(rows.every((row) => visibleLength(row) <= 36));
});

test("compact tool cards collapse only successful long output", () => {
  const body = Array.from({ length: 8 }, (_, index) => `row ${index + 1}`).join(
    "\n",
  );
  const collapsed = renderToolCard(
    { name: "read_file", state: "complete", body },
    40,
    true,
  );
  assert.match(collapsed.join("\n"), /4 more lines \/expand/);
  assert.ok(!collapsed.some((line) => line.includes("row 8")));
});
