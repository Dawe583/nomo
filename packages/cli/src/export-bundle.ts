/**
 * R14: an export bundle that declares what it carries and can prove it.
 *
 * The ledger, the operation journal, the vault manifest and the export
 * capability are four sections. Each one carries its own record count, byte
 * length and SHA-256, and the manifest that lists them is written only after
 * every section is on disk, so a bundle on disk never claims more than it
 * holds. Verification re-derives every number from the bytes: a section that
 * is missing, truncated, reordered or rewritten is a hard error, never a
 * warning.
 *
 * Valid signatures are not a completeness proof (WP-R14). A history whose tail
 * was cut is still internally consistent, so the manifest records the sequence
 * range and head hash each signed section claims, the verifier recomputes both
 * from the section bytes, and the manifest digest itself has to be presented
 * from outside the bundle. Without that anchor a rewritten bundle is a bundle
 * nobody can distinguish from an honest one.
 *
 * The vault section is a manifest, not a copy: artifacts are listed by digest
 * and byte length and their bytes stay encrypted at rest. Recovering artifact
 * bytes is the recovery-backup path, and pretending an export can restore them
 * would be a claim this format does not support.
 *
 * The stage universe in the capability section is read from the journal
 * transition tables, so a completeness claim cannot drift from the transitions
 * that are actually enforced.
 */

import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  LEDGER_READ_MAX_BYTES,
  LEDGER_READ_MAX_ENTRIES,
  readLedgerEntries,
  verifyChain,
  type PublicKeyLookup,
} from "../../ledger/src/verify.ts";
import type { JsonlEntry } from "../../ledger/src/store.ts";
import { verifyAnchor, type AttestationDocument } from "../../ledger/src/attest.ts";
import {
  assertPrivateDirectoryPath,
  assertPrivateFileIfPresent,
  assertPrivateFilePath,
  readPrivateFile,
} from "../../ledger/src/hardening.ts";
import {
  jobStageTable,
  operationStageTable,
  validateJobTransition,
  validateTransition,
  type OperationEvent,
  type RecoveryJobEvent,
  type RecoveryJobStage,
  type Stage,
} from "../../runtime/src/journal.ts";

export const BUNDLE_SCHEMA = "void.export-bundle.v1";
export const CAPABILITY_SCHEMA = "void.export-capability.v1";
export const VAULT_MANIFEST_SCHEMA = "void.export-vault-manifest.v1";
export const MANIFEST_FILE = "manifest.json";

export const BUNDLE_SECTIONS = [
  "ledger",
  "journal",
  "vault-manifest",
  "capability",
] as const;
export type BundleSectionName = (typeof BUNDLE_SECTIONS)[number];

const SECTION_FILES: Readonly<Record<BundleSectionName, string>> = {
  ledger: "ledger.jsonl",
  journal: "journal.jsonl",
  "vault-manifest": "vault-manifest.json",
  capability: "capability.json",
};

/** Refusal categories. Every one of them ends the command non-zero. */
export const bundleCategories = {
  anchor_required: "A trusted manifest digest must be presented from outside the bundle.",
  anchor_mismatch: "Bundle manifest digest does not match the presented anchor.",
  bundle_exists: "Bundle destination already exists.",
  bundle_invalid: "Bundle manifest is not a readable void.export-bundle.v1 document.",
  capability_invalid: "Capability section is not a readable export capability document.",
  journal_invalid: "Journal section does not replay under the transition tables.",
  journal_missing: "Operation journal for the workspace is unavailable.",
  journal_unverifiable: "Journal section could not be verified.",
  ledger_invalid: "Ledger section is not readable under the ledger read limits.",
  ledger_unverifiable: "Ledger section could not be verified.",
  section_count_mismatch: "Section record count does not match the manifest.",
  section_digest_mismatch: "Section digest does not match the manifest.",
  section_missing: "Bundle section is missing.",
  sequence_range_mismatch: "Section sequence range does not match the manifest.",
  state_incomplete: "Export state is incomplete.",
  vault_invalid: "Vault directory does not hold only committed digest named artifacts.",
  workspace_mismatch: "Section entries do not belong to the exported workspace.",
} as const;

