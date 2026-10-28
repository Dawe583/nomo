import test from "node:test";
import assert from "node:assert/strict";
import { PrimeInferenceProvider } from "./prime-inference.ts";

test("Prime discovery hides routes that explicitly report no tool support", async () => {
  let requestCount = 0;
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () => {
      requestCount += 1;
      return Response.json({
        data: [
          { id: "classifier", supported_parameters: ["reasoning"] },
          { id: "tool-route", supported_parameters: ["tools", "reasoning"] },
          { id: "legacy-route" },
          { id: "empty-metadata-route", supported_parameters: [] },
        ],
      });
    },
  );

  const models = await provider.models();
  assert.deepEqual(
    models.map((model) => model.id),
    ["tool-route", "legacy-route", "empty-metadata-route"],
  );
  await assert.rejects(
    provider.complete("classifier", [], [], new AbortController().signal),
    /not present in the Prime Inference model catalog/,
  );
  assert.equal(requestCount, 1);
});

test("Prime discovery still rejects duplicate IDs when their routes lack tool support", async () => {
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () =>
      Response.json({
        data: [
          { id: "classifier", supported_parameters: ["reasoning"] },
          { id: "classifier", supported_parameters: ["reasoning"] },
        ],
      }),
  );

  await assert.rejects(provider.models(), /invalid model catalog/);
});

test("Prime discovery strips control characters from display names", async () => {
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () =>
      Response.json({
        data: [
          { id: "model-id", display_name: "\u0001  Model\u007f Name\u009f " },
          { id: "fallback-id", display_name: "\u0000\u007f" },
        ],
      }),
  );

  assert.deepEqual(await provider.models(), [
    { id: "model-id", name: "Model Name" },
    { id: "fallback-id", name: "fallback-id" },
  ]);
});

test("Prime discovery rejects model IDs containing control characters", async () => {
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () => Response.json({ data: [{ id: "model\u0001id" }] }),
  );

  await assert.rejects(provider.models(), /invalid model catalog/);
});

test("Prime discovery bounds IDs by Unicode code points", async () => {
  const tooLongId = "😀".repeat(1_025);
  const tooLongProvider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () => Response.json({ data: [{ id: tooLongId }] }),
  );
  await assert.rejects(tooLongProvider.models(), /invalid model catalog/);

  const maxLengthId = "😀".repeat(1_024);
  const maxLengthProvider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () => Response.json({ data: [{ id: maxLengthId }] }),
  );
  assert.deepEqual(await maxLengthProvider.models(), [
    { id: maxLengthId, name: maxLengthId },
  ]);
});

test("Prime discovery maps complete live specs and omits partial capability claims", async () => {
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () =>
      Response.json({
        data: [
          {
            id: "vision-reasoning",
            display_name: "Vision Reasoning",
            supported_parameters: ["tools"],
            specs: {
              context_window: 100,
              max_output_tokens: 120,
              supports_reasoning: true,
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
          {
            id: "partial-spec",
            specs: { context_window: 2_000 },
          },
        ],
      }),
  );

  assert.deepEqual(await provider.models(), [
    {
      id: "vision-reasoning",
      name: "Vision Reasoning",
      contextWindow: 100,
      maxTokens: 100,
      capabilities: ["text", "image", "reasoning", "tools"],
    },
    { id: "partial-spec", name: "partial-spec" },
  ]);
});

test("Prime discovery excludes evaluation-only outputs from chat completions", async () => {
  let requestCount = 0;
  const provider = new PrimeInferenceProvider(
    { baseUrl: "https://api.pinference.ai/api/v1", apiKey: "fixture-key" },
    async () => {
      requestCount++;
      return Response.json({
        data: [
          {
            id: "chat-model",
            specs: { modalities: { output: ["text"] } },
          },
          {
            id: "evaluation-model",
            specs: { modalities: { output: ["decisions"] } },
          },
          { id: "legacy-model" },
        ],
      });
    },
  );

  assert.deepEqual(
    (await provider.models()).map((model) => model.id),
    ["chat-model", "legacy-model"],
  );
  await assert.rejects(
    provider.complete("evaluation-model", [], [], new AbortController().signal),
    /not present in the Prime Inference model catalog/,
  );
  assert.equal(requestCount, 1);
});
