import { brandHeader } from "./brand.ts";
import { CLASS_MARKER, classLabel, decisionLabel, paint } from "./theme.ts";
import { renderInspector, type Field } from "./inspector.ts";
import {
  box,
  columns,
  crop,
  fit,
  frameViewport,
  insetFrame,
  meter,
  pad,
  progressBar,
  rule,
  sanitizeText,
} from "./layout.ts";
import type {
  CostRecord,
  DashboardState,
  InterceptedCall,
  PendingHold,
  ResolvedHold,
  TerminalCapabilities,
} from "./types.ts";

const CONTEXT_THRESHOLD_AMBER = 70;
const CONTEXT_THRESHOLD_RED = 90;

const STAGES = ["intent", "classify", "decide", "seal"] as const;

function stageLine(call: InterceptedCall, width: number): string {
  const active = STAGES.indexOf(call.stage);
  const parts = STAGES.map(
    (stage, index) => `${index <= active ? "#" : "."} ${stage}`,
  );
  return fit(parts.join(" -> "), width);
}

function header(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  now: number,
): string[] {
  const age = Math.max(
    0,
    Math.floor((now - state.session.startedAt) / 1000),
  );
  const posture =
    state.session.posture === "enforce"
      ? paint("ENFORCE", "r0", capabilities, true)
      : paint("OBSERVE", "r2", capabilities, true);
  // The agent identity is external data and sits on the line every frame
  // starts from, so a persistent escape injected there blanks the whole
  // alternate screen on every diff repaint, not just one row.
  const right = `${sanitizeText(state.session.transport)} | ${sanitizeText(state.session.agent)} | ${age}s | ${posture}`;
  let ctxLine = "";
  if (state.context && state.context.total > 0) {
    const pct = Math.round((state.context.used / state.context.total) * 100);
    const isAmber = pct > CONTEXT_THRESHOLD_AMBER;
    const isRed = pct > CONTEXT_THRESHOLD_RED;
    const bar = progressBar(state.context.used, state.context.total, 10);
    const label = isRed ? "critical" : isAmber ? "warning" : "ok";
    ctxLine = `ctx ${bar} ${pct}% ${label}`;
  } else {
    ctxLine = "ctx unknown";
  }

  // Billing tokens separate from context tokens
  const billingLine = state.context?.billing !== undefined
    ? `billing ${state.context.billing}tok`
    : "";

  return [
    ...brandHeader("NOMO", capabilities),
    right,
    ctxLine,
    billingLine,
    paint(rule(capabilities.columns, "─"), "rule", capabilities),
  ];
}

function activityRows(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  width: number,
  limit: number,
): string[] {
  const rows = state.calls
    .filter((call) => state.filter === "all" || call.class === state.filter)
    .slice(-limit)
    .reverse();
  if (rows.length === 0)
    return ["No intercepted calls. Start an agent through nomo run."];
  return rows.map((call) => {
    const active = call.id === state.selectedCallId;
    const radius =
      call.blastRadius === null ? "   ?" : String(call.blastRadius).padStart(4);
    const toolWidth = Math.max(10, width - 45);
    const tool = sanitizeText(call.tool);
    const time = sanitizeText(call.time);
    const row = fit(
      `${active ? ">" : " "} ${time} ${classLabel(call.class, capabilities)} ${decisionLabel(call.decision, capabilities)} status:${call.status} ${pad(fit(tool, toolWidth, "left"), toolWidth)} ${radius}`,
      width,
    );
    return active && row.startsWith(">")
      ? `${paint(">", "accent", capabilities, true)}${row.slice(1)}`
      : row;
  });
}

function decisionTone(call: InterceptedCall): "error" | "warning" | "success" {
  if (call.decision === "deny") return "error";
  if (call.decision === "hold") return "warning";
  return "success";
}

function classTone(call: InterceptedCall): "default" | "warning" | "error" {
  if (call.class === "r3") return "error";
  if (call.class === "r2") return "warning";
  return "default";
}

function blastRadius(call: InterceptedCall): string {
  return call.blastRadius === null
    ? "not measured"
    : `${call.blastRadius} targets, measured`;
}

