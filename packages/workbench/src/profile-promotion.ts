/**
 * The signed shape of a promoted agent profile, and its inverse (H4).
 *
 * A profile promotion is evidence, not authority. It is written through
 * `commitWorkspace` like every other record, it is bound to the digest the
 * operator approved, and it carries both snapshots so a third party can replay
 * it from the chain alone. Approval and rollback share this module on purpose:
 * when the two paths built their own records they drifted, and a rollback that
 * disagrees with its activation about what a change looks like restores the
 * wrong state while reporting success.
 *
 * Pure on purpose. Nothing here reads the ledger, writes a file, verifies a
 * signature or reaches `decide`. The workbench owns all of that, and this module
 * owns exactly one question: given the approval position, the parent bound and
 * the current store, what record may be written, and what record undoes it.
 *
 * Every check fails closed, and the reasons are the ones the design records:
 *
 * - **The digest is checked twice.** It must equal the approved proposal digest
 *   and the refinement digest. One of them alone would let a record claim an
 *   approval that was given for different text.
 * - **The chain position is checked at write time.** The approval names a
 *   position, and a chain that moved after the review is no longer the chain the
 *   operator read.
 * - **The parent bound is a ceiling, not a suggestion.** Tools, policy profile,
 *   turns and context are compared against the parent's, and the bound is
 *   recorded in the signed body so the operator surface can show why a tool was
 *   allowed. The policy profile is compared rather than rewritten: clamping it
 *   would write a snapshot that is not the one the digest covers, and an
 *   approval of text nobody reviewed is not an approval.
 * - **Collisions are refused by name.** A promoted profile may not take an id a
 *   built-in preset or a registered agent already answers to, and it may not
 *   take the one id this repository refuses outright.
 * - **Snapshots are re-scanned for secrets at write time.** A value that entered
 *   the workspace after the proposal was mined travels into the chain through the
 *   before snapshot, so the refusal is re-established here instead of inherited.
 *
 * Additive by construction: the record is the same `{ digest, changes }` body
 * the existing replay already reads, with `atSeq` and `parentBound` added. A
 * chain written before this module existed replays through the legacy
 * `harnessRefinement.profiles` fallback and is untouched by anything here.
 */

import { validateAgentProfile, type AgentProfile } from "./agents.ts";
import { BASE_SYSTEM_PROMPT_ID } from "./refine-pass.ts";

/** The lifecycle event an activation writes when it carries profile changes. */
export const PROFILE_PROMOTED_EVENT = "profile:promoted";
/** The lifecycle event a rollback writes when it restores profile state. */
export const PROFILE_ROLLED_BACK_EVENT = "profile:rolled-back";

/**
 * Ids no promoted profile may take, whatever the store holds.
 *
 * `base_system_prompt` is refused here for the reason `refine-pass.ts` refuses
 * it: a harness that can rewrite the standing instructions has no boundary left
 * to enforce, and a profile is a second way to write one.
 */
export const RESERVED_PROFILE_IDS: readonly string[] = Object.freeze([
  BASE_SYSTEM_PROMPT_ID,
]);

const DIGEST = /^[a-f0-9]{64}$/;

const PROFILE_ACTIONS = ["create", "update", "delete"] as const;
type ProfileAction = (typeof PROFILE_ACTIONS)[number];

/**
 * The secret shapes the refinement path already refuses.
 *
 * Copied from `index.ts` rather than imported: `index.ts` is the module that
 * will import this one, so importing back would make a cycle, and the patterns
 * are the refusal itself rather than a helper with its own behaviour. A change
 * to either list is a change to the refusal and belongs in both.
 */
const PROFILE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;"']+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /--(?:api[_-]?key|token|password|secret|key)(?:=|\s+)\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{10,})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

/**
 * Whether serialized profile state carries a secret-shaped value.
 *
 * A pattern is refused wherever it came from, and a configured value is refused
 * when it appears verbatim. The second half is why this runs at write time: the
 * operator's secrets are read from the environment when the record is written,
 * not when the proposal was mined.
 */
