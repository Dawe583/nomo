import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

/**
 * A module that is imported by the agent-step workflow must not reach the
 * policy barrel.
 *
 * `index.ts` re-exports the pack loader and the approval broker, and both touch
 * the filesystem. The workflow runtime refuses Node builtins, so a leaf that
 * imported the barrel for one string constant would drag `node:fs`, `node:path`
 * and `node:url` into a build that cannot use them. The barrel is the public
 * surface; the modules inside it share the leaf `grammar.ts` instead.
 *
 * This failed silently for a long time: the graph was wrong, but tree-shaking
 * hid it until an unrelated change in `cloud/steps.mjs` removed the slack. A
 * dependency-shape regression that only shows up under bundler conditions is
 * worth a test that does not need the bundler.
 */
const LEAF_MODULES = ["grammar.ts", "rules.ts", "decide.ts", "hold.ts", "channels/cli.ts", "channels/slack.ts"];

test("no policy leaf module imports the barrel", async () => {
  const offenders: string[] = [];
  for (const name of LEAF_MODULES) {
    const source = await readFile(
      fileURLToPath(new URL(`./${name}`, import.meta.url)),
      "utf8",
    );
    for (const line of source.split("\n")) {
      const match = /from\s+"(\.[^"]*)"/.exec(line);
      if (match?.[1] === "./index.ts" || match?.[1] === "../index.ts") {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `policy leaves must not import the barrel: ${offenders.join("; ")}`);
});

test("the barrel still publishes the whole grammar, so nothing lost its public name", async () => {
  const barrel = await import("./index.ts");
  assert.deepEqual(barrel.MATCH_KEYS, ["class", "tool", "connector", "workspace", "blast_radius"]);
  assert.equal(barrel.POLICY_VERSION, 1);
  assert.equal(barrel.UNMATCHED_DECISION, "hold");
  assert.equal(barrel.BROKEN_POLICY_DECISION, "deny");
  assert.equal(barrel.UNKNOWN_CLASS, "unknown");
  assert.equal(barrel.UNCLASSIFIED_CLASS, "r3");
  assert.equal(barrel.isMatchKey("tool"), true);
  assert.equal(barrel.isMatchKey("nope"), false);
});