function detailRows(
  call: InterceptedCall | undefined,
  capabilities: TerminalCapabilities,
  width: number,
  compact = false,
): string[] {
  let fields: Field[];
  if (call === undefined) {
    fields = [{ label: "call", value: "Select a call to inspect its decision." }];
  } else {
    const tool: Field = { label: "tool", value: call.tool };
    const stage: Field = {
      label: "stage",
      value: stageLine(call, width),
      tone: call.status === "failed" ? "error" : "muted",
    };
    const decision: Field = {
      label: "decision",
      value: `${call.decision} / ${call.status}`,
      tone: decisionTone(call),
    };
    const risk: Field = {
      label: "class",
      value: `${CLASS_MARKER[call.class]} ${call.class.toUpperCase()} / ${call.reason}`,
      tone: classTone(call),
    };
    const radius: Field = {
      label: "blast radius",
      value: blastRadius(call),
    };
    fields = compact
      ? [stage, tool, decision, risk, radius]
      : [
          { label: "call", value: call.id },
          tool,
          { label: "agent", value: `${call.agent} / ${call.workspace}` },
          risk,
          stage,
          { label: "status", value: call.status },
          { label: "decision", value: call.decision, tone: decisionTone(call) },
          radius,
          { label: "inverse", value: call.inverse ?? "none" },
          { label: "compensation", value: call.compensation ?? "none" },
          { label: "snapshot", value: call.snapshotRef ?? "none" },
          { label: "ledger", value: call.ledgerHash ?? "pending seal" },
        ];
  }
  return renderInspector(
    {
      title: "DECISION RECORD",
      sections: [
        {
          title: compact ? "Risk summary" : "Selected call",
          fields,
        },
      ],
    },
    {
      width,
      paint: (text, tone, bold) =>
        paint(text, tone === "default" ? "fg" : tone, capabilities, bold),
    },
  );
}

function condensedDetailRows(
  call: InterceptedCall | undefined,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  if (call === undefined) return detailRows(call, capabilities, width, true);
  const riskTone = classTone(call);
  const risk =
    `${CLASS_MARKER[call.class]} ${call.class.toUpperCase()} / ` +
    sanitizeText(call.reason);
  return [
    paint("DECISION RECORD", "accent", capabilities, true),
    paint(
      stageLine(call, width),
      call.status === "failed" ? "r3" : "muted",
      capabilities,
    ),
    fit(sanitizeText(call.tool), width),
    paint(
      fit(`${call.decision} / ${call.status}`, width),
      decisionTone(call),
      capabilities,
    ),
    paint(
      fit(risk, width),
      riskTone === "default" ? "fg" : riskTone,
      capabilities,
    ),
    fit(`blast radius: ${blastRadius(call)}`, width),
  ];
}

function metrics(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  const counts = { r0: 0, r1: 0, r2: 0, r3: 0 };
  for (const call of state.calls) counts[call.class] += 1;
  const total = Math.max(1, state.calls.length);
  const gaugeWidth = Math.max(8, Math.floor((width - 12) / 2));
  return (["r0", "r1", "r2", "r3"] as const).map(
    (value) =>
      `${classLabel(value, capabilities)} ${meter(counts[value], total, gaugeWidth)} ${String(counts[value]).padStart(3)}`,
  );
}

function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return "unknown";
  return `$${value.toFixed(2)}`;
}

function costRecordLabel(
  record: CostRecord,
  capabilities: TerminalCapabilities,
): string {
  const usd = formatUsd(record.usd);
  // `unknown` nikdy `$0.00` - pokud je cena missing, renderuj `unknown`
  if (record.usd === null) return `${record.model} ${record.tokens}tok ${record.records}rec unknown`;
  return `${record.model} ${record.tokens}tok ${record.records}rec ${usd}`;
}

function costPanel(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  const labelWidth = 20;
  const rows: string[] = [];
  // Table model × tokens × records
  for (const record of (state.cost ?? [])) {
    const label = costRecordLabel(record, capabilities);
    rows.push(
      `${pad(paint(label.split(" ")[0] ?? "unknown", "muted", capabilities), labelWidth)}${fit(
        sanitizeText(label),
        width - labelWidth,
      )}`,
    );
  }
  // Rate-limit reset info
  const resetInfo = state.context?.billing !== undefined ? "5h 42% (resets 2h 10m)" : "";
  if (resetInfo) rows.push(resetInfo);
  if (rows.length === 0) rows.push("-");
  return rows;
}

