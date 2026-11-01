import { decodePasteBytes } from "@opentui/core";
import { getPalette } from "./theme.ts";
import type { ColorPalette } from "./theme-config.ts";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import type { KeyEvent } from "@opentui/core";

import type { WorkspaceTui, WorkspaceTab } from "./workspace.ts";
import {
  transcriptWindow,
  workspaceSurface,
  type WorkspaceSurfaceRow,
} from "./workspace-app-model.ts";

const TABS: readonly WorkspaceTab[] = [
  "overview",
  "chat",
  "sessions",
  "documents",
  "ledger",
  "approvals",
  "policy",
  "tools",
  "models",
  "usage",
  "help",
];
const COMPACT_TABS: Record<WorkspaceTab, string> = {
  overview: "O",
  chat: "C",
  sessions: "S",
  documents: "D",
  ledger: "L",
  approvals: "A",
  policy: "P",
  tools: "T",
  models: "M",
  usage: "U",
  help: "H",
};
const SHORT_TABS: Record<WorkspaceTab, string> = {
  overview: "OVER",
  chat: "CHAT",
  sessions: "SESS",
  documents: "DOCS",
  ledger: "LEDG",
  approvals: "APPR",
  policy: "POLI",
  tools: "TOOL",
  models: "MODE",
  usage: "USAG",
  help: "HELP",
};
const LOGO = new URL("./nomo-logo.png", import.meta.url);

export interface WorkspaceAppProps {
  readonly ui: WorkspaceTui;
  readonly input: string;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly color?: boolean;
  readonly graphicsProtocol?: "kitty";
  readonly onKey: (event: KeyEvent) => void;
  readonly onPaste: (text: string) => void;
  readonly onTab: (tab: WorkspaceTab) => void;
  readonly onSelect: (index: number) => void;
}

const foreground = (colorEnabled: boolean, value: string) =>
  colorEnabled ? value : undefined;

function Panel({
  title,
  children,
  flexGrow = 1,
  color = true,
  palette,
}: {
  title: string;
  children: React.ReactNode;
  flexGrow?: number;
  color?: boolean;
  palette: ColorPalette;
}) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={foreground(color, palette.border)}
      title={` ${title} `}
      padding={1}
      flexGrow={flexGrow}
      flexDirection="column"
      gap={1}
    >
      {children}
    </box>
  );
}

function ModelPicker({
  ui,
  width,
  height,
  color = true,
  palette,
}: {
  ui: WorkspaceTui;
  width: number;
  height: number;
  color?: boolean;
  palette: ColorPalette;
}) {
  const picker = ui.modelPicker!;
  const query = picker.query.toLocaleLowerCase();
  const models = picker.models.filter((model) =>
    `${model.name} ${model.id}`.toLocaleLowerCase().includes(query),
  );
  const visibleCount = Math.max(1, Math.min(14, Math.floor((height - 9) / 2)));
  const start = Math.max(
    0,
    Math.min(
      picker.selected - Math.floor(visibleCount / 2),
      models.length - visibleCount,
    ),
  );
  const visible = models.slice(start, start + visibleCount);
  return (
    <box
      width={Math.max(1, width - 2)}
      border
      borderStyle="rounded"
      borderColor={foreground(color, palette.accent)}
      padding={1}
      flexGrow={1}
      flexDirection="column"
      gap={1}
    >
      <text
        fg={foreground(color, palette.fg)}
        content={`SELECT MODEL · ${ui.provider?.providerId ?? "provider"}`}
      />
      <text
        fg={foreground(color, palette.muted)}
        content={`Search: ${picker.query || "type to filter"}`}
      />
      {visible.length ? (
        visible.map((model) => {
          const index = models.indexOf(model);
          const current = model.id === ui.model ? "  CURRENT" : "";
          return (
            <text
              key={model.id}
              fg={foreground(
                color,
                index === picker.selected ? palette.fg : palette.fg,
              )}
              content={`${index === picker.selected ? "›" : " "} ${model.name} · ${model.id}${current}`}
            />
          );
        })
      ) : (
        <text
          fg={foreground(color, palette.muted)}
          content="No models match this search."
        />
      )}
      <text
        fg={foreground(color, palette.muted)}
        content="↑↓ move · Enter choose · Esc cancel"
      />
    </box>
  );
}