export type BundleCategory = keyof typeof bundleCategories;

export class BundleError extends Error {
  readonly category: BundleCategory;
  constructor(category: BundleCategory, detail?: string) {
    super(
      detail
        ? `${bundleCategories[category]} (${detail})`
        : bundleCategories[category],
    );
    this.category = category;
  }
}

function refuse(category: BundleCategory, detail?: string): never {
  throw new BundleError(category, detail);
}

const DIGEST = /^[a-f0-9]{64}$/;

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * `entries` counts what the section actually carries: lines for the signed
 * sections, artifacts for the vault manifest, declared keys for the capability
 * document. The verifier recomputes it from the bytes, so the number is a
 * checkable claim rather than a label.
 */
export type BundleSection = {
  readonly name: BundleSectionName;
  readonly file: string;
  readonly entries: number;
  readonly bytes: number;
  readonly sha256: string;
  /** Contiguous sequence range the signed section claims; null otherwise. */
  readonly firstSeq: number | null;
  readonly lastSeq: number | null;
};

export type BundleManifest = {
  readonly schema: typeof BUNDLE_SCHEMA;
  readonly workspace: string;
  readonly createdAt: string;
  /** Head hash of the ledger section, so a reviewer can compare it to a live ledger. */
  readonly ledgerHead: string;
  readonly sections: readonly BundleSection[];
  /** Written last, and only for a bundle whose sections are all present and digested. */
  readonly complete: true;
};

export type VaultArtifact = {
  /** Digest of the stored blob, the vault's own artifact id. */
  readonly digest: string;
  /** Digest of the recovered plaintext: the reference a restore is checked against. */
  readonly contentDigest: string;
  /** A key id, never key material. */
  readonly keyId: string;
  readonly bytes: number;
  readonly operationId: string | null;
  readonly slot: string | null;
};

export type VaultStore = "sqlite" | "legacy-files" | "absent";

export type VaultManifestSection = {
  readonly schema: typeof VAULT_MANIFEST_SCHEMA;
  readonly workspace: string;
  readonly store: VaultStore;
  /** Interrupted writes a crashed process left behind in the legacy store; not artifacts. */
  readonly unsettled: number;
  /** Recovery slots held for operations that have not captured yet. */
  readonly reservations: number;
  readonly artifacts: readonly VaultArtifact[];
};

const VAULT_STORES: readonly string[] = ["sqlite", "legacy-files", "absent"];

const isVaultArtifact = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  "digest" in value &&
  typeof value.digest === "string" &&
  DIGEST.test(value.digest) &&
  "contentDigest" in value &&
  typeof value.contentDigest === "string" &&
  DIGEST.test(value.contentDigest) &&
  "keyId" in value &&
  typeof value.keyId === "string" &&
  value.keyId !== "" &&
  "bytes" in value &&
  typeof value.bytes === "number" &&
  Number.isSafeInteger(value.bytes) &&
  value.bytes >= 0;

export type CapabilitySection = {
  readonly schema: typeof CAPABILITY_SCHEMA;
  readonly workspace: string;
  readonly bundle: { readonly schema: string; readonly sections: readonly string[] };
  readonly limits: {
    readonly ledgerReadMaxBytes: number;
    readonly ledgerReadMaxEntries: number;
  };
  readonly operation: {
    readonly stages: readonly string[];
    readonly terminalStages: readonly string[];
    readonly transitions: number;
  };
  readonly recoveryJob: {
    readonly stages: readonly string[];
    readonly terminalStages: readonly string[];
    readonly transitions: number;
  };
  readonly excluded: readonly string[];
};

