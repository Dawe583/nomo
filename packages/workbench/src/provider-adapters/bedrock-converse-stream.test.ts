import test from "node:test";
import assert from "node:assert/strict";

import { ProviderRequestError } from "../provider.ts";
import { BedrockConverseStreamAdapter } from "./bedrock-converse-stream.ts";
import { createProviderClient } from "./factory.ts";
import { signSigV4String } from "./aws-sigv4.ts";
import type { ProviderAdapterConfig } from "./types.ts";

const auth = {
  kind: "aws-credentials" as const,
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "fixture-session-token",
};
const config: ProviderAdapterConfig = {
  providerId: "amazon-bedrock",
  transport: "bedrock-converse-stream",
  baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
  auth,
  model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
};

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function frame(headers: readonly [string, string][], payload: unknown): Uint8Array {
  const encodedHeaders = Buffer.concat(headers.map(([name, value]) => {
    const nameBytes = Buffer.from(name);
    const valueBytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([nameBytes.length]), nameBytes, Buffer.from([7, valueBytes.length >> 8, valueBytes.length & 255]), valueBytes]);
  }));
  const body = Buffer.from(JSON.stringify(payload));
  const total = 16 + encodedHeaders.length + body.length;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(encodedHeaders.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const result = Buffer.concat([prelude, encodedHeaders, body, Buffer.alloc(4)]);
  result.writeUInt32BE(crc32(result.subarray(0, result.length - 4)), result.length - 4);
  return result;
}

function event(type: string, payload: unknown): Uint8Array {
  return frame([[":message-type", "event"], [":event-type", type]], payload);
}

function exceptionEvent(type: string, payload: unknown): Uint8Array {
  return frame([[":message-type", "exception"], [":exception-type", type]], payload);
}

function stream(...events: Uint8Array[]): Response {
  const bytes = Buffer.concat(events);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

const completeEvent = event("messageStop", { messageStop: { stopReason: "end_turn" } });

// AWS S3 GET reference vector: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html#example-signature-GET-object
test("matches AWS published S3 SigV4 signing-key signature vector", () => {
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    "20130524T000000Z",
    "20130524/us-east-1/s3/aws4_request",
    "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  ].join("\n");
  assert.equal(
    signSigV4String("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "20130524", "us-east-1", "s3", stringToSign),
    "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("signs Bedrock ConverseStream request and maps streamed text, tool calls and usage", async () => {
  let sentUrl: URL | undefined;
  let sentInit: RequestInit | undefined;
  const response = stream(
    event("messageStart", { messageStart: { role: "assistant" } }),
    event("contentBlockStart", { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tool-1", name: "lookup" } } } }),
    event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "{\"q\":" } } } }),
    event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: "\"x\"}" } } } }),
    event("contentBlockStop", { contentBlockStop: { contentBlockIndex: 0 } }),
    event("contentBlockStart", { contentBlockStart: { contentBlockIndex: 1, start: {} } }),
    event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "done" } } }),
    event("contentBlockStop", { contentBlockStop: { contentBlockIndex: 1 } }),
    completeEvent,
    event("metadata", { metadata: { usage: { inputTokens: 17, outputTokens: 4, totalTokens: 21 } } }),
  );
  const model = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/my-profile";
  const adapter = new BedrockConverseStreamAdapter({ ...config, model }, async (input, init) => {
    sentUrl = new URL(String(input));
    sentInit = init;
    return response;
  }, () => new Date("2015-08-30T12:36:00.000Z"));
  const reply = await adapter.complete(model, [{ role: "user", content: "hello" }], [], new AbortController().signal);

  assert.deepEqual(await adapter.models(), [{ id: model, name: model }]);
  assert.equal(sentUrl?.href, "https://bedrock-runtime.us-east-1.amazonaws.com/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A123456789012%3Ainference-profile%2Fmy-profile/converse-stream");
  assert.equal(sentInit?.method, "POST");
  assert.equal(sentInit?.redirect, "error");
  const headers = new Headers(sentInit?.headers);
  assert.equal(headers.get("x-amz-date"), "20150830T123600Z");
  assert.equal(headers.get("x-amz-security-token"), auth.sessionToken);
  // Independently calculated from AWS SigV4 steps with Node crypto (no AWS SDK).
  const expectedSignature = [
    "2d6cb2e3589bb179",
    "3f03fb60ccea009e",
    "4988f2120ee36a59",
    "b187ee369581d49a",
  ].join("");
  assert.equal(
    headers.get("authorization"),
    `AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${expectedSignature}`,
  );
  assert.deepEqual(JSON.parse(String(sentInit?.body)), {
    messages: [{ role: "user", content: [{ text: "hello" }] }],
    inferenceConfig: { maxTokens: 4096 },
  });
  assert.deepEqual(reply, {
    message: {
      role: "assistant",
      content: "done",
      tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
    },
    usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 },
  });
  assert.equal(adapter.redact(`failed ${auth.secretAccessKey} ${auth.sessionToken}`), "failed [redacted] [redacted]");
});

