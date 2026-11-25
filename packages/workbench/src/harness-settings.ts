/**
 * Harness settings: the operator-tunable limits that govern a run.
 *
 * Every entry here replaces a number that used to be a literal inside the
 * run path. A limit nobody can change is a limit nobody chose, and the two
 * external agents NOMO orchestrates both expose theirs: prime-agent has
 * `autonomous.maxTurns`, `autonomous.maxTokens` and `autonomous.timeoutMs`
 * (prime-src `crates/pa-core/src/autonomous/mod.rs:26-29`), and omp has
 * `task.maxConcurrency`, `task.maxRecursionDepth` and `task.maxRuntimeMs`
 * (omp-src `packages/coding-agent/src/task/settings.ts:235-295`). NOMO keeps
 * its own fail-closed defaults rather than either upstream's, because NOMO's
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

import { createHash } from "node:crypto";
import { canonicalJson } from "../../ledger/src/canonical.ts";

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
  | "contextCharsPerEntry"
  | "refinementEnabled"
  | "refinementTurnInterval"
  | "refinementCooldownMs"
  | "refinementLensCount"
  | "providerRequestTimeoutMs"
  | "webToolsEnabled"
  | "sessionSearchEnabled"
  | "toolRequestTimeoutMs"
  | "maxToolResultCharacters"
  | "autoCompactMessages";

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
  /** Single-cell geometric shape (U+25A0-U+25FF) for the TUI settings list. */
  icon: string;
  default: number;
  min: number;
  max: number;
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
    icon: "▥",
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
    icon: "▨",
  },
  refinementEnabled: {
    label: "Harness refinement",
    description:
      "Whether the harness may spend a model call reviewing what it learned. Zero switches it off entirely.",
    consumerFile: "index.ts",
    consumers: ["resolveRefineGates"],
    default: 1,
    min: 0,
    max: 1,
    icon: "◭",
  },
  refinementTurnInterval: {
    label: "Turns between reviews",
    description:
      "Settled turns that must pass before an armed trigger can pay for a review.",
    consumerFile: "index.ts",
    consumers: ["resolveRefineGates"],
    default: 25,
    min: 1,
    max: 1000,
    icon: "◵",
  },
  refinementCooldownMs: {
    label: "Review cooldown (ms)",
    description:
      "How long a review attempt blocks the next one. Zero means no wait at all.",
    consumerFile: "index.ts",
    consumers: ["resolveRefineGates"],
    default: 1_200_000,
    min: 0,
    max: 86_400_000,
    icon: "◲",
  },
  refinementLensCount: {
    label: "Review lenses",
    description:
      "How many independent reviews one harness round pays for. Every lens must approve before anything is recorded; 1 is today's behavior.",
    consumerFile: "index.ts",
    consumers: ["serveHarnessBoundary"],
    default: 1,
    min: 1,
    // With unanimous merging each added lens buys only more veto power at
    // full K cost; past three the spend has no named buyer.
    max: 3,
    icon: "◑",
  },
  providerRequestTimeoutMs: {
    label: "Provider request timeout (ms)",
    description:
      "Per-request HTTP timeout for provider completions during a run, separate from the whole-run ceiling.",
    consumerFile: "provider.ts",
    consumers: ["response"],
    default: 60000,
    min: 1000,
    max: 600000,
    icon: "◴",
  },
  webToolsEnabled: {
    label: "Web fetch and search",
    description:
      "Offer nomo_web_fetch and nomo_web_search, both held at r1. Private, loopback, link-local and cloud metadata addresses are always refused. Zero leaves both tools out of the catalog.",
    consumerFile: "index.ts",
    consumers: ["startSession", "executeTool", "spawnSubagent", "availableTools", "run"],
    default: 0,
    min: 0,
    max: 1,
    icon: "◑",
  },
  sessionSearchEnabled: {
    label: "Search other conversations",
    description:
      "Offer nomo_session_search, which reads other conversations in this workbench and returns redacted excerpts. Secrets are withheld and a withheld hit is reported as truncated. Zero leaves the tool out of the catalog.",
    consumerFile: "index.ts",
    consumers: ["startSession", "executeTool", "spawnSubagent", "availableTools", "run"],
    default: 0,
    min: 0,
    max: 1,
    icon: "⌕",
  },
  toolRequestTimeoutMs: {
    label: "Tool request timeout",
    description:
      "How long one tool call may take before the run stops waiting for it. The call is not cancelled upstream, so a timeout is recorded as an unanswered call rather than a completed one.",
    consumerFile: "index.ts",
    consumers: ["execute", "run"],
    default: 180000,
    min: 1000,
    max: 600000,
    icon: "◔",
  },
  maxToolResultCharacters: {
    label: "Tool result characters",
    description:
      "Characters of one tool result retained in the conversation. A longer result is cut and the cut is marked, so the model is never shown a truncated result that looks complete.",
    consumerFile: "index.ts",
    consumers: ["run"],
    default: 64000,
    min: 256,
    max: 200000,
    icon: "◧",
  },
  autoCompactMessages: {
    label: "Automatic compaction",
    description:
      "Messages at which a run compacts the conversation before its next turn. Zero disables it, so a conversation grows until the operator compacts it or the context limit stops the run.",
    consumerFile: "index.ts",
    consumers: ["run", "compact"],
    default: 150,
    min: 0,
    max: 199,
    icon: "◫",
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
 * NOMO does not let a surface claim a change it did not make.
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
    icon: HARNESS_SETTINGS[key].icon,
    min: HARNESS_SETTINGS[key].min,
    max: HARNESS_SETTINGS[key].max,
    default: HARNESS_SETTINGS[key].default,
    value: settings[key],
    changed: settings[key] !== HARNESS_SETTINGS[key].default,
  }));
}

