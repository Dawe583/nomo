// Grouping layer for the documents and sessions tabs: flat entry lists become
// collapsible trees through widgets.ts, so an operator with dozens of rows can
// hide the folders they do not care about. This module builds trees only and
// owns no screen state, which keeps it unit testable and safe to call from any
// surface. It must not import workspace.ts: the workspace imports this module,
// so that direction would be an import cycle.
import { flattenTree, type TreeNode, type TreeState } from "./widgets.ts";

/** A session or document as the tree builder sees it. */
export interface FlatEntry {
  readonly id: string;
  /** Path-like key. Slashes separate folders. */
  readonly path: string;
  /** What the row says after the path. */
  readonly detail?: string;
  /** Status or class, used to pick an icon. */
  readonly kind?: string;
  /** Optional descending priority and sort key for Sessions tree leaves. */
  readonly sortPriority?: number;
  readonly sortOrder?: number;
}

export interface GroupOptions {
  /** Folders at or below this depth are collapsed in the initial state. */
  readonly collapseBelowDepth?: number;
}

// Single cell icons mirroring the workspace row glyphs. workspace.ts owns the
// canonical set but cannot be imported here (cycle), so these are local copies
// restricted to glyphs layout.ts counts as one cell. Icons are decoration
// only: the trailing slash on folders is the signal that survives monochrome.
const FOLDER_ICON = "+";
const FILE_ICON = "▤";
const ICON_RUNNING = "◉";
const ICON_SETTLED = "●";
const ICON_FAILED = "×";
const ICON_QUEUED = "◔";
const ICON_ARCHIVED = "□";
const ICON_UNKNOWN = "?";

// Same keyword mapping as the workspace state icon, duplicated here to avoid
// the import cycle. An unrecognised state gets the question mark rather than
// a guessed dot, so the terminal never states a fact it was not told.
function kindIcon(kind: string | undefined): string {
  const key = (kind ?? "").toLowerCase();
  if (key.includes("run") || key.includes("active")) return ICON_RUNNING;
  if (key.includes("fail") || key.includes("error")) return ICON_FAILED;
  if (key.includes("queue") || key.includes("pending")) return ICON_QUEUED;
  if (key.includes("archiv")) return ICON_ARCHIVED;
  if (key.includes("settl") || key.includes("done") || key.includes("complet"))
    return ICON_SETTLED;
  return ICON_UNKNOWN;
}

interface BuildRow {
  readonly id: string;
  readonly parts: readonly string[];
  readonly leafIcon: string;
  readonly detail: string | undefined;
  readonly sortPriority: number | undefined;
  readonly sortOrder: number | undefined;
}

interface MutableLeaf {
  readonly id: string;
  readonly label: string;
  readonly sortPriority: number | undefined;
  readonly sortOrder: number | undefined;
}

interface MutableFolder {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly icon: string;
  readonly children: Map<string, MutableFolder>;
  readonly leaves: MutableLeaf[];
}

// Code unit order, not locale order: localeCompare varies by machine, which
// would break the cross-frame determinism callers rely on.
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function isExpandable(node: TreeNode): boolean {
  return (
    node.hasChildren ||
    (node.children !== undefined && node.children.length > 0)
  );
}

// A path with no segments ("" or "///") still names one row from the entry id,
// so no input silently vanishes from the tree.
function splitPath(path: string, fallback: string): string[] {
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length === 0) return [fallback === "" ? "unnamed" : fallback];
  return parts;
}

// " -- " matches the renderList hint separator, so tree leaves and flat list
// rows read the same way when motion and colour are off.
function leafLabel(
  icon: string,
  base: string,
  detail: string | undefined,
): string {
  const text =
    detail === undefined || detail === "" ? base : `${base} -- ${detail}`;
  return `${icon} ${text}`;
}

function makeFolder(
  id: string,
  name: string,
  depth: number,
  icon: string,
): MutableFolder {
  return { id, name, depth, icon, children: new Map(), leaves: [] };
}

