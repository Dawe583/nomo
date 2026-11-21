/**
 * HP9: a scheduled prompt is an operator-owned record with a cadence and a
 * bounded budget.
 *
 * The rules live here, away from the run loop, for the same reason HP7's goal
 * rules do: a schedule decides when work starts, so what may start and what a
 * settled firing means has to be answerable without a workbench. This module
 * is pure data and pure functions. It starts no timer, opens no store and
 * holds no session; `Workbench.runDueSchedules(nowMs)` asks `dueSchedules` what
 * is due and then runs each firing through the normal `start` or `send` path,
 * which is where policy, holds, turn limits and the ledger already live.
 *
 * Four rules are the contract:
 *
 * 1. **The operator owns the schedule.** A record is created, paused, resumed
 *    and deleted by the operator through the workbench, `POST /api/schedules`
 *    or `nomo schedule`. No model tool reaches this module, so model text can
 *    never schedule its own next run. `parseScheduleInput` takes `unknown`
 *    because the body arrives over HTTP or from argv, not because a model
 *    wrote it.
 * 2. **A firing that cannot be proved due never happens.** `dueSchedules`
 *    returns only an `active`, `enabled` record whose `nextRunAt` it can read
 *    and compare. An unreadable timestamp waits for the operator rather than
 *    running on a guess.
 * 3. **An unproven outcome parks the schedule.** `recordScheduleRun` marks a
 *    `unknown` firing `paused_unknown` and disables it, because a schedule is a
 *    loop: repeating a firing whose first result nobody could verify multiplies
 *    an unknown side effect.
 * 4. **Nothing here is a daemon.** The module has no clock of its own, so a
 *    one-shot `nomo schedule run-due`, a cron entry, a systemd timer and the
 *    opt-in control-plane tick all drive the same function.
 *
 * `nameCharacters` is the only bound that could not be a literal: the prompt
 * bound is the operator's own `maxPromptCharacters`, which is known only at the
 * call site, exactly as `parseGoalInput` takes it.
 */

export const SCHEDULE_LIMITS = {
  /** Enough schedules for a fleet of operator loops; past this an operator is
   * usually modelling a cron table inside one workbench. */
  schedules: 32,
  /** One minute: below it a schedule is a busy loop wearing a cron costume. */
  minIntervalSeconds: 60,
  /** One week, so an interval schedule can still be spelled as a cadence. */
  maxIntervalSeconds: 604_800,
  /** Matches `HARNESS_SETTINGS.maxQueuedRuns` in intent: a ceiling on the
   * unattended runs one record may ever start. */
  maxRuns: 1_000,
  /** Matches `GOAL_LIMITS.tokenBudgetMax`, so a schedule budget and a goal
   * budget cannot disagree about the largest allowance NOMO will honour. */
  tokenBudgetMax: 1_000_000,
  nameCharacters: 80,
} as const;

export type ScheduleStatus =
  | "active"
  | "paused"
  | "completed"
  | "budget_limited"
  | "paused_unknown";

export type ScheduleCadence =
  | { readonly kind: "interval"; readonly everySeconds: number }
  | { readonly kind: "once"; readonly at: string };

export type ScheduleOutcome = "idle" | "failed" | "cancelled" | "unknown";

/**
 * `status` says why a schedule is not running; `enabled` is the operator's own
 * switch. Both are checked before a firing, so a reader of either field alone
 * cannot believe a parked record will run: `paused` and `paused_unknown` are
 * always written with `enabled: false`.
 */
export type Schedule = {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  /** An existing conversation to continue. Absent means every firing starts a
   * new session, which is the only shape that cannot overlap another run. */
  readonly sessionId?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly maxRuns: number;
  readonly tokenBudget?: number;
  readonly enabled: boolean;
  readonly status: ScheduleStatus;
  readonly runCount: number;
  readonly tokensUsed: number;
  /** When the operator created the record. Never read by a rule here; it is
   * carried so the API and the CLI can show a record's age. */
  readonly createdAt: string;
  readonly nextRunAt: string;
  readonly lastRunAt?: string;
  readonly lastSessionId?: string;
  readonly lastOutcome?: ScheduleOutcome;
};

