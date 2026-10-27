# NOMO Field Expert: validation and delivery roadmap

> Status: proposed prior candidate roadmap, not an owner-selected vertical, 2026-10-27.
> Estimates are planning ranges for a small founding team. Customer access,
> repository audit, and existing Nomo release gates can change them. The first
> segment remains open pending the [private AI opportunity research memo](2026-10-27-nomo-private-ai-market-research.md).
> The current first interview path is an SME owner or CFO in finance operations; this roadmap is an alternate field-service candidate.
> No phase authorizes deployment or a production write by itself.

## Outcome

Validate and deliver one paid, read-only field-expert workflow. Prove that an
operator's worker can find and apply correct, cited guidance faster, while
NOMO's existing control path remains the only route for future tool writes.

## Sequence at a glance

| Phase | Indicative time | Output | Exit gate |
|---|---:|---|---|
| 0. Asset and access audit | 2-4 working days | Verified Nomo, Leadora, and pilot-access map | A real operator and source owner can be contacted; code reuse candidates are evidence-based. |
| 1. Customer discovery | 1-2 weeks | One validated vertical, buyer, repeated job, baseline, and pilot commitment | Named owner, authorized sources, dated next step, and willingness to run or pay for a pilot. |
| 2. Concierge prototype | 1 week | Expert-reviewed answers for one workflow and sample documents | Representative evaluation set passes the agreed source, ambiguity, and abstention behavior. |
| 3. Read-only MVP | 2-3 weeks | Responsive worker flow, approved source ingestion, cited answers, expert escalation | Security and product acceptance gates pass; customer approves live read-only pilot. |
| 4. Paid pilot | 2-4 weeks | Usage and outcome evidence from one team | Repeat use plus measurable customer value, with tolerable source-maintenance and support cost. |
| 5. One controlled action | 2-4 weeks after pilot approval | One human-approved tool write through NOMO | Exact operation, policy, approval, ledger, idempotency, and recovery acceptance all pass. |
| 6. Expansion | After evidence | Second workflow or vertical, then Own Your Intelligence | First workflow demonstrates repeatable demand, quality, and economics. |

Phases may overlap only when their prerequisites are met. Do not build Phase 3
before Phase 1 names the workflow. Do not implement Phase 5 because an attractive
demo needs an integration.

## Phase 0: asset and access audit

**Goal:** determine the cheapest credible first pilot and avoid duplicating
existing work.

### Work

1. Start with the reported direct SME owner or CFO route for finance operations.
   Keep `leseni-novak` as an unverified field-service alternative; do not infer
   customer access from that repository name.
2. Read the current Leadora branch, deployment, dependencies, source-ingestion
   flow, citations, tenancy, auth, tests, privacy, license, and active users.
3. In the current Nomo branch, map the actual usable paths in Workbench, Harness,
   proxy, policy, ledger, API, and UI. Compare them with the active identity and
   fleet specifications.
4. Confirm which document formats and one customer workflow can be supported
   without new infrastructure.
5. Record candidate reuse, missing capabilities, open risk, and the proof
   needed before making a product or security claim.

### Output

One page with verified repo evidence, one proposed pilot contact, required data,
and the minimal implementation surface. Do not merge repositories or modify
Nomo platform contracts in this phase.

### Gate

Continue only if a real buyer or operating expert is accessible and can provide
an authorized, representative source set. If not, use discovery to find another
vertical before coding.

## Phase 1: customer discovery

**Goal:** choose the problem, not a feature list.

### Work

- Interview at least 10 people across owners or operations managers, dispatchers,
  experts, and workers. Prioritize people in the candidate vertical.
- Ask each person to walk through a recent job, including actual waits,
  escalations, rework, searches, decisions, and records.
- Observe one workflow in context when permitted. Record only notes needed for
  product decisions; avoid collecting customer secrets or personal data.
- Identify the source of truth and who maintains each source.
- Compare built-in incumbent AI, generic document chat, calls to senior staff,
  and current paperwork.
- Ask for a bounded paid pilot with named users, approved sources, a baseline,
  an accountable process owner, and a date to review results.

### Decision record

For each candidate workflow, score 1-5 and cite evidence for:

1. Frequency of the problem.
2. Cost of expert interruption, delay, or error.
3. Availability and quality of approved source material.
4. Access to buyer, workers, and expert reviewer.
5. Ability to measure outcome within 30 days.
6. Fit with current Nomo and Leadora capabilities.
7. Competitive gap versus the installed system.
8. Safety and integration burden.

Scores support discussion; they do not replace a buyer's commitment. Do not
choose a high-risk workflow if a lower-risk job can prove the core value.

### Gate

One workflow has a process owner, authorized source material, measurable
baseline, and a concrete pilot commitment. If none does, run more discovery or
change vertical. No MVP build yet.

## Phase 2: concierge prototype

**Goal:** validate answer quality and usability before hardening a service.

### Work

1. The customer selects and approves a small source set, initially about 20-50
   documents or the minimum required by the workflow.
2. Create 30-50 anonymized, representative questions from real jobs, including
   missing context, stale-source, wrong-asset, conflict, and safety cases.
3. Have the customer's expert write or approve expected answer, source, and
   escalation behavior for each case.
4. Use a manual or local prototype to produce responses. Do not connect to
   customer systems or enable writes.
5. Review every answer with the expert. Log source mismatch, missing context,
   false confidence, response time, and correction.
6. Compare the output with current work and at least one incumbent alternative.

### Gate

The customer expert accepts answer behavior for the agreed evaluation set and
can identify the next workflow step that would justify repeated use. A severe
unsupported instruction blocks progression until corrected and covered by a
repeatable evaluation case.

## Phase 3: read-only MVP

**Goal:** turn the validated workflow into a usable product while minimizing
new infrastructure.

### Build order

1. **Source registry:** list approved source, owner, version, effective date,
   review status, and access scope.
2. **Ingestion:** process only customer-approved formats. Preserve document
   provenance and stable page or section references.
3. **Retrieval:** filter by tenant and approved status before ranking. Refuse
   unapproved or retired sources.
4. **Answer contract:** return typed state: answer, needs-context, conflict,
   abstention, or escalation. Include source references for material claims.
5. **Citation renderer:** let a worker open the exact document version and
   location. Do not show a citation that cannot be resolved.
6. **Mobile-first surface:** implement the chosen worker flow in an existing
   Nomo or audited Leadora surface. Use text input first. Validate touch targets,
   loading, empty, error, offline-indicator, and low-bandwidth states.
7. **Expert review:** add feedback and a review queue. An approval is required
   before a correction becomes searchable knowledge.
8. **Evaluation:** run the fixed evaluation set on every retrieval, model, or
   prompt change. Track severe and unsupported cases separately.
9. **Privacy and operations:** document retention, access, source deletion,
   audit separation, support contact, and incident escalation.

### Gate

The customer approves the sources, access model, UI, evaluation results, and
read-only pilot conditions. Do not write to an operational system.

## Phase 4: paid pilot

**Goal:** prove real adoption and business value in a controlled environment.

### Pilot setup

- One company, one team, one workflow, and a fixed duration.
- Named manager, expert reviewer, and worker cohort.
- Explicit consent and data-handling agreement.
- Agreed eligible-job definition and pre-pilot baseline.
- Approved source owner and source refresh schedule.
- Read-only access to any job context used. No customer credential stored in a
  prompt, browser, document, or ledger.
- Weekly review of quality, escalations, corrections, and business outcomes.

### Gate

Continue only if workers return to the product, the expert trusts its source
behavior, the buyer can identify a measured operational benefit, and support
effort is sustainable. Otherwise narrow the workflow, improve sources, or stop.

## Phase 5: one controlled action

**Goal:** prove that a grounded expert can safely complete one small task, not
to automate the whole operation.

### Candidate action

Select the lowest-risk action that directly closes the validated workflow, such
as creating a draft job note in a test workspace. The exact target and tool must
come from the pilot system, not from this roadmap.

### Implementation order

1. Confirm a supported connector and its true preconditions, target identity,
   blast radius, idempotency, and reversibility.
2. Bind the trusted workspace, registered agent, run, proxy resource, and
   least-privilege tool scope.
3. Produce a canonical typed action proposal. Treat model-generated fields as
   untrusted input.
4. Classify and evaluate the call through existing NOMO registry and policy.
5. Hold the call for operator approval when policy requires it. Bind approval to
   exact operation digest and policy version.
