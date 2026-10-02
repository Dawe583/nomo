# VOID roadmap, Q4 2026

Status: sequencing document, 2026-09-28. This is not a status ledger. It says
what the next work is and in what order, and it points at the ledgers that
record what is true. If it is ever used as a ledger it will become a fourth one
and reproduce the problem phase 0 exists to fix.

## Where the product actually stands

The thesis has not changed. VOID is a process between an AI agent and the tools
it can write to: it decides a reversibility class, applies an operator policy,
appends a signed record to a hash-chained ledger, and can later replay a
verified inverse. That sentence is in `CONTEXT.md` and every piece of the
product is derived from it.

What the research behind this roadmap established, and what it did not:

- **The engineering core is real.** A governed write-path proxy over stdio, a
  signed hash-chained ledger with a dependency-free standalone verifier, a
  fail-closed policy engine, a reversibility registry with 268 entries, three
  legacy capture-and-inverse bindings, four managed adapters, and a managed
  runtime for filesystem, Postgres and Git. The gate that produces the number
  is `node scripts/src/check-tests.mjs`. Its last line read `13 suites, 1846
  tests`, exit 0, on 2026-09-29, and that reading is historical rather than
  current: the runner discovers its suites from the tree and now sees ten
  package suites plus control-plane, scripts, cloud and two Python suites.
  No total is restated here, because the current total has not been measured
  by a full run on this date.
- **The central claim is narrower than the marketing.** "Signed and verifiable"
  is true, and it is worth saying: the signature proves a process holding a key
  wrote the bytes and the chain is internally consistent. Nothing more. Until
  the signer and the executor are separated, the word "trust" is not available
  and the product says "record". `OPERATIONS.md` is the honest version and the
  website should quote it rather than paraphrase it.
- **Three of the 268 registry entries are executable, and they are not the whole
  executable surface.** The three are the legacy proxy root's binding names, the
  other 265 are description, and four managed adapters are executable under
  names that are not registry entries at all. A reader who counts 268 and then
  finds three has been misled, and that number is a liability until the pipeline
  exists or the claim changes. The errata at the end of this document states the
  two denominators and what executable means for each.
- **The strongest external evidence is negative.** Two independent research
  passes found no security team buying signed, attributable agent action, and no
  competitor above a few thousand stars. This is a reasonably strong negative,
  not an absence of evidence, and it is the reason the wedge below is a
  bet rather than a forecast.
- **The product has no first user yet.** The repository is private, the
  advertised download page does not resolve, and the npm name is taken. One
  package is publishable today: `@void/verifier` sets no `private` flag and
  needs no build step, because it ships one executable file of Node built-ins,
  which `scripts/src/licence-line.test.mjs` asserts; the other nine manifests
  under `packages/` all set `private: true`. A push from a developer machine works, so the
  credential problem recorded in `RELEASE.md` is no longer the blocker it was.

## Phase 0: fix the record, or nothing else is trustworthy

Three ledgers with three unrelated ID namespaces, an audit that predates two
settled decisions and still lists them as open, and a plan-status file whose
"not started" rows are false against the tree. The audit's own closing
recommendation is to collapse them, and the status index records that this is
still not done.

| Task | Acceptance |
| --- | --- |
| Refused 2026-09-26, do not execute: collapse the three ledgers into one with a stable ID and a date; archive the other two rather than deleting them, because the history is why the work exists | Refused by the scope answer in `docs/DECISIONS.md`, repeated in `docs/STATUS-INDEX.md`. The index stays, and each closed item is recorded once, in the closed table inside `docs/OPEN-WORK-AUDIT.md` |
| Re-run the open-work audit against the current commit and correct the rows the decisions already answered | the companion write-scope row and the architecture row are no longer open decisions, because `DECISIONS.md` answers both |
| Name the one unreproduced test failure or explain it | the matrix row stops saying an unnamed failure is open |
| Record the 2026-09-28 platform decision in the pack | see `PLATFORM-REDESIGN-PLAN.md` phase 0 |
| Decide the certification question in writing, or record that the permanent answer is false | there is a dated answer, and the capability schema has a place to record it |

This phase is unglamorous and it is first because every later claim of progress
rests on the record being true.

## Track A: make the central claim true

