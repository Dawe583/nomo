import test, { describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseTranscript,
  classifyCall,
  classifyTranscript,
  formatClassifyReport,
  runClassifyCommand,
  type TranscriptCall,
} from "./classify.ts";
import { REGISTRY_DISCLAIMER } from "@nomo/registry";

const s3Delete = "aws.s3.object.delete";
const pgUpdate = "postgres.row.update";

describe("parseTranscript", () => {
  test("reads one JSON object per line and skips blanks", () => {
    const text = `{"tool": "t", "arguments": {"id": 1}}\n\n{"tool": "t2"}\n`;
    const calls = parseTranscript(text);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].arguments?.id, 1);
  });

  test("a malformed line is a named load error, not a dropped call", () => {
    assert.throws(() => parseTranscript(`{"tool": "t"}\nnot json\n`), /line 2/);
    assert.throws(() => parseTranscript(`{"arguments": {}}\n`), /line 1.*tool/);
    assert.throws(() => parseTranscript(`[1,2]\n`), /line 1/);
  });
});

describe("classifyCall", () => {
  test("an unknown tool id is unknown-tool, never a guessed class", () => {
    assert.equal(classifyCall({ tool: "no.such.tool" }).outcome, "unknown-tool");
  });

  test("a migrated entry classifies from declared facts alone", () => {
    // The pilot migration landed structured ifs on this entry, so the
    // declared facts decide it with no arguments in play.
    const result = classifyCall({
      tool: s3Delete,
      facts: { "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" },
    });
    assert.equal(result.outcome, "classified");
    if (result.outcome === "classified") assert.equal(result.tone, "r0");
  });

  test("facts absent fall to the structured worst case, never a guess", () => {
    // The entry is fully migrated, so absent facts decide the terminal
    // always case: r3, the class policy must assume anyway.
    const result = classifyCall({ tool: s3Delete, facts: {} });
    assert.equal(result.outcome, "classified");
    if (result.outcome === "classified") assert.equal(result.tone, "r3");
  });

  test("a tool outside the registry is unknown, never guessed", () => {
    // The audit pass migrated the last real unmigrated registry entry, so the
    // CLI-level specimen for unmigrated prose no longer exists. The honest
    // remaining CLI assertion is that an absent tool is a distinct outcome
    // from an undecided one, with no assumed class either way.
    const result = classifyCall({ tool: "specimen.never.migrated", facts: {} });
    assert.equal(result.outcome, "unknown-tool");
    // The unknown-tool outcome is a bare marker, so an absent tone is itself
    // the assertion: TS narrowing rejects reading any other field here.
    assert.ok(!("assume" in result) && !("tone" in result));
  });
});

describe("classifyTranscript, the distribution", () => {
  test("counts are honest over a mixed session", () => {
    const calls: TranscriptCall[] = [
      { tool: s3Delete, facts: { "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" } },
      { tool: s3Delete },
      { tool: pgUpdate },
      { tool: "vendor.something.absent" },
    ];
    const report = classifyTranscript(calls);
    assert.equal(report.total, 4);
    assert.equal(report.distribution.r0, 1);
    // Both migrated entries decide without facts through the always
    // fallback, and both fallbacks are the worst class: the fail closed
    // posture shows up as r3, not as undecided calls.
    assert.equal(report.distribution.r3, 2);
    assert.equal(report.distribution.unclassified, 0);
    assert.equal(report.distribution["unknown-tool"], 1);
    assert.equal(report.unclassifiedShare, 0);
  });

  test("an empty transcript is zero, not a crash", () => {
    const report = classifyTranscript([]);
    assert.equal(report.total, 0);
    assert.equal(report.unclassifiedShare, 0);
  });

  test("the printed report shows every bucket and the share", () => {
    const report = classifyTranscript([{ tool: s3Delete }]);
    const text = formatClassifyReport(report);
    assert.ok(text.includes("calls: 1"));
    assert.ok(text.includes("unclassified: 0%"));
    assert.ok(text.includes("unknown-tool: 0"));
    assert.ok(text.includes("r3: 1"));
  });

  test("the printed report carries the registry disclaimer verbatim", () => {
    const text = formatClassifyReport(classifyTranscript([]));
    assert.ok(text.includes("not certified by any vendor"));
    assert.ok(text.endsWith(REGISTRY_DISCLAIMER));
  });
});