export function containsSecretMaterial(
  text: string,
  knownSecrets: readonly string[] = [],
): boolean {
  return (
    PROFILE_SECRET_PATTERNS.some((pattern) => pattern.test(text)) ||
    knownSecrets.some((secret) => secret.length >= 4 && text.includes(secret))
  );
}

/** One id's before and after snapshot. `before` is null for a create and
 * `after` is null for a delete, which is the shape the existing replay reads. */
export type ProfileChange = {
  readonly id: string;
  readonly before: AgentProfile | null;
  readonly after: AgentProfile | null;
};

/**
 * The parent's ceiling, recorded in the signed body.
 *
 * The operator surface shows it beside every edit, because "this tool is
 * allowed" is not evidence on its own: what makes it evidence is that the
 * parent could reach it too.
 */
export type ParentBound = {
  readonly allowedTools: readonly string[];
  readonly policyProfile: string;
  readonly maxTurns: number;
  readonly maxContextTokens: number;
};

/** The activation record, as written into the signed chain. */
export type HarnessProfileRecord = {
  readonly digest: string;
  readonly atSeq: number;
  readonly parentBound?: ParentBound;
  readonly changes: readonly ProfileChange[];
};

/**
 * The rollback record.
 *
 * `approvedBy: "rollback"` is the same label entry rollback writes, for the same
 * reason: the operator rolled back a digest without reading the restored text
 * again, so the restored snapshot must not become operator written text.
 * `restoredIds` names what came back and `removedIds` names what the promotion
 * created and this rollback deletes, so the record says which promotion was
 * reversed and what that did.
 */
export type HarnessProfileRollbackRecord = {
  readonly digest: string;
  readonly atSeq: number;
  readonly changes: readonly ProfileChange[];
  readonly restoredIds: readonly string[];
  readonly removedIds: readonly string[];
  readonly approvedBy: "rollback";
};

/**
 * One subagent edit, read structurally.
 *
 * Deliberately not `RefinementEdit`: a caller can pass the `profileEdits` an
 * approved proposal produced without importing that type here, and this module
 * then has no opinion about titles, content or provenance, which are entry
 * concerns rather than profile ones.
 */
export type ProfileEditInput = {
  readonly action: ProfileAction;
  readonly id?: string;
  readonly profile?: AgentProfile;
};

export type ProfilePromotionRequest = {
  /** The digest being signed. */
  readonly digest: string;
  /** The digest the operator approved in the pending proposal. */
  readonly approvedDigest: string;
  /** The digest the refinement record carries. */
  readonly refinementDigest: string;
  /** The chain position the approval was given at. */
  readonly atSeq: number;
  /** The chain length at write time, which must still equal `atSeq`. */
  readonly chainLength: number;
  readonly parent: ParentBound;
  readonly edits: readonly ProfileEditInput[];
  /** The store as the chain currently replays it. */
  readonly activeProfiles: readonly AgentProfile[];
  /** Ids a preset or a registered agent already answers to. */
  readonly builtinProfileIds: readonly string[];
  /** Values read from the environment and configuration at write time. */
  readonly knownSecrets?: readonly string[];
};

export type ProfileRollbackRequest = {
  /** The digest being rolled back. */
  readonly digest: string;
  /** The signed activation whose changes are inverted. */
  readonly activation: HarnessProfileRecord;
  /** The store as the chain currently replays it. */
  readonly activeProfiles: readonly AgentProfile[];
  readonly knownSecrets?: readonly string[];
};

export type ProfilePromotionReviewEdit = {
  readonly id: string;
  readonly action: ProfileAction;
  readonly before: AgentProfile | null;
  readonly after: AgentProfile | null;
};

/** What the operator surface receives for one promotion. */
export type ProfilePromotionReview = {
  readonly digest: string;
  readonly atSeq: number;
  readonly parentBound: ParentBound | null;
  readonly edits: readonly ProfilePromotionReviewEdit[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChainSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function requireDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST.test(value))
    throw new Error("The profile digest must be a lowercase hex sha256 digest.");
  return value;
}

