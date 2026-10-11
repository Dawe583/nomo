import test from "node:test";
import assert from "node:assert/strict";

import {
  formatForPrompt,
  harnessQueryTerms,
  queryTermsFrom,
  rankEntries,
  scoreEntry,
  termIdf,
} from "./harness-ranking.ts";
import type { HarnessEntry } from "./learned-harness.ts";

const entry = (id: string, title: string, content: string, tool = "fs.write"): HarnessEntry => ({
  id,
  kind: "lesson",
  scope: "workspace",
  tool,
  klass: "r1",
  title,
  content,
  derivedFromSeq: [1, 2, 3],
  repeats: 6,
  createdAt: "2026-10-07T00:00:00.000Z",
});

const OPTS = { perKindLimit: 10, contentChars: 80 };

test("a term is a word run of at least four characters", () => {
  // Shorter runs carry almost no information and IDF would weigh them near zero
  // anyway, so they are dropped at the tokenizer rather than in scoring.
  assert.deepEqual(harnessQueryTerms("the postgres connection"), ["postgres", "connection"]);
  assert.deepEqual(harnessQueryTerms("a to be in"), []);
});

test("punctuation breaks a run rather than joining it", () => {
  assert.deepEqual(harnessQueryTerms("vault/recovery/probe"), ["vault", "recovery", "probe"]);
});

test("terms are lowercased so a query and a document agree", () => {
  assert.deepEqual(harnessQueryTerms("POSTGRES Migration"), ["postgres", "migration"]);
});

test("a CJK run becomes overlapping bigrams", () => {
  // CJK has no spaces to tokenise on, so a whole run would match nothing else.
  assert.deepEqual(harnessQueryTerms("データ接続"), ["デー", "ータ", "タ接", "接続"]);
});

test("a single CJK character is kept, because dropping it loses the answer", () => {
  // It yields no bigram, but a run of one is still information and filtering
  // it out would make a one-character reply unmatchable.
  assert.deepEqual(harnessQueryTerms("字"), ["字"]);
});

test("a run mixing scripts splits at the boundary", () => {
  const terms = harnessQueryTerms("postgresデータ");
  assert.ok(terms.includes("postgres"));
  // The CJK half becomes bigrams rather than staying a whole run, so a query
  // written in one language matches a document written in either.
  assert.ok(terms.includes("デー"));
  assert.ok(!terms.includes("データ"), "a CJK run is split, not kept whole");
});

test("what the operator typed now outweighs what the chain recorded", () => {
  // The one place this departs from both reference harnesses. A term the
  // operator typed is the current question; a term mined from the chain is a
  // description of what happened before. Both are legitimate input and they are
  // not equally authoritative about what to look for.
  const terms = queryTermsFrom({ user: "postgres", ledger: "kubernetes" });
  assert.equal(terms.get("postgres"), 1);
  assert.equal(terms.get("kubernetes"), 0.5);
});

test("a term in both sources keeps the operator's weight rather than gaining it", () => {
  // Summing would let a term repeated in the chain outweigh what a human just
  // typed, which inverts the point of the two weights existing.
  assert.equal(queryTermsFrom({ user: "postgres", ledger: "postgres" }).get("postgres"), 1);
});

test("an absent ledger is simply an absent weight", () => {
  const terms = queryTermsFrom({ user: "postgres" });
  assert.equal(terms.get("postgres"), 1);
});

test("a rare term outweighs a ubiquitous one", () => {
  const entries = [
    entry("a", "postgres tuning", "postgres appears here"),
    entry("b", "postgres tuning", "postgres appears here too"),
    entry("c", "postgres tuning", "postgres once more"),
    entry("d", "kubernetes tuning", "kubernetes appears once"),
  ];
  const idf = termIdf(entries, queryTermsFrom({ user: "postgres kubernetes" }));
  // A term in every entry carries almost no information, and scoring it as
  // though it did is how a ranking looks informed while being useless.
  assert.ok((idf.get("kubernetes") ?? 0) > (idf.get("postgres") ?? 0));
});

test("IDF is the reference formula, so the two harnesses agree on what common means", () => {
  const entries = [entry("a", "alpha", "alpha"), entry("b", "beta", "beta")];
  const idf = termIdf(entries, queryTermsFrom({ user: "alpha" }));
  assert.ok(Math.abs((idf.get("alpha") ?? 0) - Math.log(1 + entries.length / 1)) < 1e-9);
});

test("a term matching no entry has no IDF, because it cannot score", () => {
  const idf = termIdf([entry("a", "alpha", "alpha")], queryTermsFrom({ user: "zulu" }));
  assert.equal(idf.has("zulu"), false);
});

test("field coverage is weighted and repetition is not", () => {
  // Repetition is a property of how the text was written, not of how relevant it
  // is, and a mined entry repeats its own tool name in every field by design.
  const repeated = entry("a", "postgres", "postgres postgres postgres postgres postgres");
  const spread = entry("b", "postgres tuning", "the postgres connection was fine");
  const terms = queryTermsFrom({ user: "postgres" });
  const idf = termIdf([repeated, spread], terms);
  // Both cover the same two fields, so they score the same no matter how many
  // times one of them says the word. Repeating a term is not evidence.
  assert.equal(scoreEntry(repeated, terms, idf), scoreEntry(spread, terms, idf));
  // Coverage, not volume, is what separates entries.
  const narrow = entry("c", "postgres", "unrelated filler");
  assert.ok(scoreEntry(spread, terms, idf) > scoreEntry(narrow, terms, idf));
});

