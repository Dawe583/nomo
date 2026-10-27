# NOMO x YC: risk register and decision log

> **State:** initial review. Owners and dates are placeholders until founders assign them.

## Risks

| Risk | Likelihood / impact | Early signal | Mitigation | Owner |
|---|---|---|---|---|
| No reachable buyer in selected workflow | High / High | Interviews remain hypothetical; no dated buyer follow-up | Choose segment through access and evidence; do not build before access gate | Founder |
| “Local AI” demand is weaker than data-training concern | High / High | Prospects accept enterprise API terms | Treat local mode as optional deployment; ask whether training, retention, inference, or egress is prohibited | Product |
| Generic assistant or incumbent already solves task | Medium / High | Users point to current product as sufficient | Reproduce real case against incumbent before implementation | Product |
| Model gives unsupported consequential guidance | Medium / Critical | Failures on stale, conflicting, or absent evidence | Read-only boundary, fixed evaluations, citations, typed abstention, expert escalation | Domain expert |
| Sensitive data leaks through prompts, telemetry, logs, backups, or support | Medium / Critical | Undocumented external calls or free-text audit records | Data-flow inventory, allowlisted egress, redaction, retention limits, incident plan | Security |
| Air-gap deployment economics become custom services | Medium / High | Each prospect needs distinct hardware and update flow | Quote full lifecycle cost; pilot one standard configuration only after paid demand | Engineering |
| NOMO platform maturity overclaimed | Medium / High | Pitch language exceeds shipped release gates | Capability audit; label shipped, partial, planned, unknown | Engineering |
| Evaluation corpus is biased or too small | Medium / High | Demo passes, real outcomes fail | Include hidden cases, edge cases, independent expert adjudication | Evaluation owner |
| Source changes invalidate answers | Medium / High | Old versions remain retrievable | Version registry, effective dates, stale source blocking, refresh owner | Product |
| Human approval becomes rubber stamp | Medium / High | Approval rate near 100% with no review time | Show exact payload and evidence; sample audits; allow reject; measure review duration | Workflow owner |
| Long sales cycle blocks learning | Medium / Medium | Security review precedes workflow evidence | Start with low-risk workflow and a bounded design partner | Founder |
| Regulatory classification shifts | Low to Medium / High | Workflow influences employment, credit, safety, health, or rights | Exclude high-impact automated decisions; obtain specialist review before expansion | Legal |

## Founder decision log

| Date | Decision | Evidence | Revisit condition |
|---|---|---|---|
| 2026-10-27 | Keep first workflow and segment open | No verified customer interviews or paid pilot in this research | Revisit after discovery gates pass |
| 2026-10-27 | Treat local inference as deployment requirement for a segment, not product premise | Survey concern addresses external model training, not a blanket cloud inference refusal | Revisit if buyers provide written no-egress requirements and budget |
| 2026-10-27 | Start read-only and gate writes behind NOMO policy and approval | Reduces operational risk while testing answer quality | Revisit after a paid pilot proves trust and measurable value |

## Open questions for founders

1. Which founders can conduct customer interviews and implement the first workflow?
2. Which three buyer networks are reachable in the next 14 days?
3. Which repos and capabilities are safe to reuse, and under which licenses?
4. What deployment modes can the team support without custom operations?
5. What is the minimum paid pilot price that creates real commitment?
6. What failure is unacceptable for the first workflow?