/**
 * What `parseScheduleInput` returns: the operator's fields as validated, plus
 * the first firing computed from a caller-supplied `nowMs` so two calls with
 * the same clock give byte-identical results. The record builder adds `id`,
 * `status`, `runCount`, `tokensUsed` and `createdAt`; none of them is a value
 * the operator may state, because a body that could name its own run count
 * could start work nobody approved.
 */
export type ScheduleInput = {
  readonly name: string;
  readonly prompt: string;
  readonly cadence: ScheduleCadence;
  readonly sessionId?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly maxRuns: number;
  readonly tokenBudget?: number;
  readonly enabled: boolean;
  readonly nextRunAt: string;
};

/** Every C0 control and DEL. A name is a single line, so it carries none. */
const NAME_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** A prompt is prose, so a tab, a newline and a carriage return are text. */
const PROMPT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** The canonical form `node:crypto` `randomUUID` returns, which is what every
 * workbench session id is. Uppercase, braces, a URN prefix and stray
 * whitespace are refused: a target session is an exact key, not a value to
 * normalise on the way in. */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The model id shape `harnessTextSettingRejection` already enforces, because
 * the id travels into a request body and the catalog still decides
 * membership. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]+$/;
const MODEL_CHARACTERS = 128;

/** The agent preset and workspace profile id rule in `agents.ts`. */
const AGENT_ID = /^[A-Za-z0-9][\w-]{0,119}$/;
const AGENT_CHARACTERS = 120;

const SCHEDULE_FIELDS = [
  "name",
  "prompt",
  "cadence",
  "sessionId",
  "model",
  "agent",
  "maxRuns",
  "tokenBudget",
  "enabled",
] as const;

/**
 * The schedule as the operator states it.
 *
 * The key set is exact. A body that carries `id`, `status`, `runCount` or
 * `nextRunAt` is refused by name rather than ignored, because a silently
 * dropped field reads to the caller as "accepted" and this record decides when
 * unattended work starts. A `once` instant that has already passed is refused
 * for the same reason: it would fire on the next tick for a moment the
 * operator cannot have meant.
 */
export function parseScheduleInput(
  input: unknown,
  maxPromptCharacters: number,
  nowMs: number = Date.now(),
): ScheduleInput {
  const value = scheduleFields(input);
  const now = clockField(nowMs);
  const promptCharacters =
    Number.isSafeInteger(maxPromptCharacters) && maxPromptCharacters > 0
      ? maxPromptCharacters
      : 0;
  // Validated in the order the field table reads, so a body with several
  // faults is refused for the first one an operator would have fixed.
  const name = nameField(value.name);
  const prompt = promptField(value.prompt, promptCharacters);
  const cadence = cadenceField(value.cadence, now);
  const sessionId = value.sessionId;
  if (
    sessionId !== undefined &&
    (typeof sessionId !== "string" || !CANONICAL_UUID.test(sessionId))
  )
    throw new Error(
      "Invalid schedule input: sessionId must be a canonical UUID, as the workbench returned it.",
    );
  const model = identifierField(
    "model",
    value.model,
    MODEL_CHARACTERS,
    MODEL_ID,
    "may hold letters, digits and the characters . _ - : @ /",
  );
  const agent = identifierField(
    "agent",
    value.agent,
    AGENT_CHARACTERS,
    AGENT_ID,
    "must start with a letter or a digit and hold letters, digits, _ or -",
  );
  const maxRuns = maxRunsField(value.maxRuns);
  const tokenBudget =
    value.tokenBudget === undefined
      ? undefined
      : tokenBudgetField(value.tokenBudget);
  const enabled = enabledField(value.enabled);
  return {
    name,
    prompt,
    cadence,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(model === undefined ? {} : { model }),
    ...(agent === undefined ? {} : { agent }),
    maxRuns,
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    enabled,
    nextRunAt: firstRunAt(cadence, now),
  };
}

/**
 * The schedules a caller may fire now, in the order it must fire them.
 *
 * Ordering is `nextRunAt` then `id`, so a caller that only fires the head of
 * the list is deterministic and a tie cannot depend on insertion order. Only
 * an `active`, `enabled` record whose instant has arrived is returned; a
 * timestamp that cannot be read is skipped, because firing on an unreadable
 * schedule would be a firing nobody can explain afterwards.
 */