export type ExportBundleOptions = {
  readonly ledgerPath: string;
  /** Root holding `journal/` and `vault/`, the layout the recovery backup reads. */
  readonly stateDir: string;
  readonly bundleDir: string;
  readonly publicKey: PublicKeyLookup;
  readonly journalPublicKey: PublicKeyLookup;
  readonly at?: () => Date;
};

export type ExportBundleResult = {
  readonly workspace: string;
  readonly bundleDir: string;
  readonly manifestDigest: string;
  readonly manifest: BundleManifest;
};

export type VerifyBundleOptions = {
  readonly bundleDir: string;
  /** Manifest digest obtained out of band when the bundle was produced. */
  readonly anchor: string;
  readonly publicKey: PublicKeyLookup;
  /**
   * A signed head published out of band, checked against the bundle's ledger
   * section. Distinct from `anchor`: that is the manifest digest, this is a
   * signature over a length and a head, so it also fails a bundle whose
   * ledger section was truncated while the manifest was rewritten to match.
   */
  readonly attestation?: AttestationDocument | undefined;
  /**
   * Optional on purpose: a reviewer holding only the bundle and its anchor can
   * check digests, ranges and transitions but not journal signatures. The
   * result then says so instead of implying an authentication that did not
   * happen.
   */
  readonly journalPublicKey?: PublicKeyLookup | undefined;
};

export type BundleVerification = {
  readonly workspace: string;
  readonly manifestDigest: string;
  readonly sections: readonly BundleSection[];
  readonly vault: VaultManifestSection;
  readonly capability: CapabilitySection;
  readonly signed: { readonly ledger: boolean; readonly journal: boolean };
};

/** Section digests and counts, the first half of the proof. */
function section(
  name: BundleSectionName,
  bytes: Uint8Array,
  entries: number,
  range?: { first: number; last: number },
): BundleSection {
  return {
    name,
    file: SECTION_FILES[name],
    entries,
    bytes: bytes.length,
    sha256: sha256(bytes),
    firstSeq: range ? range.first : null,
    lastSeq: range ? range.last : null,
  };
}

