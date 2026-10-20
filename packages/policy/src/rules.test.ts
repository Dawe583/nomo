import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadPolicy, validatePolicyFile } from "./rules.ts";
import { decide, type PolicyCall } from "./decide.ts";

const goodYaml = readFileSync(
  new URL("../../../policy/default.yaml", import.meta.url),
  "utf8",
);

const call = (over: Partial<PolicyCall> = {}): PolicyCall => ({
  tool: "aws.s3.object.delete",
  connector: "s3",
  workspace: "prod",
  klass: "r0",
  blastRadius: 1,
  ...over,
});

describe("loadPolicy, the closed grammar", () => {
  test("the shipped default policy loads", () => {
    const loaded = loadPolicy(goodYaml);
    assert.equal(loaded.ok, true);
    if (loaded.ok) assert.equal(loaded.policy.rules.length, 5);
  });

  test("a wrong version or missing rules is a named error", () => {
    const bad = loadPolicy("version: 2\nrules: []");
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes("version")));
  });

  test("a non-JSON version value returns a validation error", () => {
    const errors = validatePolicyFile({
      version: 1n,
      rules: [{ match: {}, decision: "deny" }],
    });
    assert.ok(errors.some((error) => error.startsWith("version:")));
  });

  test("an unknown match key is a load error, never a silent no-op", () => {
    const bad = loadPolicy(`
version: 1
rules:
  - match: { blast_radus: 5 }
    decision: allow
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.ok(bad.errors.some((e) => e.includes("blast_radus")));
  });

  test("a hold without a timer, or a timer off hold, is a load error", () => {
    const noTimer = loadPolicy(`
version: 1
rules:
  - match: { class: r2 }
    decision: hold
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(noTimer.ok, false);
    const timerOffHold = loadPolicy(`
version: 1
rules:
  - match: { class: r2 }
    decision: allow
    seconds: 60
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(timerOffHold.ok, false);
  });

  test("the catch-all must exist and must be last", () => {
    const notLast = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: allow
  - match: { class: r2 }
    decision: hold
    seconds: 60
`);
    assert.equal(notLast.ok, false);
    if (!notLast.ok)
      assert.ok(notLast.errors.some((e) => e.includes("catch-all")));
  });

  test("the hold ceiling is 900 seconds, the MCP request cannot outlive every client", () => {
    const tooLong = loadPolicy(`
version: 1
rules:
  - match: { class: r2 }
    decision: hold
    seconds: 9000
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(tooLong.ok, false);
    if (!tooLong.ok) assert.ok(tooLong.errors.some((e) => e.includes("900")));
  });

  test("unknown YAML keys and invalid negative hold seconds fail loudly", () => {
    const badTop = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: allow
extra: true
`);
    assert.equal(badTop.ok, false);
    if (!badTop.ok)
      assert.ok(badTop.errors.some((e) => e.includes("unknown key extra")));

    const badRule = loadPolicy(`
version: 1
rules:
  - match: { class: r2 }
    decision: hold
    seconds: -1
    mystery: true
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(badRule.ok, false);
    if (!badRule.ok) {
      assert.ok(badRule.errors.some((e) => e.includes("unknown key mystery")));
      assert.ok(badRule.errors.some((e) => e.includes("at least 1")));
    }

    const badNan = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: hold
    seconds: .nan
`);
    assert.equal(badNan.ok, false);
    if (!badNan.ok) assert.ok(badNan.errors.some((e) => e.includes("seconds")));
  });

  test("a load error names the key but does not echo the policy text", () => {
    const sentinel = "UNIQUE_POLICY_MARKER_9f3a1c";
    const bad = loadPolicy(`
version: 1
rules:
  - match: { class: r2 }
    decision: hold
    seconds: 60
    ${sentinel}: true
  - match: {}
    decision: hold
    seconds: 60
`);
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.ok(
      bad.errors.some((e) => e.includes(sentinel)),
      "the error names the offending key",
    );
    for (const error of bad.errors)
      assert.doesNotMatch(
        error,
        /decision: hold/,
        "the error must not echo the policy source text",
      );
  });

  test("blast_radius takes exactly one of the four frozen comparators", () => {
    const unknownOp = validatePolicyFile({
      version: 1,
      rules: [
        { match: { blast_radius: { between: 5 } }, decision: "allow" },
        { match: {}, decision: "hold", seconds: 60 },
      ],
    });
    assert.ok(unknownOp.some((e) => e.includes("unknown operator between")));

    const multiple = validatePolicyFile({
      version: 1,
      rules: [
        { match: { blast_radius: { gt: 2, lte: 8 } }, decision: "allow" },
        { match: {}, decision: "hold", seconds: 60 },
      ],
    });
    assert.ok(multiple.some((e) => e.includes("exactly one of")));

    const none = validatePolicyFile({
      version: 1,
      rules: [{ match: {blast_radius: {}}, decision: "allow" }, { match: {}, decision: "hold", seconds: 60 }],
    });
    assert.ok(none.some((e) => e.includes("got none")));

    const negative = validatePolicyFile({
      version: 1,
      rules: [{ match: { blast_radius: { gt: -1 } }, decision: "allow" }, { match: {}, decision: "hold", seconds: 60 }],
    });
    assert.ok(negative.some((e) => e.includes("gt must be a nonnegative safe integer")));
  });
});

