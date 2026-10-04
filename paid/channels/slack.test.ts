import test, { describe } from "node:test";
import assert from "node:assert/strict";

import type { HeldCall } from "../../packages/policy/src/hold.ts";
import {
  checkSlackWebhookUrl,
  SlackChannel,
  postHoldToSlack,
  slackPayload,
} from "./slack.ts";


const call: HeldCall = {
  id: "h0001",
  tool: "postgres.row.delete",
  klass: "r1",
  blastRadius: 41883,
  ruleIndex: 4,
  rationale: "nothing matched, so the call waits for a person",
  args: {},
  heldAt: 1,
  expiresAt: 120001,
  notify: ["cli", "slack"],
};

describe("the Slack approval channel", () => {
  test("builds a payload with title, rationale and operator URLs", () => {
    const payload = slackPayload(call, (id) => `https://operator.example/holds/${id}`);
    assert.equal(payload.text, "held: postgres.row.delete (r1, 41883 touched)\nnothing matched, so the call waits for a person");
    assert.ok(JSON.stringify(payload.blocks).includes("Approve"));
    assert.ok(JSON.stringify(payload.blocks).includes("Deny"));
    assert.ok(JSON.stringify(payload.blocks).includes("https://operator.example/holds/h0001?decision=approve"));
    assert.ok(JSON.stringify(payload.blocks).includes("https://operator.example/holds/h0001?decision=deny"));
  });

  test("a disabled channel is a no-op", async () => {
    let posted = 0;
    const channel = new SlackChannel({ enabled: false }, async () => {
      posted += 1;
      return { ok: true, status: 200, text: async () => "" };
    });
    assert.deepEqual(await channel.postHold(call, () => "https://operator.example/holds/h0001"), { kind: "disabled" });
    assert.equal(posted, 0);
  });

  test("posts JSON to the webhook when enabled", async () => {
    let seenUrl = "";
    let seenBody = "";
    const result = await postHoldToSlack(
      "https://hooks.slack.test/T000/B000/secret",
      call,
      (id) => `https://operator.example/holds/${id}?source=slack`,
      async (url, init) => {
        seenUrl = url;
        seenBody = init.body;
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");

        assert.equal(init.headers["content-type"], "application/json");
        return { ok: true, status: 200, text: async () => "ok" };
      },
    );
    assert.deepEqual(result, { kind: "posted", status: 200 });
    assert.equal(seenUrl, "https://hooks.slack.test/T000/B000/secret");
    assert.ok(seenBody.includes("held: postgres.row.delete"));
    assert.ok(seenBody.includes("decision=approve"));
    assert.ok(seenBody.includes("decision=deny"));
  });

  test("reports HTTP failures without throwing", async () => {
    const channel = new SlackChannel({ enabled: true, webhookUrl: "https://hooks.slack.test/fail" }, async () => ({
      ok: false,
      status: 500,
      text: async () => "bad webhook",
    }));
    const result = await channel.postHold(call, () => "https://operator.example/holds/h0001");
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.reason, /500: bad webhook/);
  });

  test("reports fetch failures and missing webhook configuration", async () => {
    const failed = new SlackChannel({ enabled: true, webhookUrl: "https://hooks.slack.test/fail" }, async () => {
      throw new Error("network down");
    });
    assert.deepEqual(await failed.postHold(call, () => "https://operator.example/holds/h0001"), {
      kind: "failed",
      reason: "network down",
    });

    const missing = new SlackChannel({ enabled: true });
    assert.deepEqual(await missing.postHold(call, () => "https://operator.example/holds/h0001"), {
      kind: "failed",
      reason: "slack webhook url is required when enabled",
    });
  });

  test("a webhook URL that is not https is refused before anything is posted", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["hooks.slack.test/T000/B000/secret", "slack webhook url is not a URL"],
      ["http://hooks.slack.test/T000/B000/secret", "slack webhook url must be https"],
      ["https://user:pw@hooks.slack.test/T000/B000/secret", "slack webhook url cannot carry credentials"],
      ["https://hooks.slack.test/T000/B000/secret#x", "slack webhook url cannot carry a fragment"],
    ];
    for (const [url, expected] of cases) assert.equal(checkSlackWebhookUrl(url), expected);
    assert.equal(checkSlackWebhookUrl("https://hooks.slack.test/T000/B000/secret"), undefined);
  });

  test("a refused URL never reaches the network and never quotes the secret", async () => {
    const url = "http://hooks.slack.test/T000/B000/secret";
    let posted = 0;
    const channel = new SlackChannel({ enabled: true, webhookUrl: url }, async () => {
      posted += 1;
      return { ok: true, status: 200, text: async () => "" };
    });
    const result = await channel.postHold(call, () => "https://operator.example/holds/h0001");
    assert.equal(posted, 0);
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") {
      assert.equal(result.reason, "slack webhook url must be https");
      assert.ok(!result.reason.includes("secret"));
      assert.ok(!result.reason.includes(url));
    }
  });

  test("a failure reason is capped and stripped of control characters", async () => {
    const esc = String.fromCharCode(27);
    const reason = await postHoldToSlack(
      "https://hooks.slack.test/T000/B000/secret",
      call,
      (id) => `https://operator.example/holds/${id}`,
      async () => ({ ok: false, status: 500, text: async () => `${esc}[31m${"x".repeat(400)}${esc}[0m` }),
    );
    assert.equal(reason.kind, "failed");
    if (reason.kind !== "failed") return;
    assert.ok(!reason.reason.includes(esc), reason.reason);
    assert.ok(reason.reason.length <= "slack webhook returned 500: ".length + 201, `${reason.reason.length}`);
  });

  test("a hostile endpoint cannot echo the webhook secret back into the reason", async () => {
    const url = "https://hooks.slack.test/T000/B000/secret";
    const hostile = await postHoldToSlack(url, call, () => "https://operator.example/holds/h0001", async () => ({
      ok: false,
      status: 400,
      text: async () => `no_service for ${url} (secret) at hooks.slack.test/T000/B000/secret`,
    }));
    assert.equal(hostile.kind, "failed");
    if (hostile.kind !== "failed") return;
    assert.ok(!hostile.reason.includes("secret"), hostile.reason);
    assert.ok(hostile.reason.includes("[redacted]"), hostile.reason);

    const thrown = await postHoldToSlack(url, call, () => "https://operator.example/holds/h0001", async () => {
      throw new Error(`connect ECONNREFUSED for ${url}`);
    });
    assert.equal(thrown.kind, "failed");
    if (thrown.kind !== "failed") return;
    assert.ok(!thrown.reason.includes("secret"), thrown.reason);
  });
});
