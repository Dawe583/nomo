import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseInvocation } from "./argv.ts";
import { runKillCommand, runReinstateCommand } from "./kill.ts";

const POLICY = `
version: 1
agents:
  - id: demo-support-bot
rules:
  - id: default-deny
    match: {}
    decision: deny
`;

async function withDir(
  run: (dir: string, io: ReturnType<typeof capture>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "void-kill-cli-"));
  try {
    await writeFile(join(dir, "agents.yaml"), POLICY);
    await run(dir, capture());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      env: {},
    },
  };
}

const now = () => new Date("2026-10-08T10:00:05Z");

describe("void kill and void reinstate", () => {
  test("both commands are in the parser", () => {
    assert.equal(parseInvocation(["kill", "a"]).ok, true);
    assert.equal(parseInvocation(["reinstate", "a"]).ok, true);
  });

  test("kill appends one record and says what was recorded", async () =>
    withDir(async (dir, { out, err, io }) => {
      const store = join(dir, "revocations.jsonl");
      const code = await runKillCommand(
        ["demo-support-bot", "--by", "oliver", "--reason", "demo", "--store", store, "--policy", join(dir, "agents.yaml"), "--json"],
        io,
        { now },
      );
      assert.equal(code, 0, err.join("\n"));
      assert.deepEqual(JSON.parse(out[0]!), {
        kind: "kill",
        agentId: "demo-support-bot",
        at: "2026-10-08T10:00:05.000Z",
        by: "oliver",
        reason: "demo",
        store,
        wasKilled: false,
      });
      const lines = (await readFile(store, "utf8")).trim().split("\n");
      assert.equal(lines.length, 1);
    }));

  test("an id the policy does not declare is refused unless forced", async () =>
    withDir(async (dir, { err, io }) => {
      const store = join(dir, "revocations.jsonl");
      const argv = ["demo-suport-bot", "--by", "oliver", "--store", store, "--policy", join(dir, "agents.yaml")];
      assert.equal(await runKillCommand(argv, io, { now }), 2);
      assert.match(err.join("\n"), /not declared .*declared: demo-support-bot/);
      await assert.rejects(readFile(store, "utf8"), { code: "ENOENT" });
      assert.equal(await runKillCommand([...argv, "--force"], io, { now }), 0);
    }));

  test("the policy in ./policy/agents.yaml is found without --policy", async () =>
    withDir(async (dir, { err, io }) => {
      await mkdir(join(dir, "policy"));
      await writeFile(join(dir, "policy", "agents.yaml"), POLICY);
      const code = await runKillCommand(
        ["nobody", "--by", "oliver", "--store", join(dir, "r.jsonl")],
        io,
        { now, cwd: dir },
      );
      assert.equal(code, 2);
      assert.match(err.join("\n"), /not declared/);
    }));

  test("reinstate needs a reason and a killed agent", async () =>
    withDir(async (dir, { err, io }) => {
      const store = join(dir, "revocations.jsonl");
      const common = ["demo-support-bot", "--by", "oliver", "--store", store, "--force"];
      assert.equal(await runReinstateCommand(common, io), 2);
      assert.match(err.at(-1)!, /^usage: void reinstate/);
      assert.equal(await runReinstateCommand([...common, "--reason", "fixed"], io), 1);
      assert.match(err.at(-1)!, /is not killed/);
      assert.equal(await runKillCommand(common, io, { now }), 0);
      assert.equal(await runReinstateCommand([...common, "--reason", "fixed"], io), 0);
      const kinds = (await readFile(store, "utf8")).trim().split("\n").map((line) => JSON.parse(line).kind);
      assert.deepEqual(kinds, ["kill", "reinstate"]);
    }));

  test("bad arguments are a usage error, not a write", async () =>
    withDir(async (dir, { err, io }) => {
      const store = join(dir, "revocations.jsonl");
      assert.equal(await runKillCommand(["demo-support-bot", "--store", store], io), 2);
      assert.equal(await runKillCommand(["demo-support-bot", "--by", "--json"], io), 2);
      assert.equal(await runKillCommand(["Bad Id", "--by", "oliver", "--store", store, "--force"], io), 1);
      assert.match(err.at(-1)!, /agent id must match/);
      await assert.rejects(readFile(store, "utf8"), { code: "ENOENT" });
    }));
});
