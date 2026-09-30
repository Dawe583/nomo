# VOID Slack operating pack

**Purpose:** turn Slack into a clear coordination layer for the €10k MRR program without making Slack a second database.  
**Canonical strategy:** [GO-TO-MARKET-10K-MRR.md](GO-TO-MARKET-10K-MRR.md)  
**Execution board:** [10K-MRR-EXECUTION-BOARD.md](10K-MRR-EXECUTION-BOARD.md)  
**Tracking issue:** https://github.com/Dawe583/void/issues/1

**Management correction:** €10k MRR is an upside/stretch target. Slack scorecards must show downside/base/upside forecast bands and qualified pipeline coverage; never report the target as expected revenue.

All channel messages should be in English because the VOID workspace marks the operating channels English-only.

## 1. Channel map

| Channel | Use it for | Do not use it for | Required message shape |
| --- | --- | --- | --- |
| `#announcements` | Approved milestones affecting everyone | Discussion, raw metrics, hypotheses | What changed / Why / Impact / Link / Owner |
| `#product` | ICP, workflow pain, requirements, prioritization | Implementation detail or unqualified opinions | Problem / Evidence / Decision needed / Link |
| `#research` | Interviews, competitive research, sources | Turning one hypothesis into a decision | Source / Observation / Confidence / Implication |
| `#projects` | Cross-functional milestones, dependencies, health | Task-level debate | Milestone / Status / Owner / Dependency / Next |
| `#engineering` | Code, tests, architecture, blockers | Revenue negotiation or broad strategy | Change / Validation / Risk / Evidence / Next |
| `#releases` | Release readiness, artifacts, digests, rollback | “Almost ready” announcements without gates | Scope / Gates / Artifact / Rollback / Decision |
| `#tasks` | One actionable task per message | Multi-task project plans | Owner / Status / Due / Evidence / Next step |
| `#weekly-plan` | Weekly commitments and Friday review | Daily chatter and task discussion | Outcomes / Commitments / Dependencies / Risks / Review |
| `#daily-plan` | Blockers, evidence, decisions needed today | Long reports or status theatre | Today / Done / Blocked / Decision needed |
| `#knowledge` | Stable definitions, SOPs, verified guidance | Live debate | Rule / Procedure / Owner / Last verified / Source |
| `#decisions` | Durable choices and rationale | Brainstorming | Decision / Context / Alternatives / Rationale / Owner / Review |
| `#operations` | Funnel, payments, MRR, support, access, incidents | Product prioritization | Scorecard / Variance / Action / Source |
| `#security` | Security evidence, incidents, access boundaries | Secret values or customer credentials | Finding / Severity / Containment / Owner / Evidence |
| `#lab` | Experiments and tests | Treating experiments as production evidence | Hypothesis / Setup / Result / Confidence / Next |
| `#linkedin-outreach-drafts` | Outreach drafts and review | Sending secrets or customer data | Audience / Draft / Personalization / CTA / Reviewer |

## 2. Pinned operating rules

Pin this in the core operating channels:

```text
VOID operating rules

1. GitHub documents and issues are the durable source of product and strategy truth.
2. Slack is for coordination, decisions, evidence pointers, and follow-ups.
3. Every task update has Owner, Status, Due, Evidence, and Next step.
4. Every durable decision is copied to #decisions and the linked GitHub issue.
5. No API keys, access tokens, private keys, customer credentials, or database URLs in Slack or GitHub.
6. Never count a fixture as production certification, a signed contract as collected MRR, or a like as qualified demand.
7. Keep discussion in threads; keep the channel top-level message scannable.
8. Use explicit statuses: READY / IN PROGRESS / BLOCKED / DONE / STOPPED.
9. Forecast bands are DOWNside / BASE / UPSIDE; €10k is UPSIDE until paid-cohort evidence exists.
10. Every revenue update includes collected MRR, qualified pipeline in euros, stage aging, source cohort, and support capacity.
```

## 2A. Canonical channel policy

The workspace currently contains duplicate channels created by earlier operating experiments. Because the available Slack connector cannot rename or archive channels, use this policy immediately and perform any final Slack UI cleanup later:

| Canonical channel | Legacy/duplicate channel | Policy |
| --- | --- | --- |
| `#daily-plan` | `#daily-standup` | New daily updates only in `#daily-plan` |
| `#projects` | `#project-ops` | New cross-functional project updates only in `#projects` |
| `#tasks` | `#task-board` | New execution tasks only in `#tasks` |
| `#decisions` | `#decision-log` | New durable decisions only in `#decisions` |
| `#knowledge` | `#knowledge-workflow` | New SOPs and definitions only in `#knowledge` |
| `#lab` | `#agent-lab` | New experiments only in `#lab` |
| `#ideas` | `#idea-intake` | New ideas only in `#ideas`; triage there |
| `#operations` | `#agent-ops` | Sensitive operational alerts stay in private `#agent-ops`; normal operations stay in `#operations` |

