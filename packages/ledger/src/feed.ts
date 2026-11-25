import { watchFile, unwatchFile } from "node:fs";
import type { JsonlEntry } from "./store.ts";
import { readLedgerEntries, verifyChain, type PublicKeyLookup } from "./verify.ts";
import { readLedgerReversal, type LedgerReversal } from "./reversal.ts";
import { readLedgerReason, type LedgerAttribution } from "./attribution.ts";

export type LedgerFeedRecord = {
  readonly seq: number;
  readonly at: string;
  readonly tool: string;
  readonly klass: string;
  readonly decision: string;
  readonly argsDigest: string;
  readonly captureDigest?: string;
  /** Operator decision latency when the signed record measured one. */
  readonly approvalMs?: number;
  /**
   * Present only on entries that carry a reason. Its absence is the record
   * making no attribution claim, which is a different fact from a record
   * that names a policy and no rule.
   */
  readonly attribution?: LedgerAttribution;
  /**
   * Present only on a record that claims to invert an earlier record in this
   * same chain. Its absence means the record inverts nothing.
   */
  readonly reversal?: LedgerReversal;
  /**
   * The key that signed this record. A writer appending to a chain signs under
   * the key that wrote the record it is about to reverse, because a reversal
   * signed by a second key makes the file unverifiable by whoever holds only
   * the first.
   */
  readonly keyId: string;
  readonly prevDigest: string;
  readonly digest: string;
};

export type FeedPage = {
  readonly records: readonly LedgerFeedRecord[];
  readonly verified: true;
  /** True only when a public key checked every entry signature. */
  readonly signed: boolean;
  readonly head: string;
};

export type FeedClock = {
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

export type WatchLedgerFeedOptions = {
  readonly pollMs?: number;
  readonly clock?: FeedClock;
};

export type LedgerFeedWatch = {
  close(): void;
};

const DEFAULT_POLL_MS = 500;

export async function readLedgerFeed(
  ledgerPath: string,
  options: {
    readonly afterSeq?: number;
    /**
     * A public key lookup turns the feed into authenticated reading: every
     * entry signature is checked, not just the hash chain. Without a key the
     * chain still detects local tampering, but anyone who rewrites the whole
     * file can rehash it, so the page says signed false and callers must not
     * present integrity as authentication.
     */
    readonly publicKey?: PublicKeyLookup;
  } = {},
): Promise<FeedPage> {
  const entries = await readLedgerEntries(ledgerPath);
  const result = await verifyChain(entries, { publicKey: options.publicKey });
  if (!result.ok) throw new Error(`ledger chain invalid: ${result.reason}`);
  const records = entries
    .filter((entry) => entry.seq > (options.afterSeq ?? 0))
    .map((entry) => toFeedRecord(entry));

  return { records, verified: true, signed: options.publicKey !== undefined, head: result.head };
}

export function watchLedgerFeed(
  ledgerPath: string,
  onChange: (page: FeedPage) => void,
  options: WatchLedgerFeedOptions = {},
): LedgerFeedWatch {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let closed = false;
  let running = false;
  let lastHead: string | undefined;

  const tick = (): void => {
    if (closed || running) return;
    running = true;
    void readLedgerFeed(ledgerPath)
      .then((page) => {
        if (closed) return;
        if (page.head !== lastHead) onChange(page);
        lastHead = page.head;
      })
      .finally(() => {
        running = false;
      });
  };

  if (options.clock !== undefined) {
    const handle = options.clock.setInterval(tick, pollMs);
    return {
      close() {
        closed = true;
        options.clock!.clearInterval(handle);
      },
    };
  }

  watchFile(ledgerPath, { interval: pollMs }, tick);
  return {
    close() {
      closed = true;
      unwatchFile(ledgerPath, tick);
    },
  };
}

function toFeedRecord(entry: JsonlEntry): LedgerFeedRecord {
  const body = entry.body as Record<string, unknown>;
  const at = stringField(body, "at", entry.seq);
  const tool = stringField(body, "tool", entry.seq);
  const klass = stringField(body, "klass", entry.seq);
  const decision = stringField(body, "decision", entry.seq);
  const argsDigest = stringField(body, "argsDigest", entry.seq);
  // The feed refuses what the verifier refuses, so a consumer cannot read a
  // reason the chain would reject as malformed.
  const reason = readLedgerReason(entry.body, entry.seq);
  const reversal = readLedgerReversal(entry.body, entry.seq);
  if (reversal.kind === "malformed") throw new Error(reversal.detail);
  if (reason.kind === "malformed") throw new Error(reason.detail);
  return {
    seq: entry.seq,
    at,
    tool,
    klass,
    decision,
    argsDigest,
    ...(typeof body.captureDigest === "string" ? { captureDigest: body.captureDigest } : {}),
    ...(typeof body.approvalMs === "number" && Number.isFinite(body.approvalMs) && body.approvalMs >= 0
      ? { approvalMs: body.approvalMs }
      : {}),
    ...(reason.kind === "attributed" ? { attribution: reason.attribution } : {}),
    ...(reversal.kind === "reversal" ? { reversal: reversal.reversal } : {}),
    keyId: entry.key_id,
    prevDigest: entry.prev_hash,
    digest: entry.hash,
  };
}

function stringField(body: Record<string, unknown>, name: string, seq: number): string {
  const value = body[name];
  if (typeof value !== "string" || value === "")
    throw new Error(`ledger entry ${seq} has no ${name}`);
  return value;
}

