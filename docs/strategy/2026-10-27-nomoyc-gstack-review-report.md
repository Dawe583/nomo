# NOMO × YC Winter 2027: GStack review report

**Status:** latest native CEO, design, DX, and engineering pass complete; final owner decision pending
**Review date:** 27 October 2026
**Scope:** current NOMO × YC strategy, founder page `/nomoyc`, page API, and encrypted document workflow.
**Canonical plan:** [integrated roadmap](2026-10-27-nomoyc-integrated-roadmap.md)

## Decision summary

The work is ready to begin **customer discovery**, not customer-facing product development. The strongest testable outcome remains the YC idea **The $15-an-Hour Expert**: help a worker complete one repeated, expert-gated company task with approved evidence and human review. **Own Your Intelligence** is a later improvement capability; **AI for the Air-Gapped Economy** is a deployment option only when a named buyer requires and funds it. The vertical and workflow remain unselected.

No interview, workflow, authorized case set, paid pilot, or willingness to pay has been confirmed. The warm Czech SME owner/CFO contact is an interview route, not proof of a finance segment or purchase intent. If the next interviews do not establish a repeat task, operator and expert access, a lawful data path, a current-system gap, and a buyer-backed paid next step, change the candidate or stop. The research therefore supports a disciplined experiment, not a claim that the startup will succeed.

## Phase coverage

| GStack autoplan phase | Native review | Outside review | Main findings and disposition | Remaining limit |
|---|---|---|---|---|
| CEO / product direction | Prior rounds: 4, then 2, then 0 new findings; latest amended-plan pass: 0 findings | Unavailable; no external reviewer was configured | Discovery before product code; compare workflow/buyer hypotheses; require evidence, buyer economics, and incumbent comparison; allow an inconclusive outcome | Native-only review. |
| Design / founder page | Prior rounds: 6, then 1, then 1 finding; latest amended-plan pass: 0 findings | Unavailable; no external reviewer was configured | Decision-first page, conditional roadmap branches, read-only snapshot, source labels, responsive diagrams, and authentication/loading/error states | This is a design-plan review. A browser screenshot review of the final deployed page has not run. |
| Developer experience | Prior rounds: 7, then 2, then 1 finding; latest amended-plan pass: 0 findings | Unavailable; no external reviewer was configured | RFC 9457 API errors, request IDs, recovery, retry bounds, redaction, encrypted-manifest sync, Vercel setup, and local secret handling | Native-only review. |
| Engineering plan | Earlier findings incorporated; latest amended-plan pass: 1 Medium finding | Unavailable; no external reviewer was configured | Clarified a pre-approved labor-rate method, buyer acceptance and collected-payment evidence, and separate rate series | Open question: if the labor-rate policy changes, the three-organization gate must either restart or all included deployments must be recalculated under one policy. The approved six-round cap (with one granted round) is exhausted; another plan edit reopens the review phases and needs owner authorization. |

All outside-review attempts were unavailable because the host has no configured external review provider. No private plan was sent to an external reviewer. The GStack guard is not installed/enforced on this host, so its publication-order check was not available. GStack telemetry remains off as requested. A cross-project learned-notes search returned no notes; the local brain was unreachable and had no cache.

## What changed after review

- Removed the finance-first ranking and speculative scores from active strategy papers. Finance stays one unranked candidate; the CFO is only the first reachable interviewee.
- Made the discovery plan neutral across industries and Czechia-first, with an explicit ten-working-day decision point and stop/revise criteria.
- Separated market facts from demand claims. Eurostat's AI figure applies to its 10+ employee/self-employed survey population in NACE C–J, L–N and group 95.1; it excludes micro-enterprises and finance/insurance. The 58.2% finance/accounting cloud figure is a share among paid-cloud users. None of these data establishes demand for NOMO.
- Preserved the three YC ideas as a sequence of outcome, learning capability, and deployment mode—not three parallel product lines.
- Added a developer runbook and source-to-encrypted-content tooling. The manifest check reports document IDs/paths but not document content or key values.
- Added RFC 9457 API error behavior, request correlation, retry bounds, login-screen recovery detail, and a release runbook for hidden local secrets.
- Kept the page unlinked from public navigation and sitemap, with noindex headers and authenticated encrypted content.
- Kept NOMO Harness/TUI/first-live as an independent technical stream. Shipping it does not validate demand for the startup concept.

## Security and access note

The page uses one shared password because that is the selected access mode. A shared password is a temporary gate, not proof of individual founder identity or an allowlist: anyone who receives the URL and password can use it. The runbook assigns an owner and requires rotation/revocation when membership changes. If named-person access becomes mandatory, use individual identity or deployment protection. Customer data and production credentials must remain outside this founder workspace.

The API security check currently passes 20 isolated assertions with in-memory rate-limit state and no production request. It does not test Vercel's production edge, browser rendering, mobile appearance, or real secret configuration; those still require pre/post-deployment checks.

## GStack methods used

- YC Office Hours style founder discovery: recent behavior, a neutral problem interview, buyer/operator distinction, evidence gates, and selected-answer checkpoints.
- GStack `/autoplan` with CEO, design, DX, and engineering-plan reviews; findings were incorporated into the plan and implementation.
- CEO review lens for product sequencing, timeboxes, kill criteria, buyer value, and competitor alternatives.
- Design review lens for decision-first hierarchy, conditional branches, page states, provenance, and responsive diagrams.
- DX review lens for setup steps, error contracts, recovery, retry bounds, redaction, and one-command manifest verification.
- Engineering review lens for access boundaries, fail-closed behavior, and API failure-path verification.
- Source-driven market research for YC's RFS, Eurostat, ČSÚ, Czech ÚOOÚ, and official regulatory guidance.

The standalone GStack pre-landing PR review was not run: work remains on `main`, and that skill explicitly stops when reviewing the base branch without a PR diff. The autoplan engineering review and the isolated API security assertions are the applicable evidence for this direct-to-main workflow; they are not an external code review.

## Final gate and decision

The current autoplan gate was revision 5. The owner chose `p1a` (approve as-is) after being told that one Medium engineering finding remains open and that another reviewer round would exceed the approved cap with unknown reviewer cost. The unresolved rule is to decide whether a labor-rate policy change resets the three-organization scale gate or requires recalculating every included deployment under one method. Do not mix rates silently; resolve the policy before using that gate to claim repeatability. Autoplan status: complete with this owner-accepted finding.

**Market verdict:** proceed with discovery and NOMO first-live in parallel. Do not spend months building a generic platform, train a model, build air-gap operations, or pick accounting based on these public statistics. The opportunity is plausible because NOMO's identity, policy, approval, execution, and evidence work could support a governed expert-workflow product. It succeeds only if reachable buyers demonstrate recurring costly work, authorized examples, measurable value over existing alternatives, willingness to pay, and repeat use at viable delivery cost.

## Sources

- [YC Requests for Startups, Winter 2027](https://www.ycombinator.com/rfs)
- [Eurostat: AI use and survey population](https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20251211-2)
- [Czech Statistical Office: ICT in enterprises](https://csu.gov.cz/ict-in-enterprises)
- [Eurostat: paid cloud and application denominator](https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260203-1)
- [ÚOOÚ: commercial-message FAQ](https://uoou.gov.cz/cinnost/obchodni-sdeleni/casto-kladene-otazky-k-zakonu-c-4802004-sb)
- [European Commission: AI Act enforcement timeline](https://digital-strategy.ec.europa.eu/en/policies/enforcement-ai-act)
