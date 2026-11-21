import { sanitizeText, visibleLength } from "./layout.ts";

export type InlineMarkdownPart = {
  text: string;
  style?: "strong" | "code";
};

export type ChatMarkdownBlockRow = {
  text: string;
  style: "paragraph" | "heading" | "list" | "quote" | "code";
  parts: InlineMarkdownPart[];
};

/** Convert common chat Markdown blocks into sanitized, terminal-safe rows. */
export function markdownBlockRows(value: string): ChatMarkdownBlockRow[] {
  const rows: ChatMarkdownBlockRow[] = [];
  let fence: { marker: string; length: number } | undefined;
  const add = (text: string, style: ChatMarkdownBlockRow["style"]) => {
    const safe = sanitizeText(text);
    const parts =
      style === "code"
        ? [{ text: safe, style: "code" as const }]
        : inlineMarkdownParts(safe).map((part) =>
            part.style === "code"
              ? part
              : {
                  ...part,
                  text: part.text.replace(
                    /\[([^\]]+)\]\(([^\s)]+)\)/g,
                    "$1 <$2>",
                  ),
                },
          );
    rows.push({ text: parts.map((part) => part.text).join(""), style, parts });
  };

  for (const sourceLine of value.split("\n")) {
    const safeLine = sanitizeText(sourceLine);
    const line = safeLine.replace(/\r$/, "");
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length)
        fence = undefined;
      else add(line, "code");
      continue;
    }
    if (fence) {
      add(line, "code");
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      add(heading[2].replace(/\s+#+\s*$/, ""), "heading");
      continue;
    }

    const list = line.match(/^( *)([-+*]|\d+[.)])\s+(.*)$/);
    if (list) {
      const task = list[3].match(/^\[([ xX])\]\s+(.*)$/);
      const marker = task
        ? task[1].trim()
          ? "✓ "
          : "□ "
        : `${list[2].match(/^\d/) ? `${list[2]} ` : "• "}`;
      add(`${list[1]}${marker}${task?.[2] ?? list[3]}`, "list");
      continue;
    }

    const quote = line.match(/^ {0,3}>\s?(.*)$/);
    if (quote) {
      add(`│ ${quote[1]}`, "quote");
      continue;
    }

    add(line, "paragraph");
  }

  return rows;
}

/**
 * Split the small inline subset shown by the chat painter into literal text
 * spans. This does not parse HTML, terminal escapes, links, or arbitrary
 * Markdown; callers remain responsible for sanitizing text before painting.
 */
export function inlineMarkdownParts(value: string): InlineMarkdownPart[] {
  const parts: InlineMarkdownPart[] = [];
  const pattern = /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`/g;
  let cursor = 0;

  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: value.slice(cursor, index) });

    const code = match[3];
    parts.push({
      text: code ?? match[1] ?? match[2] ?? "",
      style: code === undefined ? "strong" : "code",
    });
    cursor = index + match[0].length;
  }

  if (cursor < value.length) parts.push({ text: value.slice(cursor) });
  return parts.length ? parts : [{ text: value }];
}

/** Paint sanitized spans and pad to the requested terminal-cell width. */
export function paintInlineMarkdown(
  value: string,
  width: number,
  tone: string,
  paint: (text: string, tone: string, bold?: boolean) => string,
): string {
  const clean = sanitizeText(value);
  return paintMarkdownParts(inlineMarkdownParts(clean), width, tone, paint);
}

/** Paint already-parsed safe spans and pad to the requested terminal width. */
export function paintMarkdownParts(
  parts: readonly InlineMarkdownPart[],
  width: number,
  tone: string,
  paint: (text: string, tone: string, bold?: boolean) => string,
): string {
  const body = parts
    .map((part) =>
      paint(
        sanitizeText(part.text),
        part.style === "code" ? "info" : tone,
        part.style === "strong",
      ),
    )
    .join("");
  const cells = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const contentWidth = parts.reduce(
    (total, part) => total + visibleLength(sanitizeText(part.text)),
    0,
  );
  return body + " ".repeat(Math.max(0, cells - contentWidth));
}