function health(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  const status = (value: string, healthy: boolean): string =>
    paint(
      `[${healthy ? "+" : "!"}] ${value}`,
      healthy ? "r0" : "r3",
      capabilities,
    );
  return [
    `${status(`proxy ${state.health.proxy}`, state.health.proxy === "healthy")}  ${status(`upstream ${state.health.upstream}`, state.health.upstream === "healthy")}`,
    `${status(`ledger ${state.health.ledger}`, state.health.ledger === "verified")}  ${status(`connector ${state.health.connector}`, state.health.connector === "ready")}`,
    fit(
      `latency ${state.health.latencyMs}ms | head ${sanitizeText(state.ledger.head)} | key ${sanitizeText(state.ledger.keyId)}`,
      width,
    ),
    fit(
      `verified ${state.ledger.verifiedThrough}/${state.ledger.entries} | checkpoint ${state.ledger.checkpointAgeSeconds}s ago`,
      width,
    ),
  ];
}

function holdBanner(
  hold: PendingHold | undefined,
  capabilities: TerminalCapabilities,
  now: number,
  width: number,
): string[] {
  if (hold === undefined) return [];
  const remaining = Math.max(0, Math.ceil((hold.expiresAt - now) / 1000));
  return box(
    paint("ACTION REQUIRED", "r3", capabilities, true),
    [
      fit(
        `${classLabel(hold.call.class, capabilities)} ${sanitizeText(hold.call.tool)}`,
        width - 4,
      ),
      fit(
        `${hold.call.blastRadius ?? "?"} target${hold.call.blastRadius === 1 ? "" : "s"} | ${sanitizeText(hold.call.reason)}`,
        width - 4,
      ),
      `${paint("[a] approve", "r0", capabilities, true)}  ${paint("[c] cancel", "r3", capabilities, true)}  expires in ${remaining}s`,
    ],
    width,
  );
}


function resolvedHoldBanner(
  resolved: ResolvedHold,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  const tone =
    resolved.state === "approved"
      ? "r0"
      : resolved.state === "denied"
        ? "r3"
        : "r2";
  const by = resolved.by === null ? "system" : sanitizeText(resolved.by);
  return box(
    paint("HOLD RESOLVED", tone, capabilities, true),
    [
      fit(
        `${classLabel(resolved.hold.call.class, capabilities)} ${sanitizeText(resolved.hold.call.tool)}`,
        width - 4,
      ),
      fit(
        `${resolved.state} by ${by} | ${sanitizeText(resolved.hold.call.reason)}`,
        width - 4,
      ),
    ],
    width,
  );
}

function footer(
  state: DashboardState,
  capabilities: TerminalCapabilities,
): string {
  const mode = state.paused
    ? paint("PAUSED", "r2", capabilities, true)
    : paint("LIVE", "r0", capabilities, true);
  const keys =
    capabilities.columns < 100
      ? "j/k move  enter open  f filter  p pause  ? help  q quit"
      : "j/k move  enter detail  f filter  p pause  r replay  v verify  ? help  q quit";
  return fit(`${mode} | ${keys}`, capabilities.columns);
}

