/**
 * The refinement pass, the only place a token is spent.
 *
 * Everything else in the harness is a pure function and this is the exception,
 * which is why the exception is small. `refine-gate.ts` has already decided that
 * a pass is worth paying for, so this file's job is to turn one model's reply
 * into validated edits or into nothing, and to do it in a way a reader can check.
 *
 * Three properties are load-bearing and each one came from something that
 * actually goes wrong.
 *
 * **A truncated reply is not a malformed one.** A model that runs out of output
 * budget mid-object returns unparseable text, and calling that "invalid JSON"
 * sends the reader hunting for a model problem when the cause was a limit.
 * `isIncompleteJson` counts brackets outside string literals, treating an
 * escaped quote as not closing a string, so a reply quoting `"a \" b"` is not
 * misread as two complete strings. A truncated reply gets a message that says
 * the budget ran out.
 *
 * **Validation collects every failure rather than throwing the first.** prime-src
 * does the same, and the reason is behavioural: given one error a model usually
 * fixes that error and returns the same shape with the next violation in it.
 * Given a list it fixes the list.
 *
 * **The base system prompt is not editable.** prime-src refuses the id
 * `base_system_prompt` outright, and this copies that literally. The rule is not
 * about the id; it is that a harness which can rewrite the standing instructions
 * has no boundary left to enforce.
 *
 * Nothing here writes to the ledger and nothing reaches `decide`. A proposal is
 * data. Promotion goes through `commitWorkspace`, so a record is signed by the
 * same key as everything else, and a mined rule stays `hold` behind the
 * operator's own rules exactly as `learned-rules.ts` says.
 *
 * `applyProposal` returns a result rather than mutating, and that is deliberate
 * too: a caller must be able to refuse the whole proposal without having to
 * reconstruct what was already done.
 */

import type { HarnessEntry, HarnessKind } from "./learned-harness.ts";

export const REFINEMENT_KINDS = ["memory", "skill", "subagent", "prompt"] as const;
export type RefinementKind = (typeof REFINEMENT_KINDS)[number];

export const REFINEMENT_ACTIONS = ["create", "update", "delete"] as const;
export type RefinementAction = (typeof REFINEMENT_ACTIONS)[number];

/** prime-src refuses this id by name, and so does this. */
export const BASE_SYSTEM_PROMPT_ID = "base_system_prompt";

export type RefinementEdit = {
  readonly action: RefinementAction;
  readonly kind: RefinementKind;
  /** Required for update and delete. Optional for create. */
  readonly id?: string;
  /** Required for create and update. */
  readonly title?: string;
  /** Required for create and update. */
  readonly content?: string;
  /** The ledger sequence an edit rests on. Empty is refused. */
  readonly derivedFromSeq: readonly number[];
  /** Why this edit is worth making. Required. */
  readonly reason: string;
  /** The addendum an operator must approve before a `prompt` edit takes
   * effect. Absent on every other kind: a memory, skill or subagent edit is
   * applied or refused by the proposal, but a prompt edit is never applied by
   * the model and only ever by the operator. */
  readonly promptAddendum?: string;
  /** Present on delete and optional elsewhere: how to undo it. */
  readonly rollbackId?: string;
};

export type RefinementProposal = {
  readonly summary: string;
  readonly rationale: string;
  /** What should improve, and how anybody could tell. */
  readonly expectedOutcome: string;
  readonly edits: readonly RefinementEdit[];
};

export type ParseErrorKind = "truncated" | "not-an-object" | "invalid-json";

export type ParseResult =
  | { readonly ok: true; readonly proposal: RefinementProposal }
  | { readonly ok: false; readonly kind: ParseErrorKind; readonly message: string };

const TRUNCATED = "the model stopped before completing its JSON object; the output budget was exhausted. Retry with a smaller request.";

/**
 * Whether a reply ended mid-value rather than being malformed.
 *
 * Brackets are counted outside string literals only. Inside a string a `{` is a
 * character, and counting it would report a complete object as truncated.
 */
export function isIncompleteJson(candidate: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of candidate) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
  }
  return inString || depth > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function seqs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is number => typeof item === "number" && Number.isInteger(item) && item >= 0)
    .sort((a, b) => a - b);
}

