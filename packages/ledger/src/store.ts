/**
 * The dev tier store: one append only JSONL file per workspace.
 *
 * Decision 2. fsync before the append is acknowledged, directory 0700, file
 * 0600, one JSON object per line. The chain and the signature carry the
 * guarantee, so a JSONL ledger is exactly as tamper evident as a Postgres
 * one, and a contributor runs the suite with no database provisioned. There
 * is no memory mode at any tier: a receipt for a record that died with the
 * process is manufactured evidence.
 *
 * The Postgres store is the hosted tier at WP-06 and lives in this package
 * then, behind the same interface. What is frozen here is the interface and
 * the JSONL implementation the free tier and the test suite run on.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { FileHandle } from "node:fs/promises";

import type { KeyProvider, LedgerStore } from "./index.ts";
import { GENESIS_PREV, canonicalJson, entryHash } from "./canonical.ts";
import { readLedgerReason } from "./attribution.ts";
import { readLedgerReversal, reversalFinding } from "./reversal.ts";
import { sha256Hex, verifySignature } from "./sign.ts";
import {
  assertPrivateDirectoryPath,
  assertPrivateDirectoryIfPresent,
  ensurePrivateDirectory,
  openPrivateFile,
  readPrivateFile,
  sanitizeWorkspace,
} from "./hardening.ts";
import { dataDir } from "./paths.ts";
import { envValue } from "./env-compat.ts";

/**
 * What one line in the JSONL file is. The receipt is the entry plus what the
 * chain added, and read() returns entries only: the verifier recomputes the
 * chain rather than trusting the stored links, which is the difference
 * between a check and a decoration. The body is the payload the caller
 * appended; everything else is chain metadata.
 */
export type JsonlEntry = {
  readonly workspace: string;
  readonly seq: number;
  readonly body: unknown;
  readonly prev_hash: string;
  readonly hash: string;
  readonly key_id: string;
  readonly alg: string;
  readonly signature: string;
};

export type JsonlReceipt = JsonlEntry;

export interface JsonlStoreOptions {
  /** Directory holding <workspace>.jsonl. Defaults to ~/.nomo/ledger. */
  readonly dir?: string;
  /** Environment, injectable at the test boundary. */
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  /**
   * Called after each fsync the store issues, with the highest seq that fsync
   * covered. It cannot suppress, defer or skip the sync, so this is a
   * measurement seam, not a durability control.
   */
  readonly onFsync?: (event: JsonlFsyncEvent) => void | Promise<void>;
}

/**
 * What one completed group fsync covered. Observation only: the seam is called
 * after the fsync has returned, so a store built with one is exactly as
 * durable as a store built without. It exists because "the syncs were shared"
 * is a claim about a mechanism, and a wall clock cannot demonstrate it.
 */
export type JsonlFsyncEvent = {
  readonly workspace: string;
  /** Highest seq whose bytes this fsync flushed. */
  readonly seq: number;
};

/**
 * One workspace file's append state. The serialisation queue and the group
 * are per file, so two workspaces never wait on each other's disk.
 */
type FileState = {
  /** Tail of the serialisation queue; the chain order is decided here. */
  lock: Promise<unknown>;
  /** Highest seq whose write() has returned. */
  written: number;
  /** Highest seq a completed fsync covered. */
  synced: number;
  /** The fsync in flight, if any. */
  inFlight: Promise<void> | null;
};

/**
 * Where workspace ledger files live.
 *
 * The legacy `VOID_LEDGER_DIR` still answers, because a machine configured
 * before the rename keeps its ledgers exactly where it put them and reading
 * only the current name would report an empty ledger over real records.
 */
export function ledgerDir(env: Readonly<NodeJS.ProcessEnv> = process.env): string {
  return envValue(env, "NOMO_LEDGER_DIR") ?? join(dataDir(homedir()), "ledger");
}

/**
 * The append is one open, one write, one file fsync: a receipt returned
 * before the bytes reach the disk is the defect the memory fallback in the
 * prior art normalised. Two processes on one workspace file is the Postgres
 * tier's problem, which is the documented boundary of the dev tier.
 *
 * The fsync is the only part that batches. Appends arriving while one fsync
 * is in flight join it instead of queueing a sync each, which is legal because
 * an fsync flushes the whole file: a follower whose write() returned before
 * the leader issued its sync is covered by that sync, and one whose write
 * landed after it starts a sync of its own. Nothing else moves. The
 * serialisation, the order of the chain and the bytes written are identical
 * to a store that syncs every append on its own, and an append still returns
 * only after a sync that covers its own bytes has completed.
 *
 * The signer is injected, never imported by the store, so the store stays
 * testable with a deterministic key and the production key path stays in one
 * place.
 */