Ranked by `docs/COMPETITIVE-WEDGE.md`, which is the most recently written and
the only strategy document that read the source while writing.

| Rank | Capability | What it changes | Depends on |
| --- | --- | --- | --- |
| A1 | A provable inversion of a non-filesystem effect | Every effect with a real inverse emits a signed reversal record on the same chain, and the Postgres path re-reads after writing and refuses a mismatch, as it already does, while S3 gains the same post-write verification and a durable receipt. The surface is one `void verify` line a person can hand to somebody else. | nothing, this is the first increment |
| A2 | The record that authorises the effect names what authorised it | `attribution` on the workbench record, plus the model id and a request digest, shipped in the same release as A1, because alone it is a field set | nothing, but ship with A1 |
| A3 | The effect in the decision | A machine-checkable effect on the registry case for Postgres and S3, a new policy key, and a `void policy explain` subcommand | A1 and A2 |
| A4 | Signer and executor separation | The trust-model fix that `docs/REVERSE-WEDGE.md` names as gating everything downstream, including the analysis-assertion record | external, needs a second principal |

A1 is the only capability no competitor has and it is most of the way built. A2
alone would be a field set; together with A1 they are a product. A3 is
invisible until A1 and unauditable until A2, which is why it is last. A4 is the
hardest item in the whole set and it has been deferred twice already, which is
itself the argument for putting a date on it.

The one piece of research that argues for a different order is the analysis
assertion record: a re-derivable claim binding an assertion to a file digest
and a byte range, verified by the standalone verifier. It is a genuinely
unclaimed property, it is small, and it is the first increment on the other
flank. It is not scheduled here because the same source says the trust-model
fix gates it, and A4 is gated on nothing we control.

## Track B: the first real user

The first user is a post, not a registry listing. Nothing in Track A is worth
anything to a person who cannot install the thing.

| Rank | Task | Gate | Depends on |
| --- | --- | --- | --- |
| B1 | Build the open packages: registry, ledger, policy, proxy, then the CLI | each package produces files a clean install can run, which `scripts/src/release-packaging.test.mjs` already knows how to assert | the npm scope |
| B2 | Own the npm scope and authorise publishing | a human decision, not code | nothing, start now, it is the longest lead time |
| B3 | A gated publish workflow with an explicit package allowlist, a protected environment, provenance, and a clean-install test | a green run on a pushed commit, not a green local suite | B1, B2 |
| B4 | Publish the standalone verifier on its own, with the export-bundle fixtures a third party needs | an independent person fetches it and verifies a bundle | B2, B3 |
| B5 | Docker image, a five-minute quickstart on a clean machine, and a listing in the official MCP registry | the three exit commands the execution plan names, with their output read | B3 |
| B6 | Decide the package name, because `void` and `void-cli` are taken | a recorded decision | B2 |

B2 is the item most likely to sit still, because it is the only one that needs
somebody else to do something. Start it first and do not plan around it.

## Track C: the platform redesign

Full plan in `PLATFORM-REDESIGN-PLAN.md`, appearance in
`APPLE-DESIGN-SYSTEM.md`. In one line: the iOS app, a new macOS target and the
web control plane take the system look, on one token source, with the terminal
untouched.

The honest cost, stated because it is not in the platform plan itself: this is
roughly a quarter of the available sessions for the next two months, and it is
the largest single claim in the roadmap. The research in
`docs/VOID-FUTURE-DIRECTION.md` argued the opposite, that the Apple product
should be dropped and the ledger shipped. The user has overridden that on
2026-09-28. The override is recorded, and so is its price: Track A does not get
faster, and if A1 slips past the redesign the product will have three handsome
surfaces describing a claim that is still only partly true.

## Track D: honesty as a work item

Not glamorous, and the repository is unusually good at it already, which is why
it is a track rather than a value.

| Task | Why |
| --- | --- |
| Promote the qualification from the review documents into the README | the asset that matters most externally is buried in an internal review |
| Replace the word trust with record everywhere a person can read it | until signer separation exists, the stronger word is not available |
| Reconcile the registry count claim, or stop making it | 268 entries against three legacy bindings and four managed adapters is a liability in that order, because the two are not one ratio; the errata states both |
| Fix the five mobile web rules the stylesheet cascade silently defeats | they are already specified and already defeated, which is worse than either |
| Give every connector one honest conformance fixture, and compose the standalone host | a passing test over a mocked client is the failure mode of an undo feature |
| The site claims audit | illustrations that look like measurements are the thing this repository criticises elsewhere |