function readEdit(value: unknown): RefinementEdit {
  const raw = isRecord(value) ? value : {};
  // An absent optional field is left absent, not set to undefined. refineHarness
  // signs the proposal, canonicalJson refuses undefined because it does not
  // round trip, and JSON.stringify drops the key, so a parser-produced edit
  // would carry three keys a hand-built one never has, and could not be
  // written to the chain at all. Every test builds proposals as literals, so
  // nothing exercised the parsed shape end to end.
  const optional = (key: "id" | "title" | "content" | "rollbackId" | "promptAddendum") =>
    raw[key] === undefined ? {} : { [key]: text(raw[key]) };
  return {
    action: text(raw.action) as RefinementAction,
    kind: text(raw.kind) as RefinementKind,
    ...optional("id"),
    ...optional("title"),
    ...optional("content"),
    derivedFromSeq: seqs(raw.derivedFromSeq),
    reason: text(raw.reason),
    ...optional("rollbackId"),
    // A prompt edit carries the addendum text in its own field, not in
    // content. Dropping it here meant validateProposal rejected every prompt
    // edit a model could produce, and the approval path the operator reads
    // had nothing a review could ever put in it.
    ...optional("promptAddendum"),
  };
}

/**
 * Pull a JSON object out of a reply.
 *
 * A model told to answer with JSON sometimes fences it and sometimes explains
 * itself around it, so three shapes are accepted rather than one. Rejecting the
 * other two would only teach the model to avoid fences, at the cost of tokens.
 */
export function extractJsonObject(text_: string): ParseResult {
  const found = extractJsonValue(text_);
  if (!found.ok) return { ok: false, kind: found.kind, message: found.message };
  if (!isRecord(found.value))
    return { ok: false, kind: "not-an-object", message: "expected a JSON object" };
  return { ok: true, proposal: readProposal(found.value) };
}

export type RawJsonResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly kind: ParseErrorKind; readonly message: string };

/**
 * Pull a JSON value out of a reply without interpreting it.
 *
 * `extractJsonObject` answers "is this a proposal"; this answers "is there an
 * object here at all". A caller reading a verdict needs the second question,
 * and re-deriving the same three shapes for it would mean two parsers to keep
 * in step on every future shape a model learns to emit.
 */
export function extractJsonValue(text_: string): RawJsonResult {
  const trimmed = text_.trim();

  const attempt = (candidate: string): RawJsonResult | null => {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      return null;
    }
  };

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const direct = attempt(trimmed);
    if (direct) return direct;
    return isIncompleteJson(trimmed)
      ? { ok: false, kind: "truncated", message: TRUNCATED }
      : { ok: false, kind: "invalid-json", message: "the reply is not valid JSON" };
  }

  // A fenced block, optionally tagged `json`.
  const fence = trimmed.indexOf("```");
  if (fence !== -1) {
    const afterFence = trimmed.slice(fence + 3).replace(/^json\s*/iu, "");
    const close = afterFence.indexOf("```");
    if (close !== -1) {
      const inner = afterFence.slice(0, close).trim();
      const fenced = attempt(inner);
      if (fenced) return fenced;
      return isIncompleteJson(inner)
        ? { ok: false, kind: "truncated", message: TRUNCATED }
        : { ok: false, kind: "invalid-json", message: "the fenced block is not valid JSON" };
    }
    // An opening fence with no close is the shape a truncated reply takes.
    return { ok: false, kind: "truncated", message: TRUNCATED };
  }

  // An object embedded in prose.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const embedded = attempt(trimmed.slice(start, end + 1));
    if (embedded) return embedded;
  }

  return isIncompleteJson(trimmed)
    ? { ok: false, kind: "truncated", message: TRUNCATED }
    : { ok: false, kind: "not-an-object", message: "no JSON object found in the reply" };
}

function readProposal(value: Record<string, unknown>): RefinementProposal {
  const edits = Array.isArray(value.edits) ? value.edits : [];
  return {
    summary: text(value.summary),
    rationale: text(value.rationale),
    expectedOutcome: text(value.expectedOutcome),
    edits: edits.map(readEdit),
  };
}

