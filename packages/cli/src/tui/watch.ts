import { brandHeader } from "./brand.ts";
import { CLASS_MARKER, classLabel, decisionLabel, paint } from "./theme.ts";
import {
  box,
  columns,
  crop,
  fit,
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

function stageLine(
  call: InterceptedCall,
  capabilities: TerminalCapabilities,
  width: number,
): string {
  const active = STAGES.indexOf(call.stage);
  const parts = STAGES.map(
    (stage, index) => `${index <= active ? "#" : "."} ${stage}`,
  );
  return paint(
    fit(parts.join(" -> "), width),
    call.status === "failed" ? "r3" : "muted",
    capabilities,
  );
}

function header(
  state: DashboardState,
  capabilities: TerminalCapabilities,
  now: number,
): string[] {
  const age = Math.max(0, Math.floor((now - state.session.startedAt) / 1000));
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
  const billingLine =
    state.context?.billing !== undefined
      ? `billing ${state.context.billing}tok`
      : "";

  return [
    ...brandHeader("NOMO", capabilities),
    right,
    ctxLine,
    billingLine,
    paint(rule(capabilities.columns), "rule", capabilities),
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
    const selected = call.id === state.selectedCallId ? ">" : " ";
    const radius =
      call.blastRadius === null ? "   ?" : String(call.blastRadius).padStart(4);
    const toolWidth = Math.max(10, width - 45);
    const tool = sanitizeText(call.tool);
    const time = sanitizeText(call.time);
    return fit(
      `${selected} ${time} ${classLabel(call.class, capabilities)} ${decisionLabel(call.decision, capabilities)} status:${call.status} ${pad(fit(tool, toolWidth, "left"), toolWidth)} ${radius}`,
      width,
    );
  });
}

function detailRows(
  call: InterceptedCall | undefined,
  capabilities: TerminalCapabilities,
  width: number,
): string[] {
  if (call === undefined) return ["Select a call to inspect its decision."];
  const labelWidth = 13;
  const row = (label: string, value: string): string =>
    `${pad(paint(label, "muted", capabilities), labelWidth)}${fit(sanitizeText(value), width - labelWidth)}`;
  return [
    stageLine(call, capabilities, width),
    "",
    row("call", call.id),
    row("tool", call.tool),
    row("agent", `${call.agent} / ${call.workspace}`),
    row(
      "class",
      `${CLASS_MARKER[call.class]} ${call.class.toUpperCase()} / ${call.reason}`,
    ),
    row("status", call.status),
    row("decision", call.decision),
    row(
      "blast radius",
      call.blastRadius === null
        ? "not measured"
        : `${call.blastRadius} targets, measured`,
    ),
    row("inverse", call.inverse ?? "none"),
    row("compensation", call.compensation ?? "none"),
    row("snapshot", call.snapshotRef ?? "none"),
    row("ledger", call.ledgerHash ?? "pending seal"),
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
  if (record.usd === null)
    return `${record.model} ${record.tokens}tok ${record.records}rec unknown`;
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
  for (const record of state.cost ?? []) {
    const label = costRecordLabel(record, capabilities);
    rows.push(
      `${pad(paint(label.split(" ")[0] ?? "unknown", "muted", capabilities), labelWidth)}${fit(
        sanitizeText(label),
        width - labelWidth,
      )}`,
    );
  }
  if (rows.length === 0) rows.push("-");
  rows.push(fit("ctx reset unavailable; field absent", width));
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

export function renderWatchFrame(
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
      return [
        ...box(
          "WRITE PATH",
          activityRows(state, capabilities, width - 4, limit),
          width,
        ),
        // Narrow terminals stack the decision record below the write path.
        // Hiding it made a selected run's class, policy and blast radius
        // unreachable at exactly the width operators use most often.
        ...box(
          "DECISION RECORD",
          detailRows(selected, capabilities, width - 4).slice(
            0,
            Math.max(1, limit - 5),
          ),
          width,
        ),
        // Cost panel stays visible on narrow terminals (A6): unknown price
        // renders `unknown`, never `$0.00`.
        ...costPanel(state, capabilities, width - 4),
      ];
    }
    if (width < 160) {
      const leftWidth = Math.floor(width * 0.61);
      const rightWidth = width - leftWidth - 1;
      const left = box(
        "WRITE PATH",
        activityRows(state, capabilities, leftWidth - 4, limit),
        leftWidth,
      );
      const right = box(
        "DECISION RECORD",
        detailRows(selected, capabilities, rightWidth - 4).slice(0, limit),
        rightWidth,
      );
      return [...columns(left, right, leftWidth)];
    }
    const activityWidth = Math.floor(width * 0.49);
    const detailWidth = Math.floor(width * 0.31);
    const signalWidth = width - activityWidth - detailWidth - 2;
    const left = box(
      "WRITE PATH",
      activityRows(state, capabilities, activityWidth - 4, limit),
      activityWidth,
    );
    const middle = box(
      "DECISION RECORD",
      detailRows(selected, capabilities, detailWidth - 4).slice(0, limit),
      detailWidth,
    );
    const right = box(
      "SIGNALS",
      [
        ...metrics(state, capabilities, signalWidth - 4),
        "",
        ...costPanel(state, capabilities, signalWidth - 4),
        ...health(state, capabilities, signalWidth - 4),
      ].slice(0, limit),
      signalWidth,
    );
    return [
      ...columns(
        columns(left, middle, activityWidth),
        right,
        activityWidth + 1 + detailWidth,
      ),
    ];
  }

  lines.push(...activityRowBlock(width, availableRows));

  lines.push(paint(rule(width), "rule", capabilities));
  lines.push(footer(state, capabilities));

  return crop(lines, width, capabilities.rows).join("\n");
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