## Sequence

| Order | Phase | Size in sessions | Blocked by |
| --- | --- | --- | --- |
| 1 | phase 0, the record | 3 | nothing |
| 2 | B2, the npm scope | 1 human action, then 1 | nothing, start in parallel with 1 |
| 3 | A1 and A2, the provable inversion and its attribution | 8 | nothing |
| 4 | B1, the buildable packages | 6 | nothing, parallel with 3 |
| 5 | C phase 0 and 1, the substrate and the token source | 3 | phase 0 |
| 6 | B3, the publish workflow | 3 | B1, B2 |
| 7 | C phase 4, the web rebuild | 10 | C phase 1 |
| 8 | A3, the effect in the decision | 5 | A1, A2 |
| 9 | C phase 2, the iOS alignment | 6 | C phase 1 |
| 10 | B4 and B5, the verifier publication and the quickstart | 5 | B3 |
| 11 | C phase 3, the macOS target | 20 | C phase 1, C phase 2 |
| 12 | C phase 5, the acceptance evidence | 6 | C phases 2, 3, 4 |
| 13 | B6 and the public release gate | 4 | B3, B5 |
| 14 | A4, signer and executor separation | external | a second principal |

About 80 sessions of work plus two external gates, at three sessions a week,
which is roughly seven months. That number is the reason the order matters: the
first user arrives at step 10, the macOS client at step 11, and neither depends
on the other.

Two things would shorten it materially and both are worth saying out loud:
shipping the ledger and the verifier first, without the macOS client, would
reach the first user about six weeks earlier; and if the analysis-assertion
record is chosen over the macOS client, roughly fifteen sessions buy a
differentiated property instead of a second platform.

## What would make this roadmap wrong

- **If nobody wants the record.** The strongest available evidence says no
  security team is buying this today. If the first post gets no reply and the
  second gets none, the honest conclusion is that the wedge is a hobby, and the
  right response is to say so in the README rather than to add a surface.
- **If the inversion cannot be made provable.** A1 assumes the post-write
  verification generalises from Postgres to S3. If it does not, the central claim
  narrows to the filesystem, which is the one place the market already has
  solutions, and the wedge closes.
- **If the platform work turns out to be a rewrite.** The macOS target is
  twenty sessions on a codebase nobody has run in a month. If it passes a third
  of that without a working client, the right move is to stop and record that,
  which is cheaper than the shipped alternative, which is an empty sidebar.
- **If the record is not fixed first.** Everything above is a claim about a
  codebase whose own status files disagree with each other about what exists.
  That is the one failure mode this repository has already demonstrated it can
  fall into, and it is why phase 0 is first rather than last.

## How to read the rest of the documents

`CONTEXT.md`, `DECISIONS.md` and `STANDARDS.md` are authoritative when this
document and the code disagree. `docs/COMPETITIVE-WEDGE.md` is the most
recently written strategic document and the only one that read the source while
writing it. `docs/PREMISE-VERIFICATION.md` is a correction filter for
`docs/VOID-FUTURE-DIRECTION.md`, not a strategy source, and the two disagree in
several places where the correction is the right one. `docs/OPERATIONS.md` is
the honest limit of every security claim; quote it rather than summarising it.

## Errata, 2026-09-29: what above is wrong, and what was measured

This section corrects the roadmap above and nothing else. It adds no task, no
estimate and no order, because the document it corrects is a sequencing
document and a second ledger here would be the fault the roadmap names in its
own first paragraph. Every line below replaces a line above it, and each names
the measurement that replaces it. Where a measurement could not be taken, the
line says so rather than carrying the old number forward.

