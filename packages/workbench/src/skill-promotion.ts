/**
 * Markdown skill promotion on the signed chain (H4b).
 *
 * The H4 judge froze the subagent profile store and left one question open: does
 * a markdown skill share that record kind, or get its own? It gets its own. A
 * profile is a spawnable agent with tools, bounds and a policy profile; a skill is
 * text that reaches a prompt. Filing both under `harnessProfile` would mean one
 * replay reading two shapes and one review surface showing two different kinds of
 * decision as if they were one.
 *
 * Three properties are load-bearing, and each one is here because the opposite is
 * the easy thing to build.
 *
 * **A promotion is bound, not described.** The record carries the approved
 * proposal digest and the chain position the approval was given at, and the write
 * is refused unless both still match. A record that only names a digest can be
 * replayed against a chain that moved underneath it.
 *
 * **The record carries both snapshots.** `before` and `after` travel with the
 * promotion, so a rollback restores text the chain already holds instead of
 * reconstructing it from whatever the workspace reads later. That is the same
 * shape the profile path uses, and it is why a rollback can be checked against
 * the active state instead of trusted.
 *
 * **Nothing here is authority.** A promoted skill never reaches `decide`, policy,
 * permissions, approvals or the tool catalog. The only rendering is
 * `formatPromotedSkillsForPrompt`, which labels every skill as approved guidance
 * that is not policy or tool authority and stays inside the caller's character
 * budget, which is the operator's existing prompt ceiling. A learned skill is
 * never written as a file into `.agents/skills`: that path is the operator's own
 * lock-listed source in `project-skills.ts`, and a promotion whose id collides
 * with one is refused by name.
 *
 * Pure on purpose. The workbench verifies the chain, signs the record and
 * persists it; this module decides what a promotion may carry and what the chain
 * replays to.
 */

export const SKILL_PROMOTION_LIMITS = {
  id: 64,
  title: 120,
  description: 400,
  body: 8_000,
  changesPerProposal: 4,
  activeSkills: 16,
} as const;

/** The lifecycle event an approval writes when it carries skill changes. */
export const SKILL_PROMOTED_EVENT = "skill:promoted";
/** The lifecycle event a rollback writes when it restores skill state. */
export const SKILL_ROLLED_BACK_EVENT = "skill:rolled-back";

/** A skill as the chain holds it: the text an operator approved, and nothing
 * else. No digest per field, because the record's digest covers all of it. */
export type PromotedSkill = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
};

/** One change as the signed record carries it. `before` is null for a create and
 * `after` is null for a delete. */
export type SkillChange = {
  readonly id: string;
  readonly before: PromotedSkill | null;
  readonly after: PromotedSkill | null;
};

/** A change as a proposal carries it, before the chain supplies the other side. */
export type ParsedSkillChange =
  | { readonly action: "delete"; readonly id: string }
  | { readonly action: "create" | "update"; readonly skill: PromotedSkill };

const DIGEST = /^[a-f0-9]{64}$/;
/** Lowercase kebab case, which is also the shape a prompt line and a review line
 * can carry without quoting. */
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A body is Markdown, so tab, newline and carriage return are text. Every other
 * control character is refused, as `project-skills.ts` refuses it in a file. */
const BODY_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A title and a description are one line each: a newline in either would break
 * the prompt block and the review line that carry them. */
const LINE_CONTROLS = /[\u0000-\u001f\u007f]/;

/**
 * The same patterns `index.ts` applies to a refinement proposal before it is
 * signed.
 *
 * Duplicated rather than imported: `index.ts` is the workbench entry point and
 * imports this module's neighbours, so importing it from a leaf module would
 * close a cycle for seven regular expressions. The two lists must stay identical;
 * a later slice that exports one helper from a leaf module replaces this list
 * instead of extending it.
 */
const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*["']?[^\s,;"']+/i,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /--(?:api[_-]?key|token|password|secret|key)(?:=|\s+)\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{10,})\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function malformed(): Error {
  return new Error("The signed skill record is malformed.");
}

/** A lone surrogate cannot survive a UTF-8 round trip, and the chain stores the
 * bytes an operator approved rather than a string the runtime repaired. */
