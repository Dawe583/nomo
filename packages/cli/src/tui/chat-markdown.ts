import { sanitizeText } from "./layout.ts";

type MarkdownRow = {
  text: string;
  style: "text" | "heading" | "list" | "quote";
};

function inlineText(text: string): string {
  return text.replace(
    /\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^\s)]+)\)/g,
    (_match, bold: string, strong: string, code: string, label: string, url: string) =>
      bold ?? strong ?? code ?? `${label} <${url}>`,
  );
}

/** Present a line outside code fences without emitting terminal commands. */
export function assistantMarkdownLine(source: string): MarkdownRow {
  const line = sanitizeText(source.replace(/\r$/, ""));
  const heading = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
  if (heading)
    return { text: inlineText(heading[1]!.replace(/\s+#+\s*$/, "")), style: "heading" };

  const list = /^( *)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
  if (list) {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(list[3]!);
    const marker = task
      ? task[1]!.trim() ? "✓" : "□"
      : /^\d/.test(list[2]!) ? list[2]! : "•";
    return {
      text: `${list[1]}${marker} ${inlineText(task?.[2] ?? list[3]!)}`,
      style: "list",
    };
  }

  const quote = /^ {0,3}>\s?(.*)$/.exec(line);
  if (quote) return { text: `│ ${inlineText(quote[1]!)}`, style: "quote" };
  return { text: inlineText(line), style: "text" };
}
