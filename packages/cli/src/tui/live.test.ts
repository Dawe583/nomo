import test from "node:test";
import assert from "node:assert/strict";
import { renderLiveFeed, liveRecords, type LiveView } from "./live.ts";
import { visibleLength } from "./layout.ts";
import { verificationKeyLine } from "../../../ledger/src/verify-key.ts";

const view: LiveView = { workspace: "local", selected: 0, filter: "", paused: false, detail: false, help: false,
  page: { verified: true, signed: true, head: "a".repeat(64), records: [
    { seq: 1, at: "2026-09-11", tool: "postgres.row.update", klass: "r1", decision: "allow:resolved", argsDigest: "b".repeat(64), prevDigest: "0".repeat(64), digest: "a".repeat(64) },
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

test("live view never labels integrity-only data as signature checked", () => {
  const frame = renderLiveFeed({ ...view, page: { ...view.page!, signed: false } }, { interactive: false, ansi: false, colorDepth: 0, columns: 80, rows: 24, reason: "not-tty" });
  assert.match(frame, /Signatures have not been checked/);
  assert.equal(liveRecords({ ...view, filter: "r3" }).length, 0);
});

// The live feed rendered the bare claim "Signatures checked against the
// configured key", which says nothing about *which* key. Three different
// guarantees were reaching the operator as one sentence. This pins that they
// stay distinguishable on the screen, and that a degraded mode is never
// presented as a clean one.
test("the live feed names which key checked the signatures", () => {
  const caps = { interactive: true, ansi: false, colorDepth: 0, columns: 200, rows: 24, reason: "no-color" } as const;
  const claims = [
    "verified against a key supplied out of band",
    "verified against a trust file the agent can also replace (key substitution NOT detected)",
    "DEGRADED (key from signing key material)",
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
      verificationStatus: "DEGRADED (key from signing key material)",
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
  assert.match(frame, /VOID_VERIFY_ALLOW_SIGNING_KEY/);
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