function renderWatchFrameContent(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  now = Date.now(),
): string {
  const width = capabilities.columns;
  const lines: string[] = [...header(state, capabilities, now)];
  const pending = state.holds[0];
  const resolved = state.resolvedHolds?.at(-1);
  if (pending !== undefined)
    lines.push(...holdBanner(pending, capabilities, now, width));
  else if (resolved !== undefined)
    lines.push(...resolvedHoldBanner(resolved, capabilities, width));

  const selected =
    state.calls.find((call) => call.id === state.selectedCallId) ??
    state.calls.at(-1);
  const availableRows = Math.max(5, capabilities.rows - lines.length - 9);

  function activityRowBlock(width: number, limit: number): string[] {
    if (width < 100) {
      if (capabilities.rows < 30) {
        const detail =
          pending !== undefined || resolved !== undefined
            ? condensedDetailRows(selected, capabilities, width)
            : detailRows(selected, capabilities, width, true);
        const costs = costPanel(state, capabilities, width);
        const contentRows = Math.max(0, capabilities.rows - lines.length - 2);
        const listRows = contentRows - detail.length - costs.length;
        const list =
          listRows > 1
            ? [
                paint("WRITE PATH", "accent", capabilities, true),
                ...activityRows(
                  state,
                  capabilities,
                  width,
                  Math.min(limit, Math.max(0, listRows - 1)),
                ),
              ]
            : [];
        return [...list, ...detail, ...costs];
      }
      return [
        paint("WRITE PATH", "accent", capabilities, true),
        ...activityRows(state, capabilities, width, limit),
        ...detailRows(selected, capabilities, width),
        ...costPanel(state, capabilities, width),
      ];
    }
    if (width < 160) {
      const leftWidth = Math.floor(width * 0.61);
      const rightWidth = width - leftWidth - 1;
      const left = [
        paint("WRITE PATH", "accent", capabilities, true),
        ...activityRows(state, capabilities, leftWidth, limit),
      ];
      const right = detailRows(selected, capabilities, rightWidth);
      return [...columns(left, right, leftWidth)];
    }
    const activityWidth = Math.floor(width * 0.35);
    const detailWidth = Math.floor(width * 0.3);
    const signalWidth = width - activityWidth - detailWidth - 2;
    const left = [
      paint("WRITE PATH", "accent", capabilities, true),
      ...activityRows(state, capabilities, activityWidth, limit),
    ];
    const middle = detailRows(selected, capabilities, detailWidth);
    const right = [
      paint("SIGNALS", "accent", capabilities, true),
      ...[
        ...metrics(state, capabilities, signalWidth),
        "",
        ...costPanel(state, capabilities, signalWidth),
        ...health(state, capabilities, signalWidth),
      ].slice(0, limit),
    ];
    return [...columns(columns(left, middle, activityWidth), right, activityWidth + 1 + detailWidth)];
  }

  lines.push(...activityRowBlock(width, availableRows));

  lines.push(paint(rule(width, "─"), "rule", capabilities));
  lines.push(footer(state, capabilities));

  return crop(lines, width, capabilities.rows).join("\n");
}
export function renderWatchFrame(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  now = Date.now(),
): string {
  const viewport = frameViewport(
    capabilities.columns,
    capabilities.rows,
    20,
    8,
  );
  const contentCapabilities = {
    ...capabilities,
    columns: viewport.columns,
    rows: viewport.rows,
  };
  return insetFrame(
    renderWatchFrameContent(state, contentCapabilities, now),
    capabilities.columns,
    capabilities.rows,
    viewport,
  );
}

export class DiffScreenWriter {
  private previous: string[] = [];
  private readonly output: Pick<NodeJS.WriteStream, "write">;

  constructor(output: Pick<NodeJS.WriteStream, "write">) {
    this.output = output;
  }

  enter(): void {
    this.output.write("\u001b[?1049h\u001b[?25l\u001b[H");
  }

  write(frame: string): void {
    const next = frame.split("\n");
    // Terminals clamp a cursor address beyond the last row onto the last row,
    // so after a SIGWINCH shrink every out of range erase lands on the footer
    // and wipes it, and the diff never repaints an unchanged line. A frame
    // shorter than the previous one is the shrink case: repaint from the top
    // instead of erasing rows the screen no longer has.
    if (next.length < this.previous.length) {
      this.output.write("\u001b[H\u001b[2J");
      this.previous = [];
    }
    for (
      let index = 0;
      index < Math.max(this.previous.length, next.length);
      index += 1
    ) {
      const line = next[index] ?? "";
      if (line !== (this.previous[index] ?? "")) {
        this.output.write(`\u001b[${index + 1};1H${line}\u001b[K`);
      }
    }
    this.previous = next;
  }

  redraw(): void {
    this.output.write("\u001b[H\u001b[2J");
    this.previous = [];
  }

  leave(): void {
    this.output.write("\u001b[?25h\u001b[?1049l");
    this.previous = [];
  }
}
