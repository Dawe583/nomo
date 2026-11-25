import test from "node:test";
import assert from "node:assert/strict";
import { nodeGaps, proposals, settingGaps } from "./nomo-graph-propose.mjs";

const graph = (nodes) => ({ activeGraph: "fixture", nodes });

test("a node blocked on measurement becomes a proposal, a node blocked on a person does not", () => {
  const found = nodeGaps(
    graph([
      { id: "e3", status: "blocked", stopCondition: "Needs a measured effect from real data." },
      { id: "rel", status: "blocked", stopCondition: "Release requires explicit user approval." },
      { id: "done", status: "done", stopCondition: "Needs data." },
    ]),
  );
  assert.deepEqual(found.map((node) => node.id), ["unblock-e3"]);
});

test("a proposal is never a duplicate and never rewrites an existing node", () => {
  const found = nodeGaps(
    graph([
      { id: "e3", status: "blocked", stopCondition: "Needs a measured effect." },
      { id: "unblock-e3", status: "pending" },
    ]),
  );
  assert.deepEqual(found, []);
});

test("documented setting gaps become restore nodes", () => {
  const source = 'const KNOWN_GAPS = new Map([\n  ["autoCompactMessages", "plan B1"],\n]);';
  assert.deepEqual(
    settingGaps(source).map((node) => node.id),
    ["restore-setting-autocompactmessages"],
  );
});

test("proposals merge both sources and stay pending", () => {
  const found = proposals(
    graph([{ id: "e3", status: "blocked", stopCondition: "Needs a measured effect." }]),
    '["maxToolResultCharacters", "plan B1"]',
  );
  assert.deepEqual(found.map((node) => node.id).sort(), [
    "restore-setting-maxtoolresultcharacters",
    "unblock-e3",
  ]);
  assert.ok(found.every((node) => node.status === "pending"));
});