export function jsonlStore(
  signer: KeyProvider,
  options: JsonlStoreOptions = {},
): LedgerStore<unknown, JsonlEntry, JsonlReceipt> {
  const dir = options.dir ?? ledgerDir(options.env);
  const file = (workspace: string): string => join(dir, `${sanitizeWorkspace(workspace)}.jsonl`);

  // Appends serialize per workspace. The read-tail-then-write sequence is
  // not atomic: two appends racing in one process both read the same tail
  // and mint the same seq, and the chain forks silently. The store is the
  // only writer, so one in-process queue per workspace file closes the
  // window without a filesystem lock broker. The queue is released as soon as
  // the bytes are written, because holding it across the fsync is exactly what
  // stops the next append from joining the sync in flight.
  const states = new Map<string, FileState>();
  const stateFor = (workspace: string): FileState => {
    const existing = states.get(workspace);
    if (existing !== undefined) return existing;
    const created: FileState = { lock: Promise.resolve(), written: 0, synced: 0, inFlight: null };
    states.set(workspace, created);
    return created;
  };
  const withTailLock = async <T>(
    workspace: string,
    run: (state: FileState) => Promise<T>,
  ): Promise<{ state: FileState; value: T }> => {
    const state = stateFor(workspace);
    const previous = state.lock;
    const next = previous.catch(() => {}).then(() => run(state));
    state.lock = next;
    try {
      return { state, value: await next };
    } finally {
      // Nothing queued behind this append, so the file's state can go. An
      // append that arrives later starts a fresh group, which costs one sync
      // it would have shared and can never cost a fork: the chain order was
      // already decided under the lock this append just released.
      if (state.lock === next && state.inFlight === null) states.delete(workspace);
    }
  };

  // The directory is created and checked once per store instance. Every
  // append still validates it, twice over, inside openPrivateFile: the parent
  // directory chain on the way in and the opened handle's own mode, owner and
  // link count. What that duplicated walk bought was a second mkdir attempt.
  let directoryReady: Promise<void> | null = null;
  const ensureDirectory = (): Promise<void> => {
    if (directoryReady !== null) return directoryReady;
    const tracked = ensurePrivateDirectory(dir, "ledger directory", true).catch((error: unknown) => {
      // A refusal is not cached: the operator fixes the mode or the path and
      // appends again.
      if (directoryReady === tracked) directoryReady = null;
      throw error;
    });
    directoryReady = tracked;
    return tracked;
  };

  /**
   * Resolve once a sync covering `seq` has completed.
   *
   * The leader is whichever appender finds no sync in flight, and it takes
   * that role before it yields, so exactly one appender ever leads. It then
   * waits for the writers already queued behind it before issuing the fsync:
   * an fsync flushes the file as it is when the syscall runs, so a writer that
   * has not written yet cannot ride a sync issued now. Waiting for them is
   * the whole mechanism, and it costs a lone appender nothing, because a lone
   * appender has nothing queued behind it.
   *
   * The watermark is read after that wait and with no yield in between, so it
   * names exactly the appends whose write() had returned and no others. An
   * append whose bytes landed after the watermark is not covered by that sync
   * and starts the next one.
   */
  const syncThrough = async (
    state: FileState,
    workspace: string,
    seq: number,
    handle: FileHandle,
  ): Promise<void> => {
    for (;;) {
      if (state.synced >= seq) return;
      const inFlight = state.inFlight;
      if (inFlight !== null) {
        // The round in flight has to finish before this append can start one:
        // two concurrent fsyncs of one file would undo the sharing. Its
        // failure is not this append's failure, so it is only waited out here;
        // the loop then runs this append's own sync, which lands or throws.
        await inFlight.catch(() => {});
        continue;
      }
      const queued = state.lock;
      const round = (async (): Promise<void> => {
        await queued.catch(() => {});
        const covered = state.written;
        await handle.sync();
        state.synced = Math.max(state.synced, covered);
        // The seam fires before the round is released, so an observer sees the
        // sync before any receipt that depends on it.
        await options.onFsync?.({ workspace, seq: covered });
      })();
      state.inFlight = round;
      try {
        await round;
        return;
      } finally {
        if (state.inFlight === round) state.inFlight = null;
      }
    }
  };

  type PendingAppend = { readonly entry: JsonlReceipt; readonly handle: FileHandle };

  const appendInner = async (
    body: JsonlEntry["body"],
    state: FileState,
  ): Promise<PendingAppend> => {
    const workspace = workspaceOf(body);
    await ensureDirectory();
    const [prev, seq] = await headInfo(file(workspace), workspace);
    const keyId = await signer.currentKeyId();
    const hash = await entryHash(body, prev, sha256Hex);
    // Imported here, not at the top: index.ts re-exports this module, so a
    // static import would close a cycle the package resolves at run time.
    const { signingPreimage } = await import("./index.ts");
    const preimage = signingPreimage(signer.alg, keyId, hash);
    const signature = await signer.sign(preimage);
    const entry: JsonlEntry = {
      workspace,
      seq,
      body,
      prev_hash: prev,
      hash,
      key_id: keyId,
      alg: signer.alg,
      signature: `${signer.alg}:${Buffer.from(signature).toString("base64")}`,
    };
    // O_APPEND on the flag itself, not appendFile: the handle is kept so the
    // bytes can be fsynced before the receipt exists. Without the explicit
    // sync the durability claim in the README was false in the quietest way,
    // green on every test and absent in every crash.
    const handle = await openPrivateFile(file(workspace), "append", "ledger file");
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`);
    } catch (error) {
      await handle.close();
      throw error;
    }
    // The watermark moves under the serialisation lock, in write order, so it
    // can only ever name appends whose write() has already returned.
    state.written = Math.max(state.written, seq);
    return { entry, handle };
  };

  return {
    async append(body: JsonlEntry["body"]): Promise<JsonlReceipt> {
      const workspace = workspaceOf(body);
      // The lock is per workspace file: the tail that decides the next seq
      // lives in one file, so appends to different workspaces can still
      // interleave safely. Only the serialisation runs under it.
      const { state, value } = await withTailLock(workspace, (held) =>
        appendInner(body, held),
      );
      try {
        await syncThrough(state, workspace, value.entry.seq, value.handle);
      } finally {
        await value.handle.close();
      }
      return value.entry;
    },

    async *read(workspace: string): AsyncIterable<JsonlEntry> {
      if (!(await assertPrivateDirectoryIfPresent(dir, "ledger directory", true)))
        return;
      const text = await readOrEmpty(file(workspace));
      for (const line of text.split("\n")) {
        if (line === "") continue;
        yield JSON.parse(line) as JsonlEntry;
      }
    },

    async head(workspace: string): Promise<JsonlReceipt | null> {
      await assertPrivateDirectoryPath(dir, "ledger directory", undefined, true);
      return lastEntry(file(workspace));
    },

    async verify(workspace: string): Promise<{ ok: boolean; checked: number; reason?: string }> {
      let prev = GENESIS_PREV;
      let checked = 0;
      const publicKeys = new Map<string, Uint8Array>();
      // The hashes this run has already verified, by sequence. A reversal may
      // only name a record the chain already proved, so the rule is checked
      // against this map rather than against anything the reversal itself says.
      const proven = new Map<number, string>();
      for await (const entry of this.read(workspace)) {
        checked += 1;
        if (entry.workspace !== workspace || typeof entry.body !== "object" || entry.body === null ||
            !("workspace" in entry.body) || entry.body.workspace !== workspace)
          return { ok: false, checked, reason: `workspace: entry ${entry.seq} does not belong to ${workspace}` };
        // A record that claims a reason must carry a reason this reader can
        // vouch for. An entry with no attribution at all is not this failure:
        // that is a pre-attribution entry, and it still verifies.
        const reason = readLedgerReason(entry.body, entry.seq);
        if (reason.kind === "malformed")
          return { ok: false, checked, reason: `attribution: ${reason.detail}` };
        const reversal = readLedgerReversal(entry.body, entry.seq);
        if (reversal.kind === "malformed")
          return { ok: false, checked, reason: `reversal: ${reversal.detail}` };
        if (reversal.kind === "reversal") {
          const finding = reversalFinding(reversal.reversal, entry.seq, (named) =>
            proven.get(named),
          );
          if (finding !== undefined)
            return { ok: false, checked, reason: `reversal: entry ${entry.seq} ${finding}` };
        }
        if (entry.prev_hash !== prev)
          return { ok: false, checked, reason: `link: entry ${entry.seq} points at ${entry.prev_hash.slice(0, 8)} but the chain is at ${prev.slice(0, 8)}` };
        const recomputed = await entryHash(entry.body, prev, sha256Hex);
        if (recomputed !== entry.hash)
          return { ok: false, checked, reason: `body: entry ${entry.seq} does not hash to its stored digest` };
        if (entry.seq !== checked)
          return { ok: false, checked, reason: `order: expected seq ${checked}, found ${entry.seq}` };
        proven.set(entry.seq, entry.hash);
        const { signingPreimage } = await import("./index.ts");
        let spki = publicKeys.get(entry.key_id);
        if (spki === undefined) {
          const fetched = await signer.publicKey(entry.key_id);
          if (fetched === null)
            return { ok: false, checked, reason: `signature: unknown key ${entry.key_id} at entry ${entry.seq}` };
          spki = fetched;
          publicKeys.set(entry.key_id, spki);
        }
        // A store this package never wrote can carry any algorithm tag. The
        // verifier supports ed25519 today; anything else is a named finding
        // at the entry, never a thrown TypeError that stops the whole
        // verification run at line one of a hostile file.
        if (entry.alg !== "ed25519")
          return { ok: false, checked, reason: `signature: entry ${entry.seq} carries unsupported algorithm ${entry.alg}` };
        const [alg, ...rest] = entry.signature.split(":");
        if (alg !== entry.alg || rest.length !== 1)
          return { ok: false, checked, reason: `signature: entry ${entry.seq} carries a malformed signature tag` };
        const bytes = Buffer.from(rest.join(":"), "base64");
        const ok = verifySignature(
          "ed25519",
          signingPreimage("ed25519", entry.key_id, entry.hash),
          new Uint8Array(bytes),
          spki,
        );
        if (!ok)
          return { ok: false, checked, reason: `signature: entry ${entry.seq} fails verification under ${entry.key_id}` };
        prev = entry.hash;
      }
      return { ok: true, checked };
    },
  };
}

function throwNoWorkspace(): never {
  throw new TypeError("ledger body must carry a string workspace field: the store is per workspace");
}

/**
 * The workspace is the store's partition key, so it is read off the body with
 * a narrowing check rather than an asserted cast: a body that is not an object
 * or carries no string workspace is refused here, before any path is built.
 */
function workspaceOf(body: unknown): string {
  if (typeof body !== "object" || body === null || !("workspace" in body))
    throwNoWorkspace();
  const workspace: unknown = body.workspace;
  if (typeof workspace !== "string") throwNoWorkspace();
  return sanitizeWorkspace(workspace);
}

/**
 * How much of the file the tail read looks at before it gives up and reads the
 * whole thing. An entry is one line, so a healthy ledger's last entry is
 * always inside one window; a file whose last line is longer than this, or a
 * body larger than the window, is read in full rather than guessed at.
 */
const TAIL_WINDOW_BYTES = 64 * 1024;

/**
 * The last complete line, read from the end of the file. An append only needs
 * the tail to find the next seq, so reading the whole ledger here made append
 * cost grow with the ledger and made N appends cost O(N squared) in bytes read.
 *
 * A trailing fragment with no newline is a record another writer has not
 * finished writing. It is skipped rather than parsed, which is the same chain
 * the reader would see after the writer's own crash.
 */
async function lastEntry(file: string): Promise<JsonlReceipt | null> {
  let handle: FileHandle;
  try {
    handle = await openPrivateFile(file, "read", "ledger file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let window = Math.min(TAIL_WINDOW_BYTES, size);
    for (;;) {
      const buffer = Buffer.allocUnsafe(window);
      await handle.read(buffer, 0, window, size - window);
      // The text between the last two newlines is the final line the file
      // finished; anything after the last newline is a fragment.
      const text = buffer.toString("utf8");
      const end = text.lastIndexOf("\n");
      const line = end < 0 ? "" : text.slice(text.lastIndexOf("\n", end - 1) + 1, end);
      if (line !== "") {
        try {
          return JSON.parse(line) as JsonlReceipt;
        } catch (error) {
          // A line that is not JSON is a corrupt tail, not a short window:
          // only a full read can tell those apart.
          if (window >= size) throw error;
        }
      }
      if (window >= size) return null;
      window = Math.min(size, window * 2);
    }
  } finally {
    await handle.close();
  }
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return (await readPrivateFile(file, "ledger file")).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}


async function headInfo(
  file: string,
  _workspace: string,
): Promise<[string, number]> {
  const head = await lastEntry(file);
  return head === null ? [GENESIS_PREV, 1] : [head.hash, head.seq + 1];
}

export { canonicalJson };
