import test from "node:test";
import assert from "node:assert/strict";
import { renderLiveFeed, liveRecords, type LiveView } from "./live.ts";
import { visibleLength } from "./layout.ts";
import { verificationKeyLine } from "../../../ledger/src/verify-key.ts";

const view: LiveView = { workspace: "local", selected: 0, filter: "", paused: false, detail: false, help: false,
  page: { verified: true, signed: true, head: "a".repeat(64), records: [
    { seq: 1, at: "2026-09-11", tool: "postgres.row.update", klass: "r1", decision: "allow:resolved", argsDigest: "b".repeat(64), prevDigest: "0".repeat(64), keyId: "dev-fixture", digest: "a".repeat(64) },
  ] } };

for (const columns of [80, 120, 200]) test(`live ledger is bounded at ${columns} columns`, () => {
  for (const changes of [{}, { detail: true }, { help: true }, { filter: "r3" }, { error: "offline", page: undefined }]) {
    const frame = renderLiveFeed({ ...view, ...changes }, { interactive: true, ansi: false, colorDepth: 0, columns, rows: 24, reason: "no-color" });
    assert.equal(frame.split("\n").length, 24);
    assert.ok(frame.split("\n").every(line => visibleLength(line) <= columns));
    assert.doesNotMatch(frame, /\u001b/);
    assert.match(frame, /q quit/);
  }
});
for (const columns of [80, 120, 200]) {
  test(`live detail keeps wide Unicode values at ${columns} columns`, () => {
    const value = "界語".repeat(60);
    const record = { ...view.page!.records[0]!, tool: value };
    const fixture = {
      ...view,
      detail: true,
      page: { ...view.page!, records: [record] },
    };

    for (const caps of [
      {
        interactive: false,
        ansi: false,
        colorDepth: 0,
        columns,
        rows: 24,
        reason: "no-color",
      },
      {
        interactive: true,
        ansi: true,
        colorDepth: 24,
        columns,
        rows: 24,
        reason: "interactive",
      },
    ] as const) {
      const frame = renderLiveFeed(fixture, caps);
      const lines = frame.split("\n");
      assert.ok(
        lines.every((line) => visibleLength(line) <= columns),
        `rows stay within ${columns} terminal cells`,
      );
      const toolStart = lines.findIndex((line) => line.includes("Tool:"));
      const classStart = lines.findIndex(
        (line, index) => index > toolStart && line.includes("Class:"),
      );
      assert.ok(toolStart >= 0 && classStart > toolStart, frame);
      const recovered = lines
        .slice(toolStart, classStart)
        .map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").slice(12))
        .join("");
      assert.equal(recovered, value, `all tool text remains visible at ${columns}`);
    }
  });
}


