// NOMO mobile ASCII helpers: presentational only.
// Why: status glyphs must degrade to plain ASCII text when fonts fail.
// This module reads the data-tone attribute already rendered by the page
// and adds a text tag. It never decides policy, class, replay, or ledger
// state. All labels are plain ASCII so missing glyphs cannot break them.

const LABELS = { ok: "OK", info: "i", warn: "!", bad: "x" };

// Add a text status tag to one element. Safe to call twice.
export function asciiStatusTag(el) {
  if (!el || el.querySelector(":scope > .status-tag")) return;
  const tone = el.getAttribute && el.getAttribute("data-tone");
  const label = LABELS[tone] || "?";
  const tag = el.ownerDocument.createElement("span");
  tag.className = "status-tag";
  tag.setAttribute("data-label", label);
  tag.setAttribute("aria-hidden", "true");
  el.prepend(tag);
}

// Tag every [data-tone] element inside a root. Returns the tagged count.
export function asciiStatusScan(root) {
  if (!root || !root.querySelectorAll) return 0;
  const nodes = root.querySelectorAll("[data-tone]");
  nodes.forEach(asciiStatusTag);
  return nodes.length;
}
