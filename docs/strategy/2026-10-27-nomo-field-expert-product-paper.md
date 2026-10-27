# NOMO Field Expert: product and market paper

> Status: exploratory prior hypothesis, not a selected vertical or validated demand, 2026-10-27.
> This paper adds a narrow application wedge on top of NOMO. It does not replace
> the Agent Identity and Fleet Control Plane direction, change security
> contracts, or claim validated demand. The later [private AI opportunity
> research memo](2026-10-27-nomo-private-ai-market-research.md) broadens the
> thesis and leaves the first customer segment open. Treat the field-service
> candidate below as unselected until that research and customer evidence are
> complete.
> The founder has since reported a direct route to an SME owner or CFO in
> finance operations and can request a conversation this week. Start discovery
> there; field service remains an alternate hypothesis, not the current lead.

## Executive summary

YC's Winter 2027 request, **The $15-an-Hour Expert**, describes AI that lets a
non-specialist perform work that previously required an expert. NOMO can support
this by combining grounded operational guidance with controlled agent actions
and an auditable record. The product opportunity is not a general-purpose field
chatbot. It is a narrow assistant for one repeatable, costly field workflow in
one underserved trade.

The prior vertical hypothesis was scaffolding, equipment rental, or adjacent
construction operations, conditional on direct operator access through the
`leseni-novak` project. That access has not been verified. The current first
discovery path is an SME owner or CFO in finance operations because the founder
reports a direct route. No meeting, workflow, or purchase signal exists yet.
Do not select a vertical based on repository names alone.

The first product should help a worker answer a concrete job question from
approved manuals, SOPs, and job context, cite every operational answer, ask for
missing details, and abstain when evidence is insufficient. It can prepare a
structured work record or next-step proposal. NOMO's existing proxy, policy,
approval, ledger, and Harness capabilities provide the control path for any
later tool action. The first pilot should remain read-only until the answer
quality and workflow are proven.

The market is already active. ServiceTitan's Atlas provides cited answers to
technicians from equipment and job data in supported trades. Microsoft Dynamics
365 Field Service has a Copilot experience for work orders and field service
data. These products disprove a broad claim that field technicians lack AI
assistants. A NOMO wedge needs a defined segment they do not serve well, a
workflow that spans the customer's existing systems, and measured business
outcomes. Nomo's audit trail alone is not a reason to buy.

Leadora's repository describes a technical documentation assistant with RAG,
citations, and enterprise positioning. It may shorten the knowledge layer
build, but its current implementation, security, tenancy, operational status,
and reuse rights have not been audited in this task. Treat Leadora as a
candidate asset, not a dependency or a production-ready claim.

## 1. Strategic fit

### YC request

YC frames the opportunity as giving ordinary workers expert-level capability
through AI, including benefits, taxes, insurance claims, medical billing,
immigration paperwork, and complex business operations. The request is a
market signal, not proof that a chosen vertical will buy.

The literal "$15-an-hour" title reflects a US labor-cost frame. It is not a
recommended Czech wage, product price, or customer savings claim. In Czechia,
the product case must use local worker economics and a measured improvement in
throughput, rework, or expert escalation.

### Why NOMO fits

NOMO's approved direction is an Agent Identity and Fleet Control Plane for
MCP-capable agents. Its proxy, policy, approvals, ledger, and Harness are
relevant when an assistant moves from answering questions to proposing or
performing actions. This creates a plausible product stack:

1. **Expert experience:** the worker gets guidance in the context of a job.
2. **Customer knowledge:** approved manuals, procedures, asset facts, and
   reviewed answers ground the response.
3. **NOMO control:** tool calls use trusted identity and scope, policy decisions,
   explicit holds, and durable evidence.
4. **Learning loop:** a manager can approve corrected or useful records before
   they become searchable knowledge. Learning never expands permissions.

NOMO's README states that the fleet identity runtime is not shipped yet. The
product paper must not claim that multi-agent fleet control, standard MCP OAuth,
distributed revocation, or production-ready identity is already available.
Implement the first pilot with existing capabilities and an explicit manual
boundary. Add runtime claims only after their current acceptance gates pass.