function checkUtf8(value: string, field: string): void {
  if (Buffer.from(value, "utf8").toString("utf8") !== value)
    throw new Error(`A skill ${field} must be valid UTF-8.`);
}

function checkSkillId(id: string): void {
  if (id.length > SKILL_PROMOTION_LIMITS.id || !SKILL_ID.test(id))
    throw new Error(
      `A skill id must be lowercase kebab case and at most ${SKILL_PROMOTION_LIMITS.id} characters.`,
    );
}

function checkLine(value: string, field: "title" | "description", limit: number): void {
  checkUtf8(value, field);
  if (LINE_CONTROLS.test(value))
    throw new Error(`A skill ${field} must not contain control characters.`);
  if (value.length > limit)
    throw new Error(`A skill ${field} exceeds ${limit} characters.`);
}

/** The whole skill, checked. Called by the parser and again by the write path,
 * because a caller can hand-build a change object the parser never saw. */
function checkSkill(skill: PromotedSkill): void {
  checkSkillId(skill.id);
  if (skill.title.trim() === "") throw new Error("A skill title must not be empty.");
  checkLine(skill.title, "title", SKILL_PROMOTION_LIMITS.title);
  checkLine(skill.description, "description", SKILL_PROMOTION_LIMITS.description);
  checkUtf8(skill.body, "body");
  if (BODY_CONTROLS.test(skill.body))
    throw new Error("A skill body must not contain control characters.");
  if (skill.body.trim() === "") throw new Error("A skill body must not be empty.");
  if (skill.body.length > SKILL_PROMOTION_LIMITS.body)
    throw new Error(`A skill body exceeds ${SKILL_PROMOTION_LIMITS.body} characters.`);
}

function looksSecret(value: string, knownSecrets: readonly string[]): boolean {
  return (
    SECRET_PATTERNS.some((pattern) => pattern.test(value)) ||
    knownSecrets.some((secret) => secret.length >= 4 && value.includes(secret))
  );
}

/**
 * The text is scanned before it reaches the chain, and the scan covers the
 * snapshot a rollback would restore as well as the one being promoted: the set of
 * known secrets can grow between the two writes, and a guarantee inherited rather
 * than re-established is not a guarantee.
 */
function scanSkill(skill: PromotedSkill, knownSecrets: readonly string[]): void {
  for (const value of [skill.title, skill.description, skill.body])
    if (looksSecret(value, knownSecrets))
      throw new Error(`Skill ${skill.id} contains secret-like text and was not promoted.`);
}

function sameSkill(a: PromotedSkill, b: PromotedSkill): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.body === b.body
  );
}

function sameSnapshot(a: PromotedSkill | null, b: PromotedSkill | null): boolean {
  if (a === null || b === null) return a === b;
  return sameSkill(a, b);
}

function bySkillId(a: PromotedSkill, b: PromotedSkill): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Parse one change out of a proposal.
 *
 * The labels are trimmed because they are labels; the body is kept verbatim
 * because it is the text the operator approves, and a promotion that quietly
 * rewrote it would sign something nobody read.
 */
export function parseSkillProposalChange(value: unknown): ParsedSkillChange {
  const raw = object(value);
  if (raw === null) throw new Error("A skill change must be an object.");
  const action = text(raw.action);
  if (action === "delete") {
    const id = text(raw.id);
    checkSkillId(id);
    return { action: "delete", id };
  }
  if (action !== "create" && action !== "update")
    throw new Error("Unsupported skill change action: expected create, update or delete.");
  const skill: PromotedSkill = {
    id: text(raw.id),
    title: text(raw.title).trim(),
    description: text(raw.description).trim(),
    body: text(raw.body),
  };
  checkSkill(skill);
  return { action, skill };
}

