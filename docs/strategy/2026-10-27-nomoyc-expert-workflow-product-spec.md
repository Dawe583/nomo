# The $15-an-Hour Expert: discovery-first product specification

> Status: candidate product contract. The task, vertical, buyer, user, and sources remain unselected. This spec defines how to choose the first workflow and what a safe read-only product must do after evidence supports it.

## Product outcome

Let a worker complete one named, repeated expert-gated task with fewer avoidable searches, handoffs, corrections, or delays. The system uses customer-approved sources and case context, shows the evidence it used, asks for missing inputs, and escalates when a human decision is required.

The $15 title is a US wage illustration from YC. It is not a Czech wage, a pricing target, or a promise to replace workers. Position around task throughput, completion quality, and expert capacity.

## Required roles

- **Buyer:** owns the budget and the business outcome.
- **Operator:** performs the current workflow and can demonstrate a recent case.
- **Expert reviewer:** defines correct, incorrect, unsafe, and escalation outcomes.
- **Data owner:** approves source and case access.
- **Security or IT owner:** approves data flow, identity, inference, retention, and deployment.
- **Worker user:** sees a clear next step, evidence, uncertainty, and a human route.

One person can hold multiple roles, but the product must not infer that a buyer's approval grants data access or expert authority.

## Workflow-selection contract

Before any customer product build, complete this evidence record for one task:

1. Exact task name and trigger.
2. Last completed case, reconstructed step by step.
3. Recurrence count and time window, with source of the count.
4. Current systems, people, documents, wait states, and source of truth.
5. User time, expert time, delay, rework, and error consequences.
6. Which current software features already solve parts of the job.
7. Required case inputs and approved source set.
8. Named person who grades the output and named owner who pays.
9. Data boundary, retention, and allowed inference profile.
10. Dated next step and buyer's response to a priced pilot.

Candidate scores can prioritize interviews but cannot select a workflow. A default screening signal is that at least five of eight same-segment interviews independently reconstruct the same recent job. This is a heuristic, not statistical market proof. A paid pilot, authorized cases, and repeat use are stronger evidence.

## Initial product boundary

### In scope after evidence gate

- One tenant, one workflow, one named operator group.
- Minimal case intake for the selected task.
- Customer-approved, versioned sources with explicit owner, status, and effective date.
- Read-only retrieval restricted by tenant, user, purpose, and source status.
- Typed result states: `answer`, `needs_input`, `source_conflict`, `abstain`, `escalate`.
- A source reference for each material claim, resolvable to exact approved version and location.
- Draft-only output that the user can review, correct, copy, or export.
- Expert feedback in an untrusted review queue until an authorized person accepts it.
- Evaluation and outcome metrics agreed with the customer.

### Out of scope for the first pilot

- Generic company chatbot or open-ended workspace search.
- Autonomous decision-making in finance, employment, health, legal, safety, credit, insurance, or public-benefit eligibility.
- Writes to a production ERP, accounting, HR, CRM, claims, or service system.
- Cross-tenant memory, unreviewed training, or permission learning.
- Fine-tuning a foundation model before retrieval and rubric baselines exist.
- Air-gap, custom hardware, broad connector catalog, or a fleet-control rewrite.

## Core interaction

1. User selects the task and submits only necessary case details.
2. System checks required inputs and asks for missing information before inference.
3. Retrieval filters by tenant, source approval, version, role, and task before ranking.
4. The model returns a typed result with claims mapped to source references, missing inputs, and escalation reason.
5. A validator checks schema, source IDs, version, scope, and prohibited output state.
6. The UI shows the result, evidence, unresolved uncertainty, and the allowed next step.
7. The user confirms or corrects. Feedback is stored as a candidate evaluation record only after data-owner rules allow it.
8. No external write occurs in the pilot.

## Behavior requirements

- Missing or conflicting sources must be surfaced, not silently resolved.
- If a source is stale, unapproved, or outside access scope, the system must not use it.
- Citations must resolve to the source version used. Broken citations fail the response.
- A model confidence field cannot substitute for expert grading.
- The UI must distinguish generated, reviewed, approved, and executed states.
- A correction never changes policy, user permissions, agent permissions, or routing without a separate authorized change.
- Any action proposal contains a typed operation, target, preconditions, and exact preview. It remains disabled until a later release proves NOMO's approval path.

## Data and service boundaries

- **Customer data plane:** sources, case records, prompts, retrieved passages, answers, labels, and retention rules.
- **NOMO control plane:** registered principal, run and workspace bindings, policy version, allow/hold/deny, approval identity, operation digest, result status, and minimal evidence reference.
- **Evaluation store:** customer-approved case identifiers, rubrics, labels, model/config version, and aggregate scores. Store separately from the signed event ledger.
- **Ledger:** append-only decision and operation evidence. Do not write full prompts, retrieved passages, customer documents, credentials, or chain-of-thought to it.

## Acceptance gates for a read-only pilot

- Tenant and role isolation: zero cross-tenant retrieval in negative tests.
- Exact source provenance: 100% of shown references resolve to the approved version and location.
- Critical unsupported instructions: zero on the frozen customer evaluation set.
- Correct abstention or escalation on expert-labeled ambiguous and out-of-scope cases: target at least 95%, adjusted with the domain expert before pilot.
- Supported answer quality: target at least 95% expert-accepted on the agreed set; include confidence interval and case count rather than presenting a small-set rate as universal.
- Task completion time, rework, and review effort measured against a baseline.
- No silent cloud fallback. Every inference route is visible in configuration and test evidence.
- Security owner approves data flow, retention, deletion, and incident path.

Thresholds are proposal gates, not promises to the customer. Set a safety-critical threshold based on actual consequences. If the expert cannot define the threshold, do not automate the decision.

## What counts as validation

Strong evidence: paid pilot with a named buyer, approved cases, expert rubric, dated outcome review, repeat usage, and a conversion decision.

Medium evidence: authorized sample cases and a written pilot proposal reviewed by the budget owner.

Weak evidence: an interview, positive reaction, waitlist, an LOI without budget, or an assumption that a large lead list can be emailed.

## Product demonstration

Use synthetic or customer-authorized data. Demonstrate one ordinary case, one missing-input case, one conflicting-source case, one unsupported case, and one reviewer correction. Show the current process baseline beside the assisted workflow. Label fixtures. Do not imply production autonomy, expert replacement, air-gap readiness, or zero risk.
