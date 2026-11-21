/**
 * Session search for the model (HP6).
 *
 * `nomo_session_search` lets the model look for something the operator said in
 * another conversation. This module is pure: it takes the candidates the
 * caller already holds and returns bounded excerpts, so it opens no store,
 * reads no file and owns no session. Three things stay outside on purpose.
 *
 * 1. **The current session.** The caller excludes it. A module that guessed
 *    which candidate was "current" would need the run, and the run is not a
 *    search concern.
 * 2. **Whether the tool is enabled.** The design makes it off by default,
 *    because a hit moves text between conversations. That switch is a
 *    setting and a policy decision, not a property of a substring search.
 * 3. **Redaction.** The caller applies the provider, connector and secret
 *    redaction after this module excerpts, because the caller is the only one
 *    that knows the secrets. Redacting here and cutting there could split a
 *    marker in half and leave half a secret in a prompt; excerpting here and
 *    redacting there cannot.
 *
 * The bounds exist because the result is a prompt. A search that returned a
 * whole conversation would let one call spend the context window, and a
 * search with no bound on the corpus would let it walk every session the
 * operator ever had.
 *
 * A system message is never searched. The standing instruction and the
 * learned entry block are the harness's own text, and searching them would
 * let a later conversation read an earlier conversation's instructions, which
 * is the one thing a search across conversations must not do.
 *
 * The query is one literal phrase, never a pattern: a search language is a
 * surface the model can use to probe text it was never given, and a literal
 * substring needs no language.
 */
import type { ModelMessage } from "./provider.ts";

export const SESSION_SEARCH_LIMITS = {
  queryCharacters: 200,
  maxResults: 8,
  excerptCharacters: 240,
  scannedSessions: 100,
} as const;

export type SessionSearchHitRole = "title" | "user" | "assistant" | "tool";

export type SessionSearchCandidate = {
  readonly id: string;
  readonly title?: string;
  readonly messages: readonly ModelMessage[];
};

export type SessionSearchHit = {
  readonly sessionId: string;
  /** The bounded title of the session, derived from its first non-system
   * message when the session has none, so a hit is always identifiable. */
  readonly title?: string;
  readonly role: SessionSearchHitRole;
  readonly excerpt: string;
};

export type SessionSearchResult = {
  readonly results: SessionSearchHit[];
  readonly truncated: boolean;
};

export const SESSION_SEARCH_TOOL = {
  name: "nomo_session_search",
  description:
    "Search the titles and message text of the operator's other conversations for one literal phrase, ignoring case. Returns bounded excerpts with the session id, a title and the role that matched. System instructions are never searched.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: SESSION_SEARCH_LIMITS.queryCharacters,
        description: "The literal phrase to look for. Case is ignored.",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: SESSION_SEARCH_LIMITS.maxResults,
        description: `Most hits to return. Defaults to ${SESSION_SEARCH_LIMITS.maxResults}.`,
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

/** The cut marker is plain ASCII: it has to survive a provider round trip and
 * a terminal that does not render a typographic ellipsis. */
const ELLIPSIS = "...";

/**
 * Find `query` in the candidates.
 *
 * Order is the caller's order: candidates as given, then the title before the
 * messages, then messages in the order they were said. A result that would be
 * longer than the limit stops at the limit and says so, and so does a result
 * that could not look at every candidate, because a model that sees eight hits
 * must not conclude that there are only eight.
 */
export function searchSessions(
  candidates: readonly SessionSearchCandidate[],
  input: unknown,
): SessionSearchResult {
  const { query, limit } = readInput(input);
  const foldedQuery = query.toLowerCase();
  const results: SessionSearchHit[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let truncated = false;
  for (const item of candidates) {
    // A duplicate id is one conversation seen twice. Searching it twice would
    // report the same text twice and spend the scan bound on a repeat.
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (scanned >= SESSION_SEARCH_LIMITS.scannedSessions) {
      truncated = true;
      break;
    }
    scanned += 1;
    const title = storedTitle(item);
    const label = title ?? firstText(item.messages);
    const identified = label === undefined ? undefined : headExcerpt(label);
    if (title !== undefined && foldedIndex(title, foldedQuery) >= 0) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      results.push(hit(item.id, identified, "title", excerptOf(title, query)));
    }
    for (const message of item.messages) {
      if (message.role === "system") continue;
      const content = message.content;
      if (typeof content !== "string" || !content.trim()) continue;
      if (foldedIndex(content, foldedQuery) < 0) continue;
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      results.push(hit(item.id, identified, message.role, excerptOf(content, query)));
    }
    if (truncated) break;
  }
  return { results, truncated };
}

function hit(
  sessionId: string,
  title: string | undefined,
  role: SessionSearchHitRole,
  excerpt: string,
): SessionSearchHit {
  return title === undefined
    ? { sessionId, role, excerpt }
    : { sessionId, title, role, excerpt };
}

function readInput(input: unknown): { readonly query: string; readonly limit: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(
      "Invalid session search: expected an object with a query and an optional limit.",
    );
  const fields = input as { readonly query?: unknown; readonly limit?: unknown };
  if (typeof fields.query !== "string")
    throw new Error("Invalid session search: query must be text.");
  const query = fields.query.trim();
  if (!query) throw new Error("Invalid session search: query must not be empty.");
  if (query.length > SESSION_SEARCH_LIMITS.queryCharacters)
    throw new Error(
      `Invalid session search: query is at most ${SESSION_SEARCH_LIMITS.queryCharacters} characters, got ${query.length}.`,
    );
  if (fields.limit === undefined)
    return { query, limit: SESSION_SEARCH_LIMITS.maxResults };
  const limit = fields.limit;
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > SESSION_SEARCH_LIMITS.maxResults
  )
    throw new Error(
      `Invalid session search: limit must be an integer from 1 to ${SESSION_SEARCH_LIMITS.maxResults}, got ${JSON.stringify(limit)}.`,
    );
  return { query, limit };
}

