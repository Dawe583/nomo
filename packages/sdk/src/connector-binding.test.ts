import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { manifestReader } from "../../connectors/src/manifest.ts";
import type { Connector, ConnectorRegistry } from "../../connectors/src/registry.ts";
import type { LegacyBindingLedgerBody } from "../../proxy/src/legacy-root.ts";
import { connectorLegacyBinding } from "./connector-binding.ts";

const WORKSPACE = "binding-test";

function connector(id: "postgres" | "s3", captured: Array<Readonly<Record<string, unknown>>>): Connector {
  return {
    id,
    surface: id,
    probes: [],
    classify: async (call) => ({ call, facts: [], blastRadius: undefined, notes: [] }),
    async capture(call) {
      captured.push({
        tool: call.tool,
        connector: call.connector,
        arguments: call.arguments,
        workspace: call.workspace,
      });
      const digest = `sha256:${id === "postgres" ? "a" : "b"}`.padEnd(71, "0") as `sha256:${string}`;
      return {
        digest,
        reference: { namespace: `${id}-${WORKSPACE}`, digest, uri: `file://${id}` },
        facts: [],
        capturedAt: "2026-11-27T00:00:00.000Z",
      };
    },
    inverse: async () => { throw new Error("not used"); },
    apply: async () => { throw new Error("not used"); },
  };
}

test("connectorLegacyBinding binds every advertised service tool through its connector", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nomo-sdk-connector-binding-"));
  try {
    const postgresCalls: Array<Readonly<Record<string, unknown>>> = [];
    const s3Calls: Array<Readonly<Record<string, unknown>>> = [];
    const ledger: LegacyBindingLedgerBody[] = [];
    const connectors = {
      postgres: connector("postgres", postgresCalls),
      s3: connector("s3", s3Calls),
    } satisfies ConnectorRegistry;
    const resolver = connectorLegacyBinding({
      connectors,
      snapshotDir: dir,
      ledger: { append: async (body) => { ledger.push(body); } },
      workspace: WORKSPACE,
      now: () => new Date("2026-11-27T00:00:01.000Z"),
    });

    const update = {
      tool: "postgres.row.update",
      connector: "postgres",
      args: { sql: "update public.account set balance = 20 where id = 1" },
      workspace: WORKSPACE,
    };
    const binding = resolver(update);
    assert.notEqual(binding, null);
    const capture = await binding!.capture(update, "c".repeat(64));
    await binding!.dispatched(capture);
    const outcome = await binding!.outcome(capture, { jsonrpc: "2.0", id: 1, result: { applied: true } });

    assert.equal(outcome.status, "completed");
    assert.equal(postgresCalls.length, 1);
    assert.equal(postgresCalls[0]?.tool, "postgres.row.update");
    assert.deepEqual(postgresCalls[0]?.arguments, update.args);
    assert.equal(s3Calls.length, 0);
    assert.equal((await manifestReader(dir)).length, 1);
    assert.deepEqual(ledger.map((entry) => entry.decision), ["execute:dispatched", "execute:completed"]);

    assert.notEqual(resolver({
      tool: "postgres.row.delete",
      connector: "postgres",
      args: {},
      workspace: WORKSPACE,
    }), null);
    assert.notEqual(resolver({
      tool: "aws.s3.object.delete",
      connector: "s3",
      args: { bucket: "b", key: "k" },
      workspace: WORKSPACE,
    }), null);
    assert.equal(resolver({
      tool: "aws.s3.object.put",
      connector: "s3",
      args: {},
      workspace: WORKSPACE,
    }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