export function dueSchedules(
  schedules: readonly Schedule[],
  nowMs: number,
): readonly Schedule[] {
  const now = clockField(nowMs, "Invalid schedule queue");
  return schedules
    .filter(
      (schedule) =>
        schedule.status === "active" &&
        schedule.enabled &&
        isDue(schedule.nextRunAt, now),
    )
    .sort((left, right) => {
      const byTime = Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt);
      if (byTime !== 0) return byTime;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}

export type ScheduleRunEvent = {
  /** When the workbench started the firing, not when it settled: the cadence is
   * anchored to the start, so a slow run cannot drag the next slot. */
  readonly firedAtMs: number;
  readonly sessionId: string;
  readonly tokensUsed?: number;
  readonly outcome: ScheduleOutcome;
};

/**
 * What one settled firing means for the schedule.
 *
 * Order is the contract. An `unknown` outcome parks the record first, because
 * it is the one result that forbids another unattended firing until a person
 * reconciles it. A stop the operator already made outranks a late record: a run
 * that settles after a pause must not put the schedule back to work. Then the
 * configured run count completes the schedule, because calling finished work
 * budget limited would be false, and only then does the token budget stop it.
 *
 * The next interval slot is anchored to the previous `nextRunAt` and never to
 * the firing, so a run that starts five seconds late still keeps the operator's
 * cadence instead of drifting by five seconds every time. Slots missed while
 * the process was down are skipped rather than replayed: NOMO does not fire a
 * burst of catch-up runs nobody asked for.
 */
export function recordScheduleRun(
  schedule: Schedule,
  event: ScheduleRunEvent,
): Schedule {
  const fired = runEvent(event);
  const runCount = schedule.runCount + 1;
  const tokensUsed = schedule.tokensUsed + (fired.tokensUsed ?? 0);
  const recorded: Schedule = {
    ...schedule,
    runCount,
    tokensUsed,
    lastRunAt: new Date(fired.firedAtMs).toISOString(),
    lastSessionId: fired.sessionId,
    lastOutcome: fired.outcome,
    nextRunAt: nextRunAtAfter(schedule, fired.firedAtMs),
  };
  if (fired.outcome === "unknown")
    return { ...recorded, status: "paused_unknown", enabled: false };
  if (schedule.status !== "active" || !schedule.enabled) return recorded;
  if (schedule.cadence.kind === "once" || runCount >= schedule.maxRuns)
    return { ...recorded, status: "completed" };
  if (schedule.tokenBudget !== undefined && tokensUsed >= schedule.tokenBudget)
    return { ...recorded, status: "budget_limited" };
  return { ...recorded, status: "active" };
}

function scheduleFields(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "Invalid schedule input: expected an object with name, prompt, cadence and maxRuns.",
    );
  const value = input as Record<string, unknown>;
  // The schema says additionalProperties false; an HTTP client or a shell is
  // not a validator, and a silently dropped field is a refusal nobody sees.
  for (const key of Object.keys(value))
    if (!(SCHEDULE_FIELDS as readonly string[]).includes(key))
      throw new Error(
        `Invalid schedule input: unknown field ${JSON.stringify(key)}.`,
      );
  return value;
}

function clockField(nowMs: number, what = "Invalid schedule input"): number {
  if (
    typeof nowMs !== "number" ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  )
    throw new Error(
      `${what}: nowMs must be a non-negative integer, got ${JSON.stringify(nowMs)}.`,
    );
  return nowMs;
}

function nameField(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Invalid schedule input: name must be text.");
  const name = value.trim();
  if (!name) throw new Error("Invalid schedule input: name must not be empty.");
  if (name.length > SCHEDULE_LIMITS.nameCharacters)
    throw new Error(
      `Invalid schedule input: name is at most ${SCHEDULE_LIMITS.nameCharacters} characters, got ${name.length}.`,
    );
  if (NAME_CONTROL_CHARACTER.test(name))
    throw new Error("Invalid schedule input: name contains a control character.");
  return name;
}

