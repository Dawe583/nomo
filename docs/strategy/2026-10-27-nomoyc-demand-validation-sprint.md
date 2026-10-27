# NOMO x YC: two-week demand validation sprint

> **State:** ready-to-run proposal. The founder has a direct route to an SME owner or CFO and can request a 45-minute interview this week. The contact has not been asked; the workflow and demand remain unknown. Do not start product implementation from this schedule until a buyer path, repeated task, and authorized sample exist.

## Goal

In ten working days, decide whether one narrowly defined workflow merits a paid prototype. The sprint is successful even if it rejects the idea. It does not attempt to prove a total addressable market, select a foundation model, or build the full NOMO fleet runtime.

## Required team

- Founder who can reach buyers and schedule interviews.
- One workflow operator.
- One domain expert who can judge correct work and unacceptable errors.
- One technical owner who can inspect customer data boundaries and assemble a manual prototype.

## Days 1 and 2: find a real repeated job

- Request the 45-minute interview with the reachable owner or CFO. Reconstruct the most recent costly or difficult operational job across the company, without steering toward finance or showing the product idea.
- Ask which role performs the job, which role has expertise, and who owns the result and budget. Do not assume the CFO is the operator or the buyer for a workflow outside finance.
- From the case, record up to three candidate jobs. Keep only jobs the interviewee says recur, can identify an owner for, and can illustrate with a recent example.
- If one job is concrete and repeated, recruit up to seven people who perform, supervise, or expert-review that same job. If no job emerges, interview across a different reachable company or role; do not fill the cohort with finance contacts by default.
- Record the current workaround, artifact trail, time, delays, handoffs, corrections, error cost, and owner.
- Ask what exactly may or may not leave their environment. Separate training, retention, inference, telemetry, storage, and internet egress.

**Screening signal, not market validation:** the same job appears in at least 5 of 8 qualified interviews, with consistent evidence, a named operator, and recent cases. This is a founder-set heuristic. It is not statistical proof, product-market fit, or permission to build. If fewer than eight qualified interviews are feasible, report the denominator and uncertainty; never inflate the count.

## Days 3 and 4: obtain evidence and measure baseline

- Obtain permission for at least 20 representative historical or observed cases.
- Remove unnecessary personal data and store the cases in the environment approved by the data owner.
- Measure median and 90th percentile completion time, expert wait, rework, missing fields, and error severity.
- Ask the expert to define required evidence, missing-context questions, abstentions, and escalations.
- Compare the incumbent workflow and any existing AI feature on the same cases.

**Exit:** a named data owner approves sources and handling, and a domain expert defines the rubric. Twenty examples is a target, not a prerequisite to discovery; only run a model evaluation when the available sample is authorized and adequate for the stated question. No permission or rubric means no customer-data model experiment.

## Days 5 and 6: concierge dry run

- Produce answers manually or with the least risky available model route.
- Mark every material output with a source and exact version.
- Include missing-context, conflict, stale-source, and no-answer cases.
- Have an expert grade output blind to the authoring method where practical.
- Log failures, correction time, false confidence, refusal quality, and source mismatch.

**Exit:** zero critical unsupported instructions and at least 95% of material claims supported on the agreed sample, or stop and fix the source/model approach before any software build.

## Days 7 and 8: price and deployment test

- Present a one-workflow paid pilot with explicit boundaries and a baseline.
- Ask the budget owner to choose a budget source and a realistic price range.
- Ask neutrally what the buyer permits and prohibits for source data, prompts, inference, retention, model training, telemetry, metadata, support access, storage location, and network egress. Do not recommend local inference before hearing the restriction.
- Compare only deployment options that satisfy the buyer's stated boundary. Record required controls, cost, procurement gate, and approver. Treat local inference and no-egress as testable options, not the default answer.
- Compare an external model only on public or synthetic cases, or on customer-approved data that the buyer explicitly classifies as safe for that route. Never send sensitive customer cases to a model API for a comparison.
- Request a concrete next step: paid pilot, authorized sample, security review date, or rejection.

**Exit:** at least one buyer agrees to a priced pilot discussion, names an owner, and accepts a dated next step. A positive reaction alone does not pass.

## Days 9 and 10: decision

Write a one-page memo with evidence, failures, customer quote, baseline, proposed price, deployment requirement, competitor comparison, and decision. Choose exactly one:

- **Proceed:** buyer, evidence, measurable outcome, expert rubric, and price path all pass.
- **Narrow:** the workflow has value but the task, data set, or user must shrink.
- **Change segment:** access or repeated pain failed, another segment has stronger evidence.
- **Stop:** no buyer will give time, data, or money for the defined outcome.

## Minimum evidence packet before implementation

1. Named buyer and process owner.
2. Five independently reconstructed examples of the same recurring task.
3. Current status-quo time and failure cost.
4. Approved sample source set and data boundary.
5. Expert grading rubric with critical failure cases.
6. Incumbent comparison on the same cases.
7. Priced pilot offer and a dated response.
8. Decision record that distinguishes observed evidence from founder inference.

## Stop-loss

Cap pre-pilot engineering to two engineer-days. Do not buy GPUs, train a model, build a multi-tenant app, integrate a production system, or add a new external service before a buyer has supplied a representative sample and accepted a priced next step.