describe("runClassifyCommand, the command surface", () => {
  test("declared facts apply to the whole transcript", async () => {
    const files: Record<string, string> = {
      "s.jsonl": JSON.stringify({ tool: s3Delete }) + "\n",
      "f.json": JSON.stringify({ "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" }),
    };
    const out: string[] = [];
    const code = await runClassifyCommand(
      ["--transcript", "s.jsonl", "--facts", "f.json"],
      (path) => files[path] ?? (() => { throw new Error("no file " + path); })(),
      (line) => out.push(line),
    );
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("r0: 1"));
  });

  test("a malformed transcript is a named load error", async () => {
    await assert.rejects(
      runClassifyCommand(["--transcript", "bad.jsonl"], () => "nope\n", () => {}),
      /line 1/,
    );
  });

  test("per-call facts override the declared file", async () => {
    const files: Record<string, string> = {
      "s.jsonl": JSON.stringify({ tool: s3Delete, facts: { "bucket.versioning": "Disabled" } }) + "\n",
      "f.json": JSON.stringify({ "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" }),
    };
    const out: string[] = [];
    await runClassifyCommand(
      ["--transcript", "s.jsonl", "--facts", "f.json"],
      (path) => files[path],
      (line) => out.push(line),
    );
    // The per-call Disabled wins over the declared Enabled, the r0 guard
    // fails on a present-but-wrong fact, and the structured always fallback
    // answers r3: the override is visible in the distribution, not ignored.
    assert.ok(out.join("\n").includes("r3: 1"));
    assert.ok(out.join("\n").includes("unclassified: 0%"));
  });
});

