import assert from "node:assert/strict";
import test from "node:test";
import { assertProviderDescriptorInManifest } from "../provider-catalog.ts";
import { createProviderClient } from "./factory.ts";
import { signBedrockRequest } from "./aws-sigv4.ts";
import type { ProviderAdapterConfig } from "./types.ts";

const config: ProviderAdapterConfig = {
  providerId: "bedrock-mantle",
  transport: "openai-responses",
  baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
  auth: { kind: "aws-credential-chain" },
  model: "openai.gpt-5.4",
};

const unusedRequest: typeof fetch = async () => {
  throw new Error("unexpected provider request");
};

test("Bedrock Mantle supports API keys and its manifest-backed host credential chain", () => {
  assert.doesNotThrow(() => assertProviderDescriptorInManifest(config));
  assert.doesNotThrow(() => assertProviderDescriptorInManifest({
    ...config,
    auth: { kind: "api-key", apiKey: "fixture-key" },
  }));
  assert.throws(
    () => assertProviderDescriptorInManifest({ ...config, providerId: "openai" }),
    /requires api-key authentication/,
  );
});

test("Bedrock Mantle model listing stays local and does not resolve AWS credentials", async () => {
  let credentialLookups = 0;
  const client = createProviderClient(config, unusedRequest, {}, {
    awsCredentialProvider: async () => {
      credentialLookups++;
      throw new Error("must not resolve credentials during catalog listing");
    },
  });

  assert.deepEqual(await client.models(), [{ id: config.model, name: config.model }]);
  assert.equal(credentialLookups, 0);
});

test("Bedrock Mantle SigV4 matches a fixed independent signing fixture", () => {
  const headers = signBedrockRequest(
    new URL("https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses"),
    "{\"model\":\"fixture\"}",
    {
      accessKeyId: "AKIAFIXTURE",
      secretAccessKey: "fixture-secret-access-key",
      sessionToken: "fixture-session-token",
    },
    "us-east-1",
    new Date("2026-01-02T03:04:05.000Z"),
    "bedrock-mantle",
  );
  assert.equal(headers["x-amz-content-sha256"], "0598e1374701ed810b063d222dab05fb508ce02a4d55c2bdf35b9eca0af87fa4");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAFIXTURE/20260102/us-east-1/bedrock-mantle/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=aeae418c77087522ff09ebdc94ed61558e025453172831afbe12f82bf57f3b89",
  );
});

test("Bedrock Mantle completion signs the Responses request and redacts AWS secrets", async () => {
  const secretAccessKey = "fixture-secret-access-key";
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const client = createProviderClient(config, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      id: "resp-fixture",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: secretAccessKey }] },
        { type: "function_call", id: "item-1", call_id: "call-1", name: "lookup", arguments: JSON.stringify({ key: secretAccessKey }) },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    });
  }, {}, {
    awsCredentialProvider: async () => ({
      accessKeyId: "AKIAFIXTURE",
      secretAccessKey,
      sessionToken: "fixture-session-token",
    }),
  });

  const reply = await client.complete(
    config.model!,
    [{ role: "user", content: "hello" }],
    [{ function: { name: "lookup", description: "fixture", parameters: { type: "object" } } }],
    new AbortController().signal,
  );
  const headers = new Headers(requestInit?.headers);
  const authorization = headers.get("authorization") ?? "";

  assert.equal(requestUrl, "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses");
  assert.equal(requestInit?.method, "POST");
  assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request,/);
  assert.equal(headers.get("x-amz-security-token"), "fixture-session-token");
  assert.equal(authorization.startsWith("Bearer "), false);
  assert.equal(requestBody?.model, config.model);
  assert.equal(reply.message.content, "[redacted]");
  assert.equal(client.redact(reply.message.content ?? ""), "[redacted]");
  assert.equal(reply.message.tool_calls?.[0]?.function.arguments, "{\"key\":\"[redacted]\"}");
});