### Candidate assets in the user's project portfolio

| Asset | Evidence available | Proposed role | Remaining verification |
|---|---|---|---|
| `Dawe583/nomo` | README describes a governed MCP proxy, policy, holds, signed ledger, connectors, CLI, Workbench, and Harness direction. It also says fleet identity runtime is not shipped. | Trust, policy, evidence, and eventual tool execution layer. | Audit the current working tree and determine which capability is usable in a real pilot. |
| `Dawe583/Leadora` | README describes an enterprise technical-documentation assistant with RAG, source citations, and a Next.js/Supabase stack. | Candidate retrieval and document UX reference, or a separate app to integrate after review. | Verify code, hosted state, data isolation, citation quality, test coverage, licensing, and whether it still has an active user. |
| `Dawe583/leseni-novak` | Repository exists in the connected GitHub account. No README was available in this review. | Possible route to an initial construction or scaffolding discovery partner. | Confirm the business, relationship, buyer, workforce, and permission to run a pilot. |

Do not merge repositories or duplicate their implementations before this
verification. The cheapest route may be to reuse one user-facing surface and
call NOMO as its policy and evidence service. The decision depends on actual
code boundaries and the customer's current tools.

## 2. Customer and painful job

### Initial customer hypothesis

Small or mid-sized field-service, equipment-rental, or construction operators
with a small expert team and many less-experienced workers. The initial buyer
is likely an operations manager or owner. The day-to-day user is a field worker,
dispatcher, or service coordinator. The technical expert is an important
stakeholder because the system must preserve their standards and trust.

The best first customer has:

- frequent repeat jobs with meaningful variation;
- technical knowledge spread across PDFs, messages, senior employees, and job
  histories;
- a measurable cost for waiting on an expert, returning to a site, or correcting
  incomplete paperwork;
- authority to share a small, approved document set for a pilot;
- a named person who owns the workflow and will review pilot outcomes.

### Candidate first workflow

For a scaffolding or equipment-rental operator, test one job from request to
field handoff. The initial workflow may include answering a job-specific
technical question from approved documents, identifying missing site details,
preparing a draft inspection or handoff checklist, and preparing a draft job
record. Do not initially calculate structural safety, certify a design, approve
an installation, or autonomously dispatch workers.

This workflow is a hypothesis. Discovery must identify the single repeated
decision that consumes the most expert time and can be supported by existing
documents. If interviews point elsewhere, update the scope before coding.

### Discovery questions

Ask the buyer, dispatcher, expert, and worker about the same recent completed
job. Capture evidence rather than opinions.

1. What was the last job where a worker waited for help or called an expert?
2. What exact question did the worker ask, and how was it resolved?
3. How long did the wait, search, rework, or second site visit take?
4. Which source did the expert trust: manual, procedure, drawing, job record, or
   personal experience?
5. How often did this happen in the last month? Which role experienced the cost?
6. What would happen if the guidance were wrong? Who is allowed to approve the
   answer or action?
7. Which record or system must be updated after the job?
8. Can the company provide a permissioned document sample and a named pilot
   owner? What date is the next step?
9. Would the buyer pay for a pilot that measures a named outcome? What budget
   would it replace or come from?

Disqualify a lead if the person cannot name a recent instance, cannot provide
usable authorized evidence, has no process owner, or sees no costly delay,
rework, or escalation.

## 3. Product thesis

> A field worker completes a defined job step faster and with fewer avoidable
> escalations because the assistant applies the right customer-approved
> procedure to the current job, shows its sources, and leaves consequential
> actions under the operator's control.

This thesis is stronger than "AI expert for every worker" because it names a
user, job context, measurable outcome, evidence source, and authority boundary.

### Product promise

- Answer operational questions from the customer's approved knowledge.
- Show a source for each material instruction, including document version and
  page or section when the source supports it.
