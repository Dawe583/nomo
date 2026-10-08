/**
 * Harness settings: the operator-tunable limits that govern a run.
 *
 * Every entry here replaces a number that used to be a literal inside the
 * run path. A limit nobody can change is a limit nobody chose, and the two
 * external agents VOID orchestrates both expose theirs: prime-agent has
 * `autonomous.maxTurns`, `autonomous.maxTokens` and `autonomous.timeoutMs`
 * (prime-src `crates/pa-core/src/autonomous/mod.rs:26-29`), and omp has
 * `task.maxConcurrency`, `task.maxRecursionDepth` and `task.maxRuntimeMs`
 * (omp-src `packages/coding-agent/src/task/settings.ts:235-295`). VOID keeps
 * its own fail-closed defaults rather than either upstream's, because VOID's
 * defaults are the conservative ones.
 *
 * Three rules hold for every setting, and they are the reason this is one
 * table rather than a preference per call site:
 *
 * 1. **A setting with no consumer does not exist.** Each key names the symbols
 *    that read it, in the file that defines them, and a test asserts every
 *    name exists. A knob nothing reads would be a claim the operator cannot
 *    verify, which is worse than no knob.
 * 2. **Bounds are clamped, not trusted.** A patch is validated here and
 *    clamped into range, so no caller has to re-check and no stored value can
 *    be edited into an unsafe one.
 * 3. **The server keeps the last word on authority.** `permissionMode` is
 *    deliberately absent and stays that way: it is an authority decision, not
 *    a preference, and `preferencePatch` already refuses it.
 */

/** Every tunable limit, with the bound an operator may set it within. The
 * minimum and maximum are the values the run path can actually honour, so a
 * clamp can never produce a limit the code would refuse to enforce. */
export type HarnessSettingKey =
  | "maxTurns"
  | "maxOutputTokens"
  | "maxPromptCharacters"
  | "maxQueuedRuns"
  | "maxRequestBytes"
  | "maxRunTimeoutMs"
  | "maxToolCallsPerTurn"
  | "hookTimeoutMs"
  | "retryAttempts"
  | "retryBaseDelayMs"
  | "maxConcurrentRuns"
  | "maxContinuations"
  | "maxRunTokens"
  | "retryMaxDelayMs"
  | "contextEntryLimit"
  | "contextCharsPerEntry";

export type HarnessSettingSpec = {
  /** Operator-facing name, shown by /settings and the web settings panel. */
  label: string;
  /** What the limit governs, in one sentence an operator can check. */
  description: string;
  /** The file in this package that defines the consuming symbols. */
  consumerFile: "index.ts" | "provider.ts" | "gui.ts" | "agents.ts";
  /** The symbols in `consumerFile` that read this value. Required, and
   * asserted to exist, so the table cannot drift into naming nothing. */
  consumers: readonly string[];
  default: number;
  min: number;
  max: number;
  /** Single-cell geometric shape (U+25A0-U+25FF) for the TUI settings list. */
  icon: string;
};

