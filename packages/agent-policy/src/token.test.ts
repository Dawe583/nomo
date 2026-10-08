import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

import { keyProviderFromPkcs8 } from "../../ledger/src/sign.ts";
import { loadPolicy } from "../../policy/src/rules.ts";
import { classifyTool } from "../../registry/src/evaluate.ts";
import type { PolicyCheckRequest } from "./check.ts";
import { loadAgentPolicy } from "./load.ts";
import { revocationView, type RevocationRecord } from "./revocations.ts";
import {
  checkCall,
  issueToken,
  MAX_TOKEN_LENGTH,
  signToken,
  TOKEN_FORMAT,
  tokenSigningPreimage,
  verifierFor,
  verifyToken,
  type IssueDeps,
} from "./token.ts";

const newKey = () =>
  keyProviderFromPkcs8(
    generateKeyPairSync("ed25519").privateKey.export({
      format: "der",
      type: "pkcs8",
    }) as Buffer,
  );
const signer = newKey();
const verifier = verifierFor(signer);

const agentPolicy = loadAgentPolicy(
  readFileSync(new URL("../../../policy/agents.yaml", import.meta.url), "utf8"),
);
const classPolicy = loadPolicy(`
version: 1
rules:
  - match: { class: unknown, tool: [notes.read] }
    decision: allow
  - match: { class: r0 }
    decision: allow
  - match: { class: [r2, r3] }
    decision: hold
    seconds: 60
  - match: {}
    decision: deny
`);

const T0 = new Date("2026-10-08T09:00:00.000Z");
const shadow = { "fs.shadow.captured": "true" };

const request = (over: Partial<PolicyCheckRequest> = {}): PolicyCheckRequest => ({
  contract: "nomo.policy-check.v0",
  requestId: "req-1",
  agent: { id: "demo-support-bot" },
  tool: "fs.file.write",
  connector: "fs",
  args: { path: "drafts/reply.md" },
  target: "fs:sandbox/drafts/reply.md",
  scope: "write",
  workspace: "demo",
  ...over,
});

const deps = (
  over: { now?: Date; tool?: string; records?: RevocationRecord[] } = {},
): IssueDeps => ({
  agentPolicy,
  classPolicy,
  classify: () =>
    classifyTool(over.tool ?? "fs.file.write", { facts: shadow, args: {} }),
  revocations: revocationView(over.records ?? []),
  now: () => over.now ?? T0,
  signer,
  newTokenId: () => "tok-1",
});

const callDeps = (over: Parameters<typeof deps>[0] = {}) => {
  const { signer: _s, newTokenId: _n, ...rest } = deps(over);
  return { ...rest, verifier };
};

const { token: _t, ...callRequest } = request();

async function issued() {
  const result = await issueToken(request(), deps());
  assert.equal(result.kind, "issued");
  if (result.kind !== "issued") throw new Error("unreachable");
  return result.token;
}

/** Rebuilds a token around edited payload JSON, keeping the old signature. */
function withPayload(value: string, edit: (p: Record<string, any>) => void) {
  const [payload, signature] = value.split(".") as [string, string];
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  edit(parsed);
  return `${Buffer.from(JSON.stringify(parsed)).toString("base64url")}.${signature}`;
}

describe("issueToken", () => {
  test("allow issues a 60 second token bound to the call", async () => {
    const token = await issued();
    assert.deepEqual(token.claims, {
      jti: "tok-1",
      agentId: "demo-support-bot",
      tool: "fs.file.write",
      target: "fs:sandbox/drafts/reply.md",
      scope: "write",
      workspace: "demo",
      iat: T0.getTime() / 1000,
      exp: T0.getTime() / 1000 + 60,
      agentPolicyDigest: token.claims.agentPolicyDigest,
    });
    assert.match(token.claims.agentPolicyDigest, /^[0-9a-f]{64}$/);
    assert.equal(token.keyId, await signer.currentKeyId());
  });

  test("hold issues nothing", async () => {
    const result = await issueToken(
      request({ scope: "delete", tool: "fs.file.delete", target: "fs:sandbox/drafts/a.md" }),
      deps({ tool: "fs.file.delete" }),
    );
    assert.equal(result.kind, "held");
    assert.equal("token" in result, false);
    assert.equal(result.check.ruleId, "support-bot-deletes-need-a-human");
  });

  test("deny issues nothing", async () => {
    const result = await issueToken(
      request({ agent: { id: "demo-report-bot" } }),
      deps(),
    );
    assert.equal(result.kind, "denied");
    assert.equal("token" in result, false);
  });

  test("a killed agent gets no token", async () => {
    const result = await issueToken(
      request(),
      deps({
        records: [
          { kind: "kill", agentId: "demo-support-bot", at: T0.toISOString(), by: "op", reason: "" },
        ],
      }),
    );
    assert.equal(result.kind, "denied");
    assert.equal(result.check.ruleId, "nomo:kill-switch");
  });

  test("a request that carries a token is not a renewal", async () => {
    const token = await issued();
    const result = await issueToken(request({ token: token.claims }), deps());
    assert.equal(result.kind, "denied");
    assert.equal(result.check.ruleId, "nomo:invalid-request");
  });

  test("signToken refuses claims a verifier would refuse", async () => {
    const token = await issued();
    await assert.rejects(
      signToken({ ...token.claims, agentId: "Not An Id" }, signer),
      /agentId/,
    );
    await assert.rejects(
      signToken({ ...token.claims, extra: 1 } as never, signer),
      /exactly/,
    );
  });
});

