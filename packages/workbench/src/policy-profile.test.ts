import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Workbench } from "./index.ts";
import { assertIsolated } from "./test-fixture.ts";
import {
  DEFAULT_POLICY_PROFILE,
  listPolicyProfiles,
  resolvePolicyProfile,
} from "./policy-profile.ts";

/** The built-in policy holds every class above r0, so a `void_workspace_write`
 * (r1) under `default` reaches an operator as a pending hold. The two files
 * below are the same shape of decision made permanent: one that lets r1
 * through, one that refuses it. Neither can be told apart from the built-in
 * policy by any argument the profile passes, only by the policy it names. */
const OPEN = "version: 1\nrules:\n  - match:\n      class: [r0, r1]\n    decision: allow\n    rationale: reversible calls go through\n  - match: {}\n    decision: deny\n    rationale: nothing else is permitted here\n";
const CLOSED = "version: 1\nrules:\n  - match:\n      class: r0\n    decision: allow\n  - match: {}\n    decision: deny\n    rationale: only fully reversible calls\n";

const models = () => Response.json({ data: [{ id: "fixture" }] });
const done = () =>
  Response.json({ choices: [{ message: { role: "assistant", content: "Done" } }] });

/** A workbench whose operator policy lives in a real directory, with one
 * managed-document tool call per turn. The policy path is the operator's, so
 * the names a profile can select are the files sitting next to it. */
async function fixture(t: TestContext, policies: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "void-policy-profile-"));
  const policyDir = join(directory, "policies");
  await mkdir(policyDir);
  for (const [name, text] of Object.entries(policies))
    await writeFile(join(policyDir, `${name}.yaml`), text);
  const policyPath = join(policyDir, "operator.yaml");
  await writeFile(policyPath, OPEN);
  let turns = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return models();
    const body = JSON.parse(String(init?.body));
    if (++turns > 1) return done();
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "write",
                type: "function",
                function: {
                  name: body.tools[0].function.name,
                  arguments: JSON.stringify({ path: "note", content: "requested" }),
                },
              },
            ],
          },
        },
      ],
    });
  };
  const env = { VOID_DATA_DIR: join(directory, "data"), VOID_POLICY_PATH: policyPath };
  const app = new Workbench(env, fetcher);
  assertIsolated(join(directory, "data"), env);
  t.after(async () => {
    await app.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  await app.configure({ baseUrl: "https://fixture.test/v1", apiKey: "fixture" });
  const profile = (policyProfile: string) => ({
    id: "writer",
    name: "Writer",
    systemPrompt: "Write the requested document.",
    allowedTools: ["void_workspace_write"],
    policyProfile,
    maxTurns: 2,
    maxContextTokens: 131_072,
  });
  return { app, policyDir, policyPath, profile };
}

test("the catalogue offers the operator's policy files, and only readable valid ones", async (t) => {
  const f = await fixture(t, { open: OPEN, closed: CLOSED, broken: "version: 1\nrules: 7\n" });
  await writeFile(join(f.policyDir, ".hidden.yaml"), CLOSED);
  const names = listPolicyProfiles(f.policyPath);
  assert.equal(names[0], DEFAULT_POLICY_PROFILE);
  // `operator` is the operator's own VOID_POLICY_PATH, so it is a real file
  // in that directory and therefore a name a profile can select.
  assert.deepEqual(names.slice(1), ["broken", "closed", "open", "operator"]);
  assert.equal(f.app.agents().policyProfiles.includes("open"), true);
  assert.equal(f.app.agents().policyProfiles.includes("hidden"), false);
  // A name the catalogue lists but that cannot be resolved must still refuse.
  const broken = resolvePolicyProfile("broken", f.policyPath);
  assert.equal(broken.ok, false);
  assert.throws(() => f.app.upsertAgent(f.profile("broken")), /policy profile/i);
  // An unconfigured runtime offers nothing but the built-in policy, and any
  // other name is refused rather than resolved against some implicit path.
  assert.deepEqual(listPolicyProfiles(undefined), [DEFAULT_POLICY_PROFILE]);
  assert.equal(resolvePolicyProfile("open", undefined).ok, false);
  const builtin = resolvePolicyProfile(DEFAULT_POLICY_PROFILE, undefined);
  assert.equal(builtin.ok, true);
});

test("a profile that names an open policy writes without waiting for an operator", async (t) => {
  const f = await fixture(t, { open: OPEN });
  f.app.upsertAgent(f.profile("open"));
  const session = await f.app.start("Write the note.", "fixture", undefined, undefined, "writer");
  await f.app.settled();
  assert.equal(f.app.get(session.id)?.status, "idle");
  // The built-in policy would hold this call: an r1 document mutation waits.
  assert.equal(f.app.pending().length, 0);
  assert.equal(f.app.document(session.id, "note").content, "requested");
});

test("a profile that names a closed policy is refused at the call, not held", async (t) => {
  const f = await fixture(t, { closed: CLOSED });
  f.app.upsertAgent(f.profile("closed"));
  const session = await f.app.start("Write the note.", "fixture", undefined, undefined, "writer");
  await f.app.settled();
  // The same profile under the built-in policy reaches an operator as a
  // pending hold. The named policy denies it outright, so nothing is pending.
  assert.equal(f.app.pending().length, 0);
  assert.equal(f.app.document(session.id, "note").content, null);
  const evidence = await f.app.ledger(session.workspace);
  const denied = (evidence!.entries as Array<{ body: Record<string, unknown> }>)
    .map((entry) => entry.body)
    .filter((body) => body.decision === "deny" && body.tool === "void_workspace_write");
  assert.ok(denied.length >= 1, "the refused call is recorded as a denial");
});

test("a policy profile name is a name, never a path", async (t) => {
  const f = await fixture(t, { open: OPEN });
  for (const name of ["../open", "nested/open", ".open"]) {
    const resolved = resolvePolicyProfile(name, f.policyPath);
    assert.equal(resolved.ok, false);
    assert.match(resolved.ok === false ? resolved.reason : "", /bare name/);
  }
  assert.throws(() => f.app.upsertAgent(f.profile("../open")), /bare name/);
});

test("a profile whose policy file disappears fails its turn rather than falling back", async (t) => {
  const f = await fixture(t, { open: OPEN });
  f.app.upsertAgent(f.profile("open"));
  await rm(join(f.policyDir, "open.yaml"));
  const session = await f.app.start("Write the note.", "fixture", undefined, undefined, "writer");
  await f.app.settled();
  assert.equal(f.app.get(session.id)?.status, "failed");
  assert.match(f.app.get(session.id)!.events.find((e) => e.kind === "error")!.text, /policy profile/i);
  assert.equal(f.app.document(session.id, "note").content, null);
});