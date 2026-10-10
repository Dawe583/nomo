# Where NOMO should go, and what is left to build

Written 2026-10-04 against `main` at the amendment-seven merge. **This document exists because the
positioning it inherits is wrong**, not because the research was thin. Two claims in
`COMPETITIVE-WEDGE.md` that read as settled a month ago are now false, and both were found today
by reading vendor pages rather than by reasoning about them.

Every external claim here names a page fetched on the date in the Appendix.

---

## 1. The finding that changes the strategy

**Rubrik ships "undo for AI agents", and has since August 2025.**

Agent Rewind launched 2025-08-12, built on Predibase infrastructure acquired by Rubrik. Rubrik's
own words: *"Agent Rewind makes previously opaque AI actions visible, auditable, and reversible,
creating an audit trail and immutable snapshots that facilitate safe rollback"*, and *"Safe Rollback:
Uses Rubrik Security Cloud to rewind what changed, whether that's files, databases,
configurations, or repositories."*

Since then it has widened twice:

- **2026-06-09**, Rubrik Agent Cloud for Claude Code and Claude Cowork: *"the industry's only agent
  rewind to reverse unintended actions, and immutable codebase recovery when an incorrect action
  outruns version control."*
- **2026-08-04**, Rubrik Agent Identity: *"Rubrik Agent Cloud now monitors every agent and MCP
  server, controls access per tool call, and remediates unwanted actions."*

`COMPETITIVE-WEDGE.md` §4.3 says *"No competitor has any part of that sentence"* about a verifiable
inverse. **That is no longer true and must not be published again.** A listed company, the leader
in data protection, with the incumbent relationship and the existing contract, has the exact
positioning line.

**The market is not empty. It is being taken by people with distribution, and it is being taken
now.** Everything below is written against that.

## 2. The rest of the field, in one table

| player | what they own | where they sit | what they do not do |
|---|---|---|---|
| **Rubrik** | undo, audit, per-tool-call control, agent identity | beside the system, in Rubrik Security Cloud | nothing lands in the customer's own database |
| **Oracle** Deep Data Security (2026-03-23) | identity-aware authorization for agents in AI Database 26ai | **inside** the database | prevention, not recovery; and only Oracle estates |
| **Cloudflare** MCP portals | the chokepoint; refuses bypass since 2026-09 | at the edge | cannot understand a row write |
| **Okta, IBM, Omada, ServiceNow/Veza, Aembit** | non-human identity and delegation | beside the agent | nothing about the effect |
| **Bytebase** | database governance for AI agents | beside the database | governance, not inverse |
| **agentreceipt.org** | claims cryptographic agent receipts outright | — | a landing page, not a product |

And the demand trigger is documented and public, which is genuinely good news and bad news:
at least nine incidents in which a coding agent deleted production data, indexed by OECD.AI's
incident monitor. The PocketOS case alone — a Cursor agent running Claude Opus 4.6 deleted the
production database **and its backups in nine seconds**, 30-hour outage — was carried by Inc,
Fast Company, Business Insider, Fortune and Euronews within a day, and is in the AI Incident
Database as record 1469.

**The trigger is real. The response went to Rubrik, not to anybody new.** That is the sentence
that matters commercially, and it cuts both ways: the pain is real enough to generate headlines,
and the incumbent already answers it.

## 3. What actually survives, and it is narrower than §4.3

Two properties are not claimed by anyone above.

**a. Point-in-time restore is not an answer for a live system.** Rubrik's mechanism is
immutable snapshots and restore. Restoring a production database to 14:03 discards every
legitimate write after 14:03. For a database with humans and agents writing concurrently — which is
the only place this problem is expensive — a coarse restore is not usable. NOMO restores **the
affected rows and nothing else**, and leaves everything written since untouched.

This is a structural difference, not a feature gap. It is also why nobody with a backup-shaped
product can simply add it: a per-effect inverse needs before-images at the row level and a proven
re-derivation of the original state, which is a different engineering discipline from snapshot
management.

**b. The receipt lands in the effect's own system.** After a verified Postgres restore, NOMO writes
a durable signed record into `${schema}.recoveries`, in the customer's database. A third party
verifies the restoration by querying it, without trusting NOMO, its key or its ledger. Every
vendor above keeps the audit in their own product. Rubrik's audit lives in Rubrik Security Cloud;
Oracle's lives inside Oracle.

Property (b) is a genuine structural weakness for them: centralising the evidence is what makes
their products profitable, and they cannot hand it to the customer without giving that up.

**This is the whole remaining moat, and it is one sentence.** If the strategy is not built on
(a) plus (b), there is nothing to build.

## 4. Standards are converging on NOMO's vocabulary

Four IETF drafts now describe what NOMO already does, and one is NOMO's claim almost verbatim:

- `draft-sahu-agent-action-receipts-00`, "Signed, Hash-Chained Action Receipts for AI Agents",
  2026-08-16, Informational.
- `draft-sharif-agent-audit-trail-06`, Standards Track, 2026-09-29.
- `draft-stone-aivs-00`, "Agentic Integrity Verification Standard", 2026-03.
- `draft-birkholz-verifiable-agent-conversations-records`, IETF 125.

