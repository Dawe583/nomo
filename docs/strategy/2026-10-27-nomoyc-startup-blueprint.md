# NOMO x YC Winter 2027: startup blueprint

> Status: founder working plan, last reviewed 2026-10-27. No customer workflow, segment, pricing, or demand is validated. This document is the current index and decision frame for the adjacent YC ideas.

## Decision in one page

Build one customer outcome, not three YC ideas at once. The long-term thesis is a general company knowledge and work platform that can serve multiple industries. Use **The $15-an-Hour Expert** as the first outcome to test: help a non-specialist complete one repeatable, expert-gated task with approved evidence, visible uncertainty, and human escalation. A general platform still needs one narrow first workflow to prove value and prevent months of speculative platform work. The only current route to a buyer is a founder-reported direct contact with a Czech SME owner or CFO. That contact has not been asked for a meeting. It is an interview route, not a choice of finance as the target vertical. We do not yet know which task, role, or sector is worth building for.

Use **Own Your Intelligence** as a later improvement loop after customers run the first workflow and experts review real corrections. Start with customer-owned sources, versions, evaluation cases, retrieval, and approved changes. Do not start by fine-tuning a model.

Treat **AI for the Air-Gapped Economy** as a deployment profile that exists only when a qualified buyer names a written no-egress requirement and funds the extra engineering and support. Customer-controlled or local inference may be evaluated sooner, but a local model, VPC, on-prem deployment, and a true air gap are different promises.

Continue the coding-agent Harness, TUI, and NOMO first-live work as its own release gate. Run customer discovery in parallel now. Do not make the product work wait for every planned NOMO control-plane feature, and do not claim that the current coding Harness is already a general business-process runtime.

## How the three ideas fit

| YC idea | First role in our plan | Entry condition | Stop condition |
|---|---|---|---|
| The $15-an-Hour Expert | The user outcome and first workflow hypothesis | One repeated task, named operator and expert, approved examples, measurable baseline, and a buyer who will fund a pilot | The same job is not repeated, the incumbent already solves it, no usable evidence can be shared, or the buyer will not commit |
| Own Your Intelligence | Customer-owned source and evaluation improvement loop | Repeat usage plus expert-reviewed corrections and permission to retain the resulting evaluation data | Better source curation or prompt/retrieval changes solve the problem more cheaply, or improvement cannot be measured |
| AI for the Air-Gapped Economy | Optional deployment tier for a proven workflow | Named security owner, written no-egress requirement, representative test, paid pilot, hardware and support budget | No buyer funds offline operations, or support and deployment cost exceed contract economics |

These are layers of one possible company, not three products to build in parallel. The first layer can succeed without the other two. A customer who wants a private or local model may still accept approved cloud inference under a contract. A customer who wants an air gap may not need a learning loop.

## Customer and market starting point

Start discovery in Czechia because the founder reports local access to one owner or CFO. That is a channel for one conversation, not market proof or a finance-sector decision. Search across industries for a repeated, costly task where a non-specialist needs expert guidance. Move to the EU only after one problem and buyer are understood well enough to repeat the test in a second country.

Keep the initial customer description deliberately broad but testable: a Czech company whose operator repeatedly handles a costly task requiring expert knowledge. The owner/CFO contact is the first reachable interviewee, not the assumed user or buyer for every sector. The exact company size, industry, task, operator, expert, and budget owner remain open. Interview the process owner and operator before selecting a product.

Do not declare invoice reconciliation, month-end close, accounting, construction, or field service as the chosen wedge. Current finance incumbents already ship AI features. Select a workflow only after the buyer reconstructs a recent case and an expert confirms what correct completion means.

## What we know and do not know

### Verified public facts

- YC describes The $15-an-Hour Expert as AI augmenting ordinary workers to complete work that previously required specialists. YC lists benefits, taxes, insurance claims, medical billing, immigration paperwork, mergers and acquisitions, supply chain, and global trade as examples. YC explicitly says its RFS list is only a fraction of what it funds and is not a requirement for applying.
- Eurostat reports that 20.0% of its 2025 ICT survey population used AI. The survey covers enterprises with 10+ employees or self-employed persons in NACE Rev. 2 C–J, L–N and group 95.1, excluding micro-enterprises and financial/insurance activities (NACE K). ČSÚ reports 17.6% for Czech enterprises with 10+ employees. Neither figure measures buyer demand or willingness to pay.
- Eurostat reports 52.7% of surveyed EU enterprises with at least 10 employees or self-employed persons used paid cloud services in 2025. The 58.2% figure for paid finance/accounting applications is among enterprises using paid cloud services, not all surveyed enterprises. Neither figure establishes permission for a separate model API.
- Microsoft's Finance Agent, Intuit's accounting AI, and Xero's reconciliation capabilities make generic finance chat or reconciliation a weak differentiation claim.
- Glean, Dust, and Onyx already market enterprise knowledge, agents, governance, or customer-controlled deployment. Onyx publicly offers air-gapped deployment. These are vendor claims and product evidence, not proof of market success or an exhaustive competitor list.
- Czech ÚOOÚ says publicly available contact details alone do not permit unsolicited commercial email, including to legal entities. A company database is not an outreach permission record.