describe("decide, first match wins", () => {
  const policy = loadPolicy(goodYaml);
  if (!policy.ok) throw new Error("fixture policy must load");

  test("r0 goes through", () => {
    assert.equal(decide(policy, call()).kind, "allow");
  });

  test("r1 under the line goes through, over the line holds", () => {
    assert.equal(
      decide(policy, call({ klass: "r1", blastRadius: 99 })).kind,
      "allow",
    );
    assert.equal(
      decide(policy, call({ klass: "r1", blastRadius: 100 })).kind,
      "hold",
    );
  });

  test("a list value means any of, so r2 and r3 both hold", () => {
    assert.equal(decide(policy, call({ klass: "r2" })).kind, "hold");
    const held = decide(policy, call({ klass: "r3" }));
    assert.equal(held.kind, "hold");
    if (held.kind === "hold") {
      assert.equal(held.seconds, 120);
      assert.deepEqual([...held.notify].sort(), ["cli", "slack"]);
    }
  });

  test("a named tool denies before the class rules can hold it", () => {
    const denied = decide(
      policy,
      call({ tool: "postgres.table.drop", klass: "r2" }),
    );
    assert.equal(denied.kind, "deny");
  });

  test("an unspecified workspace never matches a workspace rule", () => {
    const fenced = loadPolicy(`
version: 1
rules:
  - match: { workspace: prod }
    decision: allow
  - match: {}
    decision: hold
    seconds: 60
`);
    if (!fenced.ok) throw new Error("fixture must load");
    assert.equal(decide(fenced, call({ workspace: undefined })).kind, "hold");
    assert.equal(decide(fenced, call({ workspace: "staging" })).kind, "hold");
    assert.equal(decide(fenced, call({ workspace: "prod" })).kind, "allow");
  });

  test("blast_radius comparators bind their own sides", () => {
    const radiusPolicy = (rule: string) => {
      const loaded = loadPolicy(`version: 1\nrules:\n${rule}\n  - match: {}\n    decision: hold\n    seconds: 60\n`);
      if (!loaded.ok) throw new Error(`fixture must load: ${loaded.errors.join("; ")}`);
      return loaded;
    };
    const lte = radiusPolicy("  - match: { blast_radius: { lte: 5 } }\n    decision: allow");
    assert.equal(decide(lte, call({ blastRadius: 5 })).kind, "allow");
    assert.equal(decide(lte, call({ blastRadius: 6 })).kind, "hold");
    const gt = radiusPolicy("  - match: { blast_radius: { gt: 5 } }\n    decision: deny");
    assert.equal(decide(gt, call({ blastRadius: 6 })).kind, "deny");
    assert.equal(decide(gt, call({ blastRadius: 5 })).kind, "hold");
    const gte = radiusPolicy("  - match: { blast_radius: { gte: 5 } }\n    decision: allow");
    assert.equal(decide(gte, call({ blastRadius: 5 })).kind, "allow");
    assert.equal(decide(gte, call({ blastRadius: 4 })).kind, "hold");
    assert.equal(
      decide(lte, call({ blastRadius: undefined })).kind,
      "hold",
      "an unmeasured radius never matches a threshold rule",
    );
  });
});