test("selected ledger records use the NOMO selection wash", () => {
  const caps = {
    interactive: true,
    ansi: true,
    colorDepth: 24,
    columns: 80,
    rows: 24,
    reason: "interactive",
  } as const;
  const frame = renderLiveFeed(view, caps);
  const selectedRow = frame.split("\n").find((line) => line.includes("postgres.row.update"));
  assert.ok(selectedRow);
  assert.match(selectedRow, /\u001b\[48;5;237m/);
  assert.equal(visibleLength(selectedRow), 80);
});

test("selected ledger records stay compatible with basic ANSI color", () => {
  const frame = renderLiveFeed(view, {
    interactive: true,
    ansi: true,
    colorDepth: 4,
    columns: 80,
    rows: 24,
    reason: "interactive",
  });
  const selectedRow = frame.split("\n").find((line) => line.includes("postgres.row.update"));
  assert.ok(selectedRow);
  assert.match(selectedRow, /^\u001b\[1;96m>/);
  assert.doesNotMatch(selectedRow, /\u001b\[48;5;237m/);
});

test("selected pending holds use the NOMO selection wash", () => {
  const hold = {
    holdId: "h001",
    call: {
      tool: "postgres.row.delete",
      klass: "r3" as const,
      connector: "postgres",
      workspace: "local",
      blastRadius: 12,
    },
    expiresAt: Date.now() + 60000,
    status: "pending" as const,
    notify: [],
  };
  const frame = renderLiveFeed(
    { ...view, approvalView: true, approvals: [hold], approvalSelected: 0 },
    {
      interactive: true,
      ansi: true,
      colorDepth: 24,
      columns: 80,
      rows: 24,
      reason: "interactive",
    },
  );
  const selectedRow = frame.split("\n").find((line) => line.includes("postgres.row.delete"));
  assert.ok(selectedRow);
  assert.match(selectedRow, /\u001b\[48;5;237m/);
  assert.match(selectedRow.replace(/\u001b\[[0-9;]*m/g, ""), /^> R3 postgres\.row\.delete/);
});

test("live view never labels integrity-only data as signature checked", () => {
  const frame = renderLiveFeed({ ...view, page: { ...view.page!, signed: false } }, { interactive: false, ansi: false, colorDepth: 0, columns: 80, rows: 24, reason: "not-tty" });
  assert.match(frame, /Signatures have not been checked/);
  assert.equal(liveRecords({ ...view, filter: "r3" }).length, 0);
});

// The live feed rendered the bare claim "Signatures checked against the
// configured key", which says nothing about *which* key and overclaims about
// what a signature proves. Three different guarantees were reaching the
// operator as one sentence. This pins that they stay distinguishable, that a
// degraded mode is never presented as a clean one, and that every one of them
// says `integrity only` rather than leaving a bare `verified` to be read as
// tamper-evidence, which it is not in any shipped topology.
test("the live feed names which key checked the signatures", () => {
  const caps = { interactive: true, ansi: false, colorDepth: 0, columns: 200, rows: 24, reason: "no-color" } as const;
  const claims = [
    "integrity only, verified against a key supplied out of band",
    "integrity only, verified against a trust file the agent can also replace (key substitution NOT detected)",
    "DEGRADED, integrity only (key from signing key material)",
  ];
  const frames = claims.map((verificationStatus) =>
    renderLiveFeed({ ...view, verificationStatus }, caps),
  );
  for (const [index, frame] of frames.entries())
    assert.match(frame, new RegExp(claims[index]!.replace(/[()]/g, "\\$&")), claims[index]);
  // Three guarantees, three renderings. Before this, all three read the same.
  assert.equal(new Set(frames).size, 3, "two key states rendered identically");
});

test("a degraded live feed carries the opt-in that caused it", () => {
  const frame = renderLiveFeed(
    {
      ...view,
      verificationStatus: "DEGRADED, integrity only (key from signing key material)",
      verificationNote: verificationKeyLine({
        keyId: "dev-ed25519:0123456789abcdef",
        source: "signing-key-file",
        degraded: true,
        operatorSupplied: false,
      }),
    },
    { interactive: true, ansi: false, colorDepth: 0, columns: 120, rows: 24, reason: "no-color" },
  );
  // The switch that put the operator in this mode survives truncation, which
  // is why the note leads with it rather than ending with it.
  assert.match(frame, /NOMO_VERIFY_ALLOW_SIGNING_KEY/);
  // The note names itself once. Prefixing it again read as a stutter.
  assert.equal(frame.match(/verification key:/g)?.length, 1, frame);
});

test('pending approvals expose real risk and require an explicit confirmation', () => {
  const hold = { holdId: 'h001', call: { tool: 'postgres.row.delete', klass: 'r3' as const, connector: 'postgres', workspace: 'local', blastRadius: 12 }, expiresAt: Date.now() + 60000, status: 'pending' as const, notify: [] };
  const frame = renderLiveFeed({ ...view, approvalView: true, approvals: [hold], approvalSelected: 0, confirmDecision: 'denied' }, { interactive: true, ansi: false, colorDepth: 0, columns: 80, rows: 24, reason: 'no-color' });
  assert.match(frame, /Blast radius: 12/);
  assert.match(frame, /Confirm denied with y/);
  assert.ok(frame.split('\n').every(line => visibleLength(line) <= 80));
});

test("live ledger uses the NOMO wordmark and thin dividers", () => {
  const caps = {
    interactive: true,
    ansi: false,
    colorDepth: 0,
    columns: 80,
    rows: 24,
    reason: "no-color",
  } as const;
  const lines = renderLiveFeed(view, caps).split("\n");
  assert.equal(lines[0], " NOMO / local");
  assert.equal(lines[2], "─".repeat(80));
  assert.equal(lines[lines.length - 2], "─".repeat(80));
});
