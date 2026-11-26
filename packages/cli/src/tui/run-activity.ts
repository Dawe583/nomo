import { sanitizeText, stripAnsi } from "./layout.ts";

/** Shared record guard for structured tool payloads. */
export function toolDetailRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Redact secrets while preserving recorded line boundaries for previews. */
export function redactToolDetail(value: string): string {
  return stripAnsi(value)
    .replace(
      /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi,
      "[redacted private key block]",
    )
    .split(/\r\n?|\n/)
    .map((line) => sanitizeText(line))
    .join("\n")
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

export const PRIVATE_TOOL_DETAIL_KEY =
  /(?:^|[_-])(?:chain[_-]?of[_-]?thought|(?:private|internal)[_-]?(?:reasoning|thoughts?)|reasoning|thoughts?)(?:$|[_-])/i;

export function isPrivateToolDetailKey(key: string): boolean {
  return PRIVATE_TOOL_DETAIL_KEY.test(key);
}

/** Extract recorded text output without inventing missing output. */
export function toolOutputText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(toolOutputText);
  const record = toolDetailRecord(value);
  if (!record) return [];
  if (Array.isArray(record.content)) {
    const content = record.content.flatMap((block) => {
      const item = toolDetailRecord(block);
      return typeof item?.text === "string" ? [item.text] : [];
    });
    if (content.length) return content;
  }
  return ["stdout", "output", "text", "message", "stderr"].flatMap((key) =>
    typeof record[key] === "string" ? [record[key] as string] : [],
  );
}