6. Recheck scope, expiry, and revocation immediately before dispatch.
7. Append the required decision evidence before forwarding. If evidence cannot
   be appended, do not dispatch.
8. Append the result or explicit unknown outcome after the response. Never claim
   that timeout means failure or cancellation.
9. Verify with an isolated target and a read-after-write check before any
   customer environment is considered.
10. Run a shadow or test phase, then obtain customer approval for a bounded
    live pilot if all product-v1 requirements are met.

### Gate

No action reaches a real customer system until the existing NOMO product-v1
identity, standard MCP HTTP authorization where used, tenant isolation, Harness,
revocation, evidence, and operations release gates are satisfied. This roadmap
does not waive or mark those gates complete.

## Phase 6: expand only from evidence

After the first workflow is stable:

1. Add expert-approved, provenance-bearing corrections to tenant knowledge.
2. Test whether an additional workflow uses the same sources, team, and buyer.
3. Offer customer-owned evaluation and improvement workflows, corresponding to
   YC's "Own Your Intelligence" request.
4. Consider offline, on-premises, or air-gapped deployment only after a buyer
   names the requirement, its budget, and its security acceptance process.
5. Expand into broader agent, human, and equipment coordination only when
   repeated job events show a concrete orchestration bottleneck.

## First 10 working days

| Day | Focus | Evidence to leave behind |
|---|---|---|
| 1 | Verify direct access to the candidate operator and whether the business is a viable pilot partner. | Named contact, role, relationship, permission path, or a decision to choose another vertical. |
| 2 | Inspect Leadora and Nomo assets read-only. | Reuse table with code and deployment evidence, not README claims alone. |
| 3 | Draft the interview script and consent/data boundary. | Questions, pilot data request, no-secret and no-production rules. |
| 4-6 | Interview 5-7 stakeholders and observe one workflow if allowed. | Recent-job narratives, observed waits and source documents, objections. |
| 7 | Compare the candidate against built-in and manual alternatives. | Competitive gap and disqualifying facts. |
| 8 | Select one workflow and define its baseline and evaluation cases. | Workflow map, owner, target metric, expert-approved test set. |
| 9 | Ask for a paid or explicitly sponsored pilot. | Pilot scope, accountable buyer, duration, date, data access. |
| 10 | Decide build, change vertical, or stop. | Short decision record with evidence, unresolved risks, and next milestone. |

Do not spend the first two weeks polishing branding or building a generalized
agent fleet UI. The primary output is evidence of a painful job and a credible
pilot path.

## Operating cadence and change control

- Keep one decision log for vertical, workflow, sources, and pilot acceptance.
- Every implementation task links to an acceptance case and allowed file scope.
- Reuse current packages and dependencies before adding components.
- Keep product, security, and runtime claims separate from aspirational roadmap
  items.
- Change this roadmap when customer evidence or an existing NOMO release gate
  changes. Do not convert a hypothesis into a product decision silently.
- Do not stage, commit, push, merge, deploy, or change customer systems as part
  of writing or reviewing this roadmap.

## Dependencies and blockers

1. Confirm pilot access and permission to use the source documents.
2. Audit Leadora and current Nomo code before selecting a reuse boundary.
3. Select the first workflow and define the expert-approved evaluation set.
4. Review the current NOMO security and product-v1 gate status before any
   authenticated customer data or writes.
5. Decide whether an external knowledge service or model provider is needed only
   after the existing code and customer constraints are known.

## Review sources

- [NOMO product context](../CONTEXT.md)
- [NOMO product-v1 specification](../superpowers/specs/2026-10-08-nomo-agent-identity-fleet-mvp-spec.md)
- [NOMO capability map](../superpowers/specs/2026-10-08-nomo-agent-identity-fleet-capability-map.md)
- [NOMO identity and fleet implementation plan](../superpowers/plans/2026-10-08-nomo-agent-identity-fleet-mvp-and-roadmap.md)
- [YC Requests for Startups, Winter 2027](https://www.ycombinator.com/rfs)
- [Microsoft: Copilot in Dynamics 365 Field Service](https://learn.microsoft.com/en-us/dynamics365/field-service/copilot-overview)
- [ServiceTitan: Atlas in Mobile](https://help.servicetitan.com/docs/atlas-in-mobile)
