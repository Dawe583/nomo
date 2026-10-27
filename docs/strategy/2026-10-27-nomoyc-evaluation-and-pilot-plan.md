# NOMO x YC: evaluation and pilot plan

> **State:** proposed pilot checklist. The canonical metric definitions and thresholds are in `2026-10-27-nomoyc-evaluation-and-economics.md`; agree all numerical gates with the buyer and expert before the pilot.

## North-star outcome

Reduce time to correctly complete one defined workflow while preserving evidence, operator authority, and customer data boundaries. Do not use model accuracy as the sole success metric.

## Baseline

For every available, authorized, comparable historical or observed case, measure: total completion time; wait time for expert help; number of handoffs; corrections or rework; missing-field rate; outcome quality; source search time; and cost per completed case. Agree the sample size and decision uncertainty with the buyer and expert; 20 cases may be a planning target, not a universal minimum.

## Evaluation dataset

Build an authorized, de-identified evaluation set sized for the question and available volume. Thirty to fifty cases is a planning range, not a universal minimum or statistical guarantee. Expert reviewers define the expected outcome, acceptable evidence, required context, and escalation behavior. Include:

- ordinary cases and common variants;
- missing context and ambiguous language;
- conflicting procedures and stale versions;
- unapproved documents and tenant-boundary attempts;
- prompt injection inside retrieved content;
- unsafe requests outside delegated authority;
- unavailable sources and tool timeouts;
- duplicate submissions and interrupted writes;
- cases with no answer in the source set.

Keep a hidden holdout set after tuning. Avoid putting sensitive examples in public benchmark services.

## Metrics and initial gates

| Metric | Definition | Initial gate |
|---|---|---:|
| Evidence support | Material answer claims supported by cited approved evidence; denominator is all graded material claims | Provisional target only; canonical gate must be agreed with buyer/expert |
| Critical unsupported instruction | High-impact claim without support | Zero in release set |
| Required abstention | Out-of-scope or insufficient-evidence cases refused/escalated correctly; denominator is all cases labeled for escalation | Provisional target only; canonical gate must be agreed with buyer/expert |
| Evidence resolution | User can open cited source and correct version | 100% |
| Tenant boundary violations | Any cross-tenant retrieval or result | Zero |
| Workflow completion time | Median total operator plus reviewer time versus baseline on comparable cases | Provisional 25% lower target; buyer must confirm value threshold |
| Rework rate | Cases requiring correction after assistant support | No worse than baseline, target improvement |
| Expert interrupts | Interruptions per completed case | Downward trend after week 2 |
| Local inference reliability | Completed responses under agreed model/hardware | Set only if buyer-selected local mode is required; define denominator, window, exclusions, and recovery behavior before pilot |

These are proposed gates, not claims. Set final thresholds with the domain expert before the test. Separate quality and economic gates from infrastructure uptime.

## Pilot design

- One organization, one team, one workflow, 2 to 4 weeks.
- Read-only first; no autonomous safety, financial, employment, medical, legal, or customer-impacting decision.
- Named buyer, process owner, expert reviewer, and technical contact.
- Approved source list and source owner.
- Written purpose, user cohort, retention, incident contact, and deletion date.
- Weekly review of failure cases, ungrounded answers, user behavior, and measured outcomes.
- Pre-agreed stop condition for unsafe output, data boundary breach, or repeated critical quality failure.
- Buyer reviews a priced continuation proposal before the pilot ends.

## Release gates

**Gate A, knowledge:** sources approved, versions traceable, permission filters verified.

**Gate B, quality:** fixed test set passes; expert signs off on abstention and escalation.

**Gate C, privacy and security:** data-flow and egress inventory approved; secrets excluded from prompts and logs; retention and deletion tested.

**Gate D, workflow:** field users complete realistic cases; mobile, empty, error, retry, and offline states are understandable.

**Gate E, value:** measured improvement and a buyer-backed commercial next step.

Only after all gates pass should a customer-approved, reversible write action be considered.

