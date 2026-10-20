import test from "node:test";
import assert from "node:assert/strict";

import {
  healthIcon,
  healthSummary,
  healthTone,
  healthWord,
  orderChecks,
  renderHealth,
  type Check,
} from "./health.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import { motionContext } from "./motion.ts";

const checks: Check[] = [
  { name: "healthy", area: "database", state: "ok", detail: "ready" },
  { name: "uncertain", area: "provider", state: "unknown", detail: "not read" },
  { name: "warning", area: "database", state: "warn", detail: "slow" },
  { name: "failure", area: "ledger", state: "fail", detail: "chain broken" },
  { name: "not applicable", area: "host", state: "skipped", detail: "unsupported" },
];

test("health states have distinct, readable words and icons", () => {
  const states = ["ok", "warn", "fail", "unknown", "skipped"] as const;
  const labels = states.map((state) => state);
  assert.deepEqual(states.map((state) => healthWord(state)), labels);
  assert.deepEqual(states.map((state) => healthTone(state)), [
    "success",
    "warning",
    "error",
    "muted",
    "default",
  ]);
  assert.equal(new Set(states.map((state) => healthIcon(state))).size, states.length);
});

test("health checks order by severity, then area and name", () => {
  assert.deepEqual(
    orderChecks(checks).map(({ name }) => name),
    ["failure", "uncertain", "warning", "not applicable", "healthy"],
  );
  const ties: Check[] = [
    { name: "same", area: "runtime", state: "warn", detail: "first" },
    { name: "same", area: "runtime", state: "warn", detail: "second" },
  ];
  assert.deepEqual(orderChecks(ties), ties);
});

test(
  "equal severity checks sort by area and name without reordering duplicates",
  () => {
    const tied: Check[] = [
      { name: "zulu", area: "zeta", state: "warn", detail: "first" },
      { name: "zulu", area: "alpha", state: "warn", detail: "second" },
      { name: "alpha", area: "zeta", state: "warn", detail: "third" },
      { name: "alpha", area: "alpha", state: "warn", detail: "fourth" },
    ];
    assert.deepEqual(
      orderChecks(tied).map(({ area, name }) => `${area}:${name}`),
      ["alpha:alpha", "alpha:zulu", "zeta:alpha", "zeta:zulu"],
    );
    const duplicates = [tied[0]!, { ...tied[0]!, detail: "duplicate" }];
    assert.deepEqual(orderChecks(duplicates), duplicates);
  },
);

test("health summary reports the worst state and truthful totals", () => {
  const one = (state: Check["state"], detail = "detail"): Check => ({
    name: state,
    area: "runtime",
    state,
    detail,
  });
  assert.equal(healthSummary([]), "No health checks ran.");
  assert.match(healthSummary(checks), /^Failing: failure -- chain broken/);
  assert.equal(
    healthSummary([one("unknown"), one("ok")]),
    "Unknown: unknown -- detail",
  );
  assert.equal(
    healthSummary([one("warn"), one("ok")]),
    "Warning: warn -- detail",
  );
  assert.equal(
    healthSummary([one("skipped")]),
    "1 check skipped; health unverified.",
  );
  assert.equal(
    healthSummary([one("skipped"), one("skipped")]),
    "All 2 checks skipped; health unverified.",
  );
  assert.equal(
    healthSummary([one("ok")]),
    "Healthy: 1 check passes.",
  );
  assert.equal(
    healthSummary([one("ok"), one("ok")]),
    "Healthy: all 2 checks pass.",
  );
  assert.equal(
    healthSummary([one("ok"), one("skipped")]),
    "Healthy: 1 of 2 checks pass, 1 skipped.",
  );
});

test("health render fits each terminal width and respects the height cap", () => {
  for (const width of [1, 2, 3, 4, 8, 24, 40, 80]) {
    for (const height of [1, 2, 5, 20]) {
      const rows = renderHealth(checks, width, { height });
      assert.ok(rows.length <= height, `${rows.length} rows at height ${height}`);
      assert.ok(rows.length > 0, "the health view stays visible");
      for (const row of rows)
        assert.ok(
          visibleLength(row) <= width,
          `${visibleLength(row)} cells at width ${width}: ${JSON.stringify(row)}`,
        );
    }
  }
});

test("health render names every state without relying on color", () => {
  const rows = renderHealth(checks, 100, {
    paint: (text) => text,
  }).join("\n");
  for (const label of ["ok", "warn", "fail", "unknown", "skipped"])
    assert.match(rows, new RegExp(`\\b${label}\\b`));
});

test("health render omits blank detail and remedy separators", () => {
  const rows = renderHealth(
    [{ name: "ledger", area: "data", state: "unknown", detail: "  ", remedy: "  " }],
    60,
  ).join("\n");
  assert.match(rows, /unknown/);
  const field = rows.split("\n").find((row) => row.startsWith("ledger:"));
  assert.ok(field, "the check still renders");
  assert.doesNotMatch(field, / -- |\(fix:/);
});

test("health render groups areas by their worst check and keeps each order", () => {
  const rows = renderHealth(checks, 80).join("\n");
  const sections = ["LEDGER", "PROVIDER", "DATABASE", "HOST"].map((name) =>
    rows.indexOf(name),
  );
  assert.ok(sections.every((index) => index >= 0));
  assert.ok(
    sections.every(
      (index, position) => position === 0 || index > sections[position - 1]!,
    ),
  );
  assert.ok(rows.indexOf("warning") < rows.indexOf("healthy"));
});

test("health render keeps a row for non-positive dimensions", () => {
  assert.deepEqual(renderHealth(checks, 0), [""]);
  assert.deepEqual(renderHealth(checks, -1), [""]);
  for (const height of [0, -1])
    assert.equal(renderHealth(checks, 40, { height }).length, 1);
});

test("health render is stable across animated motion frames", () => {
  const first = renderHealth(checks, 80, {
    motion: motionContext(0, true, false),
  });
  const later = renderHealth(checks, 80, {
    motion: motionContext(20, true, false),
  });
  assert.deepEqual(later, first);
});

test("health render sanitizes untrusted labels and details before painting", () => {
  const rows = renderHealth(
    [
      {
        name: "ledger\u001b[2J\u001b]0;spoof\u0007",
        area: "data\nsource",
        state: "fail",
        detail: "broken 界\u001b[31m",
        remedy: "verify\u0007 chain",
      },
    ],
    36,
    {
      paint: (text) => `\u001b[31m${text}\u001b[0m`,
    },
  );
  const rawRows = rows.map((row) => row.replace(/\u001b\[[0-9;]*m/g, ""));
  assert.ok(
    rawRows.every((row) => !/[\u0000-\u001f\u007f-\u009f]/.test(row)),
  );
  assert.ok(rawRows.every((row) => visibleLength(row) <= 36));
  const plainRows = rows.map(stripAnsi);
  const plain = plainRows.join("\n");
  assert.match(plain, /ledger/);
  assert.match(plain, /br\.?\s*oken/);
  assert.match(plain, /spoof/);
  assert.doesNotMatch(plain, /EVIL/);
  assert.ok(rows.every((row) => visibleLength(row) <= 36));
});
