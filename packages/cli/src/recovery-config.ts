/**
 * What `nomo recovery` read from a configuration file, and what it refused.
 *
 * The refusal used to be one sentence — `Invalid recovery configuration.` —
 * and it was the sentence an operator met first when they pointed the managed
 * executor at a filesystem root. Nothing named a field, nothing named an
 * adapter, and nothing pointed at `nomo recovery conformance`, which does take
 * `filesystem.managed`. The failure looked transient and retryable; it was not.
 *
 * So the configuration is described rather than guessed at: every field the
 * executor reads, every required field it did not find, every field it ignored,
 * and every reason the adapter is not usable. The same description is the text
 * of `nomo recovery doctor`, so the diagnostic and the report cannot drift.
 *
 * Values are printed, and no value here is a secret: the file holds path names,
 * an environment variable *name*, and the shape of a schema. The encryption key
 * itself is never in a configuration file, which is why only its variable name
 * is ever reported.
 */

/** The adapters `nomo recovery conformance --adapter <name>` can be run for. */
export const CONFORMANCE_ADAPTERS: readonly string[] = [
  "filesystem.managed",
  "git.managed",
  "postgres.managed",
];

export type ConfigField = {
  readonly key: string;
  readonly value: string;
  /** `config` when the file supplied it, `required` when it did not. */
  readonly source: string;
  readonly note?: string;
};

export type RecoveryConfigReport = {
  readonly valid: boolean;
  readonly fields: readonly ConfigField[];
  readonly problems: readonly string[];
};

const MODES = ["audit", "plan", "normal"] as const;
const ADAPTER_KEYS = ["filesystem", "git", "postgres"] as const;
const KNOWN_KEYS = [
  "workspace",
  "stateDir",
  "encryptionKeyEnv",
  "mode",
  "vaultCapacity",
  "policyPath",
  "agentId",
  ...ADAPTER_KEYS,
];

/** The two fields a recovery configuration cannot run without. */
const REQUIRED_FIELDS: Record<string, true> = { workspace: true, stateDir: true };

/**
 * The one object guard this module parses with. A configuration file is JSON
 * read at a boundary and its fields are checked one at a time below, so the
 * guard proves "this is an object" and nothing more; every field is validated
 * by name rather than assumed from the guard.
 */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown): string => {
  if (value === undefined) return "(absent)";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (Array.isArray(value)) return `${value.length} entr${value.length === 1 ? "y" : "ies"}`;
  if (isJsonObject(value)) return `block with ${Object.keys(value).length} field(s)`;
  return String(value);
};

/**
 * A relative path that stays inside the workspace. An absolute root, a parent
 * reference or a Windows separator would put managed recovery outside the tree
 * the operator named, so each is refused by name rather than silently resolved.
 */
function rootProblem(key: string, root: unknown): string | undefined {
  if (typeof root !== "string") return `${key}.root is missing or not a string`;
  if (root === "") return `${key}.root is empty`;
  if (root.includes("\\")) return `${key}.root holds a backslash: use "/" separators`;
  if (root.startsWith("/")) return `${key}.root is absolute: a managed root is relative to the config file`;
  // A leading `./` is the ordinary way a relative path is written, and it is
  // not a traversal, so it is normalised away rather than refused. Interior
  // `.` and `..` are the security property: they can walk a managed root back
  // out of the workspace, and a symlinked parent can redirect what the root
  // resolves to. Those still refuse. Refusing the leading `./` would break
  // every configuration written that way — including the Python transport
  // fixture, which is how this was found — without refusing anything unsafe.
  const parts = root.split("/");
  if (parts[0] === ".") parts.shift();
  const bad = parts.find((part) => !part || part === "." || part === "..");
  return bad === undefined
    ? undefined
    : `${key}.root holds ${JSON.stringify(bad)}: a managed root stays inside the workspace`;
}

/**
 * The adapter an operator named, when they named one in a way this executor
 * does not read. `adapters: [{ id: "filesystem.managed", ... }]` is the shape
 * the managed-executor documentation uses, and it is worth naming the adapter
 * inside it, because the sibling `nomo recovery conformance` does accept that
 * exact name and an operator who was told "invalid" had no way to learn that.
 */
function unsupportedAdapter(config: Record<string, unknown>): string | undefined {
  const adapters = config.adapters;
  if (adapters === undefined) return undefined;
  const names = (Array.isArray(adapters) ? adapters : [adapters])
    .filter(isJsonObject)
    .map((adapter) => adapter.id)
    .filter((id): id is string => typeof id === "string");
  const known = names.find((id) => CONFORMANCE_ADAPTERS.includes(id));
  if (known === undefined) return undefined;
  return (
    `\`adapters\` is not a field this command reads, so ${JSON.stringify(known)} was never selected: ` +
    `nomo recovery runs one adapter per configuration, chosen by a top-level \`postgres\`, \`filesystem\` or \`git\` block. ` +
    `\`nomo recovery conformance --adapter ${known}\` is the command that runs ${known}`
  );
}