/** Only the stored title is searched. A title derived for an untitled session
 * is a label for the hit, not text the operator wrote as a title, so it must
 * not produce a second hit for the message it came from. */
function storedTitle(item: SessionSearchCandidate): string | undefined {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  return title ? title : undefined;
}

/** What an untitled session is about, in the operator's own words. A tool
 * result is not a title, but it is still the first thing that was said, and a
 * hit the model cannot identify is worse than a hit identified by a tool
 * name. */
function firstText(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role === "system") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content;
  }
  return undefined;
}

/** One line of text, so a message full of blank lines does not spend the
 * excerpt budget on whitespace. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The case-insensitive position of `foldedNeedle` in `text`, or -1.
 *
 * `toLowerCase` maps one code unit to two for a few characters (İ is the one
 * that shows up in real text), so a position taken from the folded string can
 * sit to the right of the original one. An excerpt centred on that position
 * would then be centred past the match and could cut it out entirely, so the
 * original position is walked back only when the two lengths differ.
 */
function foldedIndex(text: string, foldedNeedle: string): number {
  const folded = text.toLowerCase();
  const at = folded.indexOf(foldedNeedle);
  if (at < 0 || folded.length === text.length) return at;
  let width = 0;
  let index = 0;
  for (const character of text) {
    if (width >= at) return index;
    width += character.toLowerCase().length;
    index += character.length;
  }
  return index;
}

/** The head of a text, used for a title. A title identifies a conversation,
 * so it keeps its beginning rather than the part that matched. */
function headExcerpt(text: string): string {
  const flat = flatten(text);
  if (flat.length <= SESSION_SEARCH_LIMITS.excerptCharacters) return flat;
  return `${flat.slice(0, SESSION_SEARCH_LIMITS.excerptCharacters - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * An excerpt centred on the match, never longer than the excerpt bound.
 *
 * The window is computed on the flattened text, because the excerpt is a
 * prompt fragment and a run of blank lines is not context. The query is
 * flattened too, so a phrase the operator typed across a line break still
 * lands on its match after the text is flattened.
 */
function excerptOf(text: string, query: string): string {
  const flat = flatten(text);
  const needle = flatten(query);
  const at = Math.max(0, foldedIndex(flat, needle.toLowerCase()));
  const room = SESSION_SEARCH_LIMITS.excerptCharacters - ELLIPSIS.length * 2;
  let start = 0;
  let end = flat.length;
  if (flat.length > room) {
    // The match keeps its room first, and the context takes what is left,
    // split evenly so neither side is preferred without a reason.
    const slack = Math.max(0, room - needle.length);
    start = Math.max(0, at - Math.floor(slack / 2));
    end = Math.min(flat.length, start + room);
    start = Math.max(0, end - room);
  }
  const head = start > 0 ? ELLIPSIS : "";
  const tail = end < flat.length ? ELLIPSIS : "";
  return `${head}${flat.slice(start, end)}${tail}`;
}
