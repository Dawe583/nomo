import test from "node:test";
import assert from "node:assert/strict";
import { agentOptions, agentInput } from "./agent-input.ts";

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
      allowedTools: "void_document_read\n void_document_list \n",
      policyProfile: "default",
      maxTurns: "4",
      maxContextTokens: "4096",
      secret: "not an API field",
    }),
    {
      id: "audit",
      name: "Auditor",
      systemPrompt: "Inspect only",
      allowedTools: ["void_document_read", "void_document_list"],
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