- Ask for required context before giving a job-specific answer.
- Say that the evidence is missing or conflicting instead of inventing a safe
  answer.
- Turn the worker's confirmed result into a structured draft, not a silent write.
- Let an authorized operator review and approve any later action.
- Preserve a verifiable account of decisions and outcomes without recording
  prompt content or secrets in the NOMO ledger.

### First user story

"When I am at a job and cannot remember a procedure, I can ask in plain
language, give the asset and job details, see the exact approved source, and
either follow it or get routed to a named expert. I do not have to search
multiple folders or trust an uncited guess."

### Excluded from the first release

- A general-purpose chatbot or broad multi-trade assistant.
- Autonomous dispatch, pricing, purchasing, financial, safety, or customer
  communications writes.
- Engineering certification or replacement of a qualified professional.
- Learning from raw conversations without review and consent.
- Customer-managed model training or a proprietary foundation model.
- Offline operation, broad integrations, or air-gapped deployment before a buyer
  requires them.
- Guarantees of zero hallucinations, complete safety, legal compliance, or
  guaranteed savings.

## 4. Competition and differentiation

This is not an empty category. Current official product documentation shows:

| Product | Publicly described capability | Strategic implication |
|---|---|---|
| ServiceTitan Atlas | Mobile technician assistant that answers from equipment records, manuals, job context, and cited sources in supported trades. | Generic "ask manuals in the field" is not sufficient differentiation. Check actual supported geographies, trades, systems, and buyer gaps. |
| Microsoft Dynamics 365 Field Service Copilot | Natural-language assistance for work-order and service data, summaries, and related actions in its ecosystem. | A broad assistant tied to an incumbent field-service platform is a direct alternative for Dynamics customers. |
| Leadora | Its README claims AI search over technical documentation with citations. | Could accelerate a standalone knowledge experience, but needs an implementation and traction audit. |
| NOMO | The current repo describes policy-controlled MCP calls, approvals, and a signed evidence ledger. | Differentiation can be controlled cross-system actions and trustworthy evidence, if customers value that outcome and the runtime is ready. |

The defensible hypothesis is a focused vertical workflow that works across a
small operator's actual sources and tools, with evidence and approval controls
that the customer can verify. This must be tested against the systems the pilot
already uses. Do not use "NOMO is the only safe agent" or similar claims.

### Required competitive test

For each candidate pilot, compare the proposed workflow against the customer's
current process, the AI already included in their existing field-service
software, generic document chat, and simply calling a senior employee. Record
the strongest alternative, the failure it leaves unsolved, the integration
cost, and who pays for the gap. Stop or reposition if an incumbent already
solves the selected job at acceptable cost and reliability.

## 5. Business model hypothesis

Start with a paid, fixed-scope pilot tied to a measured operational baseline.
Do not set a list price before learning the buyer's budget, current cost, and
procurement process. Potential later pricing units include active workers,
completed supported jobs, or a site/team subscription. Choose one only after
buyers compare it to their existing spend.

Pilot value should be measured through one or more of:

- expert interruptions per completed job;
- time from worker question to correct next step;
- repeat site visits or avoidable rework;
- time spent finding and verifying a procedure;
- completion and correction rate of a chosen job record;
- manager effort spent reviewing work.

Avoid token-based pricing as the core value metric. Model cost is an internal
gross-margin input. A customer pays for a better operational result, not for
the number of model calls.

## 6. Success criteria and evidence

### Demand evidence

The discovery phase is successful when one buyer agrees to a bounded pilot,
provides a named process owner, authorizes a representative document set, and
sets a date for review. A signed paid pilot is stronger evidence than verbal
interest. A positive response to a product description is not validation.

### Product evidence

Before expanding beyond read-only answers, the evaluation set must show that:

- every answer presented as operational guidance is traceable to the correct
  approved source;
- missing, outdated, conflicting, or wrong-asset evidence triggers a question,
  abstention, or escalation;