Legacy channels are read-only for historical context. Do not split the same update across both channels. Keep `#decision-log`, `#project-ops`, `#task-board`, `#knowledge-workflow`, `#agent-lab`, and `#idea-intake` available only until the team confirms migration and archives them manually.

## 2B. Management information standard

Every Wednesday `#operations` scorecard must contain:

- collected MRR and paid account count;
- downside / base / upside forecast;
- qualified pipeline coverage in euros;
- stage conversion by source cohort;
- oldest stalled opportunity and stage age;
- active evaluations versus operator capacity;
- support hours/account and custom-request count;
- one corrective action with owner and due date.

Every Friday `#weekly-review` must state whether the €10k upside target is **on track / at risk / reforecasted**, with the evidence and the new expected range if reforecasted.

## 3. Weekly operating rhythm

### Monday — commit

`#weekly-plan` gets one approved post containing:

- three outcomes for the week;
- no more than five committed deliverables;
- owner for each deliverable;
- dependencies and risks;
- the Friday review date;
- one explicit thing the team will not build.

### Daily — unblock

`#daily-plan` gets one concise update per active owner. Only post when there is progress, evidence, a blocker, or a decision needed. Use threads for discussion.

### Wednesday — inspect funnel and delivery

`#operations` posts the scorecard: ICP accounts, contacts, qualified opportunities, evaluations, activations, paid accounts, collected MRR, support hours, and renewal risk.

`#projects` posts milestone health: on track / at risk / blocked, with the oldest blocker and owner.

### Friday — learn and decide

`#weekly-review` records shipped, moved, blocked, learned, and one written decision. If a decision changes product, price, ICP, release, or customer scope, copy it to `#decisions` and GitHub.

## 4. Ready-to-post messages

### 4.1 `#announcements` — program kickoff

```text
VOID €10k MRR program is now in execution.

Target: at least €10,000 of collected recurring revenue in December 2026, with a quality gate through March 2027.
Primary path: eight scoped design partners at an average of €1,250 MRR.

This is an operating target, not a forecast. Unpaid pilots, one-off work, grants, and illustrative website numbers do not count.

Canonical plan: https://github.com/Dawe583/void/blob/main/docs/GO-TO-MARKET-10K-MRR.md
Execution board: https://github.com/Dawe583/void/blob/main/docs/10K-MRR-EXECUTION-BOARD.md
Slack operating pack: https://github.com/Dawe583/void/blob/main/docs/SLACK-OPERATING-PACK.md
Tracking issue: https://github.com/Dawe583/void/issues/1

The first priority is not broad feature work. It is one reproducible path: clean install → governed hold → signed export → independent verification → qualified buyer conversation.
```

### 4.2 `#weekly-plan` — first execution week

```text
WEEKLY PLAN · 2026-10-01 to 2026-10-04

Three outcomes:
1. Assign the seven DRIs and record the current MRR/customer baseline, including explicit unknowns.
2. Sign off one design-partner offer, one ICP, one activation rule, and one scorecard.
3. Decide repository visibility and package/release ownership only after the full-history secret scan.

Commitments:
- Founder/Revenue: baseline, offer, ICP, and first account-list structure.
- Product: evaluation brief with workflow, success signal, stop condition, and objection log.
- Engineering: P0 list for clean install, first hold, export, and verifier.
- Distribution: release/visibility checklist and package-name decision path.
- Content: claim-review checklist and first proof-artifact outline.
- Operations: pipeline fields, payment source, support owner, and MRR reconciliation fields.

Dependencies:
- Visibility decision depends on secret scan.
- Selling depends on a bounded offer and data boundary.
- Public claims depend on install, safety, and ledger evidence gates.

Risks:
- Scope drifting into unsupported hosted-service promises.
- Treating the existing site pricing as validated willingness to pay.
- Spending the acquisition lane on unrelated technical roadmap work.

Friday review: 2026-10-04. Source: https://github.com/Dawe583/void/blob/main/docs/10K-MRR-EXECUTION-BOARD.md
```

### 4.3 `#tasks` — task template

```text
TASK · [short verb-led title]

Owner: @[person] / [role]
Status: READY | IN PROGRESS | BLOCKED | DONE | STOPPED
Due: YYYY-MM-DD
Why it matters: [activation / proof / conversion / retention / release]
Acceptance: [observable result]
Evidence: [GitHub issue, file, test output, artifact digest, or source record]
Next step: [one concrete action]
Blocker: [none or exact blocker + owner]
```

### 4.4 `#operations` — weekly scorecard

