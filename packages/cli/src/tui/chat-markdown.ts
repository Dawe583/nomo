export type InlineMarkdownPart = {
  text: string;
  style?: "strong" | "code";
};

/** Split safe inline Markdown into renderable strong/code/plain spans. */
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
