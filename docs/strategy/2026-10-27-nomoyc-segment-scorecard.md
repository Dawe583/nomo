# NOMO x YC: segment and workflow scorecard

> **State:** unranked hypotheses only. No segment has been selected. Do not use speculative scores to choose a segment; record evidence and confidence after interviews.

## Candidate segments

The candidate list is a discovery aid, not a market ranking. Scores are removed until they can be grounded in dated interviews, authorized artifacts, and explicit confidence. The SME owner/CFO contact is the first available interview route only; it does not make finance the selected segment.

| Candidate workflow | Why it might be worth investigating | Evidence currently available | Main unknown |
|---|---|---|---|
| Accounting close and invoice exceptions | Repeated record handling may have measurable delay and rework | One uncontacted SME owner/CFO route; public market context only | Whether a specific task is frequent, painful, underserved, and funded |
| Insurance claim intake and evidence assembly | Evidence completeness and expert review may create costly queues | Public market context only | Buyer access, authority, integration, and liability |
| Field-service diagnosis and service records | Experts may need to guide less-experienced workers | Historical alternate concept, not a current decision | Reachable operator, evidence access, and differentiation from incumbent software |
| Medical billing denials and appeals | High-cost exceptions may be measurable | Public market context only | Regulation, data access, buyer access, and safe scope |
| Legal intake and document preparation | Repeated document workflows may involve expert review | Public market context only | Liability, confidentiality, authority, and incumbent coverage |
| SME knowledge search and process completion | Broad fit with the platform thesis | Founder hypothesis only | Whether one concrete, frequent job has budget and an existing system gap |

Do not rank these candidates until the team has comparable evidence for a named workflow. Public adoption figures and an available contact are not workflow demand or willingness to pay.

### Public adoption context, not a segment verdict

Eurostat's 2025 ICT survey reports AI use by 40.4% of EU professional, scientific,
and technical firms, 62.5% of information and communication firms, and 10.8%
of construction firms. These industry figures cover the survey population
(10+ employees or self-employed persons in NACE C–J, L–N and group 95.1),
excluding micro-enterprises and financial/insurance activities. Among firms that considered AI without adopting it,
70.3% cited lack of relevant expertise, 53.6% legal uncertainty, 52.7% privacy
concerns, and 38.4% cost. These figures make the expertise and governance
problem plausible. They do not tell us which segment has the best buyer access
or willingness to pay, and they do not validate accounting as the winner.

For discovery, start with the reachable owner/CFO and ask neutrally about the
most recent costly, difficult, delayed, or expert-gated company task. If a
specific workflow emerges, recruit operators and experts who perform that same
workflow. If none emerges, choose the next reachable buyer path; do not
artificially fill a finance cohort or compare unrelated tasks as if they were
equivalent.

## Interview plan

### Staged sample

1. Interview the reachable owner/CFO without a vertical or workflow prompt.
2. If a recent repeated task emerges, interview up to seven people who perform,
   supervise, or expert-review that same task; keep roles and denominators clear.
3. If no task emerges or the task fails the problem gate, change the reachable
   buyer path and repeat. Broaden to another candidate only with a concrete
   reason; do not scatter a small sample across unrelated workflows.
4. 12–18 total interviews across three workflows is an optional later
   exploration target, not the required first sprint or a statistical claim.

### Ask about behavior

1. “Walk me through the last completed case where this task took longer than expected.”
2. What triggered it? Who touched it? Which systems and documents did they use?
3. What happened while waiting? How many handoffs, corrections, or repeat contacts occurred?
4. Which step requires a credentialed or senior person? What can safely be delegated?
5. What is the source of truth, who owns it, and how often does it change?
6. What data is restricted from cloud services, and what exactly is prohibited: training, storage, inference, telemetry, or internet egress?
7. What does the existing AI or software product already do? What fails in the actual case?
8. Who owns the budget? Which line item funds improvement? What measurable target changes the decision?
9. Can they share three authorized, de-identified cases and name a pilot owner?
10. What date can the buyer review a priced pilot proposal?

Avoid hypothetical “would you use AI?” questions. Ask to see the recent work artifact when consent and policy permit. Do not copy real sensitive data into consumer AI tools.

## Score evidence, not enthusiasm

Update each 1-to-5 score with a quote or artifact reference, interview date, and confidence. Score buyer access 1 if no route to decision makers, 3 if a direct route exists but no interview is agreed, and 5 only after the buyer agrees to a dated next step. Score willingness to pay only after discussing a budget and pilot offer.

### Provisional discovery gates (founder-set heuristics)

- **Problem gate:** a target of 5 of 8 qualified interviews independently reconstructing the same recent repeated task is a screening heuristic only. Report the actual denominator; it is not statistically representative and cannot establish market demand.
- **Data gate:** an authorized owner can supply representative sources or cases.
- **Quality gate:** an expert can define expected answers, required evidence, and abstention cases.
- **Outcome gate:** a baseline and target can be measured within 30 days.
- **Commercial gate:** a budget owner agrees to a priced pilot discussion and a dated next step.
- **Safety gate:** errors have an owner, escalation path, and acceptable first-release boundary.

No segment advances because it leads a spreadsheet score or crosses an interview-count threshold alone. The commercial and data gates are mandatory. Before each concierge or pilot, the buyer and expert must approve the sample size, denominator, severity categories, quality thresholds, and stop conditions for that decision.

## Evidence ledger template

| ID | Date | Role | Segment | Recent case evidence | Current workaround | Cost | Data boundary | Buyer / budget | Next step | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| INT-001 | YYYY-MM-DD | | | | | | | | | Low / Med / High |

## Alternatives to compare

Compare the exact workflow against: current manual process; existing vertical software; general-purpose cloud assistant with enterprise data terms; retrieval assistant; customer-hosted model; and no purchase. Measure completion time, correction rate, expert interrupts, evidence coverage, and cost to operate. A local model is a deployment option, not the experiment's hypothesis.