export type SkillPromotionRequest = {
  /** The digest of the proposal that is being promoted. */
  readonly digest: string;
  /** The digest the operator approved. Promotion is refused unless it is the
   * same value, which is the whole of the approval. */
  readonly approvedDigest: string;
  /** The chain position the approval was given at. */
  readonly atSeq: number;
  /** The chain length at write time, which must still equal `atSeq`. */
  readonly chainLength: number;
  readonly changes: readonly ParsedSkillChange[];
  /** The learned skills the workspace reads now, replayed from the chain. */
  readonly active?: readonly PromotedSkill[];
  /** Project skill ids from `skills-lock.json`, when the caller has them. */
  readonly projectSkillIds?: readonly string[];
  /** Secret values this workspace knows about, as the refinement path gathers
   * them. */
  readonly knownSecrets?: readonly string[];
};

export type SkillPromotionRecord = {
  readonly digest: string;
  readonly atSeq: number;
  readonly changes: readonly SkillChange[];
};

/**
 * Build the record an approval writes.
 *
 * Every refusal here is a case where a promotion would carry something the
 * operator's approval does not cover: another digest, a chain that moved, a diff
 * too long to read, an id that belongs to a project skill, text that looks like a
 * secret, a change that is not a change, or a workspace that would read more
 * skills than the cap allows.
 */
export function prepareSkillPromotion(request: SkillPromotionRequest): SkillPromotionRecord {
  if (!DIGEST.test(request.digest))
    throw new Error("A skill promotion needs the 64-hex digest of the proposal it promotes.");
  if (!DIGEST.test(request.approvedDigest) || request.approvedDigest !== request.digest)
    throw new Error("The approved digest does not match the skill proposal digest.");
  if (!Number.isInteger(request.atSeq) || request.atSeq < 0)
    throw new Error("A skill promotion needs the non-negative atSeq it was approved at.");
  if (!Number.isInteger(request.chainLength) || request.chainLength !== request.atSeq)
    throw new Error(
      `The chain has moved since the skill proposal was read: ${request.chainLength} entries, approved at ${request.atSeq}.`,
    );
  if (request.changes.length === 0)
    throw new Error("A skill promotion needs at least one change.");
  if (request.changes.length > SKILL_PROMOTION_LIMITS.changesPerProposal)
    throw new Error(
      `A skill promotion carries at most ${SKILL_PROMOTION_LIMITS.changesPerProposal} changes.`,
    );

  const seen = new Set<string>();
  for (const change of request.changes) {
    const id = change.action === "delete" ? change.id : change.skill.id;
    if (seen.has(id)) throw new Error(`Duplicate skill ${id} in one promotion.`);
    seen.add(id);
  }

  const projectIds = new Set(request.projectSkillIds ?? []);
  const knownSecrets = request.knownSecrets ?? [];
  const active = new Map((request.active ?? []).map((item) => [item.id, item]));
  const changes: SkillChange[] = [];

  for (const change of request.changes) {
    const id = change.action === "delete" ? change.id : change.skill.id;
    checkSkillId(id);
    if (projectIds.has(id))
      throw new Error(
        `Skill ${id} is a project skill id; a learned skill cannot take the operator's own file.`,
      );

    if (change.action === "delete") {
      const before = active.get(id);
      if (before === undefined) throw new Error(`No learned skill ${id} is active to delete.`);
      scanSkill(before, knownSecrets);
      active.delete(id);
      changes.push({ id, before, after: null });
      continue;
    }

    checkSkill(change.skill);
    scanSkill(change.skill, knownSecrets);
    const before = active.get(id) ?? null;
    if (change.action === "create" && before !== null)
      throw new Error(`Skill ${id} is already active; an update replaces it.`);
    if (change.action === "update") {
      if (before === null) throw new Error(`No learned skill ${id} is active to update.`);
      if (sameSkill(before, change.skill))
        throw new Error(`The update to skill ${id} changes nothing.`);
      scanSkill(before, knownSecrets);
    }
    active.set(id, change.skill);
    changes.push({ id, before, after: change.skill });
  }

  if (active.size > SKILL_PROMOTION_LIMITS.activeSkills)
    throw new Error(
      `A workspace reads at most ${SKILL_PROMOTION_LIMITS.activeSkills} learned skills.`,
    );
  return { digest: request.digest, atSeq: request.atSeq, changes };
}

