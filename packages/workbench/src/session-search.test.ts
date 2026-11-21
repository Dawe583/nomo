/** HP6: the model searches the operator's other conversations through one
 * bounded, literal query. These tests exercise the pure module only; the
 * session, the enable switch and the redaction belong to the caller. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_SEARCH_LIMITS,
  SESSION_SEARCH_TOOL,
  searchSessions,
  type SessionSearchCandidate,
} from "./session-search.ts";
import type { ModelMessage } from "./provider.ts";

function say(role: ModelMessage["role"], content: string | null): ModelMessage {
  return { role, content };
}

function candidate(
  id: string,
  messages: readonly ModelMessage[],
  title?: string,
): SessionSearchCandidate {
  return title === undefined ? { id, messages } : { id, title, messages };
}

test("the descriptor names the tool, the query and the optional bounded limit", () => {
  assert.equal(SESSION_SEARCH_TOOL.name, "nomo_session_search");
  assert.deepEqual(SESSION_SEARCH_TOOL.inputSchema.required, ["query"]);
  assert.equal(SESSION_SEARCH_TOOL.inputSchema.additionalProperties, false);
  assert.equal(
    SESSION_SEARCH_TOOL.inputSchema.properties.query.maxLength,
    SESSION_SEARCH_LIMITS.queryCharacters,
  );
  assert.equal(SESSION_SEARCH_TOOL.inputSchema.properties.limit.minimum, 1);
  assert.equal(
    SESSION_SEARCH_TOOL.inputSchema.properties.limit.maximum,
    SESSION_SEARCH_LIMITS.maxResults,
  );
});

test("the limits are the ones the design fixes", () => {
  assert.deepEqual(SESSION_SEARCH_LIMITS, {
    queryCharacters: 200,
    maxResults: 8,
    excerptCharacters: 240,
    scannedSessions: 100,
  });
});

test("a query must be trimmed, non-empty text within the query bound", () => {
  assert.throws(() => searchSessions([], null), /expected an object/);
  assert.throws(() => searchSessions([], []), /expected an object/);
  assert.throws(() => searchSessions([], {}), /query must be text/);
  assert.throws(() => searchSessions([], { query: 5 }), /query must be text/);
  assert.throws(
    () => searchSessions([], { query: "   " }),
    /query must not be empty/,
  );
  assert.throws(
    () => searchSessions([], { query: "x".repeat(201) }),
    /at most 200 characters/,
  );
  assert.deepEqual(searchSessions([], { query: "x".repeat(200) }), {
    results: [],
    truncated: false,
  });
});

test("a limit outside 1..8 or a fractional limit is refused rather than clamped", () => {
  for (const limit of [0, 9, -1, 2.5, Number.NaN, "3", null])
    assert.throws(
      () => searchSessions([], { query: "x", limit }),
      /limit must be an integer from 1 to 8/,
    );
  assert.deepEqual(searchSessions([], { query: "x", limit: 1 }), {
    results: [],
    truncated: false,
  });
  assert.deepEqual(searchSessions([], { query: "x", limit: 8 }), {
    results: [],
    truncated: false,
  });
});

test("the search answers from the candidates alone, with no session, store or enable switch", () => {
  const candidates = Object.freeze([
    Object.freeze({
      id: "s1",
      messages: Object.freeze([say("user", "the cache key rotates")]),
    }),
  ]);
  const result = searchSessions(candidates, Object.freeze({ query: "cache key" }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]?.sessionId, "s1");
});

test("the caller excludes the current session; this module searches every candidate it is given", () => {
  const current = candidate("current", [say("user", "needle")]);
  const result = searchSessions([current], { query: "needle" });
  assert.equal(
    result.results.length,
    1,
    "a current-session candidate is searched, so the caller must filter it out",
  );
});

test("a case-insensitive literal substring matches a title and non-system message text", () => {
  const candidates = [
    candidate(
      "s1",
      [
        say("system", "cache key instructions are private"),
        say("user", "we should revisit the CACHE KEY strategy"),
        say("assistant", "done"),
        say("tool", "cache key note"),
      ],
      "Cache keys",
    ),
  ];
  assert.deepEqual(searchSessions(candidates, { query: "cache key" }), {
    results: [
      { sessionId: "s1", title: "Cache keys", role: "title", excerpt: "Cache keys" },
      {
        sessionId: "s1",
        title: "Cache keys",
        role: "user",
        excerpt: "we should revisit the CACHE KEY strategy",
      },
      { sessionId: "s1", title: "Cache keys", role: "tool", excerpt: "cache key note" },
    ],
    truncated: false,
  });
});

test("a system message is never searched, even when it is the only match", () => {
  const candidates = [
    candidate("s1", [say("system", "the needle lives here")], "title without it"),
  ];
  assert.deepEqual(searchSessions(candidates, { query: "needle" }), {
    results: [],
    truncated: false,
  });
});

test("an untitled session still says what it is about", () => {
  const candidates = [
    candidate("s2", [
      say("system", "standing instruction"),
      say("user", "the deploy script needs a retry"),
      say("assistant", "noted"),
    ]),
  ];
  assert.deepEqual(searchSessions(candidates, { query: "deploy" }), {
    results: [
      {
        sessionId: "s2",
        title: "the deploy script needs a retry",
        role: "user",
        excerpt: "the deploy script needs a retry",
      },
    ],
    truncated: false,
  });
});

test("an untitled session does not report a derived title as a title hit", () => {
  const candidates = [
    candidate("s1", [say("user", "needle first"), say("user", "needle again")]),
  ];
  const result = searchSessions(candidates, { query: "needle" });
  assert.deepEqual(
    result.results.map((hit) => hit.role),
    ["user", "user"],
  );
  assert.equal(result.results[0]?.title, "needle first");
});

test("a duplicate candidate id is searched once, and the first occurrence wins", () => {
  const first = candidate("s1", [say("user", "first needle")]);
  const second = candidate("s1", [say("user", "second needle")]);
  assert.deepEqual(searchSessions([first, second], { query: "needle" }), {
    results: [
      { sessionId: "s1", title: "first needle", role: "user", excerpt: "first needle" },
    ],
    truncated: false,
  });
  const hay = candidate("s2", [say("user", "hay only")]);
  const later = candidate("s2", [say("user", "needle later")]);
  assert.deepEqual(searchSessions([hay, later], { query: "needle" }), {
    results: [],
    truncated: false,
  });
});

test("a null or blank message content is skipped rather than matched", () => {
  const candidates = [
    candidate("s1", [say("user", null), say("assistant", "   ")]),
  ];
  assert.deepEqual(searchSessions(candidates, { query: "needle" }), {
    results: [],
    truncated: false,
  });
});

test("the query is trimmed before it is searched", () => {
  const candidates = [candidate("s1", [say("user", "cache key rotation")])];
  const [hit] = searchSessions(candidates, { query: "  cache key  " }).results;
  assert.equal(hit?.excerpt, "cache key rotation");
  assert.equal(hit?.title, "cache key rotation");
});

test("the query is a literal phrase, not a pattern", () => {
  const candidates = [candidate("s1", [say("user", "a.c is literal text")])];
  assert.equal(searchSessions(candidates, { query: "a.c" }).results.length, 1);
  assert.equal(searchSessions(candidates, { query: "a.*c" }).results.length, 0);
  assert.equal(searchSessions(candidates, { query: "a(b" }).results.length, 0);
});

test("a match across a line break keeps the whole phrase in the excerpt", () => {
  const candidates = [candidate("s1", [say("user", "first line\nsecond line")])];
  const [hit] = searchSessions(candidates, { query: "line\nsecond" }).results;
  assert.equal(hit?.excerpt, "first line second line");
});

test("an excerpt is bounded to 240 characters, centred on the match, and marked where cut", () => {
  const content = `${"A".repeat(2000)}needle${"B".repeat(2000)}`;
  const [hit] = searchSessions([candidate("s1", [say("user", content)])], {
    query: "needle",
  }).results;
  assert.ok(hit);
  assert.equal(hit.excerpt.length, SESSION_SEARCH_LIMITS.excerptCharacters);
  assert.ok(hit.excerpt.startsWith("..."));
  assert.ok(hit.excerpt.endsWith("..."));
  const at = hit.excerpt.indexOf("needle");
  assert.ok(at >= 100, "the excerpt keeps context before the match");
  assert.ok(
    hit.excerpt.length - at - "needle".length >= 100,
    "the excerpt keeps context after the match",
  );
  assert.equal(hit.title?.length, SESSION_SEARCH_LIMITS.excerptCharacters);
  assert.ok(hit.title?.endsWith("..."));
  assert.ok(!hit.title?.includes("needle"));
});

test("a long title is cut at both ends around the match and its label stays a bounded head", () => {
  const title = `${"T".repeat(1000)}needle${"T".repeat(1000)}`;
  const [hit] = searchSessions([candidate("s1", [], title)], { query: "needle" })
    .results;
  assert.ok(hit);
  assert.equal(hit.role, "title");
  assert.ok(hit.excerpt.includes("needle"));
  assert.ok(hit.excerpt.length <= SESSION_SEARCH_LIMITS.excerptCharacters);
  assert.ok(hit.excerpt.startsWith("..."));
  assert.ok(hit.excerpt.endsWith("..."));
  assert.equal(hit.title?.length, SESSION_SEARCH_LIMITS.excerptCharacters);
  assert.ok(hit.title?.endsWith("..."));
});

test("a character that folds to two code units does not shift the excerpt off the match", () => {
  const title = `${"İ".repeat(150)}${"Z".repeat(2000)}needle`;
  const [hit] = searchSessions([candidate("s1", [], title)], { query: "needle" })
    .results;
  assert.ok(hit);
  assert.equal(hit.role, "title");
  assert.ok(
    hit.excerpt.includes("needle"),
    "the excerpt must be centred on the original index, not on the folded one",
  );
  assert.ok(hit.excerpt.length <= SESSION_SEARCH_LIMITS.excerptCharacters);
});

test("a short excerpt is returned whole, with no ellipsis", () => {
  const candidates = [candidate("s1", [say("user", "needle in a short message")])];
  const [hit] = searchSessions(candidates, { query: "needle" }).results;
  assert.equal(hit?.excerpt, "needle in a short message");
});

test("more hits than the limit are cut in candidate and message order, and say so", () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    say("user", `needle ${index}`),
  );
  const candidates = [candidate("s1", messages), candidate("s2", [say("user", "needle other")])];
  const result = searchSessions(candidates, { query: "needle", limit: 3 });
  assert.deepEqual(
    result.results.map((hit) => hit.excerpt),
    ["needle 0", "needle 1", "needle 2"],
  );
  assert.equal(result.truncated, true);
  assert.deepEqual(
    searchSessions(candidates, { query: "needle", limit: 3 }).results,
    result.results,
    "the same candidates and query must produce the same hits",
  );
});

test("the default limit is eight, and a result that fills it exactly is not truncated", () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    say("user", `needle ${index}`),
  );
  const all = searchSessions([candidate("s1", messages)], { query: "needle" });
  assert.equal(all.results.length, SESSION_SEARCH_LIMITS.maxResults);
  assert.equal(all.truncated, true);
  const exact = searchSessions([candidate("s1", messages.slice(0, 8))], {
    query: "needle",
  });
  assert.equal(exact.results.length, 8);
  assert.equal(exact.truncated, false);
});

test("hits beyond the limit in a later candidate are reported as truncated", () => {
  const candidates = [
    candidate("s1", [say("user", "needle one")]),
    candidate("s2", [say("user", "needle two")]),
  ];
  const result = searchSessions(candidates, { query: "needle", limit: 1 });
  assert.deepEqual(
    result.results.map((hit) => hit.sessionId),
    ["s1"],
  );
  assert.equal(result.truncated, true);
});

test("candidates beyond the scanned bound are omitted and reported", () => {
  const many = Array.from({ length: 101 }, (_, index) =>
    candidate(`s${index}`, [
      say("user", index === 100 ? "the needle" : "hay only"),
    ]),
  );
  assert.deepEqual(searchSessions(many, { query: "needle" }), {
    results: [],
    truncated: true,
  });
  const hundred = many.slice(0, 100);
  assert.deepEqual(searchSessions(hundred, { query: "needle" }), {
    results: [],
    truncated: false,
  });
  const last = many.slice(0, 100);
  last[99] = candidate("s99", [say("user", "the needle")]);
  assert.deepEqual(searchSessions(last, { query: "needle" }), {
    results: [{ sessionId: "s99", title: "the needle", role: "user", excerpt: "the needle" }],
    truncated: false,
  });
});

test("a duplicate id does not consume the scanned bound", () => {
  const many: SessionSearchCandidate[] = [];
  for (let index = 0; index < 99; index += 1)
    many.push(candidate(`s${index}`, [say("user", "hay only")]));
  for (let index = 0; index < 10; index += 1)
    many.push(candidate("s0", [say("user", "needle")]));
  many.push(candidate("s99", [say("user", "needle")]));
  assert.deepEqual(searchSessions(many, { query: "needle" }), {
    results: [{ sessionId: "s99", title: "needle", role: "user", excerpt: "needle" }],
    truncated: false,
  });
});

test("no match is an empty result, not an error", () => {
  const candidates = [candidate("s1", [say("user", "hay only")], "hay")];
  assert.deepEqual(searchSessions(candidates, { query: "needle" }), {
    results: [],
    truncated: false,
  });
  assert.deepEqual(searchSessions([], { query: "needle" }), {
    results: [],
    truncated: false,
  });
});