export const HARNESS_SETTINGS: {
  readonly [K in HarnessSettingKey]: HarnessSettingSpec;
} = {
  maxTurns: {
    label: "Turns per run",
    description:
      "How many model turns one run may take before it stops and asks for review.",
    consumerFile: "index.ts",
    consumers: ["run"],
    default: 20,
    min: 1,
    // Matches AGENT_LIMITS.maxTurns, so a harness turn cap can never exceed
    // the cap an individual agent profile is allowed to carry.
    max: 20,
    icon: "△",
  },
  maxOutputTokens: {
    label: "Output tokens per request",
    description: "The max_tokens ceiling sent with every provider request.",
    consumerFile: "provider.ts",
    consumers: ["complete", "anthropic"],
    default: 4096,
    min: 256,
    max: 32768,
    icon: "◼",
  },
  maxPromptCharacters: {
    label: "Prompt characters",
    description:
      "Longest prompt accepted by start, send and queued text. Longer input is refused, not truncated.",
    consumerFile: "index.ts",
    // Queued text is bounded where it enters, in the TUI's own queue method,
    // not here; Workbench.send re-checks this same limit for every caller.
    consumers: ["start", "send", "event", "branch"],
    default: 32000,
    min: 256,
    max: 200000,
    icon: "▏",
  },
  maxQueuedRuns: {
    label: "Queued background runs",
    description:
      "How many background runs may wait behind the active one before the queue refuses another.",
    consumerFile: "index.ts",
    consumers: ["startSession"],
    default: 20,
    min: 1,
    // The queue is an in-memory Set of session ids, so the bound exists to
    // stop unbounded growth rather than to model a real capacity limit.
    max: 1000,
    icon: "▤",
  },
  maxRequestBytes: {
    label: "Request bytes",
    description:
      "Largest request body the control plane accepts before refusing it.",
    consumerFile: "gui.ts",
    consumers: ["capabilities"],
    default: 65536,
    min: 1024,
    max: 10485760,
    icon: "▓",
  },
  maxRunTimeoutMs: {
    label: "Run timeout",
    description:
      "Wall-clock ceiling for one run. A run that reaches it is aborted and its outcome stays unproven, so Undo and reconciliation remain available.",
    consumerFile: "index.ts",
    consumers: ["run"],
    default: 600000,
    min: 1000,
    // Zero would mean "never time out", which is exactly the unbounded run
    // this limit exists to prevent, so the floor is one second.
    max: 86400000,
    icon: "◷",
  },
  maxToolCallsPerTurn: {
    label: "Tool calls per turn",
    description:
      "Most tool calls one provider reply may request before the turn is refused as a batch too large to govern.",
    consumerFile: "index.ts",
    consumers: ["run"],
    default: 32,
    min: 1,
    max: 256,
    icon: "▣",
  },
  hookTimeoutMs: {
    label: "Hook timeout",
    description:
      "How long one hook process may run before it is killed and reported as a timeout. A timeout is never a pass.",
    consumerFile: "index.ts",
    consumers: ["fireHooks"],
    // The default and the bounds are HOOK_TIMEOUT_MS and HOOK_TIMEOUT_BOUNDS
    // from agents.ts. They are restated rather than imported so this table
    // stays readable as the operator's contract; the test asserts they agree.
    default: 5000,
    min: 100,
    max: 60000,
    icon: "◇",
  },
  retryAttempts: {
    label: "Provider retry attempts",
    description:
      "Total attempts for a transient provider rejection (429, 502, 503, 504) before the run fails. Never applied to a denial.",
    consumerFile: "provider.ts",
    consumers: ["complete"],
    default: 3,
    min: 1,
    // Three is what the free endpoint has been observed to survive. Beyond
    // that an operator is usually waiting on a rate limit that will not clear,
    // and a longer wait inside one run holds the approval surface open.
    max: 10,
    icon: "◇",
  },
  retryBaseDelayMs: {
    label: "Retry base delay",
    description:
      "Base wait between provider attempts, doubled per attempt and capped by the provider's own retry-after when it sends one.",
    consumerFile: "provider.ts",
    consumers: ["complete"],
    default: 1000,
    min: 100,
    max: 60000,
    icon: "◰",
  },
  maxConcurrentRuns: {
    label: "Concurrent runs",
    description:
      "How many background runs may execute in parallel. The queue admits up to this many at once; the rest wait.",
    consumerFile: "index.ts",
    consumers: ["startSession", "drainQueued"],
    default: 1,
    min: 1,
    max: 10,
    icon: "▦",
  },
  maxContinuations: {
    label: "Run continuations",
    description:
      "How many times a run may continue after a hold approval before it stops and asks again.",
    consumerFile: "index.ts",
    consumers: ["run", "authorizeTool"],
    default: 3,
    min: 0,
    max: 20,
    icon: "◈",
  },
  maxRunTokens: {
    label: "Run token budget",
    description:
      "Total token ceiling for one run. When reached the run stops and asks for review. Zero means unlimited.",
    consumerFile: "index.ts",
    consumers: ["run", "complete"],
    default: 0,
    min: 0,
    max: 1000000,
    icon: "▧",
  },
  retryMaxDelayMs: {
    label: "Retry max delay",
    description:
      "Ceiling on the exponential backoff between provider retry attempts. Server retry-after is still honored when smaller.",
    consumerFile: "provider.ts",
    consumers: ["complete"],
    default: 60000,
    min: 1000,
    max: 600000,
    icon: "◱",
  },
  contextEntryLimit: {
    label: "Learned entries per kind in a prompt",
    description:
      "How many learned entries of one kind may reach a prompt. Zero keeps the harness out of the prompt entirely.",
    consumerFile: "index.ts",
    consumers: ["retrievalContext"],
    default: 3,
    min: 0,
    max: 20,
    icon: "◇",
  },
  contextCharsPerEntry: {
    label: "Characters per retrieved entry",
    description:
      "How much of a retrieved entry's text a prompt shows. The stored entry is never shortened.",
    consumerFile: "index.ts",
    consumers: ["retrievalContext"],
    default: 240,
    min: 40,
    max: 4000,
    icon: "▭",
  },
};

