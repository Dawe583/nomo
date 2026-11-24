/** HP7: operator goals with allowlisted process gates and bounded continuation. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedWorkbench } from "./test-fixture.ts";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = (text = "Done", tokens?: number) =>
  Response.json({
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    ...(tokens === undefined ? {} : { usage: { total_tokens: tokens } }),
  });
const exists = (path: string) => access(path).then(() => true, () => false);

async function fixtureWithGate(
  t: any,
  gateBody: string | ((directory: string) => string),
  fetcher: typeof fetch,
) {
  const directory = await mkdtemp(join(tmpdir(), "nomo-goal-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "gate.mjs");
  await writeFile(script, typeof gateBody === "function" ? gateBody(directory) : gateBody);
  const gate = `${process.execPath} ${script}`;
  const fixture = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_HOOK_COMMANDS: JSON.stringify([gate]) },
  );
  return { fixture, gate, directory };
}

test("a passing allowlisted gate completes the goal and a forbidden gate never runs", async (t) => {
  const requests: any[] = [];
  const { fixture, gate, directory } = await fixtureWithGate(
    t,
    (directory) => `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(join(directory, "passed.txt"))},"ran");`,
    async (url, init) => {
      if (String(url).endsWith("/models")) return models();
      requests.push(JSON.parse(String(init?.body)));
      return done();
    },
  );
  const marker = join(directory, "passed.txt");
  const session = await fixture.app.start("Prepare", "fixture");
  await fixture.app.settled();
  const goal = await fixture.app.startGoal(session.id, {
    objective: "Finish verified work",
    tokenBudget: 100,
    gates: [gate],
  });
  assert.equal(goal.status, "active");
  await fixture.app.settled();
  assert.equal(fixture.app.get(session.id)!.goal!.status, "completed");
  assert.equal(await exists(marker), true);
  assert.equal(requests.length, 2);

  const forbiddenMarker = join(directory, "forbidden.txt");
  const forbiddenScript = join(directory, "forbidden.mjs");
  await writeFile(forbiddenScript, `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(forbiddenMarker)},"ran");`);
  await assert.rejects(
    fixture.app.startGoal(session.id, {
      objective: "Run a forbidden command",
      tokenBudget: 100,
      gates: [`${process.execPath} ${forbiddenScript}`],
    }),
    /allowlist/i,
  );
  assert.equal(await exists(forbiddenMarker), false);
  assert.equal(requests.length, 2);
});

test("a failing gate over an unchanged workspace stops as stalled", async (t) => {
  let calls = 0;
  const { fixture, gate } = await fixtureWithGate(
    t,
    "process.exit(1);",
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return done();
    },
  );
  const session = await fixture.app.start("Prepare", "fixture");
  await fixture.app.settled();
  await fixture.app.startGoal(session.id, {
    objective: "Do not loop without progress",
    tokenBudget: 100,
    gates: [gate],
  });
  await fixture.app.settled();
  const goal = fixture.app.get(session.id)!.goal!;
  assert.equal(goal.status, "stalled");
  assert.equal(goal.continuationCount, 0);
  assert.equal(calls, 2);
});

test("the goal token budget ends as budget_limited before a stalled retry", async (t) => {
  let calls = 0;
  const { fixture, gate } = await fixtureWithGate(
    t,
    "process.exit(1);",
    async (url) => {
      if (String(url).endsWith("/models")) return models();
      calls++;
      return done("Done", 20);
    },
  );
  const session = await fixture.app.start("Prepare", "fixture");
  await fixture.app.settled();
  await fixture.app.startGoal(session.id, {
    objective: "Stop at the goal budget",
    tokenBudget: 10,
    gates: [gate],
  });
  await fixture.app.settled();
  assert.equal(fixture.app.get(session.id)!.goal!.status, "budget_limited");
  assert.equal(calls, 2);
});

test("a real document change allows one continuation and a later passing gate completes", async (t) => {
  const requests: any[] = [];
  let goalTurn = false;
  let wrote = false;
  const { fixture, gate, directory } = await fixtureWithGate(
    t,
    "process.exit(1);",
    async (url, init) => {
      if (String(url).endsWith("/models")) return models();
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const latest = String([...body.messages].reverse().find((message: any) => message.role === "user")?.content ?? "");
      if (/Work toward the operator goal/.test(latest)) goalTurn = true;
      if (goalTurn && !wrote) {
        wrote = true;
        const tool = body.tools.find((entry: any) => entry.function.description.startsWith("void_workspace_write:"));
        assert.ok(tool);
        return Response.json({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "goal-write-1",
                type: "function",
                function: { name: tool.function.name, arguments: JSON.stringify({ path: "progress.txt", content: "changed" }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
        });
      }
      return done("Done", 1);
    },
  );
  const counter = join(directory, "counter.json");
  await writeFile(join(directory, "gate.mjs"), `
    import{readFileSync,writeFileSync}from"node:fs";
    let count=0;try{count=JSON.parse(readFileSync(${JSON.stringify(counter)},"utf8")).count;}catch{}
    writeFileSync(${JSON.stringify(counter)},JSON.stringify({count:count+1}));
    process.exit(count===0?1:0);
  `);
  const session = await fixture.app.start("Prepare", "fixture");
  await fixture.app.settled();
  await fixture.app.startGoal(session.id, {
    objective: "Continue only after measured progress",
    tokenBudget: 100,
    gates: [gate],
  });
  await fixture.app.settled();
  const goal = fixture.app.get(session.id)!.goal!;
  assert.equal(goal.status, "completed");
  assert.equal(goal.continuationCount, 1);
  assert.equal(JSON.parse(await readFile(counter, "utf8")).count, 2);
  const continuation = requests.find((body) =>
    [...body.messages].reverse().find((message: any) => message.role === "user")?.content?.includes("Untrusted goal gate"),
  );
  assert.ok(continuation, "the changed workspace must allow a continuation");
  assert.equal(JSON.stringify(continuation).includes(gate), false, "gate command text is not sent to the model");
});
