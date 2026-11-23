import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_EXEC_TOOL } from "./project-sandbox.ts";
import { PROJECT_CHANGES_TOOL } from "./project-workspace.ts";
import { isolatedWorkbench } from "./test-fixture.ts";

const profile = {
  id: "project-coder",
  name: "Project coder",
  systemPrompt: "Work only through approved tools.",
  allowedTools: [PROJECT_EXEC_TOOL.name],
  policyProfile: "default",
  maxTurns: 2,
  maxContextTokens: 8192,
};

test("project context is opt-in, custom-profile-only, and must be reconfirmed after restart", async (t) => {
  const requests: Array<{ messages: Array<{ content?: string }>; tools: Array<{ function: { name: string; description: string } }> }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
  };
  const fixture = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false },
  );
  await fixture.app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const root = await mkdtemp(join(tmpdir(), "nomo-project-access-"));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  t.after(() => rm(root, { recursive: true, force: true }));
  fixture.app.upsertAgent(profile);
  await fixture.app.confirmProjectAccess(root, []);
  const defaultSession = await fixture.app.start("Inspect", "fixture");
  await fixture.app.settled();
  assert.equal(
    requests[0]!.tools.some((tool) => tool.function.description.startsWith(`${PROJECT_EXEC_TOOL.name}:`)),
    false,
  );
  assert.equal(
    requests[0]!.tools.some((tool) => tool.function.description.startsWith(`${PROJECT_CHANGES_TOOL.name}:`)),
    false,
  );

  const projectSession = await fixture.app.start(
    "Inspect this project",
    "fixture",
    undefined,
    undefined,
    profile.id,
  );
  await fixture.app.settled();
  assert.equal(
    requests[1]!.tools.some((tool) => tool.function.description.startsWith(`${PROJECT_EXEC_TOOL.name}:`)),
    true,
  );
  assert.equal(
    requests[1]!.tools.some((tool) => tool.function.description.startsWith(`${PROJECT_CHANGES_TOOL.name}:`)),
    false,
  );
  assert.match(requests[1]!.messages[0]!.content!, /isolated, network-disabled container/);
  assert.equal(fixture.app.get(defaultSession.id)?.status, "idle");

  fixture.restart();
  assert.throws(
    () => fixture.app.send(projectSession.id, "Continue"),
    /reconfirm.*project.*skill/i,
  );
  const restored = await fixture.app.confirmProjectAccess(root, []);
  assert.equal(restored.restoredSessions, 2);
  fixture.app.send(projectSession.id, "Continue");
  await fixture.app.settled();
  assert.equal(requests.length, 3);
});

test("read-only project changes are available only to the confirmed allowlisted session", async (t) => {
  type RequestBody = {
    messages: Array<{ role: string; content?: string }>;
    tools: Array<{ function: { name: string; description: string } }>;
  };
  const requests: RequestBody[] = [];
  let reviewed = false;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body)) as RequestBody;
    requests.push(body);
    const tool = body.tools.find((candidate) =>
      candidate.function.description.startsWith(`${PROJECT_CHANGES_TOOL.name}:`),
    );
    if (!tool || reviewed)
      return Response.json({ choices: [{ message: { role: "assistant", content: "Reviewed" }, finish_reason: "stop" }] });
    reviewed = true;
    assert.equal(
      body.tools.some((candidate) =>
        candidate.function.description.startsWith(`${PROJECT_EXEC_TOOL.name}:`),
      ),
      false,
    );
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
      id: "review-call",
      type: "function",
      function: {
        name: tool.function.name,
        arguments: JSON.stringify({ operation: "status" }),
      },
    }] }, finish_reason: "tool_calls" }] });
  };
  const fixture = await isolatedWorkbench(
    t,
    fetcher,
    { NOMO_PERMISSION_MODE: "normal" },
    { configure: false },
  );
  await fixture.app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const root = await mkdtemp(join(tmpdir(), "nomo-project-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "export const answer = 42;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  const reviewProfile = {
    ...profile,
    id: "project-reviewer",
    allowedTools: [PROJECT_CHANGES_TOOL.name],
  };
  fixture.app.upsertAgent(reviewProfile);
  const { rootDigest } = await fixture.app.confirmProjectAccess(root, []);
  const copiedFile = join(
    fixture.root,
    "project-workspaces",
    rootDigest.slice("sha256:".length),
    "source",
    "src/main.ts",
  );
  await writeFile(copiedFile, "export const answer = 43;\n");

  const session = await fixture.app.start(
    "Review the project changes",
    "fixture",
    undefined,
    undefined,
    reviewProfile.id,
  );
  await fixture.app.settled();
  const exposedRequest = requests.find((request) =>
    request.tools.some((tool) =>
      tool.function.description.startsWith(`${PROJECT_CHANGES_TOOL.name}:`),
    ),
  );
  assert.ok(
    exposedRequest,
    JSON.stringify(requests.map((request) => request.tools.map((tool) => tool.function.name))),
  );
  const resultRequest = requests.find((request) =>
    request.messages.some((message) => message.role === "tool"),
  );
  assert.ok(resultRequest);
  assert.equal(await readFile(join(root, "src/main.ts"), "utf8"), "export const answer = 42;\n");
  assert.match(JSON.stringify(resultRequest.messages), /modified/);
  assert.doesNotMatch(JSON.stringify(resultRequest.messages), /answer = 42/);
  assert.ok(fixture.app.availableTools(session.id).tools.some(
    (tool) => tool.name === PROJECT_CHANGES_TOOL.name,
  ));
  await fixture.app.revokeProjectAccess();
  assert.equal(fixture.app.availableTools(session.id).tools.some(
    (tool) => tool.name === PROJECT_CHANGES_TOOL.name,
  ), false);
});