- the response does not treat model confidence as proof;
- unauthorized users cannot access another customer's documents or history;
- no tool write can occur in the pilot without the defined human approval;
- NOMO evidence records decisions without storing prompts, secrets, or document
  bodies.

Set numerical thresholds with the pilot owner before tests begin. Report sample
size, severity, and false-answer rate. Do not hide a dangerous error inside an
average accuracy score.

### Business evidence

Capture a baseline from recent jobs, compare the same workflow during the pilot,
and record exceptions. Expand only if workers use the assistant repeatedly and
the buyer sees a measurable benefit that exceeds implementation, support, and
model cost.

## 7. Risks and controls

| Risk | Initial control | Stop or escalation condition |
|---|---|---|
| Incorrect or unsupported guidance | Approved source set, citations, ambiguity questions, abstention, evaluation cases, expert escalation. | Any critical unsupported instruction blocks field deployment until root cause and regression coverage exist. |
| Safety and professional liability | Keep high-consequence decisions outside scope; defer to approved procedures and qualified people; display limits at the point of use. | A workflow requires the system to certify safety, legal compliance, or engineering correctness. |
| Customer data exposure | Separate workspace boundaries, least privilege, approved sources, retention rules, and no prompt or secret in the ledger. | Cannot prove isolation, access control, deletion, or tenant boundaries. |
| Stale manuals or conflicting procedures | Source owner, effective date, version, review date, and conflict behavior. | No named customer owner for source accuracy. |
| Existing platform competition | Ask which product customer already uses; compare actual workflow, support, and total cost. | Incumbent solves the exact job and customer has no meaningful unmet need. |
| Long-tail custom integration | Start with uploaded documents and one structured output. Add one connector only when the pilot requires it. | Every prospect requires a different integration before value appears. |
| Weak customer access | Validate pilot contact before choosing the vertical. | No authorized documents, users, or process owner. |
| Overbuilding the control plane | Reuse the existing NOMO path and add only the minimum worker experience. | Any proposed package or service has no pilot acceptance test. |
| Unverified Leadora reuse | Audit repository, active deployment, data path, tenant controls, licensing, and evaluations before integration. | Any unclear rights, data ownership, or security boundary. |

## 8. Strategic sequence beyond the first wedge

1. **$15-an-Hour Expert:** grounded field guidance for one role and workflow.
2. **Own Your Intelligence:** reviewed, tenant-owned expertise and evaluation
   data that improves the workflow without changing policy or permissions.
3. **Air-gapped AI:** a deployment option only when a regulated or critical
   buyer funds the requirement and the operational model is understood.
4. **Physical-world operating system:** expand from one worker workflow into
   controlled coordination of people, agents, and equipment after live job data
   proves a repeated need.

These are sequencing hypotheses, not four products to build in parallel.

## 9. Open assumptions

1. The first target vertical and business access are unconfirmed.
2. The last-mile device, network quality, language needs, and existing system of
   record are unconfirmed.
3. The usable state and ownership of Leadora are unconfirmed.
4. The amount of document preparation required for one customer is unmeasured.
5. The buyer's willingness to pay and preferred pricing unit are unknown.
6. NOMO product-v1 identity, OAuth, Harness, and hosted isolation gates remain
   governed by the existing specifications.

## Sources

- [YC Requests for Startups, Winter 2027](https://www.ycombinator.com/rfs)
- [NOMO repository and current product boundary](https://github.com/Dawe583/nomo)
- [Leadora repository](https://github.com/Dawe583/Leadora)
- [Microsoft: Copilot in Dynamics 365 Field Service](https://learn.microsoft.com/en-us/dynamics365/field-service/copilot-overview)
- [Microsoft: Copilot side pane in Field Service](https://learn.microsoft.com/en-us/dynamics365/field-service/copilot-side-pane)
- [ServiceTitan: Atlas in Mobile](https://help.servicetitan.com/docs/atlas-in-mobile)
- [ServiceTitan: Atlas field mobile guide](https://help.servicetitan.com/docs/atlas-field-mobile-guide-features-and-navigation-in-servicetitan-max)