export async function createBundle(
  options: ExportBundleOptions,
): Promise<ExportBundleResult> {
  const workspace = basename(options.ledgerPath, ".jsonl");
  if (!/^[\w-]{1,100}$/.test(workspace)) refuse("state_incomplete", workspace);
  const exists = await lstat(options.bundleDir).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) refuse("bundle_exists", options.bundleDir);

  const ledger = await readSignedSection(options.ledgerPath, workspace, {
    publicKey: options.publicKey,
    missing: "ledger_unverifiable",
    unreadable: "ledger_invalid",
    unverifiable: "ledger_unverifiable",
    replay: "chain",
    privateState: true,
  });
  const journalPath = join(options.stateDir, "journal", `${workspace}.jsonl`);
  const journal = await readSignedSection(journalPath, workspace, {
    publicKey: options.journalPublicKey,
    missing: "journal_missing",
    unreadable: "journal_invalid",
    unverifiable: "journal_unverifiable",
    replay: "journal",
    privateState: true,
  });
  const vault = await readVaultManifest(options.stateDir, workspace);
  const capability = capabilitySection(workspace);

  const ledgerBytes = jsonlBytes(ledger.entries);
  const journalBytes = jsonlBytes(journal.entries);
  const vaultBytes = jsonBytes(vault);
  const capabilityBytes = jsonBytes(capability);
  const manifest: BundleManifest = {
    schema: BUNDLE_SCHEMA,
    workspace,
    createdAt: (options.at?.() ?? new Date()).toISOString(),
    ledgerHead: ledger.entries[ledger.entries.length - 1]?.hash ?? "",
    sections: [
      section("ledger", ledgerBytes, ledger.entries.length, ledger.range),
      section("journal", journalBytes, journal.entries.length, journal.range),
      section("vault-manifest", vaultBytes, vault.artifacts.length),
      section("capability", capabilityBytes, Object.keys(capability).length),
    ],
    complete: true,
  };
  const manifestBytes = jsonBytes(manifest);

  const parent = dirname(options.bundleDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = join(
    parent,
    `.${basename(options.bundleDir)}.partial-${randomBytes(8).toString("hex")}`,
  );
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeFile(join(staging, SECTION_FILES.ledger), ledgerBytes, {
      mode: 0o600,
    });
    await writeFile(join(staging, SECTION_FILES.journal), journalBytes, {
      mode: 0o600,
    });
    await writeFile(join(staging, SECTION_FILES["vault-manifest"]), vaultBytes, {
      mode: 0o600,
    });
    await writeFile(join(staging, SECTION_FILES.capability), capabilityBytes, {
      mode: 0o600,
    });
    // The completeness claim lands last. Everything above can fail without a
    // single byte of claim on disk.
    await writeFile(join(staging, MANIFEST_FILE), manifestBytes, { mode: 0o600 });
    await rename(staging, options.bundleDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return {
    workspace,
    bundleDir: options.bundleDir,
    manifestDigest: sha256(manifestBytes),
    manifest,
  };
}

/**
 * Load time proof. The anchor comes from outside the bundle, so a rewritten
 * bundle cannot also rewrite the expectation. Every check below recomputes a
 * declared number from the bytes on disk; none of them trusts the manifest.
 */
export async function verifyBundle(
  options: VerifyBundleOptions,
): Promise<BundleVerification> {
  if (!DIGEST.test(options.anchor)) refuse("anchor_required", options.anchor);
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(options.bundleDir, MANIFEST_FILE));
  } catch {
    refuse("anchor_mismatch", "manifest unreadable");
  }
  const manifestDigest = sha256(manifestBytes);
  if (manifestDigest !== options.anchor) refuse("anchor_mismatch", manifestDigest);
  const manifest = parseManifest(manifestBytes);
  if (!/^[\w-]{1,100}$/.test(manifest.workspace))
    refuse("bundle_invalid", "workspace");

  if (manifest.sections.length !== BUNDLE_SECTIONS.length)
    refuse("bundle_invalid", "section list");
  const content = new Map<BundleSectionName, Buffer>();
  for (const name of BUNDLE_SECTIONS) {
    const expected = manifest.sections.find((item) => item.name === name);
    if (!expected || expected.file !== SECTION_FILES[name])
      refuse("bundle_invalid", name);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(options.bundleDir, SECTION_FILES[name]));
    } catch {
      refuse("section_missing", name);
    }
    if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
      refuse("section_digest_mismatch", name);
    content.set(name, bytes);
  }

  const ledger = await readSignedSection(
    join(options.bundleDir, SECTION_FILES.ledger),
    manifest.workspace,
    {
      publicKey: options.publicKey,
      missing: "section_missing",
      unreadable: "ledger_invalid",
      unverifiable: "ledger_unverifiable",
      replay: "chain",
      onDisk: content.get("ledger"),
    },
  );
  assertDeclared(
    manifest.sections.find((item) => item.name === "ledger")!,
    ledger.entries.length,
    ledger.range,
  );

  if (options.attestation !== undefined) {
    // The manifest digest proves the bundle is the one that was published. The
    // signed head proves the ledger inside it is the one that was anchored,
    // so a bundle truncated and re-manifested still fails.
    const anchored = await verifyAnchor(options.attestation, ledger.entries, {
      publicKey: options.publicKey,
    });
    if (!anchored.ok) refuse("anchor_mismatch", `signed anchor: ${anchored.reason}`);
  }
  if (
    (ledger.entries[ledger.entries.length - 1]?.hash ?? "") !== manifest.ledgerHead
  )
    refuse("sequence_range_mismatch", "ledger head");

  const journal = await readSignedSection(
    join(options.bundleDir, SECTION_FILES.journal),
    manifest.workspace,
    {
      publicKey: options.journalPublicKey,
      missing: "section_missing",
      unreadable: "journal_invalid",
      unverifiable: "journal_unverifiable",
      replay: "journal",
      onDisk: content.get("journal"),
    },
  );
  assertDeclared(
    manifest.sections.find((item) => item.name === "journal")!,
    journal.entries.length,
    journal.range,
  );

  const vault = parseJson(content.get("vault-manifest")!);
  if (
    vault?.schema !== VAULT_MANIFEST_SCHEMA ||
    vault.workspace !== manifest.workspace ||
    !VAULT_STORES.includes(String(vault.store)) ||
    !Number.isInteger(vault.unsettled) ||
    !Number.isInteger(vault.reservations) ||
    !Array.isArray(vault.artifacts) ||
    !vault.artifacts.every(isVaultArtifact)
  )
    refuse("vault_invalid", "document");
  if (
    manifest.sections.find((item) => item.name === "vault-manifest")!.entries !==
    vault.artifacts.length
  )
    refuse("section_count_mismatch", "vault-manifest");

  const capability = parseJson(content.get("capability")!);
  if (
    capability?.schema !== CAPABILITY_SCHEMA ||
    capability.workspace !== manifest.workspace ||
    !Array.isArray(capability.excluded)
  )
    refuse("capability_invalid", "document");
  if (
    manifest.sections.find((item) => item.name === "capability")!.entries !==
    Object.keys(capability).length
  )
    refuse("section_count_mismatch", "capability");

  return {
    workspace: manifest.workspace,
    manifestDigest,
    sections: manifest.sections,
    vault: vault as VaultManifestSection,
    capability: capability as CapabilitySection,
    // Derived, not asserted. `readSignedSection` already refuses a chain that
    // fails verification, so a literal `true` can never report a degraded state
    // if that call site ever stops supplying a key.
    signed: { ledger: ledger.signed, journal: journal.signed },
  };
}