/**
 * A setting that selects rather than limits.
 *
 * The table above is numeric because every entry there is a bound the run
 * path can honour, and a clamp is what keeps a hand-edited snapshot from
 * widening one. A model id is not a bound: it names a model, and the only
 * honest check on it is its shape, because whether a provider knows the model
 * is a fact only the provider can answer. So the selection lives in its own
 * table with its own validation, and the run path falls back to the
 * conversation's own model when nothing is selected.
 */
export type HarnessTextSettingKey = "refinementModel";

export type HarnessTextSettingSpec = {
  label: string;
  description: string;
  consumerFile: "index.ts" | "provider.ts" | "gui.ts" | "agents.ts";
  consumers: readonly string[];
  icon: string;
  default: string;
  maxLength: number;
};

export const HARNESS_TEXT_SETTINGS: {
  readonly [K in HarnessTextSettingKey]: HarnessTextSettingSpec;
} = {
  refinementModel: {
    label: "Reviewer model",
    description:
      "The provider model the harness spends its review calls on. Empty means the conversation's own model.",
    consumerFile: "index.ts",
    consumers: ["serveHarnessBoundary"],
    icon: "◕",
    default: "",
    maxLength: 128,
  },
};

export type HarnessTextSettings = {
  readonly [K in HarnessTextSettingKey]: string;
};

/** A model id is a provider's own name for a model. The shape is checked here
 * because the id travels into a request body, and a control character or a
 * space in a header or a path is a value no provider asked for. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]+$/;

export function defaultHarnessTextSettings(): HarnessTextSettings {
  return Object.fromEntries(
    (Object.keys(HARNESS_TEXT_SETTINGS) as HarnessTextSettingKey[]).map((key) => [
      key,
      HARNESS_TEXT_SETTINGS[key].default,
    ]),
  ) as HarnessTextSettings;
}

/** Why a model id was refused, in one sentence an operator can act on. The
 * value is named because a refusal that does not name it teaches nothing. */
export function harnessTextSettingRejection(
  key: HarnessTextSettingKey,
  value: unknown,
): string | null {
  const spec = HARNESS_TEXT_SETTINGS[key];
  if (typeof value !== "string")
    return `Invalid ${key}: expected a string, got ${typeof value}.`;
  if (value === "") return null;
  if (value.length > spec.maxLength)
    return `Invalid ${key}: a model id is at most ${spec.maxLength} characters, got ${value.length}.`;
  if (!MODEL_ID.test(value))
    return `Invalid ${key}: a model id may hold letters, digits and the characters . _ - : @ /, got ${JSON.stringify(value)}.`;
  return null;
}

/** Merge stored values over the defaults, keeping only what the validator
 * accepts. A hand-edited or truncated state file cannot put a model id into
 * the run path that the operator never chose. */
export function resolveHarnessTextSettings(
  stored: Readonly<Record<string, unknown>> | undefined,
): HarnessTextSettings {
  const resolved: { -readonly [K in HarnessTextSettingKey]?: string } =
    defaultHarnessTextSettings();
  if (!stored) return resolved as HarnessTextSettings;
  for (const key of Object.keys(HARNESS_TEXT_SETTINGS) as HarnessTextSettingKey[]) {
    if (!(key in stored)) continue;
    const value = stored[key];
    if (harnessTextSettingRejection(key, value) !== null) continue;
    resolved[key] = value as string;
  }
  return resolved as HarnessTextSettings;
}

