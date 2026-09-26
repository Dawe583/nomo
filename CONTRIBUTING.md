# Contributing to VOID

VOID is one maintainer's project. This file says what actually helps, so that a
pull request is not spent discovering the ground rules by being declined.

## Sign off, do not sign a CLA

Every commit carries a `Signed-off-by:` line, the Developer Certificate of
Origin 1.1:

```
git commit -s -m "..."
```

This is a sign-off, not a Contributor Licence Agreement, and there is
deliberately no CLA. Apache 2.0 section 5 already licenses inbound contributions
under the same terms as the code, so a CLA would be redundant for the licence and
would exist only to preserve an option to relicense later. This project promises
never to exercise that option. Requiring a CLA would also put friction on
exactly the contribution the open core depends on, which is registry data.

## What gets a fast review

**Registry data pull requests are the easiest valuable contribution here.** The
reversibility registry is data: one entry per tool call, with the cases that make
its class apply. Adding or correcting an entry needs no code and no architecture
discussion. Two things make an entry good:

- Every case needs a **declared precondition**, and the entry needs a **source**
  the reviewer can check, ideally vendor documentation. An entry with no recorded
  source is an illustration, not a classification, and the disclaimer that travels
  with the data says so.
- If you are correcting an existing class, say what you observed. The class of a
  call can change with configuration, which is why preconditions are recorded
  rather than assumed.

Registry contributions are credited by name in the entry.

**The standalone verifier is frozen on purpose.** `@void/verifier` has zero
dependencies and will not acquire a build step, because a verifier that pulls in
a dependency tree inherits that tree's supply chain, and the supply chain is what
an audit is supposed to be independent of. A bug report is very welcome. A
feature request to add a library will be declined, and that is the decision
rather than a judgement about your contribution.

**Connector pull requests need prior agreement.** A connector owns a fact about
someone else's API: what state a call changes, whether an inverse exists, and
what a snapshot has to capture before the write. Getting that wrong does not
produce an error, it produces a confident false claim about recoverability, which
is the worst failure this product can have. Open an issue describing the surface
and the intended scope first.

**Feature requests need a described use case**, specifically one a solo
developer protecting one system would hit. That is the operational test the
licence line is built on: if the answer is no, the feature belongs on the paid
side, and the paid side is where organisational features go by default.

## What will be declined

- Anything that makes a hold reversible by removing it. No bypass flag, no
  auto-approve, no `bypassPermissions` equivalent. The intercept, decide and
  record sequence is the product, and a mode that skips it is a different product
  that happens to have the same name.
- A second store, a second ledger, or a second copy of the registry. One source of
  truth per fact, or the classifier and the published page can disagree about what
  a class means.
- Estimated costs, invented metrics, or fabricated vendor certifications. An
  unmeasured value is printed as `unknown`, and a catalogue entry named "Free" is
  not evidence of a zero invoice.
- A new dependency. The cryptographic budget is `node:crypto` and nothing else,
  and the test runner is Node's own. Both are load bearing, not preferences.

## Running the checks

```
pnpm run check     # typecheck plus every package suite
pnpm run build     # the deployable artifacts
```

`pnpm run check` is the gate. A pull request that needs a new gate should add
the gate and show that it fails without the change, because a check nobody has
seen fail is not evidence.

Some checks here are stricter than they first look. `scripts/src/doc-truth.test.mjs`
fails when a document names a file that does not exist.
`scripts/src/design-token.test.mjs` fails when a component grows a colour
literal or an unprefixed keyframe, and `scripts/src/licence-line.test.mjs` fails
when a package claims to be publishable without a way to produce its files. All
three exist because the corresponding drift actually shipped, and all three were
written after measuring the tree rather than from memory.

## No support obligation

There is none on the open packages, and this is a statement of fact rather than a
disclaimer. VOID is maintained by one person. Issues are read; a response time is
not promised, and a bug is not guaranteed to be fixed. If you need one, that is
what the paid tier is, and you should judge it on whether the paid features are
worth paying for rather than on whether the open core will answer your issue.

If you are reading this to decide whether to depend on VOID in something you
maintain: the ledger is tamper **evident**, not tamper proof. A database
superuser bypasses every grant and trigger, which is exactly why entries are
signed and why the verifier is independent.