test("malformed rule shapes fail closed without throwing", () => {
  for (const rule of [
    null,
    [],
    { match: [], decision: "allow" },
    { match: { class: "r9" }, decision: "allow" },
  ]) {
    const loaded = loadPolicy(JSON.stringify({ version: 1, rules: [rule] }));
    assert.equal(loaded.ok, false);
  }
  for (const lt of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.notEqual(
      validatePolicyFile({
        version: 1,
        rules: [
          { match: { blast_radius: { lt } }, decision: "allow" },
          { match: {}, decision: "deny" },
        ],
      }).length,
      0,
    );
  }
});

test("YAML syntax errors never echo source contents", () => {
  const result = loadPolicy("version: 1\nrules: [SENTINEL_PRIVATE_VALUE");
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PRIVATE_VALUE/);
});

describe("S07, unclassified calls never pass a broad allow", () => {
  const broadAllow = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: allow
`);
  if (!broadAllow.ok) throw new Error("fixture must load");

  const r3Allow = loadPolicy(`
version: 1
rules:
  - match: { class: r3 }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!r3Allow.ok) throw new Error("fixture must load");

  const r3ListAllow = loadPolicy(`
version: 1
rules:
  - match: { class: [r0, r1, r2, r3] }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!r3ListAllow.ok) throw new Error("fixture must load");

  const toolAllow = loadPolicy(`
version: 1
rules:
  - match: { tool: postgres.row.delete }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!toolAllow.ok) throw new Error("fixture must load");

  const unknownAllow = loadPolicy(`
version: 1
rules:
  - match: { class: unknown }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!unknownAllow.ok) throw new Error("fixture must load");

  const mixedAllow = loadPolicy(`
version: 1
rules:
  - match: { class: [r3, unknown] }
    decision: allow
  - match: {}
    decision: deny
`);
  if (!mixedAllow.ok) throw new Error("fixture must load");

  const unclassified = call({ klass: "r3", unclassified: true });
  const classifiedR3 = call({ klass: "r3" });

  test("a bare catch-all allow does not authorize an unclassified call", () => {
    assert.notEqual(decide(broadAllow, unclassified).kind, "allow");
    assert.equal(decide(broadAllow, classifiedR3).kind, "allow");
  });

  test("a class r3 allow does not authorize an unclassified call", () => {
    assert.equal(decide(r3Allow, unclassified).kind, "deny");
    assert.equal(decide(r3Allow, classifiedR3).kind, "allow");
  });

  test("a class list of only r0 to r3 does not authorize an unclassified call", () => {
    assert.equal(decide(r3ListAllow, unclassified).kind, "deny");
    assert.equal(decide(r3ListAllow, classifiedR3).kind, "allow");
  });

  test("a tool-pinned allow without an unknown opt-in does not authorize an unclassified call", () => {
    assert.equal(decide(toolAllow, unclassified).kind, "deny");
  });

  test("an explicit unknown allow still authorizes an unclassified call", () => {
    assert.equal(decide(unknownAllow, unclassified).kind, "allow");
    assert.equal(decide(mixedAllow, unclassified).kind, "allow");
  });

  test("an explicit unknown allow does not widen classified calls", () => {
    assert.equal(decide(unknownAllow, classifiedR3).kind, "deny");
    assert.equal(decide(mixedAllow, classifiedR3).kind, "allow");
  });

  test("deny and hold rules still match unclassified calls", () => {
    const gated = loadPolicy(`
version: 1
rules:
  - match: { class: r3 }
    decision: hold
    seconds: 60
  - match: {}
    decision: deny
`);
    if (!gated.ok) throw new Error("fixture must load");
    assert.equal(decide(gated, unclassified).kind, "hold");
  });
});
