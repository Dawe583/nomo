import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import { checkPolicy } from "./check.ts";
import { loadAgentPolicy } from "./load.ts";
import { revocationView } from "./revocations.ts";
import {
  AgentPolicyScaffoldError,
  DEFAULT_AGENT_ID,
  defaultAgentPolicy,
  writeDefaultAgentPolicy,
} from "./scaffold.ts";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "nomo-scaffold-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const allowEverything = loadPolicy(`
version: 1
rules:
  - match: {}
    decision: allow
`);

describe("default agent policy", () => {
  test("declares one agent, ends in a deny, and loads", () => {
    const loaded = loadAgentPolicy(
      defaultAgentPolicy({ agentId: "support-bot", owner: "oliver" }),
    );
    assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
    assert.deepEqual(loaded.policy.agents, [
      { id: "support-bot", owner: "oliver" },
    ]);
    const last = loaded.policy.rules.at(-1)!;
    assert.deepEqual(last.match, {});
    assert.equal(last.decision, "deny");
    assert.equal(loaded.policy.rules.length, 1);
  });

  test("grants nothing, even when the class policy allows everything", () => {
    const agentPolicy = loadAgentPolicy(defaultAgentPolicy());
    for (const scope of ["read", "write", "delete", "admin"] as const) {
      const result = checkPolicy(
        {
          contract: "nomo.policy-check.v0",
          requestId: `req-${scope}`,
          agent: { id: DEFAULT_AGENT_ID },
          tool: "notes.read",
          connector: "fs",
          args: {},
          target: "fs:sandbox/notes/todo.md",
          scope,
          workspace: "default",
        },
        {
          agentPolicy,
          classPolicy: allowEverything,
          classify: () => classifyTool("notes.read", { facts: {}, args: {} }),
          revocations: revocationView([]),
          now: () => new Date("2026-10-08T10:00:00Z"),
          requireToken: false,
        },
      );
      assert.equal(result.decision, "deny", scope);
      assert.equal(result.ruleId, "default-deny", scope);
      assert.equal(result.layer, "agent-policy", scope);
    }
  });

  test("ids that YAML would read as numbers, null or booleans stay strings", () => {
    for (const agentId of ["123", "null", "true", "1e3", "0.5", "no"]) {
      const loaded = loadAgentPolicy(defaultAgentPolicy({ agentId }));
      assert.ok(loaded.ok, `${agentId}: ${JSON.stringify(!loaded.ok && loaded.errors)}`);
      assert.equal(loaded.policy.agents[0]!.id, agentId);
    }
  });

  test("an owner cannot inject YAML, and bad options are refused", () => {
    const loaded = loadAgentPolicy(
      defaultAgentPolicy({ owner: 'max" }, rules: [], x: "' }),
    );
    assert.ok(loaded.ok);
    assert.equal(loaded.policy.agents.length, 1);
    assert.equal(loaded.policy.rules.length, 1);
    for (const options of [
      { agentId: "Bad Id" },
      { agentId: "" },
      { owner: "" },
      { owner: "two\nlines" },
      { owner: "x".repeat(121) },
    ])
      assert.throws(
        () => defaultAgentPolicy(options),
        AgentPolicyScaffoldError,
        JSON.stringify(options),
      );
  });
});

describe("writeDefaultAgentPolicy", () => {
  test("creates the file and its directory, then reports it unchanged", async () =>
    withDir(async (dir) => {
      const path = join(dir, "policy", "agents.yaml");
      assert.deepEqual(await writeDefaultAgentPolicy(path), {
        status: "created",
        path,
      });
      assert.equal(await readFile(path, "utf8"), defaultAgentPolicy());
      assert.deepEqual(await writeDefaultAgentPolicy(path), {
        status: "unchanged",
        path,
      });
    }));

  test("the default with CRLF line endings is still the default", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      await writeFile(path, defaultAgentPolicy().replace(/\n/g, "\r\n"));
      assert.equal((await writeDefaultAgentPolicy(path)).status, "unchanged");
    }));

  test("an edited file is never overwritten", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      const edited = defaultAgentPolicy().replace(
        "rules:\n",
        `rules:
  - id: local-agent-reads
    match: { agent: "local-agent", scope: read, class: unknown }
    decision: allow
`,
      );
      await writeFile(path, edited);
      assert.deepEqual(await writeDefaultAgentPolicy(path), {
        status: "kept",
        path,
        problems: [],
      });
      assert.equal(await readFile(path, "utf8"), edited);
    }));

  test("a default written for another agent is the operator's file too", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      await writeDefaultAgentPolicy(path, { agentId: "first-agent" });
      const result = await writeDefaultAgentPolicy(path, { agentId: "second-agent" });
      assert.equal(result.status, "kept");
      assert.match(await readFile(path, "utf8"), /first-agent/);
    }));

  test("a broken file is kept, and its problems are reported", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      await writeFile(path, "version: 1\nagents: []\n");
      const result = await writeDefaultAgentPolicy(path);
      assert.equal(result.status, "kept");
      assert.ok(result.status === "kept" && result.problems.length > 0);
      assert.equal(await readFile(path, "utf8"), "version: 1\nagents: []\n");
    }));

  test("two inits racing on one path write once", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      const results = await Promise.all(
        Array.from({ length: 8 }, () => writeDefaultAgentPolicy(path)),
      );
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [
        "created",
        ...Array<"unchanged">(7).fill("unchanged"),
      ]);
      assert.equal(await readFile(path, "utf8"), defaultAgentPolicy());
    }));

  test("a path that is a directory is an error, and nothing is written", async () =>
    withDir(async (dir) => {
      const path = join(dir, "agents.yaml");
      await mkdir(path);
      await assert.rejects(
        writeDefaultAgentPolicy(path),
        (error) =>
          error instanceof AgentPolicyScaffoldError &&
          /exists and cannot be read .*nothing was written/.test(error.message),
      );
    }));

  test("bad options are refused before the disk is touched", async () =>
    withDir(async (dir) => {
      const path = join(dir, "nested", "agents.yaml");
      await assert.rejects(
        writeDefaultAgentPolicy(path, { agentId: "Bad Id" }),
        AgentPolicyScaffoldError,
      );
      await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
    }));
});