describe("runClassifyCommand, the single tool surface", () => {
  const factsFile = JSON.stringify({
    "bucket.versioning": "Enabled",
    "bucket.mfa_delete": "off",
  });
  // The reader names the file it cannot find rather than returning undefined,
  // so a test that asks for a path it never set up fails as itself.
  const files = (map: Record<string, string>) => (path: string) => {
    const text = map[path];
    if (text === undefined) throw new Error("no file " + path);
    return text;
  };

  test("one classified call prints the tone and exits 0", async () => {
    const out: string[] = [];
    const code = await runClassifyCommand(
      ["--tool", s3Delete, "--facts", "f.json"],
      files({ "f.json": factsFile }),
      (line) => out.push(line),
    );
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(text.includes("tool: " + s3Delete));
    assert.ok(text.includes("outcome: classified"));
    assert.ok(text.includes("tone: r0"));
  });

  test("the single verdict carries the registry disclaimer verbatim", async () => {
    const out: string[] = [];
    await runClassifyCommand(
      ["--tool", s3Delete, "--facts", "f.json"],
      files({ "f.json": factsFile }),
      (line) => out.push(line),
    );
    // Standards rule 10 travels with every classification this CLI prints,
    // not only the distribution: a lone `tone: r0` is the line an operator
    // pastes onward, and it is the one that must not read as certified.
    const text = out.join("\n");
    assert.ok(text.includes("not certified by any vendor"));
    assert.ok(text.endsWith(REGISTRY_DISCLAIMER));
  });

  test("inline --fact pairs win over the declared file", async () => {
    const out: string[] = [];
    const code = await runClassifyCommand(
      ["--tool", s3Delete, "--facts", "f.json", "--fact", "bucket.versioning=Disabled"],
      files({ "f.json": factsFile }),
      (line) => out.push(line),
    );
    // The inline Disabled beats the file's Enabled, so the r0 guard fails
    // and the structured always fallback answers r3. The exit code stays 0:
    // a verdict the operator can act on is a report.
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(text.includes("tone: r3"));
    assert.ok(text.includes("facts: 2 declared"));
  });

  test("a --fact value is compared as the text the registry declares", async () => {
    const volumeDelete = "aws.ec2.volume.delete";
    const bare = classifyCall({ tool: volumeDelete, facts: {} });
    assert.equal(bare.outcome, "classified");
    if (bare.outcome !== "classified") throw new Error("unreachable");
    assert.equal(bare.tone, "r3", "no declared facts reaches the always case");

    const out: string[] = [];
    const code = await runClassifyCommand(
      ["--tool", volumeDelete, "--fact", "aws.ec2.volume.snapshot_exists=true"],
      files({}),
      (line) => out.push(line),
    );
    assert.equal(code, 0);
    // Every `is` in the registry is a string and `holds` compares with ===,
    // so a --fact value read as the text "true" is what decides the r1 case.
    // Read as a boolean it would match nothing, and the operator would see
    // the fallback for a fact they believed they had declared.
    assert.ok(out.join("\n").includes("tone: r1"));
  });

  test("no declared facts says the tone is the fallback, not a measurement", async () => {
    const out: string[] = [];
    const code = await runClassifyCommand(["--tool", s3Delete], files({}), (line) => out.push(line));
    assert.equal(code, 0);
    const text = out.join("\n");
    assert.ok(text.includes("tone: r3"));
    // Without this line the same r3 the operator sees with verified facts
    // reads as a reading of their bucket, and it is not one: absent facts
    // reach the entry's terminal case whatever the bucket really is.
    assert.ok(text.includes("facts: none declared"));
  });

  test("an explicit versionId argument reclassifies the same tool to r3", async () => {
    const out: string[] = [];
    const code = await runClassifyCommand(
      ["--tool", s3Delete, "--facts", "f.json", "--args", JSON.stringify({ versionId: "abc" })],
      files({ "f.json": factsFile }),
      (line) => out.push(line),
    );
    // The version specific delete case outranks the marker case, so the
    // same tool with the same facts lands on permanent destruction: the
    // arguments are in play, not just the facts.
    assert.equal(code, 0);
    assert.ok(out.join("\n").includes("tone: r3"));
  });

  test("the single tool verdict is the same evaluator the transcript path uses", async () => {
    // Both surfaces must reach one evaluate(). If they ever stopped, a tone
    // the reviewer checked by hand could disagree with the tone an
    // intercepted call receives, which is the one thing this command is for.
    const direct = classifyCall({
      tool: s3Delete,
      facts: { "bucket.versioning": "Enabled", "bucket.mfa_delete": "off" },
    });
    const out: string[] = [];
    await runClassifyCommand(
      ["--tool", s3Delete, "--facts", "f.json"],
      files({ "f.json": factsFile }),
      (line) => out.push(line),
    );
    assert.equal(direct.outcome, "classified");
    if (direct.outcome !== "classified") throw new Error("unreachable");
    assert.ok(out.join("\n").includes(`tone: ${direct.tone}`));
  });

  test("unknown tool is a distinct nonzero outcome, never a guessed class", async () => {
    const out: string[] = [];
    const code = await runClassifyCommand(["--tool", "no.such.tool"], files({}), (line) => out.push(line));
    assert.equal(code, 2);
    const text = out.join("\n");
    assert.ok(text.includes("outcome: unknown-tool"));
    assert.ok(text.includes("tone: deny, unknown tool fails closed"));
  });

  test("malformed facts file and malformed --args are named load errors", async () => {
    await assert.rejects(
      runClassifyCommand(["--tool", s3Delete, "--facts", "f.json"], files({ "f.json": "nope" }), () => {}),
      /facts file is not JSON/,
    );
    await assert.rejects(
      runClassifyCommand(["--tool", s3Delete, "--args", "[1]"], files({}), () => {}),
      /--args must be an object/,
    );
  });

  test("a missing flag value and an unrecognised flag are usage errors", async () => {
    // A flag without a value used to be swallowed as a missing file and a
    // typo used to be ignored entirely. Both answers then look like a
    // classification the operator did not ask for.
    await assert.rejects(
      runClassifyCommand(["--tool"], files({}), () => {}),
      /--tool needs a value\. usage: nomo classify/,
    );
    await assert.rejects(
      runClassifyCommand(["--tool", s3Delete, "--fact"], files({}), () => {}),
      /--fact needs a value/,
    );
    await assert.rejects(
      runClassifyCommand(["--tool", s3Delete, "--fcts", "f.json"], files({}), () => {}),
      /unknown classify flag --fcts/,
    );
  });

  test("both transcript and tool flags name one usage line", async () => {
    await assert.rejects(runClassifyCommand([], files({}), () => {}), /usage: nomo classify/);
    await assert.rejects(
      runClassifyCommand(["--transcript"], files({}), () => {}),
      /usage: nomo classify/,
    );
  });
});