function promptField(value: unknown, maxLength: number): string {
  if (typeof value !== "string")
    throw new Error("Invalid schedule input: prompt must be text.");
  const prompt = value.trim();
  if (!prompt)
    throw new Error("Invalid schedule input: prompt must not be empty.");
  if (prompt.length > maxLength)
    throw new Error(
      `Invalid schedule input: prompt is at most ${maxLength} characters, got ${prompt.length}.`,
    );
  if (PROMPT_CONTROL_CHARACTER.test(prompt))
    throw new Error(
      "Invalid schedule input: prompt contains a control character.",
    );
  return prompt;
}

function cadenceField(value: unknown, nowMs: number): ScheduleCadence {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      "Invalid schedule input: cadence must be an object with kind and one of everySeconds or at.",
    );
  const cadence = value as Record<string, unknown>;
  if (cadence.kind === "interval") {
    for (const key of Object.keys(cadence))
      if (key !== "kind" && key !== "everySeconds")
        throw new Error(
          `Invalid schedule input: an interval cadence is exactly kind and everySeconds, got an extra field ${JSON.stringify(key)}.`,
        );
    return {
      kind: "interval",
      everySeconds: intervalField(cadence.everySeconds),
    };
  }
  if (cadence.kind === "once") {
    for (const key of Object.keys(cadence))
      if (key !== "kind" && key !== "at")
        throw new Error(
          `Invalid schedule input: a once cadence is exactly kind and at, got an extra field ${JSON.stringify(key)}.`,
        );
    return { kind: "once", at: onceField(cadence.at, nowMs) };
  }
  throw new Error(
    `Invalid schedule input: cadence.kind must be "interval" or "once", got ${JSON.stringify(cadence.kind)}.`,
  );
}

function intervalField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(
      `Invalid schedule input: cadence.everySeconds must be an integer number of seconds, got ${JSON.stringify(value)}.`,
    );
  if (value < SCHEDULE_LIMITS.minIntervalSeconds)
    throw new Error(
      `Invalid schedule input: cadence.everySeconds is at least ${SCHEDULE_LIMITS.minIntervalSeconds} seconds, got ${value}.`,
    );
  if (value > SCHEDULE_LIMITS.maxIntervalSeconds)
    throw new Error(
      `Invalid schedule input: cadence.everySeconds is at most ${SCHEDULE_LIMITS.maxIntervalSeconds} seconds, got ${value}.`,
    );
  return value;
}

/** A `once` instant is returned canonicalised, so the stored `nextRunAt` and a
 * later comparison both read the same bytes whatever offset the operator's
 * client sent. */
function onceField(value: unknown, nowMs: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(
      "Invalid schedule input: cadence.at must be an ISO 8601 timestamp.",
    );
  const atMs = Date.parse(value);
  if (!Number.isFinite(atMs))
    throw new Error(
      `Invalid schedule input: cadence.at is not a timestamp, got ${JSON.stringify(value)}.`,
    );
  if (atMs <= nowMs)
    throw new Error(
      `Invalid schedule input: cadence.at must be in the future, got ${JSON.stringify(value)}.`,
    );
  return new Date(atMs).toISOString();
}

function maxRunsField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(
      `Invalid schedule input: maxRuns must be an integer, got ${JSON.stringify(value)}.`,
    );
  if (value < 1)
    throw new Error(
      `Invalid schedule input: maxRuns must be at least 1, got ${value}.`,
    );
  if (value > SCHEDULE_LIMITS.maxRuns)
    throw new Error(
      `Invalid schedule input: maxRuns is at most ${SCHEDULE_LIMITS.maxRuns}, got ${value}.`,
    );
  return value;
}

function tokenBudgetField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(
      `Invalid schedule input: tokenBudget must be an integer, got ${JSON.stringify(value)}.`,
    );
  if (value < 1)
    throw new Error(
      `Invalid schedule input: tokenBudget must be at least 1, got ${value}.`,
    );
  if (value > SCHEDULE_LIMITS.tokenBudgetMax)
    throw new Error(
      `Invalid schedule input: tokenBudget is at most ${SCHEDULE_LIMITS.tokenBudgetMax}, got ${value}.`,
    );
  return value;
}