export type EditRejection = {
  readonly index: number;
  readonly edit: RefinementEdit;
  readonly reason: string;
};

export type Validated =
  | { readonly ok: true; readonly proposal: RefinementProposal }
  | { readonly ok: false; readonly rejections: readonly EditRejection[] };

/**
 * Validate a proposal before anything is written.
 *
 * Every rejection is collected rather than thrown at the first. prime-src does
 * the same and the reason is behavioural rather than cosmetic: a model given one
 * error usually fixes that error and returns the same shape with the next
 * violation in it, so a first-error-throw turns one round trip into several.
 *
 * Three rejections are refusals rather than advice. An edit naming the base
 * system prompt, an edit with no id on update or delete, and an edit with no
 * `derivedFromSeq` are all cases where applying it would mean writing something
 * this repository cannot later account for.
 */
export function validateProposal(proposal: RefinementProposal): Validated {
  const rejections: EditRejection[] = [];

  if (proposal.edits.length === 0) {
    // "Nothing here is durable" is an answer, not a failure. prime-src says this
    // in the instruction it sends, and honouring it here is what makes that
    // instruction true: a pass that is told it may decline and then has its
    // decline rejected will propose something on the next run instead.
    return { ok: true, proposal };
  }

  proposal.edits.forEach((edit, index) => {
    const reject = (reason: string) => rejections.push({ index, edit, reason });

    if (!(REFINEMENT_ACTIONS as readonly string[]).includes(edit.action)) {
      reject(`unsupported action ${JSON.stringify(edit.action)}`);
      return;
    }
    if (!(REFINEMENT_KINDS as readonly string[]).includes(edit.kind)) {
      reject(`unsupported kind ${JSON.stringify(edit.kind)}`);
      return;
    }
    if (edit.id === BASE_SYSTEM_PROMPT_ID) {
      // Not an id convention. The base system prompt is not editable, and a
      // harness that can rewrite the standing instructions has no boundary left
      // to enforce.
      reject("the base system prompt is not editable");
      return;
    }
    if (edit.action !== "create" && !edit.id) {
      reject(`${edit.action} requires an id`);
      return;
    }
    if (edit.kind === "prompt" && !edit.promptAddendum?.trim()) {
      // A prompt edit is only an addendum to the standing instructions, so it
      // has to say what the addendum is. An empty one is not an addendum: it
      // is a request to change nothing, and that is the default.
      reject("a prompt edit must carry the addendum it is asking for");
      return;
    }
    // A prompt edit carries its text in promptAddendum, which the check above
    // already required. Demanding content as well made the two rules
    // unsatisfiable together: no prompt edit a model could write was ever
    // valid, so the operator approval path had nothing to approve.
    if (edit.action !== "delete" && (!edit.title || (!edit.content && edit.kind !== "prompt"))) {
      reject(`${edit.action} requires a title and content`);
      return;
    }
    if (edit.derivedFromSeq.length === 0) {
      // The one rejection neither reference harness has. Both write into a plain
      // file they trust; this writes into a signed chain, where an edit with
      // nothing behind it cannot be audited after the fact.
      reject("an edit must name the ledger records it was derived from");
      return;
    }
  });

  return rejections.length === 0 ? { ok: true, proposal } : { ok: false, rejections };
}

export type AppliedEdit = {
  readonly edit: RefinementEdit;
  readonly kind: HarnessKind;
  readonly outcome: "created" | "updated" | "deleted" | "superseded";
  /** The entry as it stood before, so a rollback is possible without re-reading
   * the chain. */
  readonly before: HarnessEntry | null;
};