function malformedActivation(): Error {
  return new Error("The signed profile activation is malformed.");
}

/** A copy, so a caller cannot reach into the record through the object it
 * handed over, and the replay cannot be changed by mutating a returned profile. */
function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    id: profile.id,
    name: profile.name,
    systemPrompt: profile.systemPrompt,
    allowedTools: [...profile.allowedTools],
    policyProfile: profile.policyProfile,
    maxTurns: profile.maxTurns,
    maxContextTokens: profile.maxContextTokens,
  };
}

function cloneSnapshot(snapshot: AgentProfile | null): AgentProfile | null {
  return snapshot === null ? null : cloneProfile(snapshot);
}

/**
 * Whether two snapshots are the same profile.
 *
 * Compared field by field rather than by serialization: the key order of a
 * signed body is not a fact about the profile, and a re-encoded record that
 * carries the same profile must still replay.
 */
function sameProfile(a: AgentProfile | null, b: AgentProfile | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.systemPrompt === b.systemPrompt &&
    a.policyProfile === b.policyProfile &&
    a.maxTurns === b.maxTurns &&
    a.maxContextTokens === b.maxContextTokens &&
    a.allowedTools.length === b.allowedTools.length &&
    a.allowedTools.every((tool, index) => tool === b.allowedTools[index])
  );
}

function freezeChange(
  id: string,
  before: AgentProfile | null,
  after: AgentProfile | null,
): ProfileChange {
  return Object.freeze({
    id,
    before: cloneSnapshot(before),
    after: cloneSnapshot(after),
  });
}

function freezeChanges(changes: readonly ProfileChange[]): readonly ProfileChange[] {
  return Object.freeze([...changes]);
}

/**
 * Read and check the parent's ceiling.
 *
 * Refused rather than repaired when malformed: this value is written into the
 * signed body as the reason a promoted tool was allowed, so a bound that does
 * not describe a run is worse than no record at all. The tools are deduplicated
 * and sorted so two promotions of the same parent record the same bound.
 */
function readParentBound(value: unknown): ParentBound {
  if (!isRecord(value)) throw new Error("The parent bound is malformed.");
  const tools = value.allowedTools;
  if (
    !Array.isArray(tools) ||
    tools.length > 200 ||
    tools.some((tool) => typeof tool !== "string" || !tool.length)
  )
    throw new Error("The parent bound is malformed.");
  if (typeof value.policyProfile !== "string" || !value.policyProfile.trim())
    throw new Error("The parent bound is malformed.");
  if (!isChainSequence(value.maxTurns) || value.maxTurns === 0)
    throw new Error("The parent bound is malformed.");
  if (!isChainSequence(value.maxContextTokens) || value.maxContextTokens === 0)
    throw new Error("The parent bound is malformed.");
  return Object.freeze({
    allowedTools: Object.freeze([...new Set(tools as string[])].sort()),
    policyProfile: value.policyProfile.trim(),
    maxTurns: value.maxTurns,
    maxContextTokens: value.maxContextTokens,
  });
}

/**
 * Read one signed snapshot.
 *
 * Only `null` is the create or delete sentinel. A missing field is malformed
 * rather than read as null, because "the record does not say" and "the record
 * says nothing was there" are different claims and a replay that confused them
 * would restore a state the operator never approved.
 */
function readSnapshot(value: unknown, id: string): AgentProfile | null {
  if (value === null) return null;
  const profile = validateAgentProfile(value, "signed profile snapshot");
  if (profile.id !== id)
    throw new Error("The signed profile change id does not match its snapshot.");
  return profile;
}

/**
 * Read an activation record from the chain.
 *
 * The chain is data: the type says what a record should be, and this says what
 * the record actually is before anything is inverted or replayed from it.
 */
