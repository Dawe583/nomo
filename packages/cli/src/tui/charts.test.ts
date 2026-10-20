import test from "node:test";
import assert from "node:assert/strict";

import {
  barChart,
  deltaLabel,
  gauge,
  sparkline,
  stackedBar,
} from "./charts.ts";
import { stripAnsi, visibleLength } from "./layout.ts";
import { motionContext } from "./motion.ts";

test("sparkline names missing data and centers a flat series", () => {
  const empty = sparkline({ values: [] }, 8);
  assert.equal(empty.trimEnd(), "no data");
  assert.equal(visibleLength(empty), 8);
  const invalid = sparkline(
    { values: [Number.NaN, Number.POSITIVE_INFINITY] },
    8,
  );
  assert.equal(invalid.trimEnd(), "no data");
  assert.equal(visibleLength(invalid), 8);
  assert.equal(sparkline({ values: [4, 4, 4] }, 5), "▄▄▄▄▄");
  assert.equal(sparkline({ values: [4, 4] }, 0), "");
});

test("sparkline scales values and animates only the newest cell", () => {
  const series = { values: [0, 10] };
  const still = sparkline(series, 2);
  assert.equal(still, "▁█");
  assert.equal(
    sparkline(series, 2, { motion: motionContext(1, true, false) }),
    "▁▇",
  );
  assert.equal(
    sparkline(series, 2, { motion: motionContext(1, true, true) }),
    still,
  );
  assert.equal(
    sparkline({ values: [0, 5, 10] }, 3, { min: 10, max: 0 }),
    "▁▅█",
  );
});

test("bar chart shows newest values first with explicit missing labels", () => {
  const empty = barChart({ values: [] }, 12)[0]!;
  assert.equal(empty.trimEnd(), "no data");
  assert.equal(visibleLength(empty), 12);
  const missingLabel = barChart({ values: [1, 2], labels: ["old"] }, 12);
  assert.deepEqual(
    missingLabel.map((row) => row.split(" ")[0]),
    ["#2", "old"],
  );
  const rows = barChart({ values: [1, 2], labels: ["old", "new"] }, 24);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /^new /);
  assert.match(rows[1]!, /^old /);
  assert.ok(rows.every((row) => visibleLength(row) <= 24));
});

test("stacked bar keeps the largest segments and names omitted data", () => {
  const empty = stackedBar([], 12);
  assert.equal(empty.trimEnd(), "no segments");
  assert.equal(visibleLength(empty), 12);
  assert.equal(
    stackedBar([{ label: "zero", value: 0 }], 20),
    `no data${" ".repeat(13)}\nzero`,
  );
  const result = stackedBar(
    [
      { label: "a", value: 1 },
      { label: "b", value: 1 },
      { label: "c", value: 1 },
      { label: "d", value: 1 },
      { label: "e", value: 1 },
      { label: "f", value: 1 },
      { label: "g", value: 1 },
      { label: "h", value: 1 },
      { label: "top", value: 9 },
    ],
    16,
  );
  const [bar, legend] = result.split("\n");
  assert.equal(visibleLength(bar ?? ""), 16);
  assert.equal(legend, "█ top 9  +8 more");
  assert.ok(result.split("\n").every((row) => visibleLength(row) <= 16));
});

test("bar, stacked, and gauge motion changes only decorative cells", () => {
  const series = { values: [1, 2], labels: ["old", "new"] };
  const still = barChart(series, 24);
  const live = barChart(series, 24, { motion: motionContext(1, true, false) });
  assert.notEqual(live[0], still[0]);
  assert.equal(live[1], still[1]);
  assert.match(live[0] ?? "", /▓/);

  const segments = [
    { label: "first", value: 1 },
    { label: "second", value: 1 },
  ];
  const stableStack = stackedBar(segments, 10);
  const movingStack = stackedBar(segments, 10, {
    motion: motionContext(1, true, false),
  });
  assert.equal(
    stableStack.split("\n")[0]?.replace("|", ":"),
    movingStack.split("\n")[0],
  );
  assert.equal(stableStack.split("\n")[1], movingStack.split("\n")[1]);

  assert.equal(
    gauge(5, 10, { motion: motionContext(1, true, false) }),
    "███▓░░░░ 5/10 50%",
  );
  assert.equal(
    gauge(5, 10, { motion: motionContext(1, true, true) }),
    "████░░░░ 5/10 50%",
  );
});

test("chart rows remain within tiny and wide terminal widths", () => {
  for (const width of [0, 1, 2, 3, 4, 8, 20, 80]) {
    const rows = [
      sparkline({ values: [1, 2, 3] }, width),
      ...barChart({ values: [1, 2] }, width),
      ...stackedBar(
        [
          { label: "a", value: 1 },
          { label: "b", value: 2 },
        ],
        width,
      ).split("\n"),
    ];
    assert.ok(
      rows.every((row) => visibleLength(row) <= width),
      `chart row exceeds ${width} cells`,
    );
  }
});

test("gauge reports unknown scales and clamps measured values", () => {
  assert.equal(gauge(3, 0), "3/? (max unknown)");
  assert.equal(gauge(Number.NaN, 5), "?/5 (value unknown)");
  assert.match(gauge(12, 10, { label: "context" }), /^context █{8} 12\/10 100%$/);
  assert.match(gauge(-2, 10), /^░{8} -2\/10 0%$/);
});

test("delta label names rising, falling, flat, and unknown trends", () => {
  assert.equal(deltaLabel(12, 10, { suffix: " tok" }), "+2 tok ▲ rising");
  assert.equal(deltaLabel(8, 10), "-2 ▼ falling");
  assert.equal(deltaLabel(10, 10), "±0 flat");
  assert.equal(deltaLabel(10, Number.NaN), "10 ? unknown");
});

test("chart text is sanitized and rows fit narrow terminal widths", () => {
  const hostile = "name\u001b[2J\nsecret";
  const values = [
    sparkline({ values: [1, 2, 3] }, 4),
    ...barChart({ values: [2, 10], labels: [hostile, "ok"] }, 20),
    ...stackedBar([{ label: hostile, value: 3 }], 20).split("\n"),
    gauge(2, 4, { label: hostile }),
    deltaLabel(Number.POSITIVE_INFINITY, 2),
  ];
  const plain = values.map(stripAnsi);
  assert.ok(plain.every((row) => !/[\u0000-\u001f\u007f-\u009f]/.test(row)));
  assert.ok(values.every((row) => visibleLength(row) <= 40));
  assert.ok(plain.some((row) => row.includes("name?[2J?secret")));
});