export type HarnessSettings = {
  readonly [K in HarnessSettingKey]: number;
};

/** The defaults every fresh workspace starts from. A stored value is merged
 * over this and clamped, so a workspace written by an older build still gets a
 * complete, in-range set rather than `undefined` at a call site. */
export function defaultHarnessSettings(): HarnessSettings {
  return Object.fromEntries(
    (Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[]).map((key) => [
      key,
      HARNESS_SETTINGS[key].default,
    ]),
  ) as HarnessSettings;
}

/** Coerce one stored or supplied value into range. A value that is not a
 * finite integer is not a limit an operator chose, so it falls back to the
 * default rather than to a neighbour. */
export function clampHarnessSetting(
  key: HarnessSettingKey,
  value: unknown,
): number {
  const spec = HARNESS_SETTINGS[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return spec.default;
  return Math.min(spec.max, Math.max(spec.min, Math.round(value)));
}

/** Merge stored values over the defaults, clamping each one. Used on load so
 * a hand-edited or truncated state file cannot put the run path in range of a
 * limit nobody chose. */
export function resolveHarnessSettings(
  stored: Readonly<Record<string, unknown>> | undefined,
): HarnessSettings {
  // Mutable while it is being assembled, readonly once returned.
  const resolved: { -readonly [K in HarnessSettingKey]?: number } =
    defaultHarnessSettings();
  if (!stored) return resolved as HarnessSettings;
  for (const key of Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[])
    if (key in stored) resolved[key] = clampHarnessSetting(key, stored[key]);
  return resolved as HarnessSettings;
}

/** Validate a patch body and return the keys it may change.
 *
 * A key that is not in the table is refused by name rather than ignored: a
 * silent no-op on a misspelled limit reads to an operator as "applied", and
 * VOID does not let a surface claim a change it did not make.
 */
export function harnessSettingsPatch(
  body: Record<string, unknown>,
): Partial<HarnessSettings> {
  // Mutable on the way out: a patch is assembled key by key, and the
  // readonly modifier on HarnessSettings describes a settled set, not a
  // half-built one.
  const patch: { -readonly [K in HarnessSettingKey]?: number } = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(HARNESS_SETTINGS, key))
      throw new Error(
        `Unknown harness setting ${key}. Known: ${Object.keys(HARNESS_SETTINGS).sort().join(", ")}.`,
      );
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(`Invalid ${key}: expected a number.`);
    patch[key as HarnessSettingKey] = clampHarnessSetting(
      key as HarnessSettingKey,
      value,
    );
  }
  return patch;
}

/** One row per setting, for /settings and the web panel. The consumer is
 * included so a reader can see what a value actually governs instead of
 * having to take the label's word for it. */
export function harnessSettingsView(settings: HarnessSettings) {
  return (Object.keys(HARNESS_SETTINGS) as HarnessSettingKey[]).map((key) => ({
    key,
    label: HARNESS_SETTINGS[key].label,
    description: HARNESS_SETTINGS[key].description,
    consumer: HARNESS_SETTINGS[key].consumers.join(", "),
    min: HARNESS_SETTINGS[key].min,
    max: HARNESS_SETTINGS[key].max,
    default: HARNESS_SETTINGS[key].default,
    value: settings[key],
    changed: settings[key] !== HARNESS_SETTINGS[key].default,
    icon: HARNESS_SETTINGS[key].icon,
  }));
}