```text
WEEKLY REVENUE SCORECARD · YYYY-MM-DD

Collected MRR: €[x] / €10,000 target
Paid accounts: [x] / 8 primary-path target
Named ICP accounts: [x] / 240
Personalized contacts: [x] / 120
First conversations: [x] / 48
Qualified opportunities: [x] / 24
Scoped evaluations: [x] / 12
Activated evaluations: [x] / 8+
Time to first hold: [x] days (trend: up/down/flat)
Verified exports: [x]
Support hours/account: [x]
Renewal risk: [low/medium/high + reason]

Variance from plan: [one sentence]
Top action this week: [one action + owner + due date]
Oldest blocker: [blocker + owner + escalation date]
Source records: [link to board/payment source]
```

### 4.5 `#engineering` — evidence update

```text
ENGINEERING EVIDENCE · [component]

Change: [what changed]
Validation: [commands/tests and result]
Supported claim: [exact narrow claim]
Not proven: [fixture / provider / platform / scale limits]
Release impact: [none / ready for review / blocked]
Evidence: [link to commit, test output, artifact, or doc]
Next: [one action + owner + due]
```

### 4.6 `#releases` — release gate

```text
RELEASE READINESS · [version/artifact]

Scope: [what is included]
Owner: @[person]
Visibility decision: [public / private / pending]
Install gate: PASS | FAIL | N/A
Safety gate: PASS | FAIL | N/A
Ledger/verifier gate: PASS | FAIL | N/A
Provider evidence gate: PASS | FAIL | N/A
Secret scan: PASS | FAIL | N/A
Artifact digest: [sha256]
Rollback path: [link or exact procedure]
Known limits: [short list]
Decision needed: [none / exact decision + owner + due]
```

### 4.7 `#decisions` — durable decision

```text
DECISION · D-[number] · [short title]

Date: YYYY-MM-DD
Owner: @[person]
Decision: [one sentence]
Context: [why this decision is needed now]
Alternatives considered:
- A: [option + trade-off]
- B: [option + trade-off]
Rationale: [evidence-based reason]
Consequences: [what changes and what does not]
Review date: YYYY-MM-DD
Canonical record: [GitHub issue/doc link]
```

### 4.8 `#research` — discovery evidence

```text
RESEARCH NOTE · [buyer/workflow]

Source: [call, public source, or artifact]
Date: YYYY-MM-DD
Buyer role: [role]
Workflow: [specific agent write]
Consequence: [what goes wrong]
Current workaround: [what they do today]
Urgency: [low / medium / high + evidence]
Evaluator: [named role]
Environment: [disposable/customer-controlled/unknown]
Budget path: [known/unknown]
Next dated step: [date + action]
Confidence: [low/medium/high]
Implication: [what this changes in the wedge, product, or content]
```

### 4.9 `#knowledge` — stable SOP

```text
KNOWLEDGE ENTRY · [definition/procedure]

Rule: [one stable rule]
Procedure: [numbered steps]
Owner: @[person/role]
Last verified: YYYY-MM-DD
Applies to: [scope]
Does not prove: [explicit boundary]
Canonical source: [GitHub link]
```

### 4.10 `#security` — security finding

```text
SECURITY FINDING · [short title]

Owner: @[person]
Severity: [low/medium/high/critical]
Finding: [one sentence; no secrets]
Exposure: [what could be affected]
Containment: [immediate action]
Remediation: [bounded action]
Evidence: [sanitized test/output/link]
Due: YYYY-MM-DD
Status: OPEN | MITIGATED | VERIFIED | ACCEPTED
```

## 5. Content review checklist

Before any founder post, website update, launch post, or customer-facing document:

- Is the claim about current behavior, a roadmap concept, or an illustration?
- Is the source artifact linked and reproducible?
- Does the wording distinguish integrity, authenticity, correctness, availability, and recovery?
- Does any number have a source and date?
- Is any customer/logo/quote explicitly approved for publication?
- Does the install path work on a clean supported environment?
- Does the post avoid claiming that every action is reversible?
- Does the post avoid calling fixture tests production certification?
- Is the next buyer question clear?

## 6. Escalation and handoff

Use a thread first. Promote to a top-level message only when the issue affects a milestone, safety boundary, revenue commitment, or release. If no owner responds by the due date, post the escalation format from the execution board and link the GitHub issue.

A handoff is complete only when the recipient has:

- the current status;
- the exact next action;
- the acceptance condition;
- the evidence link;
- the known limits;
- the decision deadline.

## 7. What success looks like in Slack

The workspace should make these questions answerable in under two minutes:

1. What are the three outcomes this week?
2. Who owns the next step for each one?
3. Which customer workflow is being tested?
4. What evidence proves activation?
5. How much MRR is actually collected?
6. Which blocker is oldest and what decision clears it?
7. What is the team explicitly not building?
8. Where is the canonical record?
