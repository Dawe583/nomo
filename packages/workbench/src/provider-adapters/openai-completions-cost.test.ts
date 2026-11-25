import test from "node:test";
import assert from "node:assert/strict";

import { defaultHarnessSettings } from "../harness-settings.ts";
import { OpenAICompletionsAdapter } from "./openai-completions.ts";
import type { ModelReply } from "../provider.ts";

/**
 * The harness can only record what a call cost if the adapter keeps the number
 * the provider sent. Zen reports it as `usage.cost` beside the tokens, and a
 * gateway that reports nothing must not gain a fabricated zero.
 */
const reply = async (usage: unknown): Promise<ModelReply> => {
  const adapter = new OpenAICompletionsAdapter({
    origin: "https://zen.test/v1",
    resolveSettings: () => defaultHarnessSettings(),
    response: async () => new Response("{}", { status: 200 }),
    decode: async () => ({
      choices: [
        {
          message: { role: "assistant", content: "ready" },
          finish_reason: "stop",
        },
      ],
      usage: usage as ModelReply["usage"],
    }),
    streamReply: async () => {
      throw new Error("the streaming path is not used by this test");
    },
  });
  return adapter.complete(
    "muse-spark-1.3-contributor-free",
    [{ role: "user", content: "say ready" }],
    [],
    new AbortController().signal,
  );
};

test("a provider-reported cost reaches the reply as cost_usd", async () => {
  const result = await reply({
    prompt_tokens: 96,
    completion_tokens: 26,
    total_tokens: 122,
    cost: 0.0004,
  });

  assert.equal(result.usage?.cost_usd, 0.0004);
  assert.equal(result.usage?.total_tokens, 122, "the token counts are unchanged");
});

test("a usage object without a cost does not gain one", async () => {
  const result = await reply({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });

  assert.equal(
    Object.prototype.hasOwnProperty.call(result.usage ?? {}, "cost_usd"),
    false,
    "a missing cost must stay missing, not become zero",
  );
});

test("a non-numeric cost is ignored rather than coerced", async () => {
  const result = await reply({ total_tokens: 6, cost: "0.0004" });

  assert.equal(Object.prototype.hasOwnProperty.call(result.usage ?? {}, "cost_usd"), false);
  assert.equal(result.usage?.total_tokens, 6);
});
