import assert from "node:assert/strict";
import test from "node:test";
import { renderInspector, type InspectorSpec } from "./inspector.ts";
import { visibleLength } from "./layout.ts";

test("a long field name leaves short fields aligned and values readable", () => {
  const rows = renderInspector(
    {
      title: "Ledger",
      sections: [
        {
          title: "Proof",
          fields: [
            {
              label: "Signature verification status",
              value: "verified locally",
            },
            { label: "Key", value: "development" },
          ],
        },
      ],
    },
    { width: 24 },
  );
  assert.ok(rows.some((row) => row.includes("verified locally")));
  assert.ok(rows.some((row) => row.includes("development")));
  assert.ok(rows.some((row) => row.includes("Signature verification")));
  assert.ok(rows.some((row) => row.includes("status")));
  assert.ok(rows.every((row) => visibleLength(row) <= 24));
});

test("empty panels, badges and double-width glyphs stay inside tiny columns", () => {
  const spec: InspectorSpec = {
    title: "健康",
    sections: [
      { title: "Empty", fields: [] },
      {
        title: "Data",
        fields: [{ label: "Key", value: "界界", badge: "live" }],
        body: ["界界"],
      },
    ],
  };
  for (let width = 1; width <= 28; width++) {
    for (const row of renderInspector(spec, { width })) {
      assert.ok(
        visibleLength(row) <= width,
        `width ${width}, row ${JSON.stringify(row)}`,
      );
    }
  }
});

test("long action hints remain available in narrow detail views", () => {
  const hint = "Enter opens the document. Esc returns to the list.";
  const rows = renderInspector(
    { title: "Document", sections: [], hint },
    { width: 20 },
  );
  assert.equal(rows.slice(3).join("").trim(), hint);
  assert.ok(rows.every((row) => visibleLength(row) <= 20));
});