function enabledField(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "boolean")
    throw new Error(
      `Invalid schedule input: enabled must be a boolean, got ${JSON.stringify(value)}.`,
    );
  return value;
}

function identifierField(
  name: "model" | "agent",
  value: unknown,
  maxLength: number,
  pattern: RegExp,
  shape: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new Error(
      `Invalid schedule input: ${name} must be text, got ${typeof value}.`,
    );
  const trimmed = value.trim();
  if (!trimmed)
    throw new Error(`Invalid schedule input: ${name} must not be empty.`);
  if (trimmed.length > maxLength)
    throw new Error(
      `Invalid schedule input: ${name} is at most ${maxLength} characters, got ${trimmed.length}.`,
    );
  if (!pattern.test(trimmed))
    throw new Error(
      `Invalid schedule input: ${name} ${shape}, got ${JSON.stringify(trimmed)}.`,
    );
  return trimmed;
}

/** An interval schedule first fires one full interval after it is created, so
 * creating a schedule never starts work the operator has not yet seen listed. */
function firstRunAt(cadence: ScheduleCadence, nowMs: number): string {
  return cadence.kind === "once"
    ? cadence.at
    : new Date(nowMs + cadence.everySeconds * 1000).toISOString();
}

function isDue(nextRunAt: string, nowMs: number): boolean {
  const at = Date.parse(nextRunAt);
  return Number.isFinite(at) && at <= nowMs;
}

/**
 * The next slot of the same cadence, strictly after the firing.
 *
 * A `once` schedule has no next slot, so it keeps the instant it ran and can
 * never be due again. An interval steps forward from its own anchor by whole
 * intervals until the slot is in the future. An anchor that cannot be read is
 * the one case with no answer from the record, so the interval restarts from
 * the firing: a schedule that has just run is one interval away from running
 * again, which is the only claim this record supports.
 */
function nextRunAtAfter(schedule: Schedule, firedAtMs: number): string {
  if (schedule.cadence.kind === "once") return schedule.nextRunAt;
  const intervalMs = schedule.cadence.everySeconds * 1000;
  const anchorMs = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(anchorMs))
    return new Date(firedAtMs + intervalMs).toISOString();
  if (anchorMs > firedAtMs) return new Date(anchorMs).toISOString();
  const steps = Math.floor((firedAtMs - anchorMs) / intervalMs) + 1;
  return new Date(anchorMs + steps * intervalMs).toISOString();
}

function runEvent(event: ScheduleRunEvent): ScheduleRunEvent {
  if (event === null || typeof event !== "object" || Array.isArray(event))
    throw new Error("Invalid schedule run: expected an object.");
  const value = event as unknown as Record<string, unknown>;
  const firedAtMs = value.firedAtMs;
  if (
    typeof firedAtMs !== "number" ||
    !Number.isSafeInteger(firedAtMs) ||
    firedAtMs < 0
  )
    throw new Error(
      `Invalid schedule run: firedAtMs must be a non-negative integer, got ${JSON.stringify(firedAtMs)}.`,
    );
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || !CANONICAL_UUID.test(sessionId))
    throw new Error(
      "Invalid schedule run: sessionId must be a canonical UUID, as the workbench returned it.",
    );
  const tokensUsed = value.tokensUsed;
  if (
    tokensUsed !== undefined &&
    (typeof tokensUsed !== "number" ||
      !Number.isSafeInteger(tokensUsed) ||
      tokensUsed < 0)
  )
    throw new Error(
      `Invalid schedule run: tokensUsed must be a non-negative integer, got ${JSON.stringify(tokensUsed)}.`,
    );
  const outcome = value.outcome;
  if (
    outcome !== "idle" &&
    outcome !== "failed" &&
    outcome !== "cancelled" &&
    outcome !== "unknown"
  )
    throw new Error(
      `Invalid schedule run: outcome must be one of idle, failed, cancelled or unknown, got ${JSON.stringify(outcome)}.`,
    );
  return {
    firedAtMs,
    sessionId,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    outcome,
  };
}