test("Bedrock Mantle streaming redacts AWS credentials split across text deltas", async () => {
  const secretAccessKey = "fixture-secret-access-key";
  const events = [
    { type: "response.output_text.delta", delta: "prefix fixture-secret-" },
    { type: "response.output_text.delta", delta: "access-key suffix" },
    {
      type: "response.completed",
      response: {
        id: "resp-secret",
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: `prefix ${secretAccessKey} suffix` }] }],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    },
  ];
  const client = createProviderClient(config, async () => new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  ), {}, {
    awsCredentialProvider: async () => ({
      accessKeyId: "AKIAFIXTURE",
      secretAccessKey,
      sessionToken: "fixture-session-token",
    }),
  });
  const deltas: string[] = [];
  await client.complete(
    config.model!,
    [{ role: "user", content: "hello" }],
    [],
    new AbortController().signal,
    delta => { deltas.push(delta); },
  );

  assert.equal(deltas.join(""), "prefix [redacted] suffix");
  assert.equal(deltas.join("").includes(secretAccessKey), false);
});

test("Bedrock Mantle concurrent completions keep signatures and redaction bound to their credentials", async () => {
  const secrets = {
    first: "first-secret-access-key",
    second: "second-secret-access-key",
  };
  const accessKeys = { first: "AKIAFIRST", second: "AKIASECOND" };
  const authorizations: Record<string, string> = {};
  let credentialLookups = 0;
  const client = createProviderClient(config, async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      input: readonly { content: readonly { text?: string }[] }[];
    };
    const name = body.input[0]?.content[0]?.text as keyof typeof secrets;
    authorizations[name] = new Headers(init?.headers).get("authorization") ?? "";
    const secret = secrets[name];
    const events = [
      { type: "response.output_text.delta", delta: `prefix ${secret.slice(0, 12)}` },
      { type: "response.output_text.delta", delta: `${secret.slice(12)} suffix` },
      {
        type: "response.completed",
        response: {
          id: `resp-${name}`,
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: `prefix ${secret} suffix` }] }],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        },
      },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  }, {}, {
    awsCredentialProvider: async () => {
      const name = credentialLookups++ === 0 ? "first" : "second";
      return { accessKeyId: accessKeys[name], secretAccessKey: secrets[name] };
    },
  });
  const firstDeltas: string[] = [];
  const secondDeltas: string[] = [];

  const [firstReply, secondReply] = await Promise.all([
    client.complete(config.model!, [{ role: "user", content: "first" }], [], new AbortController().signal, delta => { firstDeltas.push(delta); }),
    client.complete(config.model!, [{ role: "user", content: "second" }], [], new AbortController().signal, delta => { secondDeltas.push(delta); }),
  ]);

  assert.ok(authorizations.first?.startsWith("AWS4-HMAC-SHA256 Credential=AKIAFIRST/"));
  assert.ok(authorizations.first?.includes("/us-east-1/bedrock-mantle/aws4_request,"));
  assert.ok(authorizations.second?.startsWith("AWS4-HMAC-SHA256 Credential=AKIASECOND/"));
  assert.ok(authorizations.second?.includes("/us-east-1/bedrock-mantle/aws4_request,"));
  assert.equal(firstDeltas.join(""), "prefix [redacted] suffix");
  assert.equal(secondDeltas.join(""), "prefix [redacted] suffix");
  assert.equal(firstReply.message.content, "prefix [redacted] suffix");
  assert.equal(secondReply.message.content, "prefix [redacted] suffix");
});

test("Bedrock Mantle credential failures do not make a provider request or expose credential text", async () => {
  let requests = 0;
  const client = createProviderClient(config, async () => {
    requests++;
    throw new Error("request must not run");
  }, {}, {
    awsCredentialProvider: async () => {
      throw new Error("fixture secret must stay hidden");
    },
  });

  await assert.rejects(
    client.complete(config.model!, [{ role: "user", content: "hello" }], [], new AbortController().signal),
    /AWS credential chain could not resolve valid credentials/,
  );
  assert.equal(requests, 0);
});