function readActivation(value: unknown): {
  readonly digest: string;
  readonly atSeq: number;
  readonly parentBound: ParentBound | null;
  readonly changes: readonly ProfileChange[];
} {
  if (!isRecord(value)) throw malformedActivation();
  const digest = value.digest;
  if (typeof digest !== "string" || !DIGEST.test(digest))
    throw new Error("The signed profile digest is malformed.");
  if (!isChainSequence(value.atSeq)) throw malformedActivation();
  if (!Array.isArray(value.changes)) throw malformedActivation();
  const parentBound =
    value.parentBound === undefined ? null : readParentBound(value.parentBound);
  const changes = value.changes.map((raw) => {
    if (!isRecord(raw)) throw malformedActivation();
    if (typeof raw.id !== "string" || !raw.id)
      throw new Error("The signed profile change has no id.");
    return freezeChange(
      raw.id,
      readSnapshot(raw.before, raw.id),
      raw.after === null ? null : readSnapshot(raw.after, raw.id),
    );
  });
  return { digest, atSeq: value.atSeq, parentBound, changes: freezeChanges(changes) };
}

function actionOf(change: ProfileChange): ProfileAction {
  if (change.before === null) return "create";
  if (change.after === null) return "delete";
  return "update";
}

/**
 * Build the activation record, or refuse the promotion.
 *
 * The order of the checks is the order of the reasons: the digest says which
 * approval is being spent, the chain position says the approval still applies,
 * the parent bound says what authority the promotion may reach, and only then is
 * a profile read. A refusal therefore names the first thing that is wrong with
 * the operation rather than the first thing that is wrong with a profile inside
 * an operation that was never allowed to run.
 */
export function prepareProfilePromotion(
  request: ProfilePromotionRequest,
): HarnessProfileRecord {
  const digest = requireDigest(request.digest);
  if (digest !== request.approvedDigest)
    throw new Error("The profile promotion digest does not match the approved proposal.");
  if (digest !== request.refinementDigest)
    throw new Error("The profile promotion digest does not match its refinement.");
  if (!isChainSequence(request.atSeq))
    throw new Error("The approval position is not a chain sequence.");
  if (request.chainLength !== request.atSeq)
    throw new Error(
      "The chain moved after the proposal was reviewed. Ask for a new proposal.",
    );
  const parentBound = readParentBound(request.parent);
  if (request.edits.length === 0)
    throw new Error("The approved proposal has no supported edit to activate.");

  const active = new Map(request.activeProfiles.map((profile) => [profile.id, profile]));
  const parentTools = new Set(parentBound.allowedTools);
  const builtin = new Set(request.builtinProfileIds);
  const knownSecrets = request.knownSecrets ?? [];
  const seen = new Set<string>();
  const changes: ProfileChange[] = [];

  for (const edit of request.edits) {
    if (!(PROFILE_ACTIONS as readonly string[]).includes(edit.action))
      throw new Error(
        `Unsupported subagent profile action: expected one of ${PROFILE_ACTIONS.join(", ")}.`,
      );
    const id = edit.profile?.id ?? edit.id;
    if (typeof id !== "string" || !id.trim())
      throw new Error("A subagent profile edit needs an id.");
    if (seen.has(id))
      throw new Error(`Only one subagent profile edit per id is allowed: ${id}.`);
    seen.add(id);
    const before = active.get(id) ?? null;
    if (edit.action === "create" && before)
      throw new Error(`Workspace profile ${id} already exists.`);
    if (edit.action !== "create" && !before)
      throw new Error(`Workspace profile ${id} does not exist.`);
    if (edit.action === "delete") {
      if (edit.profile !== undefined)
        throw new Error("A subagent delete must not carry a profile.");
      changes.push(freezeChange(id, before, null));
      continue;
    }
    if (edit.profile === undefined)
      throw new Error("A subagent create or update must carry a profile.");
    const profile = validateAgentProfile(edit.profile, "subagent profile");
    if (edit.id !== undefined && edit.id !== profile.id)
      throw new Error("The subagent edit id must match its profile id.");
    if (builtin.has(profile.id))
      throw new Error(`Workspace profile ${profile.id} collides with an existing agent.`);
    if (RESERVED_PROFILE_IDS.includes(profile.id))
      throw new Error(`Workspace profile ${profile.id} is reserved.`);
    if (profile.allowedTools.some((tool) => !parentTools.has(tool)))
      throw new Error(`Subagent profile ${profile.id} exceeds the parent tool scope.`);
    if (profile.policyProfile !== parentBound.policyProfile)
      throw new Error(
        `Subagent profile ${profile.id} exceeds the parent run bounds or policy: exceeds the parent policy profile.`,
      );
    if (profile.maxTurns > parentBound.maxTurns)
      throw new Error(
        `Subagent profile ${profile.id} exceeds the parent run bounds or policy: exceeds the parent turn bound.`,
      );
    if (profile.maxContextTokens > parentBound.maxContextTokens)
      throw new Error(
        `Subagent profile ${profile.id} exceeds the parent run bounds or policy: exceeds the parent context bound.`,
      );
    changes.push(freezeChange(profile.id, before, profile));
  }

  const record: HarnessProfileRecord = Object.freeze({
    digest,
    atSeq: request.atSeq,
    parentBound,
    changes: freezeChanges(changes),
  });
  // Both snapshots, not only the proposed one. The before snapshot came out of
  // the store, and a secret that entered the workspace after the proposal was
  // mined is exactly what a write time scan catches and an inherited guarantee
  // does not.
  if (containsSecretMaterial(JSON.stringify(record.changes), knownSecrets))
    throw new Error(
      "The profile promotion carries secret-like text and cannot be promoted.",
    );
  return record;
}

