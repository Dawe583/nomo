// A collapsible tree for grouped rows. NOMO's item lists were flat strings,
// so forty documents meant forty rows to scroll past with no way to fold away
// the folders that did not matter. This owns the fold state and the window,
// and nothing else: no screen state, no raw mode, so it stays safe to unit
// test and to render inside any surface.
//
// Motion follows the motion.ts discipline: every animated choice is a pure
// function of the frame counter, and every marker already reads as text with
// motion off. A filterable list lived here too and was removed: items() in
// workspace.ts already filters, and a second filter on top of it would have
// narrowed the rows twice.
import { pad, sanitizeText } from "./layout.ts";
import { cursorMarker, type MotionContext } from "./motion.ts";
import { getSymbols, type SymbolPreset } from "./theme.ts";

export interface TreeNode {
  readonly id: string;
  readonly label: string;
  readonly depth: number;
  readonly hasChildren: boolean;
  /** undefined for a leaf. */
  readonly children?: readonly TreeNode[];
}

export interface TreeState {
  /** Ids of every expanded node. */
  readonly expanded: ReadonlySet<string>;
  /** Index into the flattened visible list. */
  readonly cursor: number;
}

export interface RenderOptions {
  readonly motion?: MotionContext;
  readonly paint?: (text: string, tone: string, bold?: boolean) => string;
  readonly symbolPreset?: SymbolPreset;
}

// Base frame used when the caller passes no motion: the static marker, so a
// snapshot test and a motion-frozen terminal agree byte for byte.
const BASE_MOTION: MotionContext = { frame: 0, enabled: false, reduced: true };

function resolveMotion(options: RenderOptions | undefined): MotionContext {
  return options?.motion ?? BASE_MOTION;
}

function resolvePaint(
  options: RenderOptions | undefined,
): (text: string, tone: string, bold?: boolean) => string {
  return options?.paint ?? ((text: string): string => text);
}

// Depth-first walk that emits only nodes whose ancestors are all expanded.
// Collapsed children are absent from the output rather than flagged hidden,
// so a caller can trust the list is complete and index into it directly.
export function flattenTree(
  nodes: readonly TreeNode[],
  state: TreeState,
): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      out.push(node);
      if (
        node.children !== undefined &&
        node.children.length > 0 &&
        state.expanded.has(node.id)
      ) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return out;
}

function findTreeNode(
  nodes: readonly TreeNode[],
  id: string,
): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children !== undefined) {
      const found = findTreeNode(node.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// A leaf carries no expandable entry: toggling it returns the state
// unchanged so a keystroke on a leaf never grows the expanded set forever.
// An unknown id is also a no-op rather than an invented entry.
export function toggleTreeNode(
  state: TreeState,
  id: string,
  nodes: readonly TreeNode[],
): TreeState {
  const node = findTreeNode(nodes, id);
  if (node === undefined) return state;
  const expandable =
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0);
  if (!expandable) return state;
  const expanded = new Set(state.expanded);
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  const next: TreeState = { expanded, cursor: state.cursor };
  const flat = flattenTree(nodes, next);
  if (flat.length === 0) return { expanded, cursor: 0 };
  return {
    expanded,
    cursor: Math.max(0, Math.min(next.cursor, flat.length - 1)),
  };
}

// Wrap-around movement against the live flattened length, which changes as
// nodes expand and collapse, so moving after a collapse never lands the
// cursor past the end of the visible list.
export function moveTree(
  state: TreeState,
  delta: number,
  nodes: readonly TreeNode[],
): TreeState {
  const flat = flattenTree(nodes, state);
  if (flat.length === 0) return { expanded: state.expanded, cursor: 0 };
  const next =
    (((state.cursor + delta) % flat.length) + flat.length) % flat.length;
  return { expanded: state.expanded, cursor: next };
}

// Expand markers are bracketed text ([-], [+]) rather than a bare glyph, so
// expanded, collapsed, and leaf rows stay distinguishable on a monochrome
// terminal and under a screen reader. ASCII keeps every marker one cell.
function treeExpandMarker(node: TreeNode, expanded: boolean): string {
  const expandable =
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0);
  if (!expandable) return "   ";
  return expanded ? "[-]" : "[+]";
}

export function renderTree(
  nodes: readonly TreeNode[],
  state: TreeState,
  width: number,
  height: number,
  options?: RenderOptions,
): string[] {
  const motion = resolveMotion(options);
  const paint = resolvePaint(options);
  const symbols = getSymbols(options?.symbolPreset ?? "ascii");
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const flat = flattenTree(nodes, state);
  if (flat.length === 0) return [pad("No nodes.", safeWidth)];
  const cursor = Math.max(0, Math.min(state.cursor, flat.length - 1));
  // Minimum scroll: the window starts at zero until the cursor runs past the
  // bottom, then follows by exactly the overflow, so the cursor row is always
  // visible and steady rows never jump.
  const start =
    cursor < safeHeight
      ? 0
      : Math.min(cursor - safeHeight + 1, flat.length - 1);
  const rows: string[] = [];
  const end = Math.min(flat.length, start + safeHeight);
  const lastSiblings = new Set<TreeNode>();
  const rootEnd = nodes.at(-1);
  if (rootEnd) lastSiblings.add(rootEnd);
  // Keep at least eight cells for the name before spending width on guides.
  const maxDepth = Math.max(0, Math.floor((safeWidth - 14) / 2));
  const rails: string[] = [];
  for (let index = 0; index < end; index += 1) {
    const node = flat[index]!;
    const childEnd = node.children?.at(-1);
    if (childEnd) lastSiblings.add(childEnd);
    const depth = Number.isFinite(node.depth)
      ? Math.min(maxDepth, Math.max(0, Math.floor(node.depth)))
      : 0;
    const last = lastSiblings.has(node);
    rails.length = depth;
    const guide =
      depth === 0
        ? ""
        : rails.slice(1).join("") +
          (last ? symbols.frame.bl : symbols.frame.teeL) +
          symbols.frame.h;
    rails[depth] = last ? "  " : `${symbols.frame.v} `;
    if (index < start) continue;
    const selected = index === cursor;
    const marker = cursorMarker(selected, motion);
    const expand = treeExpandMarker(node, state.expanded.has(node.id));
    const label = sanitizeText(node.label);
    const row = pad(`${marker}${expand} ${guide}${label}`, safeWidth);
    rows.push(selected ? paint(row, "accent", true) : row);
  }
  return rows;
}
