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
}

interface MutableLeaf {
  readonly id: string;
  readonly label: string;
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

// Folders sort before files and each group sorts by id, so the tree is stable
// across frames and a caller can compare state frame to frame.
function freezeChildren(folder: MutableFolder): TreeNode[] {
  const folders = [...folder.children.values()].sort((a, b) =>
    compareStrings(a.id, b.id),
  );
  const leaves = [...folder.leaves].sort((a, b) => compareStrings(a.id, b.id));
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

// Shared path-grouping core. idPrefix scopes folder ids under one root, while
// leaf ids stay tied to their source rows so duplicate paths remain selectable.
function buildPathNodes(
  rows: readonly BuildRow[],
  parentDepth: number,
  idPrefix: string,
): TreeNode[] {
  const fullId = (parts: readonly string[]): string =>
    idPrefix + parts.join("/");
  // Folder ids are every strict parent prefix, collected before inserting so
  // a path naming both a file and a folder resolves one way: the folder wins
  // and the conflicting file row is omitted.
  const folderIds = new Set<string>();
  for (const row of rows) {
    for (let level = 1; level < row.parts.length; level += 1) {
      folderIds.add(fullId(row.parts.slice(0, level)));
    }
  }
  // Fewest segments first so folders exist before a same-id file row is
  // considered, then by id so any input order freezes to the same tree.
  const ordered = [...rows].sort((a, b) => {
    if (a.parts.length !== b.parts.length)
      return a.parts.length - b.parts.length;
    return (
      compareStrings(fullId(a.parts), fullId(b.parts)) ||
      compareStrings(a.id, b.id)
    );
  });
  const root: MutableFolder = makeFolder(
    idPrefix,
    "",
    parentDepth,
    FOLDER_ICON,
  );
  const byId = new Map<string, MutableFolder>([[idPrefix, root]]);
  for (const row of ordered) {
    const id = fullId(row.parts);
    // Folders win a file/folder path collision. Leaf nodes keep the source id,
    // so duplicate titles remain selectable and Enter resolves the right row.
    if (folderIds.has(id)) continue;
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
      parts: splitPath(entry.path, entry.id),
      leafIcon: kindIcon(entry.kind),
      detail: entry.detail,
    };
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  const keys = [...groups.keys()].sort(compareStrings);
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