/**
 * Apply a validated proposal to the current harness, in memory.
 *
 * Returns rather than writes, because writing is `commitWorkspace`'s job and a
 * record there must be signed by the same key as everything else. Nothing here
 * reaches `decide`: a `refinement` kind becomes a lesson for a human, never a
 * rule, and `learned-rules.ts` keeps the rules in their own channel.
 *
 * An update supersedes rather than overwrites. prime-src has a rollback path; the
 * superseded entry stays addressable here, so a correction is auditable in the
 * same way the ledger makes a decision auditable.
 *
 * A `prompt` edit is withheld rather than applied. A model that can rewrite the
 * standing instructions can also talk itself out of every boundary above, so
 * the operator's approval is a precondition rather than a review step. Withholding
 * it here instead of filtering it at the call site means a caller that forgets
 * the check still cannot change a prompt.
 *
 * The one way through is `approval`, which is deliberately not a boolean: it
 * names who approved and what they approved, so the call site that opts in
 * carries its own proof and a caller that forgets cannot arrive here with
 * `true` by accident. Omitting it is the fail-closed default.
 */
export type PromptApproval = {
  /** The operator's own account of who decided. Recorded, not authenticated. */
  readonly by: string;
  /** The digest of the proposal as it was reviewed. */
  readonly digest: string;
  /** The chain position the approval was given at. */
  readonly atSeq: number;
};

export function applyProposal(
  current: readonly HarnessEntry[],
  proposal: RefinementProposal,
  now: string,
  /** Present only when an operator has already approved this proposal. */
  approval?: PromptApproval,
): {
  readonly entries: HarnessEntry[];
  readonly applied: readonly AppliedEdit[];
  /** Edits held back for an operator. Never present in `entries`. */
  readonly awaitingApproval: readonly RefinementEdit[];
} {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const applied: AppliedEdit[] = [];
  const awaitingApproval: RefinementEdit[] = [];

  for (const edit of proposal.edits) {
    if (edit.kind === "prompt" && approval === undefined) {
      awaitingApproval.push(edit);
      continue;
    }
    if (edit.action === "delete") {
      const id = edit.id!;
      const before = byId.get(id) ?? null;
      byId.delete(id);
      applied.push({ edit, kind: before?.kind ?? "lesson", outcome: "deleted", before });
      continue;
    }
    // An approved prompt edit becomes a workspace-scoped lesson holding the
    // addendum text. The operator approved it, so it applies to later sessions
    // and survives a restart: it is rebuilt from the chain with everything
    // else. Session scope is a different thing, a mined entry the current
    // session observed, and that is not restored as active state.
    const addendum =
      edit.kind === "prompt" ? edit.promptAddendum ?? "" : edit.content ?? "";
    const id =
      edit.id ?? contentAddressedId(edit.kind, edit.title ?? "", addendum);
    const before = byId.get(id) ?? null;
    const entry: HarnessEntry = {
      id,
      // A refinement never produces a `rule`. Rules are mined from the chain by
      // `learned-rules.ts`, which can only emit `hold`, and letting a model
      // author one would route around the only thing that is auditable.
      kind: "lesson",
      scope: "workspace",
      tool: before?.tool ?? "",
      klass: before?.klass ?? "",
      title: edit.title ?? "",
      content: addendum,
      derivedFromSeq: edit.derivedFromSeq,
      repeats: edit.derivedFromSeq.length,
      createdAt: before?.createdAt ?? now,
    };
    byId.set(id, entry);
    applied.push({ edit, kind: entry.kind, outcome: before ? "superseded" : "created", before });
  }

  return { entries: [...byId.values()], applied, awaitingApproval };
}