export function describeRecoveryConfig(
  raw: unknown,
  configPath: string,
): RecoveryConfigReport {
  const fields: ConfigField[] = [];
  const problems: string[] = [];
  if (!isJsonObject(raw)) {
    return {
      valid: false,
      fields: [{ key: "config", value: "not a JSON object", source: "config" }],
      problems: [
        `${configPath} does not hold a JSON object; nomo recovery reads its configuration from a JSON file`,
      ],
    };
  }
  const config = raw;
  // `workspace` and `stateDir` are the two fields a configuration cannot run
  // without; the rest are read when present and defaulted when not, and the
  // report says which of the two a field is rather than calling every absent
  // field required.
  const required = REQUIRED_FIELDS;
  const field = (key: string, note?: string): ConfigField => ({
    key,
    value: show(config[key]),
    source:
      config[key] === undefined
        ? REQUIRED_FIELDS[key] === true
          ? "required, not found"
          : "optional, not set"
        : "config",
    ...(note === undefined ? {} : { note }),
  });

  for (const key of [
    "workspace",
    "stateDir",
    "encryptionKeyEnv",
    "mode",
    "vaultCapacity",
    "policyPath",
    "agentId",
  ])
    fields.push(
      field(
        key,
        key === "encryptionKeyEnv"
          ? "the variable holding the vault key; the key itself is never in this file"
          : undefined,
      ),
    );


  const workspace = config.workspace;
  if (typeof workspace !== "string" || !/^[\w-]{1,100}$/.test(workspace))
    problems.push(
      workspace === undefined
        ? "workspace is required: a JSON string of 1 to 100 letters, digits, _ or -"
        : `workspace is ${JSON.stringify(workspace)}: it must be a JSON string of 1 to 100 letters, digits, _ or -`,
    );
  const stateDir = config.stateDir;
  if (typeof stateDir !== "string" || stateDir === "")
    problems.push(
      stateDir === undefined
        ? "stateDir is required: the recovery vault and journal live under it"
        : `stateDir is ${JSON.stringify(stateDir)}: it must be a non-empty path`,
    );
  const mode = config.mode;
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode))
    problems.push(
      `mode is ${JSON.stringify(mode)}: it must be one of ${MODES.join(", ")}`,
    );

  const present = ADAPTER_KEYS.filter((key) => config[key] !== undefined);
  for (const key of present) fields.push(field(key));
  for (const key of ADAPTER_KEYS)
    if (!present.includes(key))
      fields.push({
        key,
        value: "(absent)",
        source: "required, not found",
        note: "exactly one adapter block selects the target this executor manages",
      });

  const unsupported = unsupportedAdapter(config);
  if (unsupported !== undefined) problems.push(unsupported);
  if (present.length === 0 && unsupported === undefined)
    problems.push(
      `no adapter is configured: exactly one of ${ADAPTER_KEYS.join(", ")} must be a block in this file`,
    );
  if (present.length > 1)
    problems.push(
      `${present.length} adapters are configured (${present.join(", ")}): exactly one of ${ADAPTER_KEYS.join(", ")} must be a block in this file`,
    );

  const filesystem = config.filesystem;
  if (isJsonObject(filesystem)) {
    const problem = rootProblem("filesystem", filesystem.root);
    if (problem !== undefined) problems.push(problem);
    if (filesystem.cooperative !== true)
      problems.push(
        `filesystem.cooperative is ${show(filesystem.cooperative)}: a managed filesystem root must set "cooperative": true`,
      );
  }
  const git = config.git;
  if (isJsonObject(git)) {
    const problem = rootProblem("git", git.root);
    if (problem !== undefined) problems.push(problem);
    if (git.cooperative !== true)
      problems.push(
        `git.cooperative is ${show(git.cooperative)}: a managed git root must set "cooperative": true`,
      );
  }
  const postgres = config.postgres;
  if (isJsonObject(postgres)) {
    if (typeof postgres.schema !== "string" || postgres.schema === "")
      problems.push(
        `postgres.schema is ${show(postgres.schema)}: it must be a non-empty string`,
      );
    if (!Array.isArray(postgres.tables))
      problems.push(
        `postgres.tables is ${show(postgres.tables)}: it must be a JSON array of table names`,
      );
    if (typeof postgres.urlEnv !== "string" || postgres.urlEnv === "")
      problems.push(
        `postgres.urlEnv is ${show(postgres.urlEnv)}: it must name the environment variable holding the connection URL`,
      );
  }

  for (const key of Object.keys(config))
    if (!KNOWN_KEYS.includes(key))
      fields.push({
        key,
        value: show(config[key]),
        source: "ignored",
        note: "not read by nomo recovery",
      });

  return { valid: problems.length === 0, fields, problems };
}

/** The text of the refusal, with every reason in it rather than one of them. */
export function recoveryConfigRefusal(report: RecoveryConfigReport): string {
  return [
    "Invalid recovery configuration.",
    ...report.problems.map((problem) => `  ${problem}`),
    "  run `nomo recovery doctor --config <file>` to see every field this command reads and ignores",
  ].join("\n");
}

/**
 * `nomo recovery doctor --config <file>`. The shape `cloud/config.mjs` already
 * uses: one line per field with where it came from, never a value that could be
 * sensitive. Exit 0 when the configuration is usable, 1 when it is not, so this
 * is checkable in a script rather than only readable by eye.
 */
export function renderRecoveryConfigReport(
  configPath: string,
  report: RecoveryConfigReport,
): string {
  return [
    `config: ${configPath}`,
    ...report.fields.map((item) => `field ${item.key}: ${item.value} (${item.source}${item.note === undefined ? "" : `, ${item.note}`})`),
    `adapters configured: ${ADAPTER_KEYS.filter((key) => report.fields.some((item) => item.key === key && item.source === "config")).join(", ") || "none"}`,
    ...report.problems.map((problem) => `problem: ${problem}`),
    `configuration: ${report.valid ? "usable" : "not usable"}`,
  ].join("\n");
}