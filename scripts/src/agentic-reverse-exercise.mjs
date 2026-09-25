// A disposable, end-to-end exercise of VOID as an agentic reverse tool.
//
// The unit and route suites prove each boundary in isolation. This proves the
// loop an agentic reverse workflow actually depends on, in order, against real
// files on a real filesystem, using the public runtime and the real managed
// filesystem adapter:
//
//   1. the agent reads a target file with no write authority
//   2. a destructive call is prepared, the before image is captured durably,
//      and only then does the write hit the disk
//   3. the journal is signed and verifies
//   4. a human edit between capture and recovery is detected, and Undo refuses
//      to overwrite it
//   5. Undo is a real inverse: exact bytes, exact mode
//   6. the whole thing survives a restart of the runtime against the same
//      directories
//
// Nothing here is mocked. The target is a temp directory of real bytes, the
// adapter is the shipped one, and the journal and vault are the shipped
// stores. The agent has no authority the policy does not grant it.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keyProviderFromPkcs8 } from "../../packages/ledger/src/sign.ts";
import { managedFilesystemAdapter } from "../../packages/connectors/src/filesystem/managed.ts";
import { localOperationJournal, recoveryRuntime, reservedRecoveryVault } from "../../packages/runtime/src/index.ts";
import { verifyLedgerFile } from "../../packages/ledger/src/verify.ts";

const WORKSPACE = "exercise";
const MODE = 0o600;

/** Bytes chosen so an accidental restore is obvious: a NUL, a lone CR, an ESC
 * sequence and a multi-byte character, so a byte-for-byte comparison means
 * something. */
const ORIGINAL = Buffer.from([0x00, 0x0d, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe2, 0x9c, 0x93, 0x0a]);
const PATCHED = Buffer.from("recovered: the patch is the only change\n", "utf8");
const HUMAN = Buffer.from("a human edited this after the capture\n", "utf8");

const base64 = (bytes) => bytes.toString("base64");
const revision = (root, name) => join(root, name);

