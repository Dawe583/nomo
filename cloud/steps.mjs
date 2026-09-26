import { mutateCloudDocument } from "./recovery.mjs";
import { resolveIntegration } from "./integrations.mjs";
import { integrationClass } from "./oauth.mjs";
import { vercelCall } from "./vercel-integration.mjs";
import { providerFailure } from "../packages/workbench/src/gui.ts";
import {
  createWorkspace,
  executeWorkspaceTool,
  workspaceToolClass,
} from "../packages/workbench/src/workspace.ts";
import { encrypt } from "./store.mjs";
import { read, write, transaction, event, append, decrypt } from "./store.mjs";
import { assertOwner } from "./owner.mjs";
import { ProviderRequestError } from "../packages/workbench/src/provider.ts";
import { provider, rememberProviderFailure } from "./provider.mjs";
import { rpc } from "./mcp.mjs";
import { classifyTool } from "../packages/registry/src/evaluate.ts";
import { loadPolicy } from "../packages/policy/src/rules.ts";
import { decide } from "../packages/policy/src/decide.ts";
import { policyDigest } from "../packages/policy/src/digest.ts";
import { buildAttribution } from "../packages/ledger/src/attribution.ts";
import { canonicalJson } from "../packages/ledger/src/canonical.ts";
import { sha256Hex } from "../packages/ledger/src/sign.ts";
export const CLOUD_POLICY =
  "version: 1\nrules:\n  - match:\n      class: r0\n    decision: allow\n  - match: {}\n    decision: hold\n    seconds: 300\n    notify: [cli]\n";

/**
 * The policy decision for one cloud tool call.
 *
 * Exported so the approval boundary can be tested without a database. A
 * built-in workspace tool gets no exemption: `void_workspace_write` and
 * `void_workspace_delete` are r1 and `CLOUD_POLICY` holds everything that is
 * not r0, so returning `allow` for built-ins would let the agent write managed
 * documents with no human in the loop and no hold to approve.
 */
export function cloudToolDecision(policy, classification, callInfo) {
  return classification.outcome === "classified"
    ? decide(policy, callInfo)
    : { kind: "deny" };
}

/** A hold identifier is derived from public session counters, so a decision is
 * only accepted when it also presents the unguessable token minted with the
 * hold. Comparison is length-checked first because `timingSafeEqual` throws on
 * a length mismatch. */
export function holdTokenMatches(record, presented) {
  const expected = record?.decisionToken;
  if (typeof expected !== "string" || expected.length === 0) return false;
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  // Constant-time over equal-length base64url, so a wrong token reveals nothing
  // about how much of the right one it guessed. No Node builtin: this module
  // compiles into the agent-step workflow.
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1)
    difference |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
  return difference === 0;
}

/** 24 random bytes, base64url, exactly like the local broker's per-record
 * token. Never derived from session state, because a hold identifier is
 * derived from session state.
 *
 * Web Crypto, not `node:crypto`: this module is compiled into the agent-step
 * workflow, whose runtime rejects Node builtins outright. `getRandomValues` is
 * both available there and the stronger primitive, so nothing is weakened. */