export type SkillRollbackRequest = {
  /** The digest of the promotion being undone. */
  readonly digest: string;
  /** The position that promotion was approved at. */
  readonly atSeq: number;
  /** The signed changes of that promotion. */
  readonly changes: readonly SkillChange[];
  /** The learned skills the workspace reads now. */
  readonly active?: readonly PromotedSkill[];
};

export type SkillRollbackRecord = {
  readonly digest: string;
  readonly atSeq: number;
  /** Not "operator". The operator rolled back a digest without reading the
   * restored text again, so the restored text is not a fresh instruction. */
  readonly approvedBy: "rollback";
  readonly changes: readonly SkillChange[];
  /** The ids whose earlier version came back. A rollback of a create restores
   * nothing, so it names nothing. */
  readonly restoredIds: readonly string[];
};

/**
 * Build the inverse of a promotion.
 *
 * The active skill must be exactly the text the promotion signed. That check is
 * what makes a rollback a fact rather than a reconstruction: if something else
 * changed the skill since, restoring the old text would silently discard that
 * change.
 */
export function prepareSkillRollback(request: SkillRollbackRequest): SkillRollbackRecord {
  if (!DIGEST.test(request.digest))
    throw new Error("A skill rollback needs the 64-hex digest of the promotion it undoes.");
  if (!Number.isInteger(request.atSeq) || request.atSeq < 0)
    throw new Error("A skill rollback needs the non-negative atSeq of the promotion it undoes.");
  if (request.changes.length === 0)
    throw new Error("A skill rollback needs at least one change to invert.");

  const active = new Map((request.active ?? []).map((item) => [item.id, item]));
  const changes: SkillChange[] = [];
  const restoredIds: string[] = [];

  for (const change of request.changes) {
    checkSkillId(change.id);
    if (change.before === null && change.after === null) throw malformed();
    if (change.before !== null && change.before.id !== change.id) throw malformed();
    if (change.after !== null && change.after.id !== change.id) throw malformed();
    const current = active.get(change.id);
    if (change.after === null) {
      if (current !== undefined)
        throw new Error(`Skill ${change.id} is active, so this promotion did not delete it.`);
    } else if (current === undefined) {
      throw new Error(`No learned skill ${change.id} is active to roll back.`);
    } else if (!sameSkill(current, change.after)) {
      throw new Error(
        `The active skill ${change.id} does not match the text this promotion signed.`,
      );
    }
    changes.push({ id: change.id, before: change.after, after: change.before });
    if (change.before !== null) restoredIds.push(change.id);
    if (change.before === null) active.delete(change.id);
    else active.set(change.id, change.before);
  }
  return {
    digest: request.digest,
    atSeq: request.atSeq,
    approvedBy: "rollback",
    changes,
    restoredIds,
  };
}

/** An entry as this module reads it. `seq` is required on a skill record: a
 * record that cannot be placed in order cannot be replayed. */
export type SkillChainEntry = { readonly body: unknown; readonly seq?: number };

export type ReplayedSkills = {
  readonly byId: ReadonlyMap<string, PromotedSkill>;
  /** Sorted by id, so two runs over one chain produce the same list. */
  readonly skills: readonly PromotedSkill[];
};

function promotedSkill(raw: unknown): PromotedSkill {
  const value = object(raw);
  if (value === null) throw malformed();
  const skill: PromotedSkill = {
    id: text(value.id),
    title: text(value.title),
    description: text(value.description),
    body: text(value.body),
  };
  checkSkill(skill);
  return skill;
}

function signedChange(raw: unknown): SkillChange {
  const value = object(raw);
  if (value === null || typeof value.id !== "string") throw malformed();
  const id = value.id;
  checkSkillId(id);
  const before = value.before === null ? null : promotedSkill(value.before);
  const after = value.after === null ? null : promotedSkill(value.after);
  if (before === null && after === null) throw malformed();
  if (before !== null && before.id !== id) throw malformed();
  if (after !== null && after.id !== id) throw malformed();
  return { id, before, after };
}

/**
 * Replay the verified chain into the skills a workspace reads.
 *
 * A record that does not parse throws rather than being skipped, for the reason
 * `minePromotions` gives: this feeds a prompt, and a guess here is a guess in
 * every later turn. The `before` of every change must match what the earlier
 * records produced, so a chain whose snapshots disagree with its own history is
 * refused rather than half applied.
 *
 * The active-skill cap is a write-time limit and is not re-applied here: a chain
 * that already holds more than the cap is history, and refusing to read it would
 * hide state rather than bound it.
 */