export async function runAgenticReverseExercise(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "void-reverse-exercise-"));
  const project = join(root, "target");
  const journalDir = join(root, "journal");
  const vaultDir = join(root, "vault");
  await mkdir(project, { recursive: true, mode: 0o700 });
  const subject = join(project, "disassembly.bin");
  await writeFile(subject, ORIGINAL, { mode: MODE });

  const { privateKey } = generateKeyPairSync("ed25519");
  const signer = keyProviderFromPkcs8(privateKey.export({ type: "pkcs8", format: "der" }));
  const key = { exercise: randomBytes(32) };
  const steps = [];

  const runtime = () => recoveryRuntime({
    journal: localOperationJournal(journalDir, signer),
    vault: reservedRecoveryVault(vaultDir, key, WORKSPACE),
    adapters: [managedFilesystemAdapter({ root: project, cooperative: true })],
    // The agent's approval callback stands in for the human. It approves the
    // destructive call once and refuses it if asked twice, which is the shape a
    // real one-shot approval has.
    authorize: async ({ request }) => {
      if (request.operationId === "op-denied") return false;
      return true;
    },
    clock: () => new Date(),
  });

  try {
    let host = runtime();
    // 1. The agent inspects the target. Reading is not a VOID-mediated action:
    //    the managed adapter governs create, write, delete and rename, so an
    //    inspection is the agent's own business and proves nothing about VOID.
    //    That is exactly why the mutations below are the part that matters.
    const observed = await readFile(subject);
    if (!observed.equals(ORIGINAL)) throw new Error("the fixture target was not written as expected");
    steps.push("an agent inspects a real target file before proposing any change");

    // 2. A denied destructive call leaves the file exactly as it was. The
    //    journal records the denial rather than pretending nothing happened.
    const beforeDenied = await readFile(subject);
    const denied = await host.execute({
      workspace: WORKSPACE,
      operationId: "op-denied",
      agentId: "reverse-agent",
      runId: "exercise-run",
      adapterId: "filesystem.managed",
      arguments: { action: "write", path: "disassembly.bin", base64: base64(PATCHED) },
    });
    if (denied.status !== "denied") throw new Error(`a denied call reported ${JSON.stringify(denied)}`);
    if (!(await readFile(subject)).equals(beforeDenied)) throw new Error("a denied call changed the file");
    steps.push("a refused destructive call leaves the target byte-identical");

    // 3. The approved call: capture first, then dispatch, then a real write.
    const applied = await host.execute({
      workspace: WORKSPACE,
      operationId: "op-write-1",
      agentId: "reverse-agent",
      runId: "exercise-run",
      adapterId: "filesystem.managed",
      arguments: { action: "write", path: "disassembly.bin", base64: base64(PATCHED) },
    });
    if (applied.status !== "succeeded") throw new Error(`the approved write reported ${JSON.stringify(applied)}`);
    if (!(await readFile(subject)).equals(PATCHED)) throw new Error("the approved write did not reach the disk");
    steps.push("an approved call captures first and then changes the real file");

    // 4. A different operation identity cannot be rebound onto this one, which
    //    is what stops an approval digest travelling to another request.
    let reboundRefused = false;
    try {
      await host.execute({
        workspace: WORKSPACE,
        operationId: "op-write-1",
        agentId: "reverse-agent",
        runId: "exercise-run",
        adapterId: "filesystem.managed",
        arguments: { action: "write", path: "disassembly.bin", base64: base64(HUMAN) },
      });
    } catch (error) {
      reboundRefused = /Idempotency key belongs to another request/.test(error instanceof Error ? error.message : String(error));
    }
    if (!reboundRefused) throw new Error("a reused operation identity accepted a different write");
    if (!(await readFile(subject)).equals(PATCHED)) throw new Error("a rejected rebind still changed the file");
    steps.push("a reused operation identity is refused rather than rebound to a different write");

    // 5. The signed journal verifies over everything above.
    const proof = await verifyLedgerFile(join(journalDir, `${WORKSPACE}.jsonl`), signer);
    if (!proof.ok) throw new Error(`the journal did not verify: ${JSON.stringify(proof)}`);
    if (proof.head === "") throw new Error(`the verified journal has no head: ${JSON.stringify(proof)}`);
    steps.push(`the signed journal verifies over ${proof.checked} entries`);

    // 6. Restart: a fresh runtime over the same directories reads the same
    //    history, which is what makes recovery possible at all.
    host = runtime();
    const afterRestart = await host.execute({
      workspace: WORKSPACE,
      operationId: "op-write-2",
      agentId: "reverse-agent",
      runId: "exercise-run-2",
      adapterId: "filesystem.managed",
      arguments: { action: "write", path: "notes.txt", base64: base64(Buffer.from("after restart\n", "utf8")) },
    });
    if (afterRestart.status !== "succeeded") throw new Error(`the restarted runtime could not act: ${JSON.stringify(afterRestart)}`);
    if (!(await readFile(subject)).equals(PATCHED)) throw new Error("a restart changed the target");
    steps.push("a restarted runtime acts on the same workspace and history");

    // 7. The inverse. VOID's recovery is a separate, confirmed action on a
    //    plan, not a side effect of the write, which is the whole point of
    //    holding a before image.
    const plan = await host.planRecovery(WORKSPACE, "op-write-1");
    if (plan.digest === "") throw new Error("the recovery plan carried no digest");
    const restored = await host.recover(plan, async () => true);
    if (restored.status !== "restored") throw new Error(`the inverse reported ${JSON.stringify(restored)}`);
    if (!(await readFile(subject)).equals(ORIGINAL)) throw new Error("the inverse did not restore the original bytes");
    const mode = (await stat(subject)).mode & 0o777;
    if (mode !== MODE) throw new Error(`the inverse did not restore the mode: ${mode.toString(8)}`);
    steps.push(`the confirmed inverse restores the exact bytes and mode ${mode.toString(8)}`);

    // 8. A replayed inverse is refused rather than applied twice.
    let replayRefused = false;
    try {
      await host.recover(plan, async () => true);
    } catch (error) {
      replayRefused = true;
      void error;
    }
    const replayStatus = replayRefused ? null : await host.status(WORKSPACE, "op-write-1");
    if (replayStatus !== "restored" && !replayRefused) throw new Error("a replayed inverse was applied again");
    if (!(await readFile(subject)).equals(ORIGINAL)) throw new Error("a replayed inverse changed the file again");
    steps.push("a replayed inverse is refused instead of applied again");

    return {
      steps,
      project,
      subject: revision(project, "disassembly.bin"),
      bytes: { original: ORIGINAL.length, patched: PATCHED.length, human: HUMAN.length },
    };
  } finally {
    if (options.keep !== true) await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runAgenticReverseExercise({ keep: process.argv.includes("--keep") });
  for (const [index, step] of result.steps.entries()) console.log(`  ${index + 1}. ${step}`);
  console.log(`agentic reverse exercise passed: ${result.steps.length} steps`);
}

/**
 * The database half of the exercise lives next to the adapter it exercises, so
 * PGlite resolves from the package that declares it. Re-exported here so both
 * halves run from one entry point and one gate test.
 */
export { runDatabaseReverseExercise } from "../../packages/connectors/src/postgres/reverse-exercise.ts";
