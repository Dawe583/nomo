# NOMO x YC: segment and workflow scorecard

> **State:** hypotheses only. Scores are initial planning estimates, not market facts. Replace with interview evidence before segment selection.

## Candidate segments

Scores are 1 to 5, where 5 is favorable. “Access” measures the path to a buyer, not demand: 1 means no route; 3 means a direct route with an interview request possible; 5 means a buyer has agreed to a dated next step. High risk means more controls and longer validation, therefore a lower score.

| Candidate workflow | Frequency | Cost of delay/error | Source readiness | Buyer access | 30-day measurability | NOMO fit | Low risk burden | Current score / 35 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Accounting close and invoice exceptions | 4 | 4 | 4 | 3 | 5 | 4 | 3 | 27 |
| Insurance claim intake and evidence assembly | 4 | 5 | 3 | 2 | 4 | 4 | 2 | 24 |
| Field-service diagnosis and service records | 4 | 4 | 3 | 2 | 4 | 4 | 2 | 23 |
| Medical billing denials and appeals | 5 | 5 | 3 | 1 | 4 | 4 | 1 | 23 |
| Legal intake and document preparation | 4 | 4 | 3 | 2 | 4 | 3 | 1 | 21 |
| SME knowledge search and process completion | 3 | 3 | 2 | 3 | 3 | 5 | 4 | 23 |

These totals are not rankings. They conceal uncertainty and should not be used as a decision without evidence. The founder reports a direct route to an SME owner or CFO in accounting or finance operations and can request an interview this week. The contact has not been asked, no workflow is known, and no customer evidence exists. The access score reflects a reachable path, not a confirmed meeting or buyer commitment. Accounting is a plausible low-regret discovery path because exceptions and records can be measured, not because it has been validated. Field service remains an option only if access is real. Medical, legal, insurance, and safety-sensitive work need an explicit risk and oversight design.

### Public adoption context, not a segment verdict

Eurostat's 2025 data reports AI use by 40.4% of EU professional, scientific,
and technical firms, 62.5% of information and communication firms, and 10.8%
of construction firms. Among firms that considered AI without adopting it,
70.3% cited lack of relevant expertise, 53.6% legal uncertainty, 52.7% privacy
concerns, and 38.4% cost. These figures make the expertise and governance
problem plausible. They do not tell us which segment has the best buyer access
or willingness to pay, and they do not validate accounting as the winner.

For the two-week discovery sprint, start with the accounting contact the founder
identified, then compare it with one alternative only if the buyer can name a
recent case and provide an authorized sample. Do not choose a second sector by
spreading interviews thinly across unrelated workflows.

## Interview plan

### Sample

Conduct 12 to 18 interviews across 3 candidate workflows. For each workflow, seek at least one buyer, one day-to-day operator, and one expert or process owner. Continue until the same costly task appears independently and the source system is named.

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

### Segment decision gates

- **Problem gate:** at least 5 of 8 interviews in one segment independently describe the same recent repeated task.
- **Data gate:** an authorized owner can supply representative sources or cases.
- **Quality gate:** an expert can define expected answers, required evidence, and abstention cases.
- **Outcome gate:** a baseline and target can be measured within 30 days.
- **Commercial gate:** a budget owner agrees to a priced pilot discussion and a dated next step.
- **Safety gate:** errors have an owner, escalation path, and acceptable first-release boundary.

No segment advances because it leads a spreadsheet score alone. The commercial and data gates are mandatory.

## Evidence ledger template

| ID | Date | Role | Segment | Recent case evidence | Current workaround | Cost | Data boundary | Buyer / budget | Next step | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|
| INT-001 | YYYY-MM-DD | | | | | | | | | Low / Med / High |

## Alternatives to compare

Compare the exact workflow against: current manual process; existing vertical software; general-purpose cloud assistant with enterprise data terms; retrieval assistant; customer-hosted model; and no purchase. Measure completion time, correction rate, expert interrupts, evidence coverage, and cost to operate. A local model is a deployment option, not the experiment's hypothesis.