export type SignedSection = {
  readonly entries: readonly JsonlEntry[];
  readonly range: { readonly first: number; readonly last: number };
  /** False when no key was supplied: the chain verified, the origin did not. */
  readonly signed: boolean;
};

type ReadSectionOptions = {
  readonly publicKey?: PublicKeyLookup | undefined;
  readonly missing: BundleCategory;
  readonly unreadable: BundleCategory;
  readonly unverifiable: BundleCategory;
  /** `journal` replays the events through the transition tables; `chain` only verifies it. */
  readonly replay: "chain" | "journal";
  /** Live local state is private; bundle bytes have already been hash checked. */
  readonly privateState?: boolean;
  /** Set when verifying a bundle: the already digest checked bytes are reused. */
  readonly onDisk?: Buffer | undefined;
};

/**
 * Read, authenticate and replay one signed section. The chain verifier already
 * enforces a contiguous sequence from one, so the range it returns is the
 * expected range rather than an observed guess: a gap is a refusal, not a
 * shorter bundle.
 */
export async function readSignedSection(
  path: string,
  workspace: string,
  options: ReadSectionOptions,
): Promise<SignedSection> {
  let entries: JsonlEntry[];
  if (options.onDisk) {
    entries = parseJsonl(options.onDisk.toString("utf8"), options.unreadable, path);
  } else if (options.privateState) {
    let bytes: Buffer;
    try {
      bytes = await readPrivateFile(
        path,
        "local signed state file",
        LEDGER_READ_MAX_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        refuse(options.missing, path);
      refuse(options.unreadable, (error as Error).message);
    }
    entries = parseJsonl(bytes.toString("utf8"), options.unreadable, path);
    if (entries.length > LEDGER_READ_MAX_ENTRIES)
      refuse(
        options.unreadable,
        `${path} exceeds the ${LEDGER_READ_MAX_ENTRIES} entry read limit`,
      );
  } else {
    const present = await lstat(path).then(
      (info) => info.isFile(),
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (!present) refuse(options.missing, path);
    try {
      entries = await readLedgerEntries(path);
    } catch (error) {
      refuse(options.unreadable, (error as Error).message);
    }
  }
  const chain = await verifyChain(
    entries,
    options.publicKey === undefined ? {} : { publicKey: options.publicKey },
  );
  if (!chain.ok) refuse(options.unverifiable, chain.reason);
  if (entries.some((entry) => entry.workspace !== workspace))
    refuse("workspace_mismatch", path);
  if (entries.length === 0) refuse(options.unreadable, "empty section");
  if (options.replay === "journal") replayJournal(entries);
  return {
    entries,
    range: {
      first: entries[0]!.seq,
      last: entries[entries.length - 1]!.seq,
    },
    signed: options.publicKey !== undefined,
  };
}

/**
 * Replay every event through the transition tables. A signed journal that
 * cannot be replayed is evidence of nothing, so the bundle refuses it rather
 * than counting its lines.
 */
function replayJournal(entries: readonly JsonlEntry[]): void {
  const operationEvents: OperationEvent[] = [];
  const jobEvents: RecoveryJobEvent[] = [];
  for (const entry of entries) {
    const event = entry.body as { schema?: unknown };
    if (event.schema === "void.operation.v1") {
      try {
        validateTransition(operationEvents, entry.body as OperationEvent);
      } catch (error) {
        refuse("journal_invalid", (error as Error).message);
      }
      operationEvents.push(entry.body as OperationEvent);
    } else if (event.schema === "void.recovery-job.v1") {
      try {
        validateJobTransition(jobEvents, entry.body as RecoveryJobEvent);
      } catch (error) {
        refuse("journal_invalid", (error as Error).message);
      }
      jobEvents.push(entry.body as RecoveryJobEvent);
    } else refuse("journal_invalid", `entry ${entry.seq} is not a journal event`);
  }
}

/**
 * The vault inventory, taken from whichever store the state directory holds:
 * the SQLite vault that `reservedRecoveryVault` writes, or the digest named
 * files an older state still carries. Artifact bytes stay encrypted at rest,
 * so this is a manifest of what exists, not a copy of what is in it.
 */
export async function readVaultManifest(
  stateDir: string,
  workspace: string,
): Promise<VaultManifestSection> {
  const root = join(stateDir, "vault");
  const database = join(root, "vault.sqlite");
  const rootPresent = await lstat(root).then(
    (info) => {
      if (info.isSymbolicLink() || !info.isDirectory())
        refuse("vault_invalid", root);
      return true;
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!rootPresent)
    return {
      schema: VAULT_MANIFEST_SCHEMA,
      workspace,
      store: "absent",
      unsettled: 0,
      reservations: 0,
      artifacts: [],
    };
  await assertPrivateDirectoryPath(root, "recovery vault directory");
  const isFile = await lstat(database).then(
    (info) => {
      if (info.isSymbolicLink() || !info.isFile())
        refuse("vault_invalid", database);
      return true;
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (isFile) {
    await assertPrivateFilePath(database, "recovery vault database");
    for (const suffix of ["-journal", "-wal", "-shm"])
      await assertPrivateFileIfPresent(
        `${database}${suffix}`,
        "recovery vault SQLite sidecar",
      );
    const vault = new DatabaseSync(database, { readOnly: true });
    try {
      const artifacts = vault
        .prepare(
          "SELECT digest, content_digest, key_id, length(data) AS bytes, operation_id, slot FROM artifacts WHERE workspace=? ORDER BY digest",
        )
        .all(workspace)
        .map(vaultArtifact);
      const counted = vault
        .prepare("SELECT COUNT(*) AS count FROM reservations WHERE workspace=?")
        .get(workspace);
      if (
        typeof counted !== "object" ||
        counted === null ||
        !("count" in counted) ||
        typeof counted.count !== "number"
      )
        refuse("vault_invalid", "reservations");
      return {
        schema: VAULT_MANIFEST_SCHEMA,
        workspace,
        store: "sqlite",
        unsettled: 0,
        reservations: counted.count,
        artifacts,
      };
    } finally {
      vault.close();
    }
  }
  return legacyVaultManifest(root, workspace);
}

/** One artifacts row, checked field by field: a vault row is external state. */
function vaultArtifact(row: unknown): VaultArtifact {
  if (typeof row !== "object" || row === null) refuse("vault_invalid", "row");
  const { digest, content_digest, key_id, bytes, operation_id, slot } = row as Record<string, unknown>;
  if (
    typeof digest !== "string" ||
    typeof content_digest !== "string" ||
    typeof key_id !== "string" ||
    typeof bytes !== "number" ||
    !DIGEST.test(digest) ||
    !DIGEST.test(content_digest)
  )
    refuse("vault_invalid", String(digest));
  return {
    digest,
    contentDigest: content_digest,
    keyId: key_id,
    bytes,
    operationId: typeof operation_id === "string" ? operation_id : null,
    slot: typeof slot === "string" ? slot : null,
  };
}

async function legacyVaultManifest(
  root: string,
  workspace: string,
): Promise<VaultManifestSection> {
  const directory = join(root, workspace);
  const present = await lstat(directory).then(
    (info) => {
      if (info.isSymbolicLink() || !info.isDirectory())
        refuse("vault_invalid", directory);
      return true;
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!present)
    return {
      schema: VAULT_MANIFEST_SCHEMA,
      workspace,
      store: "absent",
      unsettled: 0,
      reservations: 0,
      artifacts: [],
    };
  await assertPrivateDirectoryPath(directory, "legacy vault workspace directory");
  const artifacts: VaultArtifact[] = [];
  let unsettled = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(".tmp-")) {
      const path = join(directory, item.name);
      if (!item.isFile()) refuse("vault_invalid", item.name);
      await assertPrivateFilePath(path, "legacy vault temporary file");
      unsettled += 1;
      continue;
    }
    if (!item.isFile() || !DIGEST.test(item.name))
      refuse("vault_invalid", item.name);
    const path = join(directory, item.name);
    await assertPrivateFilePath(path, "legacy vault artifact");
    const bytes = await readPrivateFile(path, "legacy vault artifact");
    artifacts.push({
      digest: item.name,
      contentDigest: item.name,
      keyId: "unknown",
      bytes: bytes.length,
      operationId: null,
      slot: null,
    });
  }
  artifacts.sort((left, right) => (left.digest < right.digest ? -1 : 1));
  return {
    schema: VAULT_MANIFEST_SCHEMA,
    workspace,
    store: "legacy-files",
    unsettled,
    reservations: 0,
    artifacts,
  };
}

export function operationStageNames(): readonly string[] {
  return Object.keys(operationStageTable);
}

export function terminalOperationStageNames(): readonly string[] {
  return operationStageNames().filter(
    (stage) => operationStageTable[stage as Stage].length === 0,
  );
}

export function jobStageNames(): readonly string[] {
  return Object.keys(jobStageTable);
}

export function terminalJobStageNames(): readonly string[] {
  return jobStageNames().filter(
    (stage) => jobStageTable[stage as RecoveryJobStage].length === 0,
  );
}

const transitionCount = (table: Readonly<Record<string, readonly string[]>>) =>
  Object.values(table).reduce((total, next) => total + next.length, 0);

export function capabilitySection(workspace: string): CapabilitySection {
  return {
    schema: CAPABILITY_SCHEMA,
    workspace,
    bundle: {
      schema: BUNDLE_SCHEMA,
      sections: [...BUNDLE_SECTIONS],
    },
    limits: {
      ledgerReadMaxBytes: LEDGER_READ_MAX_BYTES,
      ledgerReadMaxEntries: LEDGER_READ_MAX_ENTRIES,
    },
    operation: {
      stages: operationStageNames(),
      terminalStages: terminalOperationStageNames(),
      transitions: transitionCount(operationStageTable),
    },
    recoveryJob: {
      stages: jobStageNames(),
      terminalStages: terminalJobStageNames(),
      transitions: transitionCount(jobStageTable),
    },
    excluded: [
      "vault artifact bytes: listed by digest and length, recovery runs through the backup path",
      "signing key material: never part of a bundle",
      "the ledger and journal sections are verbatim copies of recorded operations and may contain prompts, document content and tool results; the bundle applies no redaction of its own",
    ],
  };
}

function assertDeclared(
  declared: BundleSection,
  entries: number,
  range: { first: number; last: number },
): void {
  if (declared.entries !== entries) refuse("section_count_mismatch", declared.name);
  if (declared.firstSeq !== range.first || declared.lastSeq !== range.last)
    refuse("sequence_range_mismatch", declared.name);
}

function parseManifest(bytes: Buffer): BundleManifest {
  const manifest = parseJson(bytes);
  if (
    manifest?.schema !== BUNDLE_SCHEMA ||
    typeof manifest.workspace !== "string" ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.ledgerHead !== "string" ||
    manifest.complete !== true ||
    !Array.isArray(manifest.sections)
  )
    refuse("bundle_invalid", "manifest");
  for (const item of manifest.sections) {
    if (
      typeof item !== "object" ||
      item === null ||
      !BUNDLE_SECTIONS.includes(item.name) ||
      typeof item.file !== "string" ||
      !Number.isInteger(item.entries) ||
      item.entries < 0 ||
      !Number.isInteger(item.bytes) ||
      item.bytes < 0 ||
      !DIGEST.test(item.sha256) ||
      (item.firstSeq !== null && !Number.isInteger(item.firstSeq)) ||
      (item.lastSeq !== null && !Number.isInteger(item.lastSeq))
    )
      refuse("bundle_invalid", "section entry");
  }
  return manifest as BundleManifest;
}

function parseJson(bytes: Uint8Array | string): Record<string, unknown> {
  const text =
    typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    refuse("bundle_invalid", "not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    refuse("bundle_invalid", "not an object");
  return parsed as Record<string, unknown>;
}

function parseJsonl(
  text: string,
  category: BundleCategory,
  path: string,
): JsonlEntry[] {
  const entries: JsonlEntry[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      refuse(category, `line ${index + 1} of ${path} is not JSON`);
    }
    if (typeof parsed !== "object" || parsed === null)
      refuse(category, `line ${index + 1} of ${path} is not an object`);
    entries.push(parsed as JsonlEntry);
  }
  return entries;
}

const jsonBytes = (value: unknown): Buffer =>
  Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Byte identical to what the section file holds, so digests recompute. */
const jsonlBytes = (entries: readonly JsonlEntry[]): Buffer =>
  Buffer.from(
    entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );

/** Human readable bundle summary for the CLI, one line per section.
 *
 * The block is contiguous and positionally meaningful: it opens with
 * `workspace`, ends with `complete true`, and callers read the first and last
 * lines. Any caller-supplied detail therefore belongs *inside* the block, one
 * line above the terminator, not before or after it. */
export function describeBundle(result: ExportBundleResult, verification?: string): string[] {
  return [
    `workspace ${result.workspace}`,
    `bundle ${result.bundleDir}`,
    ...result.manifest.sections.map(
      (item) =>
        `section ${item.name} entries=${item.entries} bytes=${item.bytes} sha256=${item.sha256}`,
    ),
    `ledger head ${result.manifest.ledgerHead}`,
    `manifest sha256 ${result.manifestDigest}`,
    ...(verification ? [verification] : []),
    "complete true",
  ];
}
