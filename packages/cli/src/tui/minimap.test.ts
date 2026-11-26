import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMinimapEvents,
  minimapEventsFromRows,
  renderMinimap,
} from "./minimap.ts";

test("minimap renders exact height and marks the viewport in unicode and ascii", () => {
  const events = minimapEventsFromRows(
    Array.from({ length: 30 }, (_, index) => ({
      style: index % 5 === 0 ? "user" : index % 7 === 0 ? "tool" : "assistant",
      text: `row ${index}`,
    })),
  );
  const unicode = renderMinimap(events, {
    height: 10,
    viewportStart: 10,
    viewportEnd: 20,
  });
  assert.equal(unicode.length, 10);
  assert.ok(unicode.every((row) => [...row].length === 1));
  assert.ok(unicode.includes("▸"));

  const ascii = renderMinimap(events, {
    height: 10,
    viewportStart: 10,
    viewportEnd: 20,
    ascii: true,
  });
  assert.ok(ascii.includes(">"));
  assert.ok(ascii.every((row) => /^[|#*\->x!^?.]$/.test(row)));
});

test("minimap row mapping separates user, assistant, tool and error rows", () => {
  assert.deepEqual(
    minimapEventsFromRows([
      { style: "user", text: "ask" },
      { style: "assistant", text: "answer" },
      { style: "role-tool", text: "tool" },
      { style: "diff-add", text: "+patch" },
      { style: "role-error", text: "failed" },
    ]).map((event) => event.kind),
    ["user", "assistant", "tool", "tool", "error"],
  );
});

test("event minimap keeps sequence gaps and approvals explicit", () => {
  const events = buildMinimapEvents([
    { kind: "user", seq: 1, text: "one" },
    { kind: "tool", type: "approval.requested", seq: 4, text: "hold" },
  ]);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["user", "gap", "approval"],
  );
});

test("empty minimap renders a muted exact-height track", () => {
  assert.deepEqual(renderMinimap([], { height: 4, ascii: true }), [
    "|",
    "|",
    "|",
    "|",
  ]);
});
