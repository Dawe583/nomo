import { fit, pad, sanitizeText, visibleLength } from "./layout.ts";
import { classLabel, decisionLabel, paint } from "./theme.ts";
import type { InterceptedCall, TerminalCapabilities } from "./types.ts";

export function renderInlineCall(
  call: InterceptedCall,
  capabilities: TerminalCapabilities,
): string {
  const width = capabilities.columns;
  const radius =
    call.blastRadius === null
      ? "? targets"
      : `${call.blastRadius} target${call.blastRadius === 1 ? "" : "s"}`;
  const classText = classLabel(call.class, capabilities);
  const decisionText = decisionLabel(call.decision, capabilities);
  const compactFixed = `${classText} ${decisionText} `;
  const timedFixed = `${sanitizeText(call.time)} ${compactFixed}`;
  const suffix = ` ${radius} ${call.durationMs}ms`;
  const suffixWidth = visibleLength(suffix);
  const fixed =
    visibleLength(timedFixed) + suffixWidth <= width
      ? timedFixed
      : compactFixed;
  const toolWidth = Math.max(0, width - visibleLength(fixed) - suffixWidth);
  // Left truncation keeps the resource and action suffix of a long tool id,
  // which is where the meaning lives. The tool id is external data, so it is
  // sanitized before any of the width math, not after.
  const tool = fit(sanitizeText(call.tool), toolWidth, "left");
  return fit(
    `${fixed}${pad(tool, toolWidth)}${paint(suffix, "muted", capabilities)}`,
    width,
  );
}
