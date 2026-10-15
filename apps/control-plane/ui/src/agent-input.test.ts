import test from "node:test";
import assert from "node:assert/strict";
import { agentOptions, agentInput, sessionAgent, DEFAULT_AGENT_CONTEXT_TOKENS } from "./agent-input.ts";

test("agent choices combine server presets and custom profiles without duplicate ids", () => {
  assert.deepEqual(
    agentOptions({
      agents: [
        { id: "default", name: "Default" },
        { id: "audit", name: "Audit" },
      ],
      profiles: [
        { id: "audit", name: "Audit profile" },
        { id: "local", name: "Local" },
      ],
    }).map((row) => row.id),
    ["default", "audit", "local"],
  );
  assert.deepEqual(agentOptions(undefined), []);
});

test("profile payload uses the explicit tool allowlist and bounded numeric fields", () => {
  assert.deepEqual(
    agentInput({
      id: "audit",
      name: " Auditor ",
      systemPrompt: "Inspect only",
      allowedTools: "nomo_document_read\n nomo_document_list \n",
      policyProfile: "default",
      maxTurns: "4",
      maxContextTokens: "4096",
      secret: "not an API field",
    }),
    {
      id: "audit",
      name: "Auditor",
      systemPrompt: "Inspect only",
      allowedTools: ["nomo_document_read", "nomo_document_list"],
      policyProfile: "default",
      maxTurns: 4,
      maxContextTokens: 4096,
    },
  );
  assert.throws(
    () => agentInput({ maxTurns: "0", maxContextTokens: "4096" }),
    /positive integer/,
  );
  assert.throws(
    () => agentInput({ maxTurns: "1.5", maxContextTokens: "4096" }),
    /positive integer/,
  );
});

test("cloud agent defaults use the host execution preference, never a local preset", () => {
  const catalog = { agents: [{ id: "cloud", name: "Cloud" }, { id: "prime-agent", name: "Prime" }] };
  const preferences = { defaultAgent: "prime-agent", defaultAgentPreset: "default" };
  assert.equal(sessionAgent(undefined, preferences, "cloud", catalog), "prime-agent");
  assert.equal(sessionAgent("cloud", preferences, "cloud", catalog), "cloud");
  assert.equal(sessionAgent("unavailable", preferences, "cloud", catalog), undefined);
  assert.equal(sessionAgent(undefined, { defaultAgent: "missing" }, "cloud", catalog), undefined);
});

test("local agent defaults preserve presets and explicit custom profiles", () => {
  const catalog = { agents: [{ id: "default", name: "Default" }], profiles: [{ id: "custom", name: "Custom" }] };
  assert.equal(sessionAgent(undefined, { defaultAgent: "cloud", defaultAgentPreset: "default" }, "local", catalog), "default");
  assert.equal(sessionAgent("custom", { defaultAgentPreset: "default" }, "local", catalog), "custom");
  assert.equal(sessionAgent(undefined, {}, "local", catalog), undefined);
});

test("new profiles reserve room for input and output without raising explicit limits", () => {
  assert.equal(DEFAULT_AGENT_CONTEXT_TOKENS, 32768);
  const defaults = { maxTurns: "8", maxContextTokens: String(DEFAULT_AGENT_CONTEXT_TOKENS) };
  assert.equal(agentInput(defaults).maxContextTokens, 32768);
  assert.equal(agentInput({ ...defaults, maxContextTokens: "512" }).maxContextTokens, 512);
});