/** Validate a patch body and return the keys it may change. An unknown key
 * is refused by name rather than ignored: a silent no-op on a misspelled
 * selection reads to an operator as applied. */
export function harnessTextSettingsPatch(
  body: Record<string, unknown>,
): Partial<HarnessTextSettings> {
  const patch: { -readonly [K in HarnessTextSettingKey]?: string } = {};
  for (const [key, value] of Object.entries(body)) {
    if (!Object.hasOwn(HARNESS_TEXT_SETTINGS, key))
      throw new Error(
        `Unknown harness selection ${key}. Known: ${Object.keys(HARNESS_TEXT_SETTINGS).sort().join(", ")}.`,
      );
    const rejection = harnessTextSettingRejection(
      key as HarnessTextSettingKey,
      value,
    );
    if (rejection) throw new Error(rejection);
    patch[key as HarnessTextSettingKey] = value as string;
  }
  return patch;
}

/** One row per selection, for the operator surfaces. */
export function harnessTextSettingsView(settings: HarnessTextSettings) {
  return (Object.keys(HARNESS_TEXT_SETTINGS) as HarnessTextSettingKey[]).map(
    (key) => ({
      key,
      label: HARNESS_TEXT_SETTINGS[key].label,
      description: HARNESS_TEXT_SETTINGS[key].description,
      consumer: HARNESS_TEXT_SETTINGS[key].consumers.join(", "),
      icon: HARNESS_TEXT_SETTINGS[key].icon,
      default: HARNESS_TEXT_SETTINGS[key].default,
      value: settings[key],
      changed: settings[key] !== HARNESS_TEXT_SETTINGS[key].default,
    }),
  );
}

/**
 * A harness variant's identity: every axis that can change what a run does.
 *
 * The axes are the resolved numeric and text settings, a digest of the prompt
 * preamble (the text itself never enters the identity) and the model id. The
 * id is a sha256 over the canonical JSON of the axes, so two variants with the
 * same id agree on every axis. Two variants are comparable only when they
 * differ in at most one axis; otherwise "A beat B" could be any of the changed
 * axes and the comparison would claim a cause nobody isolated.
 */
export type VariantAxes = Readonly<Record<string, number | string>>;

export type VariantIdentity = {
  readonly variantId: string;
  readonly axes: VariantAxes;
};

export type VariantComparison =
  | { readonly comparable: true; readonly changedAxis: string | null }
  | { readonly comparable: false; readonly changedAxes: readonly string[]; readonly reason: string };

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export function variantIdentity(input: {
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly promptPreamble: string;
  readonly model: string;
}): VariantIdentity {
  if (typeof input.promptPreamble !== "string")
    throw new TypeError("promptPreamble: expected a string");
  if (typeof input.model !== "string" || !input.model || !MODEL_ID.test(input.model))
    throw new TypeError("model: expected a provider model id");
  const numeric: Record<string, unknown> = {};
  const text: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.settings ?? {})) {
    if (Object.hasOwn(HARNESS_TEXT_SETTINGS, key)) text[key] = value;
    else numeric[key] = value;
  }
  const axes: VariantAxes = {
    ...defaultHarnessSettings(),
    ...harnessSettingsPatch(numeric),
    ...defaultHarnessTextSettings(),
    ...harnessTextSettingsPatch(text),
    promptPreamble: sha256(input.promptPreamble),
    model: input.model,
  };
  return { variantId: sha256(canonicalJson(axes)), axes };
}

/** Name the single axis two variants differ in, or refuse the comparison. A
 * variant whose id does not match its own axes is refused too, so a hand-edited
 * identity cannot pass as comparable. */
export function compareVariants(a: VariantIdentity, b: VariantIdentity): VariantComparison {
  for (const variant of [a, b])
    if (sha256(canonicalJson(variant.axes)) !== variant.variantId)
      return { comparable: false, changedAxes: [], reason: `${variant.variantId} does not match its axes` };
  const keys = [...new Set([...Object.keys(a.axes), ...Object.keys(b.axes)])].sort();
  const changedAxes = keys.filter((key) => a.axes[key] !== b.axes[key]);
  if (changedAxes.length > 1)
    return {
      comparable: false,
      changedAxes,
      reason: `variants differ in ${changedAxes.length} axes (${changedAxes.join(", ")}); only one may change`,
    };
  return { comparable: true, changedAxis: changedAxes[0] ?? null };
}