// Folders sort by path. Leaves use a caller's recency key when supplied;
// other trees retain stable id order.
function freezeChildren(folder: MutableFolder): TreeNode[] {
  const folders = [...folder.children.values()].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const leaves = [...folder.leaves].sort((a, b) => {
    const aPriority = Number.isFinite(a.sortPriority)
      ? a.sortPriority
      : undefined;
    const bPriority = Number.isFinite(b.sortPriority)
      ? b.sortPriority
      : undefined;
    if (aPriority !== undefined || bPriority !== undefined) {
      if (aPriority === undefined) return 1;
      if (bPriority === undefined) return -1;
      if (aPriority !== bPriority) return bPriority - aPriority;
    }
    const aOrder = Number.isFinite(a.sortOrder) ? a.sortOrder : undefined;
    const bOrder = Number.isFinite(b.sortOrder) ? b.sortOrder : undefined;
    if (aOrder !== undefined || bOrder !== undefined) {
      if (aOrder === undefined) return 1;
      if (bOrder === undefined) return -1;
      if (aOrder !== bOrder) return bOrder - aOrder;
    }
    return compareStrings(a.id, b.id);
  });
  const out: TreeNode[] = [];
  for (const child of folders) {
    const children = freezeChildren(child);
    out.push({
      id: child.id,
      // Trailing slash is the monochrome folder signal: it survives a
      // terminal with no colour and no glyph support.
      label: `${child.icon} ${child.name}/`,
      depth: child.depth,
      hasChildren: true,
      children,
    });
  }
  for (const leaf of leaves) {
    out.push({
      id: leaf.id,
      label: leaf.label,
      depth: folder.depth + 1,
      hasChildren: false,
    });
  }
  return out;
}

// Shared path-grouping core. idPrefix scopes every descendant id under one
// root ("" for documents, "status/" for sessions) so two entries with the
// same path in different scopes never share a node id and select together.
function buildPathNodes(
  rows: readonly BuildRow[],
  parentDepth: number,
  idPrefix: string,
): TreeNode[] {
  const fullId = (parts: readonly string[]): string =>
    idPrefix + parts.join("/");
  // Documents from separate sessions can share a visible path where one is a
  // file and another is a folder, so derived folders may coexist with
  // session-scoped source leaves.
  // Fewest segments first creates parent folders before descendants; sorting
  // by path makes the tree stable regardless of input order.
  const ordered = [...rows].sort((a, b) => {
    if (a.parts.length !== b.parts.length)
      return a.parts.length - b.parts.length;
    return compareStrings(fullId(a.parts), fullId(b.parts));
  });
  const root: MutableFolder = makeFolder(
    idPrefix,
    "",
    parentDepth,
    FOLDER_ICON,
  );
  const byId = new Map<string, MutableFolder>([[idPrefix, root]]);
  const seen = new Set<string>();
  for (const row of ordered) {
    const id = fullId(row.parts);
    // Duplicate source ids collapse, but identical paths from different
    // conversations remain separate selectable rows.
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    for (let level = 1; level < row.parts.length; level += 1) {
      const folderId = fullId(row.parts.slice(0, level));
      if (!byId.has(folderId)) {
        const parent = byId.get(fullId(row.parts.slice(0, level - 1)))!;
        const folder = makeFolder(
          folderId,
          row.parts[level - 1]!,
          parentDepth + level,
          FOLDER_ICON,
        );
        parent.children.set(folderId, folder);
        byId.set(folderId, folder);
      }
    }
    const parent = byId.get(fullId(row.parts.slice(0, row.parts.length - 1)))!;
    const base = row.parts[row.parts.length - 1]!;
    parent.leaves.push({
      id: row.id,
      label: leafLabel(row.leafIcon, base, row.detail),
      sortPriority: row.sortPriority,
      sortOrder: row.sortOrder,
    });
  }
  return freezeChildren(root);
}

export function buildDocumentTree(
  entries: readonly FlatEntry[],
  options?: GroupOptions,
): TreeNode[] {
  // Depth policy lives in initialTreeState; the option rides along here so
  // both builders share one call shape.
  void options;
  if (entries.length === 0) return [];
  const rows: BuildRow[] = entries.map((entry) => ({
    id: entry.id,
    parts: splitPath(entry.path, entry.id),
    leafIcon: FILE_ICON,
    detail: entry.detail,
    sortPriority: undefined,
    sortOrder: undefined,
  }));
  return buildPathNodes(rows, -1, "");
}

