import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devKeyProvider } from "../sign.ts";
import { jsonlStore } from "../store.ts";
import { buildGraph } from "./graph.ts";
import { exportTaint, taintFromLedger, verifyTaint } from "./capture.ts";

const workspace = "taint-ws";

type TaintBody = {
  readonly workspace: string;
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
  readonly args: Readonly<Record<string, unknown>>;
};

async function seedLedger(): Promise<{
  readonly dir: string;
  readonly file: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "void-taint-"));
  const signer = await devKeyProvider({ dir: join(dir, "keys"), env: {} });
  const store = jsonlStore(signer, { dir });
  const bodies: TaintBody[] = [
    {
      workspace,
      at: "2026-09-01T00:00:00.000Z",
      tool: "s3.object.delete",
      klass: "r1",
      decision: "allow:resolved",
      argsDigest: "1".repeat(64),
      args: { bucket: "docs", key: "a.txt" },
    },
    {
      workspace,
      at: "2026-09-02T00:00:00.000Z",
      tool: "s3.object.delete",
      klass: "r1",
      decision: "allow:resolved",
      argsDigest: "2".repeat(64),
      args: { bucket: "docs", key: "a.txt" },
    },
  ];
  for (const body of bodies) await store.append(body);
  return { dir, file: join(dir, `${workspace}.jsonl`) };
}

describe("taint export validation", () => {
  test("rejects a bindingType outside the union", async () => {
    const { dir } = await seedLedger();
    const tampered = mutateFirstEdge(await exportedFrom(dir), (edge) => {
      edge.bindingType = "assumed-dependency";
    });

    assert.throws(
      () => verifyTaint(tampered),
      /taint export edge has invalid bindingType/,
    );
  });

  test("rejects an edge that omits bindingType", async () => {
    const { dir } = await seedLedger();
    const tampered = mutateFirstEdge(await exportedFrom(dir), (edge) => {
      delete edge.bindingType;
    });

    assert.throws(
      () => verifyTaint(tampered),
      /taint export edge has invalid bindingType/,
    );
  });
});

async function exportedFrom(dir: string): Promise<string> {
  return exportTaint(await taintFromLedger(dir, workspace));
}

function mutateFirstEdge(
  json: string,
  mutate: (edge: Record<string, unknown>) => void,
): string {
  const parsed = JSON.parse(json) as {
    edges: Array<Record<string, unknown>>;
  };
  const edge = parsed.edges[0];
  assert.ok(edge, "the seeded export must carry at least one edge");
  mutate(edge);
  return JSON.stringify(parsed);
}

describe("taintFromLedger", () => {
  test("builds only after the ledger chain verifies", async () => {
    const { dir } = await seedLedger();
    const graph = await taintFromLedger(dir, workspace);

    assert.equal(graph.nodes.size, 2);
    assert.equal(graph.edges.length, 1);
  });

  test("refuses to build when chain verification fails", async () => {
    const { dir, file } = await seedLedger();
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    const first = JSON.parse(lines[0]!) as { body: { tool: string } };
    first.body.tool = "tampered.tool";
    lines[0] = JSON.stringify(first);
    await writeFile(file, `${lines.join("\n")}\n`);

    await assert.rejects(
      () => taintFromLedger(dir, workspace),
      /body does not match digest/,
    );
  });
});

describe("taint export", () => {
  test("round trips the pinned JSON shape", async () => {
    const { dir, file } = await seedLedger();
    const text = await readFile(file, "utf8");
    const graph = buildGraph(
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as never),
    );
    const json = exportTaint(graph);
    const parsed = JSON.parse(json) as {
      version: string;
      nodes: unknown[];
      edges: unknown[];
    };
    const verified = verifyTaint(json);

    assert.equal(parsed.version, "void.taint.v1");
    assert.equal(parsed.nodes.length, 2);
    assert.equal(parsed.edges.length, 1);
    assert.deepEqual([...verified.nodes.values()], [...graph.nodes.values()]);
    assert.deepEqual(verified.edges, graph.edges);
    void dir;
  });
});