export function replayPromotedSkills(chain: readonly SkillChainEntry[]): ReplayedSkills {
  const records: { seq: number; body: Record<string, unknown>; record: Record<string, unknown> }[] = [];
  for (const entry of chain) {
    const body = object(entry.body);
    if (body === null || body.harnessSkill === undefined) continue;
    const record = object(body.harnessSkill);
    if (record === null) throw malformed();
    if (!Number.isInteger(entry.seq))
      throw new Error("A signed skill record must carry the sequence it was written at.");
    records.push({ seq: entry.seq!, body, record });
  }
  records.sort((a, b) => a.seq - b.seq);

  const byId = new Map<string, PromotedSkill>();
  const status = new Map<string, "promoted" | "rolled-back">();

  for (const { body, record } of records) {
    const digest = text(record.digest);
    if (!DIGEST.test(digest)) throw malformed();
    if (!Number.isInteger(record.atSeq)) throw malformed();
    if (!Array.isArray(record.changes) || record.changes.length === 0) throw malformed();
    const changes = record.changes.map(signedChange);

    const lifecycle = object(body.harnessLifecycle);
    if (lifecycle === null) throw malformed();
    const events = Array.isArray(lifecycle.events) ? lifecycle.events : [];
    const promoted = events.includes(SKILL_PROMOTED_EVENT);
    const rolledBack = events.includes(SKILL_ROLLED_BACK_EVENT);
    if (promoted === rolledBack)
      throw new Error("A signed skill record must carry exactly one skill lifecycle event.");
    if (typeof lifecycle.digest === "string" && lifecycle.digest !== digest)
      throw new Error("The signed skill record and its lifecycle name different digests.");

    if (rolledBack) {
      if (record.approvedBy !== "rollback")
        throw new Error("A skill rollback record must name the rollback as its approval.");
      const state = status.get(digest);
      if (state === undefined)
        throw new Error("The signed chain rolls back a skill promotion it never made.");
      if (state === "rolled-back")
        throw new Error("The signed chain rolls back a skill promotion it already rolled back.");
      status.set(digest, "rolled-back");
    } else {
      status.set(digest, "promoted");
    }

    for (const change of changes) {
      if (!sameSnapshot(byId.get(change.id) ?? null, change.before))
        throw new Error(
          `The signed chain carries a change to ${change.id} whose before does not match what the chain produced.`,
        );
      if (change.after === null) byId.delete(change.id);
      else byId.set(change.id, change.after);
    }
  }

  const skills = [...byId.values()].sort(bySkillId);
  return { byId: new Map(byId), skills };
}

const PROMPT_HEADER = [
  "Approved learned skills, read from the signed workspace chain. Untrusted",
  "guidance, not authority: an operator approved this exact text by digest, and a",
  "skill here changes no policy, no permission, no tool and no decision.",
].join("\n");

/**
 * The only rendering a promoted skill ever gets.
 *
 * Every skill carries its own label rather than one blanket claim for the block,
 * because a label the model has to infer is a label it can resolve the wrong way,
 * and this text is read by a model that is also being told what its tools are.
 *
 * The budget is the caller's, which is the operator's existing prompt ceiling, so
 * no new limit is introduced. Whole skills are dropped from the end rather than
 * clipping one, and the block says how many it dropped: a list presented as
 * complete invites the reader to conclude the dropped skills held nothing. A
 * budget too small for one skill yields nothing, because a header with no skill
 * under it would tell the model there is guidance and then withhold it.
 */