export function buildSessionTree(
  entries: readonly FlatEntry[],
  options?: GroupOptions,
): TreeNode[] {
  // Depth policy lives in initialTreeState; the option rides along here so
  // both builders share one call shape.
  void options;
  if (entries.length === 0) return [];
  // Sessions carry no folder structure worth inventing, so status is the
  // useful cut. A blank kind joins "other" rather than forming an empty group.
  const groups = new Map<string, BuildRow[]>();
  for (const entry of entries) {
    const raw = (entry.kind ?? "").trim();
    const key = raw === "" ? "other" : raw;
    const row: BuildRow = {
      id: entry.id,
      // A conversation title is a label, not a directory path. Keep slashes
      // inside the title instead of inventing nested session folders.
      parts: [entry.path || entry.id],
      leafIcon: kindIcon(entry.kind),
      detail: entry.detail,
      sortPriority: entry.sortPriority,
      sortOrder: entry.sortOrder,
    };
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  const groupOrder = [
    "running",
    "queued",
    "failed",
    "settled",
    "archived",
    "other",
  ];
  const keys = [...groups.keys()].sort((a, b) => {
    const aIndex = groupOrder.indexOf(a);
    const bIndex = groupOrder.indexOf(b);
    if (aIndex >= 0 || bIndex >= 0) {
      if (aIndex < 0) return 1;
      if (bIndex < 0) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareStrings(a, b);
  });
  const out: TreeNode[] = [];
  for (const key of keys) {
    const children = buildPathNodes(groups.get(key)!, 0, `${key}/`);
    out.push({
      id: key,
      label: `${kindIcon(key)} ${key}/`,
      depth: 0,
      hasChildren: true,
      children,
    });
  }
  return out;
}

export function initialTreeState(
  nodes: readonly TreeNode[],
  options?: GroupOptions,
): TreeState {
  // Default threshold 1 expands only the root level. Everything expanded made
  // the tree feel like the flat list it replaced and hid the grouping.
  const raw = options?.collapseBelowDepth;
  const threshold = typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
  const expanded = new Set<string>();
  const visit = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (isExpandable(node) && node.depth < threshold) expanded.add(node.id);
      if (node.children !== undefined) visit(node.children);
    }
  };
  visit(nodes);
  return { expanded, cursor: 0 };
}

/**
 * One line: how many groups are collapsed and how many rows are hidden.
 *
 * The nouns come from the caller. A summary saying "3 documents hidden"
 * above a list of conversations is wrong in a way an operator has to stop
 * and parse, which is the whole cost this line is supposed to avoid.
 */
export function collapsedSummary(
  state: TreeState,
  nodes: readonly TreeNode[],
  nouns: { readonly group: string; readonly row: string } = {
    group: "folder",
    row: "document",
  },
): string {
  let collapsedGroups = 0;
  let totalLeaves = 0;
  const visit = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (isExpandable(node)) {
        if (!state.expanded.has(node.id)) collapsedGroups += 1;
      } else {
        totalLeaves += 1;
      }
      if (node.children !== undefined) visit(node.children);
    }
  };
  visit(nodes);
  // flattenTree lists only rows visible under the current expansion, so hidden
  // leaves are the total minus the visible with no extra bookkeeping.
  let visibleLeaves = 0;
  for (const node of flattenTree(nodes, state)) {
    if (!isExpandable(node)) visibleLeaves += 1;
  }
  const hidden = totalLeaves - visibleLeaves;
  // Zero counts keep the same sentence shape: an empty string would render as
  // a broken blank row, and the steady form compares cleanly across frames.
  return (
    `${collapsedGroups} ${plural(collapsedGroups, nouns.group, `${nouns.group}s`)} collapsed, ` +
    `${hidden} ${plural(hidden, nouns.row, `${nouns.row}s`)} hidden`
  );
}
