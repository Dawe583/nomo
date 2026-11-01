import { basename, resolve } from "node:path";

import type { WorkspaceTab, WorkspaceTui } from "./workspace.ts";

export interface WorkspaceUsageRecord {
  readonly id: string;
  readonly model: string;
  readonly provider?: string;
  readonly totalTokens?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly at?: string;
}

export interface WorkspaceSurfaceRow {
  readonly id: string;
  readonly label: string;
  readonly details: readonly string[];
  readonly usage?: WorkspaceUsageRecord;
}
export function transcriptWindow<T>(
  events: readonly T[],
  scroll: number,
  height: number,
): readonly T[] {
  const size = Math.max(1, height);
  const start = Math.max(
    0,
    Math.min(
      !Number.isFinite(scroll) || scroll < 0 ? events.length - size : scroll,
      events.length - size,
    ),
  );
  return events.slice(start, start + size);
}

export interface WorkspaceSurface {
  readonly tab: WorkspaceTab;
  readonly heading: string;
  readonly workspace: string;
  readonly layout: "columns" | "stacked";
  readonly width: number;
  readonly height: number;
  readonly rows: readonly WorkspaceSurfaceRow[];
  readonly selected?: WorkspaceSurfaceRow;
  readonly provider?: string;
  readonly empty: boolean;
  readonly emptyTitle: string;
  readonly details: readonly string[];
}

const TITLES: Record<WorkspaceTab, string> = {
  overview: "Overview",
  chat: "Chat",
  sessions: "Sessions",
  documents: "Documents",
  ledger: "Ledger",
  approvals: "Approvals",
  policy: "Policy",
  tools: "Tools",
  models: "Models",
  usage: "Usage",
  help: "Help",
};

const EMPTY_TITLES: Record<WorkspaceTab, string> = {
  overview: "No recent activity",
  chat: "Start a conversation",
  sessions: "No conversations yet",
  documents: "No workspace documents",
  ledger: "No activity to review",
  approvals: "No pending approvals",
  policy: "No connected policies",
  tools: "No tools available",
  models: "No models from this provider",
  usage: "No usage recorded",
  help: "Help is ready",
};

export function workspaceSurface(
  ui: WorkspaceTui,
  width: number,
  height: number,
): WorkspaceSurface {
  const projectId = ui.session()?.project ?? ui.projectId;
  const project = ui.workbench
    .listProjects()
    .find((entry) => entry.id === projectId);
  const workspace =
    project?.name ?? basename(resolve(project?.root ?? process.cwd()));
  const rows =
    ui.tab === "models"
      ? (ui.modelCatalogStatus === "ready"
          ? (ui.provider?.models ?? [])
          : []
        ).map((model) => ({
          id: model.id,
          label: model.name,
          details: [
            `Provider: ${ui.provider?.providerId ?? "unavailable"}`,
            `Model ID: ${model.id}`,
            `Selected: ${model.id === ui.model ? "yes" : "no"}`,
          ],
        }))
      : ui.items().map((row) => ({
          id: row.id,
          label: row.label,
          details: row.lines,
          ...(row.usage ? { usage: row.usage } : {}),
        }));
  const selected = rows[ui.selected];
  const detail = ui.detail ?? selected?.details ?? [];
  return {
    tab: ui.tab,
    heading: TITLES[ui.tab],
    workspace,
    layout: width >= 120 ? "columns" : "stacked",
    width,
    height,
    rows,
    selected,
    ...(ui.provider?.providerId ? { provider: ui.provider.providerId } : {}),
    empty: rows.length === 0,
    emptyTitle: EMPTY_TITLES[ui.tab],
    details: detail,
  };
}
export function handleModelPickerKey(
  ui: WorkspaceTui,
  value: string | undefined,
  key: Readonly<{ name?: string; ctrl?: boolean; meta?: boolean }>,
): false | true | string {
  const picker = ui.modelPicker;
  if (!picker?.open) return false;
  const matches = picker.models.filter((model) =>
    `${model.name} ${model.id}`
      .toLocaleLowerCase()
      .includes(picker.query.toLocaleLowerCase()),
  );
  if (key.name === "escape") {
    ui.closeModelPicker();
    ui.notice = "Model selection cancelled.";
    return true;
  }
  if (key.name === "return" || key.name === "enter")
    return matches[picker.selected]?.id ?? true;
  if (key.name === "up" || key.name === "down") {
    ui.modelPicker = {
      ...picker,
      selected: Math.max(
        0,
        Math.min(
          Math.max(0, matches.length - 1),
          picker.selected + (key.name === "down" ? 1 : -1),
        ),
      ),
    };
    return true;
  }
  if (key.name === "backspace") {
    ui.modelPicker = {
      ...picker,
      query: picker.query.slice(0, -1),
      selected: 0,
    };
    return true;
  }
  if (value && !key.ctrl && !key.meta && [...value].length === 1) {
    ui.modelPicker = {
      ...picker,
      query: picker.query + value,
      selected: 0,
    };
  }
  return true;
}
