import { loadDevices, writeScope, type CompanionSession } from "./devices.ts";
import { countOperations } from "./operations.ts";

/** Diagnostics are an allowlist projection, never a log tail. An entry carries
 * an identifier, a health word, and an optional short summary; nothing else
 * can be expressed, so a path, a credential, a prompt, or a document body has
 * no field to travel in. */
export type CompanionDiagnosticStatus = "ok" | "pending" | "failed";

export type CompanionDiagnosticEntry = {
  readonly id: string;
  readonly status: CompanionDiagnosticStatus;
  readonly summary?: string;
};

export type CompanionDiagnostics = { readonly entries: readonly CompanionDiagnosticEntry[] };

const statuses: readonly CompanionDiagnosticStatus[] = ["ok", "pending", "failed"];
const maxEntries = 100;
const maxSummaryCharacters = 320;
const idPattern = /^[A-Za-z0-9_.:-]{1,160}$/;

/** Plain short display text and nothing else. A path separator, a home
 * directory, a control character, or one unbroken 32-character run is a
 * location or a credential rather than a label, and is dropped whole instead
 * of being escaped into a summary a phone would render. */
const displayText = /^[\p{L}\p{N} ._'-]{1,80}$/u;

function boundedSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let summary = "";
  // The bound is measured on whole code points: an emoji is two UTF-16 units,
  // and the frozen `boundedString` check counts units, so appending blindly
  // would overshoot the 320 contract limit by one unit.
  for (const point of value.replace(/[\u0000-\u001f\u007f]/g, " ")) {
    if (summary.length + point.length > maxSummaryCharacters) break;
    summary += point;
  }
  summary = summary.trim();
  return summary === "" ? undefined : summary;
}

function entryOf(value: unknown): CompanionDiagnosticEntry | null {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (record === null || typeof record.id !== "string" || !idPattern.test(record.id) ||
      typeof record.status !== "string" || !statuses.includes(record.status as CompanionDiagnosticStatus) ||
      Object.keys(record).some(key => key !== "id" && key !== "status" && key !== "summary")) return null;
  const summary = boundedSummary(record.summary);
  const status = record.status as CompanionDiagnosticStatus;
  return summary === undefined ? { id: record.id, status } : { id: record.id, status, summary };
}

/** The bound is part of the projection, not a caller convention: a page never
 * grows past a hundred entries, and an entry the allowlist cannot express is
 * dropped rather than passed through. */
export function projectDiagnostics(candidates: readonly unknown[]): CompanionDiagnostics {
  const entries: CompanionDiagnosticEntry[] = [];
  for (const candidate of candidates) {
    if (entries.length === maxEntries) break;
    const entry = entryOf(candidate);
    if (entry !== null) entries.push(entry);
  }
  return { entries };
}

function deviceSummary(session: CompanionSession): string {
  const state = session.scopes.includes(writeScope) ? "active" : "active read-only";
  return displayText.test(session.label) && (session.label.includes(" ") || Array.from(session.label).length < 32)
    ? `${session.label}, ${state}`
    : state;
}

function operationsCandidate(env: Readonly<NodeJS.ProcessEnv>, workspaceId: string): unknown {
  try {
    return { id: "companion.operations", status: "ok", summary: `${countOperations(env, workspaceId)} retained operation records` };
  } catch {
    return { id: "companion.operations", status: "failed", summary: "operation records unreadable" };
  }
}

function registryCandidate(env: Readonly<NodeJS.ProcessEnv>, workspaceId: string): unknown {
  try {
    const devices = loadDevices(env).filter(device => device.workspaceId === workspaceId);
    const revoked = devices.filter(device => device.revokedAt !== null).length;
    return { id: "companion.registry", status: "ok", summary: `${devices.length - revoked} active, ${revoked} revoked` };
  } catch {
    return { id: "companion.registry", status: "failed", summary: "device registry unreadable" };
  }
}

export function companionDiagnostics(env: Readonly<NodeJS.ProcessEnv>, session: CompanionSession): CompanionDiagnostics {
  return projectDiagnostics([
    registryCandidate(env, session.workspaceId),
    operationsCandidate(env, session.workspaceId),
    { id: `device:${session.deviceId}`, status: "ok", summary: deviceSummary(session) },
  ]);
}