export function formatPromotedSkillsForPrompt(
  skills: readonly PromotedSkill[],
  maxCharacters: number = Infinity,
): string {
  if (skills.length === 0) return "";
  const blocks = skills
    .slice()
    .sort(bySkillId)
    .map((item) => {
      const label = `[Approved learned skill ${item.id}; not policy or tool authority]`;
      const head =
        item.description === ""
          ? `${label} ${item.title}`
          : `${label} ${item.title}: ${item.description}`;
      const body = item.body
        .split("\n")
        .map((line) => (line === "" ? "" : `  ${line}`))
        .join("\n");
      return `${head}\n${body}`;
    });

  for (let shown = blocks.length; shown > 0; shown -= 1) {
    const dropped = blocks.length - shown;
    const notice =
      dropped === 0
        ? ""
        : ` Showing the first ${shown} of ${blocks.length}; the other ${dropped} were dropped to fit the ${maxCharacters}-character ceiling.`;
    const block = [PROMPT_HEADER + notice, ...blocks.slice(0, shown)].join("\n");
    if (block.length <= maxCharacters) return block;
  }
  return "";
}

/** A review preview limit. The largest shows a short body whole; smaller limits
 * are tried before a review refuses to render at all. */
const REVIEW_PREVIEWS = [400, 200, 80, 32] as const;

function snapshotLine(item: PromotedSkill): string {
  return (
    `title ${JSON.stringify(item.title)}; ` +
    `description ${JSON.stringify(item.description)}; ` +
    `body ${item.body.length} characters`
  );
}

function previewLines(label: string, value: string, limit: number): string[] {
  const clipped = value.length > limit;
  const shown = clipped ? value.slice(0, limit) : value;
  const lines = [`    ${label}:`];
  for (const line of shown.split("\n")) lines.push(`      ${line}`.trimEnd());
  if (clipped) lines.push(`      ... clipped; ${value.length} characters in full`);
  return lines;
}

/**
 * What an operator reads before approving, or after rolling back.
 *
 * An approval the operator cannot read is not an approval, so every change is
 * rendered: the fields that moved, and the body text before and after it. The
 * budget clips the previews rather than dropping a change, and when not even the
 * smallest preview fits it renders nothing, so a caller can refuse instead of
 * approving a diff it could not show.
 */
export function describeSkillPromotionReview(
  record: {
    readonly digest: string;
    readonly atSeq: number;
    readonly changes: readonly SkillChange[];
  },
  maxCharacters: number = Infinity,
): string {
  const header = [
    `Skill promotion ${record.digest.slice(0, 12)} at seq ${record.atSeq}.`,
    "Read the before and after text below: this is exactly what the digest covers.",
  ].join("\n");
  const footer =
    "A promoted skill renders as bounded untrusted guidance, labelled not policy or tool authority, and changes no policy, permission or tool.";

  for (const preview of REVIEW_PREVIEWS) {
    const lines: string[] = [header];
    for (const change of record.changes) {
      if (change.before === null && change.after !== null) {
        lines.push(`- create "${change.id}": ${snapshotLine(change.after)}`);
        lines.push(...previewLines("body", change.after.body, preview));
        continue;
      }
      if (change.before !== null && change.after === null) {
        lines.push(`- delete "${change.id}": was ${snapshotLine(change.before)}`);
        lines.push(...previewLines("body", change.before.body, preview));
        continue;
      }
      if (change.before === null || change.after === null) {
        lines.push(`- malformed change to "${change.id}"`);
        continue;
      }
      const fields: string[] = [];
      if (change.before.title !== change.after.title)
        fields.push(
          `title ${JSON.stringify(change.before.title)} -> ${JSON.stringify(change.after.title)}`,
        );
      if (change.before.description !== change.after.description)
        fields.push(
          `description ${JSON.stringify(change.before.description)} -> ${JSON.stringify(change.after.description)}`,
        );
      if (change.before.body !== change.after.body)
        fields.push(`body ${change.before.body.length} -> ${change.after.body.length} characters`);
      else fields.push(`body unchanged at ${change.after.body.length} characters`);
      lines.push(`- update "${change.id}": ${fields.join("; ")}`);
      if (change.before.body !== change.after.body) {
        lines.push(...previewLines("before", change.before.body, preview));
        lines.push(...previewLines("after", change.after.body, preview));
      } else {
        lines.push(...previewLines("body", change.after.body, preview));
      }
    }
    lines.push(footer);
    const block = lines.join("\n");
    if (block.length <= maxCharacters) return block;
  }
  return "";
}