test("maps system prompts, prior tool results and function declarations", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new BedrockConverseStreamAdapter(config, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body));
    return stream(
      event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } }),
      completeEvent,
    );
  }, () => new Date("2015-08-30T12:36:00.000Z"));
  await adapter.complete(config.model!, [
    { role: "system", content: "Be safe" },
    { role: "user", content: "lookup" },
    { role: "assistant", content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
    { role: "tool", content: "found", tool_call_id: "tool-1" },
  ], [{ type: "function", function: { name: "lookup", description: "Search", parameters: { type: "object", properties: { q: { type: "string" } } } } }], new AbortController().signal);
  assert.deepEqual(requestBody, {
    messages: [
      { role: "user", content: [{ text: "lookup" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "tool-1", name: "lookup", input: { q: "x" } } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "tool-1", content: [{ text: "found" }] } }] },
    ],
    system: [{ text: "Be safe" }],
    toolConfig: {
      tools: [{
        toolSpec: {
          name: "lookup",
          description: "Search",
          inputSchema: { json: { type: "object", properties: { q: { type: "string" } } } },
        },
      }],
    },
    inferenceConfig: { maxTokens: 4096 },
  });
});
test("maps modeled stream exceptions to safe provider statuses", async () => {
  const cases: readonly (readonly [string, number])[] = [
    ["validationException", 400],
    ["throttlingException", 429],
    ["serviceUnavailableException", 503],
    ["modelStreamErrorException", 424],
    ["internalServerException", 500],
  ];
  for (const [exceptionType, status] of cases) {
    const client = new BedrockConverseStreamAdapter(config, async () =>
      stream(exceptionEvent(exceptionType, { message: "raw private exception body" })),
    );
    await assert.rejects(
      client.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal),
      error => error instanceof ProviderRequestError &&
        error.status === status &&
        !error.message.includes("raw private exception body"),
    );
  }
  const unknownClient = new BedrockConverseStreamAdapter(config, async () =>
    stream(exceptionEvent("__proto__", { message: "raw private exception body" })),
  );
  await assert.rejects(
    unknownClient.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal),
    error => error instanceof Error &&
      !(error instanceof ProviderRequestError) &&
      error.message === "Bedrock stream returned an error event." &&
      !error.message.includes("raw private exception body"),
  );
});

test("fails closed on unsupported content block delta variants", async () => {
  const client = new BedrockConverseStreamAdapter(config, async () => stream(
    event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "hidden reasoning" } } } }),
    event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 1, delta: { text: "answer" } } }),
    completeEvent,
  ));
  await assert.rejects(
    client.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal),
    /unsupported content block delta/,
  );
});

test("validates Bedrock tool names and supplied descriptions before requesting", async () => {
  let requested = false;
  const client = new BedrockConverseStreamAdapter(config, async () => {
    requested = true;
    return stream(completeEvent);
  });
  const invalidTools = [
    { type: "function", function: { name: "", parameters: { type: "object" } } },
    { type: "function", function: { name: "lookup.tool", parameters: { type: "object" } } },
    { type: "function", function: { name: "x".repeat(65), parameters: { type: "object" } } },
    { type: "function", function: { name: "lookup", description: "", parameters: { type: "object" } } },
    { type: "function", function: { name: "lookup", description: null, parameters: { type: "object" } } },
  ];
  for (const tool of invalidTools) {
    await assert.rejects(
      client.complete(config.model!, [{ role: "user", content: "x" }], [tool], new AbortController().signal),
      /Provider tool definition is invalid/,
    );
  }
  assert.equal(requested, false);
});


test("refuses foreign endpoints, corrupt or truncated frames and partial model output", async () => {
  assert.throws(
    () => new BedrockConverseStreamAdapter({ ...config, baseUrl: "https://attacker.example" }, async () => stream(completeEvent), () => new Date()),
    /official Bedrock Runtime endpoint/,
  );
  const badCrc = Buffer.from(completeEvent);
  badCrc[badCrc.length - 1] ^= 1;
  const badClient = new BedrockConverseStreamAdapter(config, async () => stream(badCrc), () => new Date("2015-08-30T12:36:00.000Z"));
  await assert.rejects(badClient.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal), /checksum/);

  const truncated = new BedrockConverseStreamAdapter(config, async () => stream(completeEvent.subarray(0, 10)), () => new Date("2015-08-30T12:36:00.000Z"));
  await assert.rejects(truncated.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal), /ended before completion/);

  const limited = new BedrockConverseStreamAdapter(config, async () => stream(event("messageStop", { messageStop: { stopReason: "max_tokens" } })), () => new Date("2015-08-30T12:36:00.000Z"));
  await assert.rejects(limited.complete(config.model!, [{ role: "user", content: "x" }], [], new AbortController().signal), /blocked or truncated/);
});
test("factory routes typed AWS credential profiles to Bedrock and rejects auth mismatches", async () => {
  let called = false;
  const client = createProviderClient(config, async (_input, init) => {
    called = true;
    assert.equal(new Headers(init?.headers).get("x-amz-security-token"), auth.sessionToken);
    return stream(
      event("contentBlockDelta", { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "ok" } } }),
      completeEvent,
    );
  });
  const reply = await client.complete(config.model!, [{ role: "user", content: "hello" }], [], new AbortController().signal);
  assert.equal(called, true);
  assert.equal(reply.message.content, "ok");
  assert.throws(
    () => createProviderClient({ ...config, providerId: "google", transport: "google-generative-ai" }),
    /different authentication profile/,
  );
});
