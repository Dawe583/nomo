import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadAgentPolicy } from "./load.ts";

const shipped = readFileSync(
  new URL("../../../policy/agents.yaml", import.meta.url),
  "utf8",
);

const minimal = (rules: string, agents = "  - id: bot-a\n") =>
  `version: 1\nagents:\n${agents}rules:\n${rules}`;

const catchAll = "  - id: default-deny\n    match: {}\n    decision: deny\n";

const errorsOf = (text: string): readonly string[] => {
  const loaded = loadAgentPolicy(text);
  assert.equal(loaded.ok, false, "expected a load error");
  return loaded.ok ? [] : loaded.errors;
};

describe("loadAgentPolicy", () => {
  test("the shipped demo agent policy loads", () => {
    const loaded = loadAgentPolicy(shipped);
    assert.equal(loaded.ok, true, loaded.ok ? "" : loaded.errors.join("; "));
    if (loaded.ok) {
      assert.deepEqual(
        loaded.policy.agents.map((a) => a.id),
        ["demo-support-bot", "demo-report-bot"],
      );
      assert.equal(loaded.policy.rules.at(-1)?.decision, "deny");
    }
  });

  test("invalid YAML is a load error, not a throw", () => {
    assert.deepEqual(errorsOf("version: 1\nrules: [\n"), [
      "yaml: invalid agent policy syntax",
    ]);
  });

  test("a wrong version is named", () => {
    const errors = errorsOf(
      minimal(catchAll).replace("version: 1", "version: 2"),
    );
    assert.ok(errors.some((e) => e.startsWith("version:")));
  });

  test("an unknown match key is a load error, never ignored", () => {
    const errors = errorsOf(
      minimal(
        "  - id: r1\n    match: { agnet: bot-a }\n    decision: allow\n" +
          catchAll,
      ),
    );
    assert.ok(errors.some((e) => e.includes("agnet: not a match key")));
  });

  test("the catch-all must exist, be last and deny", () => {
    assert.ok(
      errorsOf(
        minimal(
          "  - id: r1\n    match: { agent: bot-a }\n    decision: allow\n",
        ),
      ).some((e) => e.includes("last rule must be the unguarded catch-all")),
    );
    assert.ok(
      errorsOf(
        minimal("  - id: open\n    match: {}\n    decision: allow\n"),
      ).some((e) => e.includes("catch-all must deny")),
    );
    assert.ok(
      errorsOf(
        minimal(
          catchAll + "  - id: after\n    match: {}\n    decision: deny\n",
        ),
      ).some((e) => e.includes("unreachable")),
    );
  });

  test("a rule naming an undeclared agent is a load error", () => {
    const errors = errorsOf(
      minimal(
        "  - id: r1\n    match: { agent: ghost }\n    decision: allow\n" +
          catchAll,
      ),
    );
    assert.ok(errors.some((e) => e.includes("ghost is not declared")));
  });

  test("rule ids are required and unique", () => {
    assert.ok(
      errorsOf(
        minimal(
          "  - match: { agent: bot-a }\n    decision: allow\n" + catchAll,
        ),
      ).some((e) => e.startsWith("rules[0].id")),
    );
    assert.ok(
      errorsOf(
        minimal(
          "  - id: dup\n    match: { agent: bot-a }\n    decision: allow\n" +
            "  - id: dup\n    match: { agent: bot-a }\n    decision: deny\n" +
            catchAll,
        ),
      ).some((e) => e.includes("dup is used twice")),
    );
  });

  test("a target prefix must end at a boundary", () => {
    const errors = errorsOf(
      minimal(
        "  - id: r1\n    match: { target_prefix: fs:sandbox/notes }\n    decision: allow\n" +
          catchAll,
      ),
    );
    assert.ok(errors.some((e) => e.includes("must end with / or :")));
  });

  test("scope and class values are closed sets", () => {
    const errors = errorsOf(
      minimal(
        "  - id: r1\n    match: { scope: root, class: r4 }\n    decision: allow\n" +
          catchAll,
      ),
    );
    assert.ok(errors.some((e) => e.includes(".scope: must be")));
    assert.ok(errors.some((e) => e.includes(".class: must be")));
  });

  test("hold needs a timer within the ceiling, other decisions have none", () => {
    assert.ok(
      errorsOf(
        minimal(
          "  - id: h\n    match: { agent: bot-a }\n    decision: hold\n" +
            catchAll,
        ),
      ).some((e) => e.includes("seconds: required for hold")),
    );
    assert.ok(
      errorsOf(
        minimal(
          "  - id: h\n    match: { agent: bot-a }\n    decision: hold\n    seconds: 901\n" +
            catchAll,
        ),
      ).some((e) => e.includes("ceiling")),
    );
    assert.ok(
      errorsOf(
        minimal(
          "  - id: a\n    match: { agent: bot-a }\n    decision: allow\n    seconds: 5\n" +
            catchAll,
        ),
      ).some((e) => e.includes("only a hold has a timer")),
    );
  });
});
