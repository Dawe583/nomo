import type { SessionEvent } from "../../../workbench/src/index.ts";
import { sanitizeText, stripAnsi } from "./layout.ts";

export type RunActivityMode = "compact" | "details" | "expanded";

const PREVIEW_KEYS = [
  "command",
  "cmd",
  "script",
  "path",
  "file_path",
  "filename",
  "file",
  "uri",
  "patch",
  "diff",
  "old_str",
  "new_str",
  "content",
  "query",
] as const;
const SECRET_KEY =
  /(?:^|[_-])(?:api[_-]?)?(?:key|token|secret|password|credential|authorization)(?:$|[_-])/i;
const PRIVATE_KEY =
  /(?:^|[_-])(?:chain[_-]?of[_-]?thought|(?:private|internal)[_-]?(?:reasoning|thoughts?)|reasoning|thoughts?)(?:$|[_-])/i;
const MAX_LINES = 40;
const MAX_LINE_CHARS = 1000;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Redact secrets before terminal sanitization so multiline PEM blocks remain recognizable.
function redactSecrets(value: string): string {
  return value
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi,
      "[redacted private key block]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
      "[redacted]",
    )
    .replace(
      /\b((?:api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|token|credential|secret|password|authorization)(?:\\?["'])?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /([?&](?:api[_-]?key|private[_-]?key|token|secret|password)=)[^&\s]+/gi,
      "$1[redacted]",
    );
}

function safeText(value: string): string {
  return sanitizeText(redactSecrets(stripAnsi(value)));
}

function safeMultiline(value: string): string {
  return redactSecrets(stripAnsi(value))
    .split(/\r?\n/)
    .map((line) => sanitizeText(line))
    .join("\n");
}

function cleanField(
  key: string,
  value: unknown,
  mode: RunActivityMode,
  depth = 0,
): string[] {
  if (PRIVATE_KEY.test(key)) return [];
  if (SECRET_KEY.test(key)) return [`${safeText(key)}: [redacted]`];
  if (typeof value === "string") {
    const safe = safeMultiline(value);
    if (mode === "compact")
      return safe.trim() ? [safe.split("\n", 1)[0]!.trim().slice(0, 180)] : [];
    const code =
      /^(?:content|text|body|prompt|patch|diff|script|command|old_str|new_str|source|replacement|code)$/i.test(
        key,
      ) || safe.includes("\n");
    if (!code && mode !== "expanded")
      return [
        `${safeText(key)}: ${safe.replace(/\s+/g, " ").trim().slice(0, 180)}`,
      ];
    const limit = mode === "expanded" ? 16 * 1024 : 900;
    const shown = safe.slice(0, limit).split("\n");
    const lines =
      mode === "expanded"
        ? shown
        : shown.slice(0, 5).map((line) => line.slice(0, 180));
    const out = [
      `${safeText(key)} · ${safe.split("\n").length} lines · ${safe.length} chars`,
      ...lines.map((line) => `  ${line}`),
    ];
    if (shown.length < safe.split("\n").length)
      out.push(`  … ${safe.split("\n").length - shown.length} more lines`);
    if (safe.length > limit)
      out.push(`  … ${safe.length - limit} characters omitted`);
    return out;
  }
  if (typeof value === "number" && Number.isFinite(value))
    return [`${safeText(key)}: ${value}`];
  if (typeof value === "boolean")
    return [`${safeText(key)}: ${value ? "yes" : "no"}`];
  if (Array.isArray(value)) {
    if (mode !== "expanded" || depth >= 5)
      return [`${safeText(key)}: ${value.length} items`];
    const shown = value.slice(0, 12);
    return [
      `${safeText(key)}: ${value.length} items`,
      ...shown.flatMap((item, index) =>
        cleanField(`[${index}]`, item, mode, depth + 1),
      ),
      ...(shown.length < value.length
        ? [`… ${value.length - shown.length} more items`]
        : []),
    ];
  }
  const nested = record(value);
  if (nested) {
    if (mode !== "expanded" || depth >= 5)
      return [
        `${safeText(key)}: { ${Object.keys(nested)
          .filter((child) => !PRIVATE_KEY.test(child))
          .slice(0, 8)
          .map(safeText)
          .join(", ")} }`,
      ];
    const entries = Object.entries(nested).slice(0, 12);
    return [
      `${safeText(key)}: {`,
      ...entries.flatMap(([child, item]) =>
        cleanField(child, item, mode, depth + 1),
      ),
      `}${entries.length < Object.keys(nested).length ? ` … ${Object.keys(nested).length - entries.length} more fields` : ""}`,
    ];
  }
  return [];
}

function resultText(result: unknown): string {
  const data = record(result);
  if (!data) return "";
  if (Array.isArray(data.content)) {
    const text = data.content.flatMap((block) => {
      const item = record(block);
      return typeof item?.text === "string" ? [item.text] : [];
    });
    if (text.length) return text.join("\n");
  }
  return ["stdout", "output", "text", "message", "stderr"]
    .flatMap((key) =>
      typeof data[key] === "string" ? [data[key] as string] : [],
    )
    .join("\n");
}

function bounded(lines: readonly string[]): string[] {
  const truncated = lines.length > MAX_LINES;
  const contentLimit = truncated ? MAX_LINES - 1 : MAX_LINES;
  const result = lines
    .slice(0, contentLimit)
    .map((line) => safeText(line).slice(0, MAX_LINE_CHARS));
  if (truncated) result.push(`… ${lines.length - contentLimit} more lines`);
  return result;
}

/** Format only recorded tool I/O; provider-private reasoning is never rendered. */
export function formatRunActivity(
  event: SessionEvent,
  mode: RunActivityMode = "compact",
): string[] {
  if (
    event.kind !== "tool" ||
    (event.type !== "tool.started" && event.type !== "tool.result")
  )
    return [];
  const payload = event.payload;
  const tool =
    typeof payload?.tool === "string" && payload.tool.trim()
      ? safeText(payload.tool).slice(0, 120)
      : "unknown tool";
  const result = record(payload?.result);
  const failed = result?.isError === true;
  if (event.type === "tool.started") {
    const args = record(payload?.arguments);
    const keys = args
      ? Object.keys(args).sort((a, b) => {
          const ai = PREVIEW_KEYS.indexOf(
            a.toLowerCase() as (typeof PREVIEW_KEYS)[number],
          );
          const bi = PREVIEW_KEYS.indexOf(
            b.toLowerCase() as (typeof PREVIEW_KEYS)[number],
          );
          return (
            (ai < 0 ? PREVIEW_KEYS.length : ai) -
            (bi < 0 ? PREVIEW_KEYS.length : bi)
          );
        })
      : [];
    const preview = keys.find(
      (key) =>
        !PRIVATE_KEY.test(key) &&
        (typeof args?.[key] === "string" || SECRET_KEY.test(key)),
    );
    if (mode === "compact") {
      const value =
        preview && args
          ? cleanField(preview, args[preview], mode)[0]
          : safeText(event.text).trim().slice(0, 180);
      return bounded([
        `${tool} · running${value ? ` · ${preview ? `${safeText(preview)}: ` : ""}${value}` : ""}`,
      ]);
    }
    const details: string[] = [];
    for (const key of keys.slice(0, mode === "expanded" ? 32 : 8))
      details.push(...cleanField(key, args?.[key], mode));
    if (keys.length > (mode === "expanded" ? 32 : 8))
      details.push(
        `… ${keys.length - (mode === "expanded" ? 32 : 8)} more fields`,
      );
    if (details.length === 0) {
      const fallback = safeText(event.text).trim();
      if (fallback)
        details.push(
          ...fallback.split("\n").slice(0, mode === "expanded" ? 16 : 1),
        );
      else details.push("Arguments unavailable");
    }
    return bounded([`${tool} · running`, ...details]);
  }
  const output = resultText(payload?.result).trim();
  const state = failed ? "failed" : "completed";
  if (mode === "compact") {
    const preview = output
      ? safeMultiline(output).split("\n", 1)[0]!.trim().slice(0, 180)
      : "No output returned";
    return bounded([`${tool} · ${state} · ${preview}`]);
  }
  const lines: string[] = [`${tool} · ${state}`];
  if (output) {
    const safe = safeMultiline(output);
    const cap = mode === "expanded" ? 16 * 1024 : 1200;
    lines.push(
      `Output · ${safe.split("\n").length} lines · ${safe.length} chars`,
      ...safe.slice(0, cap).split("\n"),
    );
    if (safe.length > cap)
      lines.push(`… ${safe.length - cap} characters omitted`);
  } else {
    const text = safeText(event.text).trim();
    lines.push(text || "No output returned");
  }
  return bounded(lines);
}