**1. Phase 0 row 1 is refused, and the refusal is dated.** The row asks for the
three ledgers to be collapsed into one. The scope answer in
`docs/DECISIONS.md` ("One status index, not one status ledger", 2026-09-26)
considered the collapse and rejected it, and `docs/STATUS-INDEX.md` repeats
that refusal. This roadmap's own reading guide makes `docs/DECISIONS.md`
authoritative over this document, so the row is marked refused in place and the
dated decision stands; a sequencing document does not get to reverse it. What
the row becomes instead is the two halves the decision actually leaves: the
index stays, and each closed item is recorded once, in the closed table inside
`docs/OPEN-WORK-AUDIT.md`, so a reader who arrives at the audit first does not
rebuild finished work. The row is not deleted, because a reader comparing this
roadmap against the decision log has to be able to see that the two disagreed
and that the decision log won.

**2. The test count was asserted rather than measured, and is now named.** The
sentence above used to say "about 1,800 tests green as of 2026-09-28", a
number nobody had run. The first run on 2026-09-29 of
`node scripts/src/check-tests.mjs` printed `13 suites, 1817 tests` and exited
1: the `scripts` suite reported 150 passing and one failing, the failure being
"every static theme-color equals the canvas token of the page it belongs to" at
`scripts/src/design-token.test.mjs`, a file a concurrent change was editing at
the moment of the run. That figure proved nothing about a settled tree, so it
was not promoted to a count and the old figure was not replaced with a guess.
The settled run is the one that counts. Run again the same day against a tree
no concurrent change was touching, the same command printed
`13 suites, 1846 tests` and exited 0, and all thirteen suites reported zero
failures, so the green count is now measured rather than asserted. The count
is reproducible: run the command, and its last line is the count.

**3. "Three of the 268 are executable" is one denominator stated as two.** The
registry has 268 entries, counted by importing `registry` from
`packages/registry/src/registry.ts` and taking its length. Executable means two
different things in this repository, and they do not share a denominator:

- **The legacy proxy root, three bindings, all three of which are registry
  entries.** `LEGACY_BINDING_NAMES` in `packages/proxy/src/legacy-root.ts` is
  exactly `postgres.row.update`, `postgres.row.delete` and
  `aws.s3.object.delete`, and it is the only set the legacy production root will
  bind. Each of the three is a registry entry id, so 3 of the 268 are
  executable through that root and the other 265 have no binding there at all.
  The in-code rationale is that a name earns its place only when a connector can
  capture a before image and invert it, which is why `aws.s3.object.put` is
  present in the registry and deliberately absent from the set: a put
  overwrites bytes the root has never read.
- **The managed path, four adapters, none of which is a registry entry.**
  `providerProfiles` in `packages/cli/src/conformance.ts` publishes
  `filesystem.managed`, `git.managed`, `managed-documents` and
  `postgres-managed-conformance`, the last one scoped to the configured
  workspace rather than to a provider. These four run the shared conformance
  case list in `runAdapterConformance`, and they are named by adapter id, so
  they are not four of the 268. A managed adapter declares its own
  `reversibility` class, as `packages/connectors/src/filesystem/managed.ts`
  does with `r1`, rather than inheriting one from a registry entry.
- **The set is fail-closed, which is the part worth publishing.**
  `resolveProviderProfile` in `packages/connectors/src/capability-profiles.ts`
  throws for an adapter id the set does not publish and names the ids that do
  exist, and `declareProviderProfiles` refuses a set whose profiles do not fit
  `void.adapter-capability.v2`, so an adapter cannot ship unnamed.

The honest sentence is: 268 registry entries, of which 3 are executable through
the legacy proxy root, and 4 managed adapters that are executable under names
outside the registry. "3 of 268" is true, is about one surface, and reads as a
ratio over the registry, which is why it is corrected here rather than repeated.
The other documents that quote the ratio carry the same correction: the
registry count is 268, not 270.

Two phase 0 rows above are partly discharged by the same re-run, and their dated
record is in `docs/OPEN-WORK-AUDIT.md`, not here. The audit re-run row is met:
the rows the decisions already answered are in a closed table dated 2026-09-29.
The row that asks for the unnamed test failure to be named or explained is
answered in the audit's own terms, by stating that the run which produced it was
not retained and that the failure therefore cannot be named. Its acceptance
criterion names `docs/RELEASE-1.0.1-MATRIX.md`, and that document still records
the failure as open; correcting another ledger is not this errata's business, so
the remaining disagreement is stated here rather than fixed silently.