### Internal facts

- NOMO has a coding-agent Workbench and Harness, signed ledger paths, policy/approval boundaries, control-plane and fleet specifications, and a working tree with ongoing Harness/TUI changes.
- The current TUI is an operator surface. It is not yet a worker-facing finance application.
- The Harness learning path applies to governed code changes. It does not by itself create a customer knowledge base, tenant-isolated retrieval, or a finance workflow.
- Papayai is potential founder dogfood and prospect-research tooling. Its README describes a hosted NVIDIA inference path and Supabase persistence. Do not describe it as a local customer-data plane.
- The current NOMO checkout is heavily modified. Strategy documents describe proposed work and do not change the code's release status.

### Unproven

- Whether the CFO will meet, whether any one task repeats, whether a worker or expert experiences material pain, whether a buyer has a budget, whether customer cases can be authorized, whether the buyer bans API inference, and whether NOMO reduces cost or risk.

## Product promise to test

Help a worker finish one named task with the correct customer-approved context, show the evidence and missing information, and route judgment or action to the right human. The promise is a measurable work result, not an AI model, an audit ledger, or a privacy adjective.

A successful answer may be: supported answer, needs-input question, source conflict, abstention, or human escalation. The first product writes nothing to a customer's operational system. A citation is not proof that the conclusion is correct. A confidence score is not a safety case.

## NOMO's role

NOMO should enter where an agent needs an identity, bounded scope, a policy decision, a hold, an approval, a controlled tool call, and verifiable evidence. Keep customer files, retrieved passages, prompts, answers, and corrections in the customer's approved data plane, not in the append-only evidence ledger. The ledger should record only the minimum references and decision evidence allowed by the customer.

The first pilot may use only a subset of NOMO. Do not force a distributed fleet, hosted control plane, TUI, or every connector into an MVP if a read-only workflow can be validated with a simple web or mobile surface. Do not use the TUI as a substitute for a worker product.

## Release order

1. **Now, while NOMO ships its first live coding Harness:** run one-to-one discovery through approved relationships, validate the first problem, audit recent in-scope assets, and prepare a concierge evaluation set. No customer product code yet.
2. **After discovery:** run an expert-reviewed concierge on permissioned, minimized examples. Compare against the current human and incumbent process.
3. **After quality and budget evidence:** deliver one read-only workflow for one team. Start with customer-approved inference and a documented data boundary. No silent cloud fallback.
4. **After paid repeated use:** evaluate one bounded, reversible action through the supported NOMO policy, hold, approval, and evidence path.
5. **After the workflow improves with reviewed corrections:** ship source versioning and customer-owned evaluation, then test any model adaptation against simpler baselines.
6. **After a buyer pays for no-egress:** build and validate the air-gapped deployment package as a separate operating mode.

## First decisions still open

- Which recent job does the CFO reconstruct?
- Who performs that job, who validates it, and who can authorize sample data?
- Which current system or accountant already handles it?
- What exactly can leave the customer environment: prompts, documents, outputs, metadata, telemetry, logs, or update checks?
- Which permitted channel reaches additional buyers in Czechia?
- Which part of NOMO is already releasable versus still planned?
- What would the buyer pay for, from which budget, and by what date?

## Document set

| Document | Purpose |
|---|---|
| `2026-10-27-nomoyc-market-and-competition.md` | Market facts, competitors, evidence limits, and positioning |
| `2026-10-27-nomoyc-expert-workflow-product-spec.md` | First product boundary and workflow contract |
| `2026-10-27-nomoyc-nomo-integration-plan.md` | Exact NOMO reuse boundary and post-Harness build sequence |
| `2026-10-27-nomoyc-own-your-intelligence.md` | Later customer-owned intelligence product and gates |
| `2026-10-27-nomoyc-air-gapped-deployment.md` | Air-gap product and operational readiness |
| `2026-10-27-nomoyc-leadspicker-and-sales.md` | Czech-first discovery, sales process, lead provenance, and legal guardrails |
| `2026-10-27-nomoyc-evaluation-and-economics.md` | Canonical quality, outcome, cost, and paid-pilot measurement protocol |
| `2026-10-27-nomoyc-evaluation-and-pilot-plan.md` | Pilot checklist; use with the canonical measurement protocol, not as a second independent threshold source |
| `2026-10-27-nomoyc-integrated-roadmap.md` | Cross-idea timeline and release gates |
| `2026-10-27-nomoyc-index.md` | Navigation for the complete document set; this blueprint is the canonical decision frame |
| `2026-10-27-nomo-field-expert-*.md` | Superseded alternate field-service scenario; do not execute unless new buyer evidence reopens it |

## Sources

See the market memo for dated links and methodology. Core sources include YC Winter 2027 RFS, Eurostat AI and cloud data for 2025, Czech Statistical Office ICT data, official vendor product and deployment documentation, the European Commission AI Act page, and Czech ÚOOÚ marketing-email guidance.
