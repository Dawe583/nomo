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
  executable capture-and-inverse paths, and a managed runtime for filesystem,
  Postgres and Git. The workspace gate runs 13 suites and about 1,800 tests
  green as of 2026-09-28.
- **The central claim is narrower than the marketing.** "Signed and verifiable"
  is true, and it is worth saying: the signature proves a process holding a key
  wrote the bytes and the chain is internally consistent. Nothing more. Until
  the signer and the executor are separated, the word "trust" is not available
  and the product says "record". `OPERATIONS.md` is the honest version and the
  website should quote it rather than paraphrase it.
- **Three of the 268 registry entries are executable.** The other 265 are
  description. A reader who counts 268 and then finds three has been misled, and
  that number is a liability until the pipeline exists or the claim changes.
- **The strongest external evidence is negative.** Two independent research
  passes found no security team buying signed, attributable agent action, and no
  competitor above a few thousand stars. This is a reasonably strong negative,
  not an absence of evidence, and it is the reason the wedge below is a
  bet rather than a forecast.
- **The product has no first user yet.** The repository is private, the
  advertised download page does not resolve, the npm name is taken, and no
  package is publishable.
- **Remote CI ran green once and now cannot start at all.** Verified
  2026-09-28: three runs succeeded on 2026-09-25, one `ci` and two
  `cloud integration`, and every run since has failed within four seconds with
  "The job was not started because recent account payments have failed or your
  spending limit needs to be increased". A push from a developer machine works,
  so this is an account condition rather than an access one, and it is the
  cheapest blocker on this roadmap to clear and the one that silently invalidates
  every remote claim until it is. `docs/RELEASE.md` and
  `docs/DISTRIBUTION-PATH.md` carried the opposite claim and are corrected.

## Phase 0: fix the record, or nothing else is trustworthy

Three ledgers with three unrelated ID namespaces, an audit that predates two
settled decisions and still lists them as open, and a plan-status file whose
"not started" rows are false against the tree. The audit's own closing
recommendation is to collapse them, and the status index records that this is
still not done.

| Task | Acceptance |
| --- | --- |
| Collapse the three ledgers into one with a stable ID and a date; archive the other two rather than deleting them, because the history is why the work exists | every open item in the old namespaces maps to a row in the survivor, and a script fails on an ID that is not in it |
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
| Reconcile the registry count claim, or stop making it | 268 entries and three executables is a liability in that order |
| Fix the five mobile web rules the stylesheet cascade silently defeats | they are already specified and already defeated, which is worse than either |
| Give every connector one honest conformance fixture, and compose the standalone host | a passing test over a mocked client is the failure mode of an undo feature |
| The site claims audit | illustrations that look like measurements are the thing this repository criticises elsewhere |

## Sequence

| Order | Phase | Size in sessions | Blocked by |
| --- | --- | --- | --- |
| 1 | phase 0, the record | 3 | nothing |
| 2 | B2, the npm scope, and clearing the account condition that stops CI | 1 human action, then 1 | nothing, start in parallel with 1 |
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