export function mintHoldToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
const save = (owner, s, c) => write(owner, `session:${s.id}`, s, c);
export async function advance(owner, id, generation) {
  "use step";
  assertOwner(owner);
  const claim = await transaction(owner, id, async (c) => {
    const s = await read(owner, `session:${id}`, c);
    if (!s || s.generation !== generation || s.status !== "running")
      return { kind: "done" };
    if (s.executing) {
      event(
        s,
        "error",
        "Execution was interrupted. Review the ledger; the tool will not be retried automatically.",
      );
      s.status = "unknown";
      await save(owner, s, c);
      return { kind: "done" };
    }
    if (s.pending) {
      const h = await read(owner, `hold:${s.pending.id}`, c);
      if (h.status === "pending" && h.expiresAt > Date.now())
        return { kind: "wait" };
      const approved = h.status === "approved" && h.decidedAt <= h.expiresAt;
      await append(
        owner,
        {
          ...s.pending.body,
          at: new Date().toISOString(),
          decision: approved ? "hold:approved" : "hold:denied",
        },
        c,
      );
      if (!approved) {
        s.messages.push({
          role: "tool",
          tool_call_id: s.pending.call.id,
          content: "VOID denied the request. Do not retry.",
        });
        s.queue.shift();
        event(s, "tool", `${s.pending.name}: denied`);
        s.pending = null;
        await save(owner, s, c);
        return { kind: "next" };
      }
      s.executing = "tool";
      const job = {
        kind: "tool",
        session: s,
        call: s.pending.call,
        name: s.pending.name,
        args: s.pending.args,
        body: s.pending.body,
        connectorId: s.pending.connectorId,
      };
      s.pending = null;
      await save(owner, s, c);
      return job;
    }
    if (s.queue?.length) {
      const call = s.queue[0],
        index = Number(call.function.name.replace(/^tool_/, "")),
        tool = s.tools[index];
      if (!tool || call.function.name !== `tool_${index}`)
        throw new Error("Provider requested a tool outside the catalog.");
      const args = JSON.parse(call.function.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid tool arguments.");
      const config =
        tool.connectorId && s.connected?.[tool.connectorId]
          ? decrypt(s.connected[tool.connectorId].config)
          : s.upstream
            ? decrypt(s.upstream)
            : {};
      const name = config.mapping?.[tool.name] ?? tool.name;
      const classification = tool.builtin
        ? { outcome: "classified", tone: workspaceToolClass(tool.name) }
        : config.oauthProvider
          ? {
              outcome: "classified",
              tone: integrationClass(config.oauthProvider, tool.name),
            }
          : classifyTool(name, {
              facts: config.facts ?? {},
              args,
            });
      const policy = loadPolicy(config.policy ?? CLOUD_POLICY);
      if (!policy.ok) throw new Error("Invalid cloud policy.");
      const callInfo = {
        tool: name,
        connector: name.split(".")[0],
        workspace: s.workspace,
        klass:
          classification.outcome === "classified" ? classification.tone : "r3",
        blastRadius: undefined,
        arguments: args,
        ...(config.oauthProvider
          ? { automaticUndo: false, provider: config.oauthProvider }
          : {}),
      };
      const decision = cloudToolDecision(policy, classification, callInfo);
      const body = {
        workspace: s.workspace,
        at: new Date().toISOString(),
        tool: name,
        klass: callInfo.klass,
        decision: decision.kind,
        argsDigest: `sha256:${await sha256Hex(new TextEncoder().encode(canonicalJson(args)))}`,
        // The same reason the local proxy binds, so a cloud record is as
        // attributable as a local one and one reader serves both.
        attribution: buildAttribution(policyDigest(policy.policy), decision),
      };
      event(
        s,
        "tool",
        `${tool.name}: requested`,
        {
          tool: tool.name,
          callId: call.id,
          arguments: args,
          klass: callInfo.klass,
          decision: decision.kind,
        },
        "tool.started",
      );
      await append(owner, body, c);
      if (decision.kind === "hold") {
        const holdId = `${s.id}-${s.generation}-${s.turn}-${s.queue.length}`;
        await write(
          owner,
          `hold:${holdId}`,
          {
            // A hold identifier is derived from public session counters, so the
            // record also carries an unguessable possession factor, exactly as
            // `packages/policy/src/approvals.ts` does. The decision route
            // refuses a decision that does not present it.
            holdId,
            sessionId: s.id,
            call: callInfo,
            expiresAt: Date.now() + decision.seconds * 1000,
            decisionToken: mintHoldToken(),
            status: "pending",
            notify: [],
          },
          c,
        );
        s.pending = {
          id: holdId,
          call,
          name: tool.name,
          args,
          body,
          connectorId: tool.connectorId,
        };
        event(s, "tool", `${tool.name}: waiting for your approval`);
        await save(owner, s, c);
        return { kind: "wait" };
      }
      if (decision.kind !== "allow") {
        s.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content:
            "VOID denied an unknown, unclassified or disallowed tool. Do not retry.",
        });
        s.queue.shift();
        event(s, "tool", `${tool.name}: denied by VOID`);
        await save(owner, s, c);
        return { kind: "next" };
      }
      s.executing = "tool";
      await save(owner, s, c);
      return {
        kind: "tool",
        session: s,
        call,
        name: tool.name,
        args,
        body,
        builtin: tool.builtin,
        connectorId: tool.connectorId,
      };
    }
    if (s.turn >= 20 || s.messages.length > 200)
      throw new Error("Session limit reached. Start a new session.");
    s.executing = "model";
    await save(owner, s, c);
    return { kind: "model", session: s };
  });
  if (claim.kind === "done" || claim.kind === "wait" || claim.kind === "next")
    return claim.kind;
  const s = claim.session;
  try {
    const client = await provider(owner, s.provider);
    if (claim.kind === "model") {
      const tools = s.tools.map((tool, index) => ({
        type: "function",
        function: {
          name: `tool_${index}`,
          description: `${tool.name}: ${tool.description ?? ""}`,
          parameters: tool.inputSchema ?? { type: "object", properties: {} },
        },
      }));
      let delta = "",
        flushed = Date.now();
      const flush = async () => {
        if (!delta) return;
        const text = client.redact(delta);
        delta = "";
        flushed = Date.now();
        await transaction(owner, id, async (c) => {
          const current = await read(owner, `session:${id}`, c);
          if (current.status !== "running" || current.generation !== generation)
            return;
          event(current, "assistant", text, {}, "message.delta");
          await save(owner, current, c);
        });
      };
      const reply = await client.complete(
        s.model,
        s.messages,
        tools,
        AbortSignal.timeout(65000),
        async (text) => {
          delta += text;
          if (Date.now() - flushed > 500 || delta.length > 1024) await flush();
        },
      );
      await flush();
      if ((reply.message.tool_calls?.length ?? 0) > 32)
        throw new Error("Too many tool calls in a single batch.");
      await transaction(owner, id, async (c) => {
        const current = await read(owner, `session:${id}`, c);
        if (current.generation !== generation) return;
        if (current.status === "stopping") {
          current.status = "cancelled";
          current.executing = null;
          event(current, "tool", "Stopped", { status: "cancelled" }, "run.status");
          await save(owner, current, c);
          return;
        }
        if (current.status !== "running") return;
        current.executing = null;
        const safeMessage = JSON.parse(
          client.redact(JSON.stringify(reply.message)),
        );
        current.messages.push(safeMessage);
        await rememberProviderFailure(owner, current.provider, { status: 0 }, c);
        current.queue = safeMessage.tool_calls ?? [];
        current.turn++;
        if (reply.message.content)
          event(current, "assistant", client.redact(reply.message.content));
        if (reply.usage)
          event(
            current,
            "usage",
            `${reply.usage.total_tokens ?? "Unknown"} tokens reported by provider`,
            { ...reply.usage, model: s.model, source: "provider", cost: null },
          );
        if (!current.queue.length) {
          current.status = "idle";
          event(current, "tool", "Idle", { status: "idle" }, "run.status");
        }
        await save(owner, current, c);
      });
    } else {
      if (claim.builtin) {
        await transaction(owner, id, async (c) => {
          const current = await read(owner, `session:${id}`, c);
          if (current.generation !== generation) return;
          if (current.status === "stopping") {
            current.status = "cancelled";
            current.executing = null;
            event(current, "tool", "Stopped before dispatch", { status: "cancelled" }, "run.status");
            await save(owner, current, c);
            return;
          }
          if (current.status !== "running") return;
          const saved = await read(owner, `workspace:${id}`, c),
            state = saved ? decrypt(saved) : createWorkspace();
          const input = {
            id: `${id}-${generation}-${s.turn}-${claim.call.id}`,
            name: claim.name,
            arguments: claim.args,
          };
          const managed = [
            "void_workspace_write",
            "void_workspace_delete",
          ].includes(claim.name);
          // Defence in depth. A managed document write is r1, so the policy
          // decision above has already parked it behind a human hold. If this
          // line is ever reached anyway, "cloud-agent" is deliberately absent
          // from AUTHORIZED_WRITE_SURFACES, so the runtime records `denied`
          // and dispatches nothing instead of an agent self-approval.
          const transition = managed
            ? await mutateCloudDocument(owner, current, c, input, "cloud-agent")
            : executeWorkspaceTool(state, input);
          if (!managed)
            await append(
              owner,
              {
                ...claim.body,
                at: new Date().toISOString(),
                decision: transition.result.isError
                  ? "execute:failed"
                  : "execute:completed",
                ...(transition.operation
                  ? {
                      operationId: transition.operation.id,
                      captureDigest: await sha256Hex(
                        canonicalJson(transition.operation),
                      ),
                    }
                  : {}),
              },
              c,
            );
          await write(owner, `workspace:${id}`, encrypt(transition.state), c);
          event(
            current,
            "tool",
            `${claim.name}: ${transition.result.isError ? "failed" : "completed, change captured"}`,
            {
              tool: claim.name,
              callId: claim.call.id,
              result: transition.result,
            },
          );
          if (transition.operation)
            event(
              current,
              "tool",
              `Changed ${transition.operation.path}.`,
              {
                path: transition.operation.path,
                operationId: transition.operation.id,
              },
              "document.changed",
            );
          current.executing = null;
          current.queue.shift();
          current.messages.push({
            role: "tool",
            tool_call_id: claim.call.id,
            content: client.redact(JSON.stringify(transition.result)),
          });
          await save(owner, current, c);
        });
        return "next";
      }
      const connection = claim.connectorId
        ? s.connected?.[claim.connectorId]
        : undefined;
      const config = await resolveIntegration(
        owner,
        decrypt(connection?.config ?? s.upstream),
      );
      const rawResult =
        config.oauthProvider === "vercel"
          ? { result: await vercelCall(config, claim.name, claim.args) }
          : await rpc(
              config,
              "tools/call",
              { name: claim.name, arguments: claim.args },
              connection?.sessionId ?? s.mcpSession,
            );
      const result = config.token
        ? JSON.parse(
            JSON.stringify(rawResult).split(config.token).join("[redacted]"),
          )
        : rawResult;
      await transaction(owner, id, async (c) => {
        const current = await read(owner, `session:${id}`, c);
        await append(
          owner,
          {
            ...claim.body,
            at: new Date().toISOString(),
            decision: result.result?.isError
              ? "execute:failed"
              : "execute:completed",
          },
          c,
        );
        event(
          current,
          "tool",
          `${claim.name}: ${result.result?.isError ? "failed" : "result received"}`,
        );
        current.executing = null;
        if (current.status === "stopping") {
          current.status = "cancelled";
          event(current, "tool", "Stopped after the dispatched tool settled", { status: "cancelled" }, "run.status");
        }
        current.queue.shift();
        current.messages.push({
          role: "tool",
          tool_call_id: claim.call.id,
          content: (config.token
            ? client
                .redact(JSON.stringify(result.result))
                .split(config.token)
                .join("[redacted]")
            : client.redact(JSON.stringify(result.result))
          ).slice(0, 64000),
        });
        await save(owner, current, c);
      });
    }
    return "next";
  } catch (error) {
    await transaction(owner, id, async (c) => {
      const current = await read(owner, `session:${id}`, c);
      if (["running", "stopping"].includes(current.status) && current.generation === generation) {
        if (error instanceof ProviderRequestError)
          await rememberProviderFailure(owner, current.provider, error, c);
        const uncertain = claim.kind === "tool" && !claim.builtin;
        if (uncertain)
          await append(owner, { ...claim.body, at: new Date().toISOString(), decision: "execute:unknown" }, c);
        current.status = uncertain ? "unknown" : current.status === "stopping" ? "cancelled" : "failed";
        current.executing = null;
        event(
          current,
          "error",
          error instanceof ProviderRequestError
            ? providerFailure(error).text
            : "Cloud execution failed. Check provider and tool connectivity. A dispatched tool is not retried automatically.",
          error instanceof ProviderRequestError
            ? providerFailure(error).payload
            : {},
        );
        await save(owner, current, c);
      }
    });
    return "done";
  }
}
export async function fail(owner, id, generation) {
  "use step";
  assertOwner(owner);
  await transaction(owner, id, async (c) => {
    const s = await read(owner, `session:${id}`, c);
    if (s && ["running", "stopping"].includes(s.status) && s.generation === generation) {
      s.status = s.executing === "tool" ? "unknown" : s.status === "stopping" ? "cancelled" : "failed";
      s.executing = null;
      event(
        s,
        "error",
        "Cloud execution stopped. Check provider access and the tool server. An interrupted tool is never automatically retried.",
      );
      await save(owner, s, c);
    }
  });
}