function UsageChart({
  rows,
  selected,
  color = true,
  palette,
}: {
  rows: readonly WorkspaceSurfaceRow[];
  selected: number;
  color?: boolean;
  palette: ColorPalette;
}) {
  const records = rows.flatMap((item, index) =>
    item.usage ? [{ item, index, usage: item.usage }] : [],
  );
  const totals = records.flatMap(({ usage }) =>
    typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
      ? [usage.totalTokens]
      : [],
  );
  const maximum = Math.max(1, ...totals);
  return (
    <Panel title="Provider-reported usage" color={color} palette={palette}>
      {records.length ? (
        records.map(({ item, index, usage }) => {
          const total =
            typeof usage.totalTokens === "number" &&
            Number.isFinite(usage.totalTokens)
              ? usage.totalTokens
              : undefined;
          const bar =
            total === undefined
              ? ""
              : "█".repeat(Math.max(1, Math.round((total / maximum) * 24)));
          const at =
            usage.at && Number.isFinite(Date.parse(usage.at))
              ? usage.at
              : `Record ${index + 1}`;
          return (
            <box key={usage.id} flexDirection="column" gap={1}>
              <text
                fg={foreground(
                  color,
                  index === selected ? palette.fg : palette.fg,
                )}
                content={`${index === selected ? "› " : "  "}${at}  ${total === undefined ? "total unknown" : `${total} tokens`}`}
              />
              <text
                fg={foreground(color, palette.accent)}
                content={bar || "  No provider total reported"}
              />
              {index === selected ? (
                <text
                  fg={foreground(color, palette.muted)}
                  content={`Provider: ${usage.provider ?? "unknown"} · Model: ${usage.model} · Input: ${usage.inputTokens ?? "unknown"} · Output: ${usage.outputTokens ?? "unknown"} · Cost: unknown`}
                />
              ) : null}
            </box>
          );
        })
      ) : (
        <text
          fg={foreground(color, palette.muted)}
          content="No provider usage records are available."
        />
      )}
    </Panel>
  );
}