test("Workbench summarizes, revokes, and deletes only the owned project copy", async (t) => {
  const fixture = await isolatedWorkbench(
    t,
    async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "fixture" }] })
      : Response.json({ choices: [{ message: { role: "assistant", content: "Ready" }, finish_reason: "stop" }] }),
    {},
    { configure: false },
  );
  const root = await mkdtemp(join(tmpdir(), "nomo-project-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, stdio: "ignore" });
  const { rootDigest } = await fixture.app.confirmProjectAccess(root, []);

  const summary = await fixture.app.projectWorkspaceSummary();
  assert.deepEqual(summary.project, {
    rootDigest,
    displayName: root.split(/[\\/]/).at(-1),
  });
  assert.equal(JSON.stringify(summary).includes(root), false);
  const saved = await fixture.app.listProjectWorkspaces();
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.rootDigest, rootDigest);
  await fixture.app.deleteProjectWorkspace(rootDigest);
  assert.deepEqual(await fixture.app.projectWorkspaceSummary(), {
    project: null,
    workspace: null,
  });
  assert.deepEqual(await fixture.app.listProjectWorkspaces(), []);
});

test("an allowlisted R3 project command runs in the pinned sandbox and records dispatch evidence", {
  skip:
    !process.env.NOMO_PROJECT_SANDBOX_RUNTIME ||
    !process.env.NOMO_PROJECT_SANDBOX_IMAGE,
}, async (t) => {
  const sandboxRuntime = process.env.NOMO_PROJECT_SANDBOX_RUNTIME!;
  const sandboxImage = process.env.NOMO_PROJECT_SANDBOX_IMAGE!;
  const directory = await mkdtemp(join(tmpdir(), "nomo-project-exec-"));
  const projectRoot = join(directory, "project");
  const policyDir = join(directory, "policies");
  await mkdir(projectRoot);
  execFileSync("git", ["init", "--quiet"], { cwd: projectRoot, stdio: "ignore" });
  await mkdir(policyDir);
  const policyPath = join(policyDir, "operator.yaml");
  await writeFile(
    join(policyDir, "open.yaml"),
    "version: 1\nrules:\n  - match:\n      class: [r0, r1, r3]\n    decision: allow\n    rationale: explicitly allowed in this test\n  - match: {}\n    decision: deny\n    rationale: deny all other calls\n",
  );
  await writeFile(policyPath, "version: 1\nrules:\n  - match: {}\n    decision: deny\n");
  let turn = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models"))
      return Response.json({ data: [{ id: "fixture" }] });
    const body = JSON.parse(String(init?.body));
    if (++turn > 1)
      return Response.json({ choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }] });
    const projectTool = body.tools.find(
      (tool: { function: { name: string; description: string } }) =>
        tool.function.description.startsWith(`${PROJECT_EXEC_TOOL.name}:`),
    );
    assert.ok(projectTool);
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{
      id: "project-call",
      type: "function",
      function: {
        name: projectTool.function.name,
        arguments: JSON.stringify({ command: "printf sandbox-ok > result.txt" }),
      },
    }] }, finish_reason: "tool_calls" }] });
  };
  const env = {
    NOMO_POLICY_PATH: policyPath,
    NOMO_PROJECT_SANDBOX_RUNTIME: sandboxRuntime,
    NOMO_PROJECT_SANDBOX_IMAGE: sandboxImage,
    NOMO_PERMISSION_MODE: "normal",
  };
  const fixture = await isolatedWorkbench(t, fetcher, env, { configure: false });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await fixture.app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const { rootDigest } = await fixture.app.confirmProjectAccess(projectRoot, []);
  const session = await fixture.app.start(
    "Write one file in the project",
    "fixture",
    undefined,
    undefined,
    profile.id,
  );
  await fixture.app.settled();
  assert.equal(
    await readFile(join(fixture.root, "project-workspaces", rootDigest, "source", "result.txt"), "utf8"),
    "sandbox-ok",
  );
  await assert.rejects(readFile(join(projectRoot, "result.txt"), "utf8"), { code: "ENOENT" });
  const ledger = await fixture.app.ledger(session.workspace);
  assert.equal(ledger?.result.ok, true);
  const projectRecords = ledger!.entries
    .map((entry) => entry.body as Record<string, unknown>)
    .filter((body) => body.tool === PROJECT_EXEC_TOOL.name);
  assert.deepEqual(
    projectRecords.map((body) => body.decision),
    ["allow", "dispatch:started", "execute:completed"],
  );
  assert.doesNotMatch(JSON.stringify(projectRecords), /printf sandbox-ok|result\.txt/);
});
