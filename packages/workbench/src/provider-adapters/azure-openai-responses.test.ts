import test from "node:test";
import assert from "node:assert/strict";
import { createProviderClient } from "./factory.ts";
import { ProviderRequestError } from "../provider.ts";
import type { ProviderAdapterConfig } from "./types.ts";

const config: ProviderAdapterConfig = {
  providerId: "azure",
  transport: "azure-openai-responses",
  baseUrl: "https://fixture-resource.openai.azure.com",
  auth: { kind: "api-key", apiKey: "azure-fixture-key" },
  azureOptions: { apiVersion: "v1" },
};

const eventStream = (events: readonly unknown[]) => new Response(
  events.map(event => `event: ${(event as { type?: string }).type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } },
);

test("Azure Responses uses the Azure resource route, api-version query, and api-key header", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  let requestBody: Record<string, unknown> | undefined;
  const client = createProviderClient(config, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    requestBody = JSON.parse(String(init?.body));
    return eventStream([
      { type: "response.output_text.delta", delta: "ready" },
      { type: "response.output_item.added", output_index: 0, item: { id: "item-1", type: "function_call", call_id: "call-1", name: "inspect", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "item-1", delta: "{\"ok\":true}" },
      { type: "response.function_call_arguments.done", output_index: 0, item_id: "item-1", arguments: "{\"ok\":true}" },
      { type: "response.completed", response: {
        id: "resp-azure",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "ready" }] },
          { type: "function_call", call_id: "call-1", name: "inspect", arguments: "{\"ok\":true}" },
        ],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
      } },
    ]);
  });
  const deltas: string[] = [];
  const reply = await client.complete("deployment-fixture", [{ role: "user", content: "inspect" }], [], new AbortController().signal, value => { deltas.push(value); });

  assert.equal(requestUrl, "https://fixture-resource.openai.azure.com/openai/v1/responses?api-version=v1");
  assert.equal(requestInit?.method, "POST");
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers["api-key"], "azure-fixture-key");
  assert.equal(headers.authorization, undefined);
  assert.equal(requestInit?.redirect, "error");
  assert.equal(requestBody?.model, "deployment-fixture");
  assert.equal(requestBody?.stream, true);
  assert.deepEqual(deltas, ["ready"]);
  assert.equal(reply.message.content, "ready");
  assert.deepEqual(reply.message.tool_calls?.map(call => [call.id, call.function.name, call.function.arguments]), [
    ["call-1", "inspect", "{\"ok\":true}"],
  ]);
  assert.deepEqual(reply.usage, { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 });
  assert.equal(reply.response_id, "resp-azure");
});

test("Azure Responses rejects non-Azure resources, unrecognized resource paths, and unsupported API versions", () => {
  const create = (overrides: Partial<ProviderAdapterConfig>) => () => createProviderClient({ ...config, ...overrides }, async () => {
    throw new Error("request must not run");
  });
  assert.throws(create({ baseUrl: "https://api.openai.com/v1" }), /Azure OpenAI resource endpoint/);
  assert.throws(create({ baseUrl: "https://fixture-resource.openai.azure.com/openai/deployments/other" }), /Azure OpenAI resource endpoint/);
  assert.throws(create({ baseUrl: "https://fixture-resource.openai.azure.com:8443" }), /Azure OpenAI resource endpoint/);
  assert.throws(create({ baseUrl: "https://fixture-resource.openai.azure.com/openai/v1?api-version=v1" }), /Azure OpenAI resource endpoint/);
  const unsupportedVersion = { ...config, azureOptions: { apiVersion: "2025-04-01-preview" } } as unknown as ProviderAdapterConfig;
  assert.throws(() => createProviderClient(unsupportedVersion), /unsupported Azure Responses API version/);
});

test("Azure Responses model discovery is resource-bound and uses Azure API-key auth", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const client = createProviderClient(config, async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return Response.json({ data: [{ id: "deployment-fixture" }] });
  });
  assert.deepEqual(await client.models(), [{ id: "deployment-fixture", name: "deployment-fixture" }]);
  assert.equal(requestUrl, "https://fixture-resource.openai.azure.com/openai/v1/models?api-version=v1");
  const headers = requestInit?.headers as Record<string, string>;
  assert.equal(headers["api-key"], "azure-fixture-key");
  assert.equal(headers.authorization, undefined);
  assert.equal(requestInit?.redirect, "error");
});
test("Azure Responses accepts the pinned Prime provider identity with the official route", async () => {
  let requestUrl = "";
  const client = createProviderClient({ ...config, providerId: "azure-openai-responses", baseUrl: "https://fixture-resource.openai.azure.com/openai/v1" }, async input => {
    requestUrl = String(input);
    return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] });
  });
  await client.complete("deployment-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal);
  assert.equal(requestUrl, "https://fixture-resource.openai.azure.com/openai/v1/responses?api-version=v1");
});


test("Azure Responses reports HTTP failures without exposing response bodies", async () => {
  let requestInit: RequestInit | undefined;
  const client = createProviderClient(config, async (_input, init) => {
    requestInit = init;
    return new Response("azure secret diagnostic", { status: 401 });
  });
  await assert.rejects(
    client.complete("deployment-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal),
    error => error instanceof ProviderRequestError && error.status === 401 && !String(error).includes("azure secret diagnostic"),
  );
  assert.equal(requestInit?.redirect, "error");
});

test("Azure Responses rejects malformed and unterminated streams", async () => {
  const client = (events: readonly string[]) => createProviderClient(config, async () => new Response(
    events.join(""),
    { headers: { "content-type": "text/event-stream" } },
  ));
  await assert.rejects(
    client(["data: {bad json}\n\n"]).complete("deployment-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal, () => {}),
    /malformed stream data/,
  );
  await assert.rejects(
    client(['data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"partial"}]}]}}\n']).complete("deployment-fixture", [{ role: "user", content: "go" }], [], new AbortController().signal, () => {}),
    /ended before completion/,
  );
});
