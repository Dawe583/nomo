/**
 * Before and after evidence for one approval record.
 *
 * The server is authoritative and its approval record carries the call
 * descriptor only (tool, connector, workspace, class, blast radius), never
 * a state snapshot. A diff therefore shows whatever before and after
 * images the record actually carries, usually under the call or top level
 * keys below, and says so explicitly when the server sent none. Nothing
 * here invents a before image: an absent before renders as unknown.
 */
import type { Row } from "./api.ts";
import { riskOf } from "./approval-text.ts";

/** Same rendering as the shared json helper, local so tests stay runtime free. */
const json = (value: unknown): string => JSON.stringify(value, null, 2);

const BEFORE_KEYS = ["before", "previous", "current", "old", "oldValue"];
const AFTER_KEYS = [
  "after",
  "proposed",
  "next",
  "new",
  "newValue",
  "args",
  "arguments",
  "payload",
  "params",
];

function pick(
  source: Row,
  keys: string[],
): { key: string; value: unknown } | undefined {
  for (const key of keys) {
    if (source[key] !== undefined) return { key, value: source[key] };
  }
  return undefined;
}

export type BeforeAfter = {
  readonly before: unknown;
  readonly beforeKey: string | undefined;
  readonly after: unknown;
  readonly afterKey: string | undefined;
  /** True when the server sent no before image at all. */
  readonly beforeMissing: boolean;
  /** True when the record carries nothing to show on either side. */
  readonly empty: boolean;
};

/** Find the before and after images, first on the record, then on its call. */
export function extractBeforeAfter(record: Row): BeforeAfter {
  const call =
    record.call !== null && typeof record.call === "object"
      ? (record.call as Row)
      : undefined;
  const before =
    pick(record, BEFORE_KEYS) ?? (call ? pick(call, BEFORE_KEYS) : undefined);
  const after =
    pick(record, AFTER_KEYS) ?? (call ? pick(call, AFTER_KEYS) : undefined);
  const beforeMissing = before === undefined;
  return {
    before: before?.value,
    beforeKey: before?.key,
    after: after?.value,
    afterKey: after?.key,
    beforeMissing,
    empty: before === undefined && after === undefined,
  };
}

export type DiffLine = {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
};

function toLines(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.split("\n");
  return json(value).split("\n");
}

/**
 * Line diff of two values over their JSON rendering. Small inputs only;
 * approval payloads are bounded by the server. LCS table, greedy backtrack.
 */
export function diffLines(before: unknown, after: unknown): DiffLine[] {
  const left = toLines(before);
  const right = toLines(after);
  const width = right.length + 1;
  const cell = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      cell[i * width + j] =
        left[i] === right[j]
          ? cell[(i + 1) * width + (j + 1)] + 1
          : Math.max(cell[(i + 1) * width + j], cell[i * width + (j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      out.push({ kind: "same", text: left[i]! });
      i++;
      j++;
    } else if (cell[(i + 1) * width + j] >= cell[i * width + (j + 1)]) {
      out.push({ kind: "del", text: left[i]! });
      i++;
    } else {
      out.push({ kind: "add", text: right[j]! });
      j++;
    }
  }
  while (i < left.length) out.push({ kind: "del", text: left[i++]! });
  while (j < right.length) out.push({ kind: "add", text: right[j++]! });
  return out;
}

/**
 * Destructive gate: R3 and unknown holds need an explicit two step
 * confirmation before the approve call is sent. Everything else approves
 * with one press. The server stays authoritative; this only slows the hand.
 */
export function requiresConfirm(record: Row): boolean {
  const risk = riskOf(record);
  return risk === "r3" || risk === "unknown";
}
