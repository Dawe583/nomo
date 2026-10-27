# NOMO x YC: evaluation, pilot economics, and decision rules

> Status: proposed measurement protocol. Thresholds below are starting gates, not achieved results. Adapt with the customer and domain expert before a pilot.

## Core question

Does one workflow produce a customer-valued outcome with acceptable quality, security, and delivery cost? Do not count model accuracy alone. Measure the complete task, including corrections, escalations, review, support, and customer change effort.

## Baseline protocol

For each case, record only approved, minimized fields:

- case type, complexity, source version, and whether the case is in scope;
- active operator minutes, expert review minutes, elapsed waiting time, and handoffs;
- completion, exception, correction, rework, and failure outcome;
- customer-approved consequence measure, such as deadline, backlog, or avoided external review;
- incumbent tools and human steps used.

Use a representative case set, not only easy examples. Keep a holdout set. Domain experts define the rubric before model output is reviewed. Label ground truth independently where feasible; adjudicate disagreements and preserve disagreement as evidence.

## Quality measures

| Dimension | Measurement | Initial pilot gate |
|---|---|---|
| Evidence support | Claims tied to an approved, current source and precise passage | At least 95% of supported claims; expert confirms denominator |
| Critical unsupported instruction | Unsafe or materially false instruction that reaches operator | Zero in pilot cases; any event pauses use and triggers review |
| Abstention / escalation | Correctly asks for missing evidence, conflict, or expert judgment | At least 95% on cases rubric marks as requiring escalation |
| Source version | Correct version and effective date used | 100% of evaluated cases |
| Tenant / access boundary | Unauthorized source or cross-customer access | Zero |
| Task time | End-to-end operator plus reviewer time versus baseline | Target 25% lower; include review time and support |
| Completion | In-scope case completed without preventable rework | Customer-defined non-inferiority and improvement target |

These are proposed pilot gates. They do not establish safety for another workflow or customer.

## Comparison design

1. Freeze the workflow definition, source set, policy, model version, prompt/configuration, and rubric.
2. Select cases across normal, edge, conflict, missing-input, and out-of-scope conditions.
3. Run the incumbent and the assistant on the same permitted cases. Blind expert reviewers to output source where practical.
4. Include all human review and remediation time. Compare cost per successfully completed case, not raw generation latency.
5. Record every failure, source gap, hallucination, escalation, and customer correction. Do not silently exclude bad cases.
6. Repeat after a change using a versioned holdout. Do not claim improvement from training data reused in evaluation.

## Unit economics

Per-case gross value estimate:

`labor value = cases/month × (baseline total minutes − assisted total minutes) / 60 × fully loaded hourly cost`

Add only customer-verified avoided rework, external service, delay, or error cost. Subtract:

`variable cost = inference + storage + connector/API + human review + support + incident handling`

Monthly contribution before fixed engineering:

`contribution = verified customer value − variable delivery cost − customer-specific operations`

Record assumptions separately. Do not multiply an unverified saving by a broad market estimate. Price against a meaningful fraction of realized value and the buyer's alternative, then test willingness with a paid offer. Do not set a final price before cost and value are observed.

## Paid pilot shape

- One workflow, one team, one approved data boundary, and a fixed duration.
- Read-only operation. No direct system write in the first pilot.
- Customer supplies an owner, operator, expert reviewer, and security approver.
- Written scope, cases, rubric, baseline, quality gates, support limit, privacy terms, deletion date, incident route, and exit decision.
- Fixed fee paid before or at start. If the buyer will only participate for free, record this as weaker evidence.
- Weekly results review. Final continuation decision uses measured outcomes and an explicit commercial next step.

## Stop, revise, continue

### Stop or change segment if

- no repeated, expensive task appears across qualified interviews;
- an incumbent already solves the hard cases at acceptable cost;
- expert review consumes any time saved;
- permitted examples or a reliable rubric are unavailable;
- critical failure cannot be bounded by abstention and review;
- there is no named buyer or paid-pilot commitment after showing evidence.

### Continue to a narrow product if

- the same job recurs across multiple companies;
- operator and expert confirm the same workflow gap;
- the workflow passes the agreed case evaluation;
- total end-to-end time or another agreed customer outcome improves;
- the buyer pays and commits to repeat use;
- security and support costs fit plausible gross margin.

### Add Own Your Intelligence only if

Repeated use produces permissioned expert corrections, those corrections improve a versioned evaluation set, and source, retrieval, or policy tuning no longer captures enough improvement. Benchmark fine-tuning against simpler changes.

### Add air-gap only if

A qualified buyer has a written no-egress rule, security owner, representative workload, paid pilot, hardware plan, acceptance test, and funded lifecycle support.

## Evidence ledger

The product ledger must not become the customer data lake. Store only authorized event IDs, policy/version IDs, outcome category, approved digests, actor/agent IDs, timestamps, and decision references. Keep prompts, files, retrieved passages, model outputs, and personal data in the customer-approved operational data plane with retention and deletion controls. A signature proves a record's integrity relative to its key; it does not prove truth or independent verification.