Two consequences, opposite in sign. **It validates that the problem is legible.** It also means
"we sign the ledger" is now a published format rather than a differentiator, so a pitch built on
the signature is finished. Only the placement of the receipt still differentiates.

## 5. The buyer, stated as specifically as the evidence allows

Not "a security team". The incident buyers went to Rubrik and to their cloud provider, and that
is the segment Rubrik and Oracle address. The segment nobody above addresses is:

> **A team running agents against a production Postgres where a full restore is not acceptable,
> because humans and other systems are writing concurrently.**

That is a database-platform or SRE conversation, not a security conversation. It is smaller, and
it is the one where (a) is decisive and where Rubrik's restore model actively disqualifies them.

The honest read of `COMPETITIVE-WEDGE.md` §6 still holds and still binds hardest: nobody is
shopping for this category. Rubrik's eight-figure position in it is not evidence of demand for a
new entrant, it is evidence that the incumbent captured the demand that existed.

## 6. What I would do, in order

1. **Rebuild the pitch around (a), not around undo.** The sentence is: *rewind one effect in a live
   system without rewinding everything else.* Rubrik cannot say it, because its mechanism is a
   restore.
2. **Publish one (b) receipt.** Take the PocketOS-shaped incident, run the real inverse against a
   real Postgres, publish the signed record from `${schema}.recoveries` and the query a third party
   runs to check it. That is a demo that cannot be faked and that no landing page competes with.
3. **Correct §4.3 of `COMPETITIVE-WEDGE.md` today.** It currently asserts a competitive
   uniqueness that Rubrik has occupied for a year. That is the exact drift this repository's gates
   were written to stop, and it is the first thing a buyer or a reviewer would catch.
4. **Do not build a second inverse.** More adapters do not change the argument; a second proved
   adapter in the same live-concurrency story does.
5. **Do not chase identity, prevention or the MCP gateway.** Okta, IBM, Omada, ServiceNow, Oracle
   and Cloudflare are there, with distribution, and none of them is going to lose.

## 7. The case against this recommendation, stated plainly

- The moat is **one sentence**. Rubrik, Oracle or the database vendor a customer already uses can
  decide to build it, and (b) is a data-model change they could ship.
- The buyer is **narrower** than the incident headlines suggest, because most of those companies
  have a cloud provider and a backup product and will use them.
- The strongest version of the competitor's position is that a customer with Rubrik already has
  "undo for agents" in the contract, and the argument has to survive that sentence being true.

If a single publicly checkable (b) receipt does not produce two design partners who will pay, the
honest conclusion is that this is a well-built open-source tool and not a company, and that should
be said in the README rather than answered with another surface. `COMPETITIVE-WEDGE.md` §6 already
predicts that outcome and would be right.

---

## Appendix — what was fetched, 2026-10-04

| source | what it established |
|---|---|
| `rubrik.com/.../rubrik-unveils-agent-rewind-for-when-ai-agents-go-awry`, release PDF via the company's own q4cdn, dated 2025-08-12 | Agent Rewind launch, Predibase acquisition, "audit trail and immutable snapshots", "rewind what changed, whether that's files, databases, configurations, or repositories" |
| `ir.rubrik.com/.../rubrik-launches-rubrik-agent-cloud-for-anthropics-claude-code`, 2026-06-09 | "the industry's only agent rewind", immutable codebase recovery |
| `rubrik.com/.../rubrik-unveils-agent-identity-to-secure-agentic-actions-in-real-time`, 2026-08-04 | per-tool-call control over agents and MCP servers, "remediates unwanted actions" |
| `oecd.ai/en/incidents/2026-04-27-6153`, read in full | PocketOS: nine seconds, database and backups gone, 30-hour outage, AI Incident Database 1469, and the monitor's own classification as harm to property |
| `blogs.oracle.com/database/introducing-oracle-deep-data-security...`, 2026-03-23 | identity-aware authorization for agents, database-native, inside Oracle AI Database 26ai |
| `developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals`, page updated 2026-10-02 | centralised MCP portals, tool and prompt curation, Code Mode, Gateway DLP routing |
| `datatracker.ietf.org` for `draft-sahu-agent-action-receipts-00`, `draft-sharif-agent-audit-trail-06`, `draft-stone-aivs-00`, IETF 125 slides for `draft-birkholz-verifiable-agent-conversations` | four drafts and their dates |
| Forrester Okta recap, ServiceNow/Veza, Omada release, Aembit ranking, IBM solution page | the identity wave, cited only as a direction, not as a competitive finding |
| `agentreceipt.org` | a landing page claiming cryptographic agent receipts; no product found behind it |

Not verified and not claimed: Rubrik's per-effect granularity, whether any of them write anything
into a customer's own database, and whether Rubrik's Agent Rewind is generally available at scale as
opposed to announced. The release itself carries a Safe Harbor statement, which is why the claim
above is that the positioning is taken, not that the feature is ubiquitous.