/**
 * Build the record that undoes an activation, or refuse the rollback.
 *
 * The active store must still match the signed `after` for every changed id. A
 * drift is refused rather than tolerated: the inverse restores `before`, and if
 * the store has moved since the promotion then restoring `before` would discard
 * whatever moved it, under a record that claims to undo something else.
 */
export function prepareProfileRollback(
  request: ProfileRollbackRequest,
): HarnessProfileRollbackRecord {
  const digest = requireDigest(request.digest);
  const activation = readActivation(request.activation);
  if (digest !== activation.digest)
    throw new Error("The rollback digest does not match the signed profile activation.");
  if (activation.changes.length === 0)
    throw new Error("The signed profile activation carries no profile change to roll back.");

  const active = new Map(request.activeProfiles.map((profile) => [profile.id, profile]));
  const knownSecrets = request.knownSecrets ?? [];
  const changes: ProfileChange[] = [];
  const restoredIds: string[] = [];
  const removedIds: string[] = [];
  for (const change of activation.changes) {
    const current = active.get(change.id) ?? null;
    if (!sameProfile(current, change.after))
      throw new Error("The active profile no longer matches the signed activation.");
    if (change.before === null) removedIds.push(change.id);
    else restoredIds.push(change.id);
    changes.push(freezeChange(change.id, change.after, change.before));
  }

  const record: HarnessProfileRollbackRecord = Object.freeze({
    digest,
    atSeq: activation.atSeq,
    changes: freezeChanges(changes),
    restoredIds: Object.freeze(restoredIds),
    removedIds: Object.freeze(removedIds),
    approvedBy: "rollback",
  });
  // Re-scanned, not inherited: the restored text was written under the secrets
  // known when it entered the chain, and this is the second time it travels.
  if (containsSecretMaterial(JSON.stringify(record.changes), knownSecrets))
    throw new Error("The profile rollback carries secret-like text and cannot be recorded.");
  return record;
}

/**
 * Replay activation and rollback records, in chain order, into the store.
 *
 * The records arrive from a signed ledger, so the parameter is `unknown`: the
 * type says what a record should be, and this checks what it is. A record whose
 * `before` disagrees with the state the earlier records produced is refused
 * rather than applied, because that is the shape a rewritten or reordered chain
 * takes, and a replay that accepted it would report a store nobody signed.
 *
 * `atSeq` is optional so a chain written before this module existed, whose
 * records carry only `{ digest, changes }`, still replays. Records that do carry
 * a position may not go backwards, which is how an out of order hand-over is
 * caught; a rollback legitimately repeats its activation's position.
 */