test("the title outweighs the identifier", () => {
  const inTitle = entry("zzz", "postgres", "unrelated");
  const inId = entry("postgres", "unrelated", "unrelated");
  const terms = queryTermsFrom({ user: "postgres" });
  const idf = termIdf([inTitle, inId], terms);
  assert.ok(scoreEntry(inTitle, terms, idf) > scoreEntry(inId, terms, idf));
});

test("an entry matching nothing scores zero", () => {
  const terms = queryTermsFrom({ user: "zulu" });
  const target = entry("a", "alpha", "beta");
  assert.equal(scoreEntry(target, terms, termIdf([target], terms)), 0);
});

test("empty terms score zero rather than dividing by nothing", () => {
  assert.equal(scoreEntry(entry("a", "alpha", "alpha"), new Map(), new Map()), 0);
});

test("a missing IDF map weighs every term at one rather than dropping it", () => {
  // An entry must not be silently discarded because a caller forgot the map.
  const terms = queryTermsFrom({ user: "postgres" });
  assert.ok(scoreEntry(entry("a", "postgres", "postgres"), terms, new Map()) > 0);
});

test("a ranking drops entries that matched nothing", () => {
  // Padding a context window with non-matches teaches the model that the list is
  // noise, so an irrelevant lesson is dropped rather than shown last.
  const ranked = rankEntries(
    [entry("a", "alpha", "alpha"), entry("b", "postgres", "postgres tuning")],
    queryTermsFrom({ user: "postgres" }),
    OPTS,
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.entry.id, "b");
});

test("the same state ranks the same way twice", () => {
  const entries = [entry("a", "postgres", "postgres"), entry("b", "kubernetes", "kubernetes")];
  const terms = queryTermsFrom({ user: "postgres kubernetes" });
  assert.deepEqual(rankEntries(entries, terms, OPTS), rankEntries(entries, terms, OPTS));
});

test("ties break on the content-addressed id, not on the caller's order", () => {
  // A digest that moves for no reason cannot be used to tell whether anything
  // changed, so the order cannot depend on which order the caller collected in.
  const a = entry("zzz", "same", "same text");
  const b = entry("aaa", "same", "same text");
  const terms = queryTermsFrom({ user: "same" });
  assert.deepEqual(
    rankEntries([a, b], terms, OPTS).map((row) => row.entry.id),
    rankEntries([b, a], terms, OPTS).map((row) => row.entry.id),
  );
});

test("a per-kind limit stops one kind crowding out another", () => {
  const entries: HarnessEntry[] = [
    { ...entry("a", "postgres one", "postgres"), kind: "lesson" },
    { ...entry("b", "postgres two", "postgres"), kind: "lesson" },
    { ...entry("c", "postgres three", "postgres"), kind: "lesson" },
    { ...entry("d", "postgres rule", "postgres"), kind: "rule" },
  ];
  const ranked = rankEntries(entries, queryTermsFrom({ user: "postgres" }), {
    perKindLimit: 1,
    contentChars: 80,
  });
  // One lesson and one rule, not three lessons and no rule: a global limit of
  // three would have looked fine and dropped the other kind entirely.
  assert.equal(ranked.length, 2);
  assert.deepEqual(
    ranked.map((row) => row.entry.kind).sort(),
    ["lesson", "rule"],
  );
});

test("a per-kind limit of zero drops the kind rather than failing", () => {
  const ranked = rankEntries([entry("a", "postgres", "postgres")], queryTermsFrom({ user: "postgres" }), {
    perKindLimit: 0,
    contentChars: 80,
  });
  assert.deepEqual(ranked, []);
});

test("a nonsensical limit is refused rather than silently clamped", () => {
  const terms = queryTermsFrom({ user: "postgres" });
  const entries = [entry("a", "postgres", "postgres")];
  assert.throws(() => rankEntries(entries, terms, { perKindLimit: -1, contentChars: 80 }), /negative/);
  assert.throws(() => rankEntries(entries, terms, { perKindLimit: 1, contentChars: 0 }), /positive/);
});

test("no entries and no terms are both empty, not an error", () => {
  assert.deepEqual(rankEntries([], queryTermsFrom({ user: "postgres" }), OPTS), []);
  assert.deepEqual(rankEntries([entry("a", "alpha", "alpha")], new Map(), OPTS), []);
});

test("rendered fields are clipped so one entry cannot fill the window", () => {
  const long = entry("a", "postgres", `${"postgres ".repeat(50)}`);
  const ranked = rankEntries([long], queryTermsFrom({ user: "postgres" }), {
    perKindLimit: 10,
    contentChars: 20,
  });
  assert.ok((ranked[0]?.entry.content.length ?? 0) <= 20);
});

test("the digest says it is not an instruction", () => {
  // Injected text that reads like an instruction is an instruction, which is the
  // distinction context.ts draws for compaction summaries too.
  const ranked = rankEntries(
    [entry("a", "postgres tuning", "postgres was approved 6 times")],
    queryTermsFrom({ user: "postgres" }),
    OPTS,
  );
  const text = formatForPrompt(ranked, "2026-10-07");
  assert.match(text, /not instructions/);
  assert.match(text, /changes a policy/);
  assert.match(text, /not permission to act/);
});

test("an empty ranking renders nothing rather than an empty section", () => {
  assert.equal(formatForPrompt([], "2026-10-07"), "");
});