describe("verifyToken", () => {
  test("a fresh token verifies and returns its claims", async () => {
    const token = await issued();
    const verified = await verifyToken(token.value, verifier);
    assert.equal(verified.ok, true);
    if (verified.ok) assert.deepEqual(verified.claims, token.claims);
  });

  const refusals: [string, (v: string) => Promise<unknown> | unknown, RegExp][] = [
    ["a changed claim", (v) => withPayload(v, (p) => (p.claims.target = "fs:sandbox/secrets")), /signature/],
    ["a longer lifetime", (v) => withPayload(v, (p) => (p.claims.exp += 3600)), /signature/],
    ["a flipped signature bit", (v) => {
      const [p, s] = v.split(".") as [string, string];
      const sig = Buffer.from(s, "base64url");
      sig[0]! ^= 1;
      return `${p}.${sig.toString("base64url")}`;
    }, /signature/],
    ["another algorithm", (v) => withPayload(v, (p) => (p.alg = "none")), /algorithm/],
    ["an unknown key id", (v) => withPayload(v, (p) => (p.kid = "dev-other")), /unknown key/],
    ["an extra payload field", (v) => withPayload(v, (p) => (p.admin = true)), /unknown fields/],
    ["another format", (v) => withPayload(v, (p) => (p.v = "nomo.token.v1")), /format/],
    ["three parts", (v) => `${v}.x`, /payload\.signature/],
    ["padding", (v) => `${v}=`, /base64url/],
    ["an oversized value", () => "a".repeat(MAX_TOKEN_LENGTH + 1), /longer/],
    ["an empty string", () => "", /not a string/],
    ["a non-string", () => 42, /not a string/],
  ];
  for (const [name, mutate, why] of refusals)
    test(`refuses ${name}`, async () => {
      const token = await issued();
      const verified = await verifyToken(await mutate(token.value), verifier);
      assert.equal(verified.ok, false);
      if (!verified.ok) {
        assert.equal(verified.ruleId, "nomo:token-invalid");
        assert.match(verified.reason, why);
        assert.equal(verified.reason.includes(token.value), false);
      }
    });

  test("a token from another key is refused", async () => {
    const other = newKey();
    const token = await signToken((await issued()).claims, other);
    const verified = await verifyToken(token.value, verifier);
    assert.equal(verified.ok, false);
  });

  test("a signature over the bare payload, without the domain tag, is refused", async () => {
    const token = await issued();
    const [payload] = token.value.split(".") as [string];
    const bare = await signer.sign(new TextEncoder().encode(payload));
    const forged = `${payload}.${Buffer.from(bare).toString("base64url")}`;
    assert.equal((await verifyToken(forged, verifier)).ok, false);
    assert.match(
      new TextDecoder().decode(tokenSigningPreimage(payload)),
      new RegExp(`^${TOKEN_FORMAT.replaceAll(".", "\\.")}\\n`),
    );
  });
});

describe("checkCall: the proxy side", () => {
  test("a valid token for this call is allowed", async () => {
    const token = await issued();
    const result = await checkCall(callRequest, token.value, callDeps());
    assert.equal(result.decision, "allow");
    assert.ok(result.trace.some((s) => s.ruleId === "nomo:token-valid"));
  });

  test("no token, a forged token and an expired token are denied by name", async () => {
    const token = await issued();
    const missing = await checkCall(callRequest, undefined, callDeps());
    assert.equal(missing.ruleId, "nomo:token-invalid");
    assert.equal(missing.layer, "token");
    assert.equal(missing.trace.at(-1)?.ruleId, "nomo:token-invalid");

    const forged = withPayload(token.value, (p) => (p.claims.scope = "admin"));
    assert.equal(
      (await checkCall(callRequest, forged, callDeps())).ruleId,
      "nomo:token-invalid",
    );

    const late = new Date(T0.getTime() + 60_000);
    assert.equal(
      (await checkCall(callRequest, token.value, callDeps({ now: late }))).ruleId,
      "nomo:token-expired",
    );
  });

  test("a token for one file does not open another", async () => {
    const token = await issued();
    const result = await checkCall(
      { ...callRequest, target: "fs:sandbox/drafts/other.md" },
      token.value,
      callDeps(),
    );
    assert.equal(result.ruleId, "nomo:token-mismatch");
  });

  test("the kill-switch wins over a bad token, and kills a good one", async () => {
    const token = await issued();
    const killed = callDeps({
      records: [
        { kind: "kill", agentId: "demo-support-bot", at: T0.toISOString(), by: "op", reason: "" },
      ],
    });
    assert.equal((await checkCall(callRequest, "garbage", killed)).ruleId, "nomo:kill-switch");
    assert.equal((await checkCall(callRequest, token.value, killed)).ruleId, "nomo:kill-switch");
  });
});