export function replayPromotedProfiles(records: readonly unknown[]): AgentProfile[] {
  const profiles = new Map<string, AgentProfile>();
  let lastSeq: number | null = null;
  for (const raw of records) {
    if (!isRecord(raw)) throw malformedActivation();
    if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest))
      throw new Error("The signed profile digest is malformed.");
    if (raw.atSeq !== undefined && raw.atSeq !== null) {
      if (!isChainSequence(raw.atSeq)) throw malformedActivation();
      if (lastSeq !== null && raw.atSeq < lastSeq)
        throw new Error("The signed profile activations are not in chain order.");
      lastSeq = raw.atSeq;
    }
    if (!Array.isArray(raw.changes)) throw malformedActivation();
    for (const rawChange of raw.changes) {
      if (!isRecord(rawChange)) throw new Error("The signed profile change is malformed.");
      if (typeof rawChange.id !== "string" || !rawChange.id)
        throw new Error("The signed profile change has no id.");
      const current = profiles.get(rawChange.id) ?? null;
      if (!sameProfile(current, readSnapshot(rawChange.before, rawChange.id)))
        throw new Error("The signed profile history does not replay consistently.");
      if (rawChange.after === null) {
        profiles.delete(rawChange.id);
        continue;
      }
      profiles.set(rawChange.id, readSnapshot(rawChange.after, rawChange.id)!);
    }
  }
  return [...profiles.values()].map(cloneProfile);
}

/**
 * What the operator surface receives for one promotion.
 *
 * Structured rather than only formatted, because an approval the operator cannot
 * read is not an approval and a surface that receives pre-rendered text can only
 * display it. Every edit carries the before and after snapshot and the bound is
 * carried once, so "what will this change" and "why is that tool allowed" are
 * both answerable from the record alone.
 */
export function reviewProfilePromotion(
  record: HarnessProfileRecord,
): ProfilePromotionReview {
  const activation = readActivation(record);
  return Object.freeze({
    digest: activation.digest,
    atSeq: activation.atSeq,
    parentBound: activation.parentBound,
    edits: Object.freeze(
      activation.changes.map((change) =>
        Object.freeze({
          id: change.id,
          action: actionOf(change),
          before: cloneSnapshot(change.before),
          after: cloneSnapshot(change.after),
        }),
      ),
    ),
  });
}

function describeBound(bound: ParentBound | null): string {
  if (bound === null) return "not recorded";
  return [
    `policy=${bound.policyProfile}`,
    `turns=${bound.maxTurns}`,
    `context tokens=${bound.maxContextTokens}`,
    `tools=${bound.allowedTools.join(", ") || "none"}`,
  ].join(" ");
}

function describeSnapshot(profile: AgentProfile | null, absent: string): string {
  if (profile === null) return absent;
  return [
    profile.name,
    `policy=${profile.policyProfile}`,
    `turns=${profile.maxTurns}`,
    `context tokens=${profile.maxContextTokens}`,
    `tools=${profile.allowedTools.join(", ") || "none"}`,
    // Serialized so a multi line prompt stays on one line and its whitespace is
    // visible: the operator is reading the text that will be signed.
    `system prompt=${JSON.stringify(profile.systemPrompt)}`,
  ].join(" | ");
}

/**
 * Render one promotion for a plain text surface.
 *
 * ASCII only, one fact per line, because this is read in a terminal and compared
 * against the digest by eye. The structured form is `reviewProfilePromotion`;
 * this is the same evidence for a surface that has no widgets.
 */
export function describeProfilePromotionReview(record: HarnessProfileRecord): string {
  const review = reviewProfilePromotion(record);
  const lines = [
    `profile promotion ${review.digest} at chain position ${review.atSeq}`,
    `parent bound: ${describeBound(review.parentBound)}`,
  ];
  review.edits.forEach((edit, index) => {
    lines.push(`edit ${index + 1} ${edit.action} ${edit.id}`);
    lines.push(`  before: ${describeSnapshot(edit.before, "new")}`);
    lines.push(`  after: ${describeSnapshot(edit.after, "removed")}`);
  });
  return lines.join("\n");
}