/** A stable id for a create, so two identical proposals agree. */
function contentAddressedId(kind: string, title: string, content: string): string {
  let hash = 0x811c9dc5;
  const input = `${kind}\u0000${title}\u0000${content}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `re_${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The instruction given to the reviewing model.
 *
 * Written as a contract rather than a description, because the constraints are
 * the interesting part and a model that ignores them produces a proposal this
 * module then has to refuse. Three refusals are the ones prime-src names and
 * for its reasons: a single occurrence is noise, a cause is unsupported however
 * plausible it sounds, and a tool's output says nothing about the next run.
 *
 * The provenance rule is the strictest line and it is NOMO's. Neither reference
 * harness needs it, because both write into a plain file the agent can rewrite;
 * here a claim that cannot cite the chain would enter a signed ledger and be
 * indistinguishable from a recorded fact.
 */
export const REFINEMENT_INSTRUCTIONS = [
  "You are improving a harness's learned entries. You propose; you do not apply.",
  "",
  "The entries below were mined from a signed ledger without you. The ledger",
  "records what happened and never why, so anything you write about a cause is",
  "unsupported however plausible it sounds.",
  "",
  "Refuse these three, each of them:",
  "- one-off noise. One call is not a pattern.",
  "- transient tool output. It says nothing about the next run.",
  "- an explanation of a cause, for the reason above.",
  "",
  "Every edit must cite the records it came from in `derivedFromSeq`. An edit",
  "that cannot say where it came from is refused, and that is not a formality:",
  "the ledger is signed and an uncited claim cannot be recorded.",
  "",
  `The base system prompt is never editable, and an edit naming`,
  `\`${BASE_SYSTEM_PROMPT_ID}\` is refused outright.`,
  "",
  "Prefer the smallest edit that fixes the problem. If nothing here is durable,",
  "reply with an empty edits array and say so in the summary. Declining is a",
  "correct answer, and a refiner that must always find something will find",
  "something wrong.",
  "",
  "Reply with JSON only:",
  '{ "summary": "one sentence", "rationale": "what in the records supports this",',
  '  "expectedOutcome": "what improves and how it could be checked",',
  '  "edits": [ { "action": "create|update|delete", "kind": "memory|skill|subagent|prompt",',
  '    "id": "required for update and delete", "title": "", "content": "",',
  '    "reason": "why this is worth keeping", "derivedFromSeq": [1, 2] } ] }',
  "",
  'A "prompt" edit changes the standing instructions, so it puts the text it',
  'wants added in "promptAddendum" and leaves "content" empty. It still reaches',
  'nothing on its own: an operator reads the exact addendum and approves it',
  'before it is written.',
].join("\n");

/**
 * The request a pass sends.
 *
 * The candidates go in whole rather than summarised, because the pass has
 * already been paid for by the gate and a summary would answer a different
 * question than the one the evidence can answer.
 *
 * Whole is also how they are bounded. The list stops at `maxCharacters` by
 * dropping trailing entries whole, never by cutting an entry's text, because a
 * half-quoted observation is the summary this function refuses to produce. The
 * budget is the operator's own prompt ceiling: without it the request grows
 * with the chain, and a thousand mined entries measured at 557k characters,
 * seventeen times the default ceiling, on every review the gate allows.
 *
 * When anything is dropped the request says so, because a list presented as
 * complete invites the reader to conclude the dropped entries held nothing.
 */
export function buildRefineRequest(input: {
  readonly entries: readonly HarnessEntry[];
  readonly rules: number;
  readonly settledTurns: number;
  readonly maxCharacters?: number;
}): string {
  const total = input.entries.length;
  const budget = input.maxCharacters ?? Infinity;
  const summary =
    `${total} mined ${total === 1 ? "entry" : "entries"} and ` +
    `${input.rules} refusal rule(s) across ${input.settledTurns} settled turns.`;
  const notice = (shown: number, dropped: number) =>
    ` Showing the first ${shown} of ${total}; the other ${dropped} were ` +
    `dropped to fit the ${input.maxCharacters}-character ceiling, so this is a ` +
    `sample and not the whole set.`;
  const listed: string[] = [];
  let used = summary.length;
  for (const entry of input.entries) {
    const line =
      `- [${entry.kind}] ${entry.id} (${entry.tool}/${entry.klass}, ` +
      `${entry.repeats} records, seq ${entry.derivedFromSeq.join(", ") || "none"}): ` +
      entry.content;
    if (used + line.length + 1 > budget) break;
    listed.push(line);
    used += line.length + 1;
  }
  // The notice spends budget too, so give it room before committing to a list.
  // It is also only true once something has actually been dropped: with no
  // ceiling the loop would otherwise add it to a complete list, which is the
  // one thing a truncation notice must never do.
  let tail = "";
  if (listed.length < total) {
    while (listed.length > 0) {
      const candidate = notice(listed.length, total - listed.length);
      if (used + candidate.length <= budget) {
        tail = candidate;
        break;
      }
      used -= listed.pop()!.length + 1;
    }
    if (tail === "")
      tail = notice(listed.length, total - listed.length);
  }
  return [summary + tail, "", ...listed].join("\n");
}