export function WorkspaceApp({
  ui,
  input,
  editing,
  busy,
  color = true,
  graphicsProtocol,
  onKey,
  onPaste,
  onTab,
  onSelect,
}: WorkspaceAppProps) {
  const { width, height } = useTerminalDimensions();
  const palette = getPalette(ui.themeConfig.colorTheme);
  useKeyboard(onKey);
  usePaste((event) => onPaste(decodePasteBytes(event.bytes)));
  const surface = workspaceSurface(ui, width, height);
  const workspace = surface.workspace;
  const rows = surface.rows;
  const selected = surface.selected;
  const details = surface.details;
  const columns = surface.layout === "columns";
  const session = ui.session();
  const transcript = (session?.events ?? []).filter(
    (event) => event.kind !== "usage" && event.type !== "run.status",
  );
  const chatWindowHeight = Math.max(1, Math.floor((height - 13) / 3));
  const chatOffset = Math.max(
    0,
    Math.min(
      !Number.isFinite(ui.scroll) || ui.scroll < 0
        ? transcript.length - chatWindowHeight
        : ui.scroll,
      Math.max(0, transcript.length - chatWindowHeight),
    ),
  );
  const chatRows = transcriptWindow(transcript, ui.scroll, chatWindowHeight);
  ui.viewport = {
    offset: chatOffset,
    height: chatWindowHeight,
    total: transcript.length,
  };
  const nav = (
    <box flexDirection="row" gap={1}>
      {TABS.map((tab) => {
        const icon =
          graphicsProtocol &&
          ui.localTabIcons &&
          ui.themeConfig.symbolPreset !== "ascii"
            ? ui.localTabIcons[
                ui.themeConfig.colorTheme === "paper" ||
                ui.themeConfig.colorTheme === "solarized-light"
                  ? "light"
                  : "dark"
              ][tab]
            : undefined;
        return (
          <box key={tab} onMouseDown={() => onTab(tab)}>
            {icon ? (
              <image source={icon.png} width={2} height={1} protocol="kitty" />
            ) : null}
            <text
              fg={foreground(
                color,
                ui.tab === tab ? palette.fg : palette.muted,
              )}
              content={
                width < 64
                  ? COMPACT_TABS[tab]
                  : width < 100
                    ? SHORT_TABS[tab]
                    : tab.toUpperCase()
              }
            />
          </box>
        );
      })}
    </box>
  );
  const list = (
    <Panel
      title={`${ui.tab.toUpperCase()} · ${rows.length}`}
      flexGrow={columns ? 2 : 1}
      color={color}
      palette={palette}
    >
      {rows.length ? (
        rows.map((row, index) => (
          <box
            key={row.id}
            border={ui.selected === index}
            borderStyle="rounded"
            borderColor={foreground(
              color,
              ui.selected === index ? palette.accent : palette.border,
            )}
            paddingLeft={1}
            paddingRight={1}
            onMouseDown={() => onSelect(index)}
          >
            <text
              fg={foreground(
                color,
                ui.selected === index ? palette.fg : palette.fg,
              )}
              content={row.label}
            />
          </box>
        ))
      ) : (
        <box
          border
          borderStyle="rounded"
          borderColor={foreground(color, palette.border)}
          padding={1}
        >
          <text
            fg={foreground(color, palette.muted)}
            content={
              ui.tab === "models" && ui.modelCatalogStatus !== "ready"
                ? "Provider model catalog unavailable."
                : `No ${ui.tab} records are available.`
            }
          />
        </box>
      )}
    </Panel>
  );
  const detail = (
    <Panel
      title={
        ui.tab === "models" && ui.provider?.providerId
          ? `Provider · ${ui.provider.providerId}`
          : "Selected record"
      }
      color={color}
      palette={palette}
    >
      {details.length ? (
        details.map((line, index) => (
          <text
            key={`${index}-${line}`}
            fg={foreground(color, palette.fg)}
            content={line || " "}
          />
        ))
      ) : (
        <text
          fg={foreground(color, palette.muted)}
          content="Select a record to inspect its details."
        />
      )}
    </Panel>
  );
  const chat = (
    <box flexDirection="column" flexGrow={1} gap={1}>
      <Panel
        title={session?.title ?? "New conversation"}
        color={color}
        palette={palette}
      >
        {chatRows.length ? (
          chatRows.map((event) => (
            <box
              key={`${event.seq}-${event.kind}`}
              flexDirection="column"
              gap={1}
            >
              <text
                fg={foreground(
                  color,
                  event.kind === "assistant"
                    ? palette.accent
                    : event.kind === "user"
                      ? palette.info
                      : palette.warning,
                )}
                content={`${event.kind === "assistant" ? "NOMO" : event.kind === "user" ? "YOU" : event.kind.toUpperCase()}  ${event.type === "tool.result" ? "TOOL RESULT" : ""}`}
              />
              <text
                fg={foreground(color, palette.fg)}
                content={event.text || " "}
              />
            </box>
          ))
        ) : (
          <box
            border
            borderStyle="rounded"
            borderColor={foreground(color, palette.border)}
            padding={1}
          >
            <text
              fg={foreground(color, palette.muted)}
              content="No messages yet. Write a prompt to start a conversation."
            />
          </box>
        )}
      </Panel>
      <box
        border
        borderStyle="rounded"
        borderColor={foreground(
          color,
          editing ? palette.accent : palette.border,
        )}
        padding={1}
      >
        <text
          fg={foreground(color, editing ? palette.fg : palette.muted)}
          content={`›  ${input || "Message NOMO…"}`}
        />
      </box>
      <text
        fg={foreground(color, palette.muted)}
        content={
          busy
            ? "NOMO is working. Esc stops the active run."
            : `${ui.session()?.model ?? ui.model ?? "No model selected"} · Enter sends · Alt+Enter adds a line`
        }
      />
    </box>
  );
  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <box flexDirection="row" alignItems="center" gap={2}>
        {graphicsProtocol && width >= 40 && height >= 12 ? (
          <image
            source={LOGO}
            width={9}
            height={5}
            protocol={graphicsProtocol}
          />
        ) : null}
        <text fg={foreground(color, palette.fg)} content={workspace} />
        <text
          fg={foreground(color, palette.muted)}
          content={`${ui.tab.toUpperCase()}  ·  ${ui.providerSummary()}`}
        />
      </box>
      {nav}
      {ui.modelPicker?.open ? (
        ui.modelCatalogStatus === "ready" ? (
          <ModelPicker
            ui={ui}
            width={width}
            height={height}
            color={color}
            palette={palette}
          />
        ) : (
          <Panel title="Models" color={color} palette={palette}>
            <text
              fg={foreground(color, palette.muted)}
              content={
                ui.notice ?? "Connect a provider to load its model catalog."
              }
            />
          </Panel>
        )
      ) : ui.tab === "chat" ? (
        chat
      ) : ui.tab === "usage" ? (
        <box flexDirection={columns ? "row" : "column"} flexGrow={1} gap={1}>
          {list}
          <UsageChart
            rows={rows}
            selected={ui.selected}
            color={color}
            palette={palette}
          />
          {details.length ? detail : null}
        </box>
      ) : columns ? (
        <box flexDirection="row" flexGrow={1} gap={1}>
          {list}
          {detail}
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1} gap={1}>
          {list}
          {detail}
        </box>
      )}
      <box flexDirection="row" justifyContent="space-between">
        <text
          fg={foreground(color, palette.muted)}
          content={ui.notice ?? "Ready"}
        />
        <text
          fg={foreground(color, palette.muted)}
          content={
            ui.tab === "chat" ? "TAB" : "Click selects · Enter opens · TAB"
          }
        />
      </box>
    </box>
  );
}
