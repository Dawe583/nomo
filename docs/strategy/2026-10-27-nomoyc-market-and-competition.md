# NOMO x YC: market and competition review

> Research date: 2026-10-27. This is a decision memo, not a total addressable market estimate or a claim that buyers want NOMO.

## Executive conclusion

Public evidence justifies a small discovery experiment; it does not establish market size or a viable company opportunity. AI use is rising among the enterprises covered by the survey, while finance and knowledge products are shipping AI features quickly. NOMO should not compete as a generic company chatbot, local model host, or reconciliation assistant. Test one expert-gated workflow only after buyer evidence shows a measurable gap in current software.

The first geography is Czechia because founder access exists there. The product ambition is a general company knowledge and work platform across industries; the first vertical remains unselected. Use the SME owner/CFO contact as an interview route to one recent completed task, then find the operator and expert who know the workflow. Do not build a broad horizontal platform before proving one narrow repeated workflow. Do not build around a task that appears attractive only in a YC essay or a repository name.

## YC signal, read narrowly

The YC Winter 2027 page frames three nearby ideas:

- **The $15-an-Hour Expert:** use AI to let an ordinary worker perform work that previously required specialist expertise. YC names benefits, taxes, insurance claims, medical billing, immigration paperwork, M&A, supply chain, and global trade.
- **Own Your Intelligence:** convert a company's workflows into evaluations, expertise into usable data, and production failures into improvements. The cited request specifically describes open-weight models, customer-specific learning, model choice, data rights, and repeatable improvement.
- **AI for the Air-Gapped Economy:** deliver models, deployment tooling, accreditation, and hardware for buyers that require an offline environment. YC itself calls the sales motion slower and harder.

YC explicitly says RFS is extra validation to explore, not a market validation study and not a requirement for YC applicants. The three items are best interpreted as a product outcome, an improvement capability, and a deployment mode. They should not become three simultaneous product lines.

## European market evidence

| Evidence | What it supports | What it does not support |
|---|---|---|
| Eurostat: 20.0% of its 2025 ICT survey population used AI; the Czech Statistical Office reports 17.6% for Czech enterprises with 10+ employees | Adoption context for the covered enterprise populations | Eurostat covers 10+ employees or self-employed persons in NACE Rev. 2 C–J, L–N and group 95.1; it excludes micro-enterprises and financial/insurance activities (NACE K). Neither statistic is demand or willingness-to-pay evidence. |
| Eurostat: 52.7% of surveyed EU enterprises used paid cloud in 2025; 58.2% of paid-cloud users used finance/accounting applications | Paid cloud is common among the surveyed 10+ employee/self-employed enterprise population; finance applications are common among paid-cloud users | No proof that any particular processor, model, retention setting, data category, or cross-border processing is accepted |
| Eurostat size split: 17.0% small, 30.4% medium, and 55.0% large enterprises used AI in 2025 | Adoption differs by size; onboarding and budget assumptions should not treat all SMEs alike | Survey covers firms with at least 10 employees and excludes micro-enterprises |
| UK Business Data Survey 2026 reports concern about external-model training among some firms | Data-use concern belongs in discovery | UK attitude to training is not the same as refusing API inference, nor a Czech or EU demand estimate |

Do not use these survey percentages as a top-down TAM. The bottom-up market should be measured after workflow selection: eligible companies in a named geography, reachable lawful buyer roles, repeated cases per year, current spend, and a workable deployment margin.

## Competitive facts from current first-party sources

| Alternative | Publicly described capability | Consequence for NOMO |
|---|---|---|
| Microsoft Finance Agent | Finance workflows in Excel, Outlook, and Microsoft Copilot, including reconciliation, discrepancy reports, ERP data, and actions. Microsoft documentation currently notes language/region limits for some surfaces. | Do not pitch generic reconciliation to Microsoft-heavy firms. Test Czech localization, system coverage, exceptions, and access constraints as possible gaps. Verify current availability per tenant. |
| Intuit Intelligence / QuickBooks AI | Company-data answers and multi-step financial tasks, with accounting and transaction workflows in QuickBooks. | Embedded incumbent AI can remove the need for a separate tool. Confirm which accounting platform the CFO uses and what it already handles. |
| Xero JAX / Auto Bank Reconciliation | Automated bank-reconciliation assistance and review capabilities. | Reconciliation itself is not a defensible category. Search for unresolved exceptions and cross-system work beyond the incumbent. |
| Glean | Enterprise search and AI coworker with grounded answers, permission-aware sources, agents, and a customer-hosted deployment option. | Company knowledge plus citations is already a competitive category. Glean's customer-hosted option still has vendor operational access and is not the same as an offline air gap. |
| Dust | Company knowledge, 70+ integrations/MCPs, agents and workflows, model choice, audit and governance, and EU/US residency. | Generic governed agents are already offered. Pick a specific workflow, incumbent gap, or deployment condition. |
| Onyx | Open-source enterprise search and assistant with cloud, on-prem, bare-metal, and public air-gap claims, plus permission controls and connectors. | Air-gap plus RAG is not an empty market. Compare product quality, support, integration, compliance scope, and the buyer's own implementation capacity. |
| Existing accountants, finance suite, spreadsheets, email, and human experts | Existing status quo may already be acceptable and carries known accountability | They are competitors even if they are not AI products. Measure their total time, quality, risk, and switching cost. |

Competitor descriptions above are based on vendor documentation and marketing pages. They are not independent security audits. Verify exact feature availability, licenses, model retention, support access, and localization during customer discovery.

## Initial market hypotheses to test

1. **Expert workflow:** one role completes a repeated task that requires searching across internal rules and case context. The worker can safely prepare, classify, or draft, while an expert retains judgment and accountability.
2. **Company intelligence:** the buyer needs a repeatable way to maintain approved sources, capture reviewed corrections, compare models, and prove quality over time.
3. **Private deployment:** the buyer needs documented control over model inference, storage, telemetry, updates, and support. The word "private" must be decomposed into these testable requirements.

### Candidate first workflow screen

A workflow passes initial screening only if all are true:

- The same identifiable task occurred recently and recurs at a known frequency.
- A named user or operator owns the work and a named expert can grade the result.
- The current process has measurable delay, expert interruption, rework, or capacity cost.
- One source of truth and one current software alternative are known.
- The buyer can authorize a small representative case set.
- A read-only outcome can help before any sensitive write or autonomous decision.
- The buyer agrees to a dated, priced next step if the evaluation passes.

Potential examples include document-heavy financial exceptions, supplier or customer case resolution, claims intake, or service paperwork. These are prompts for discovery, not ranked product choices. Avoid employment decisions, medical diagnosis, financial advice, safety certification, or other high-impact determinations as an early MVP.

## Decision on accounting as first segment

The CFO contact makes finance one possible first conversation, not the selected vertical or automatically the best product. Search across industries for workflow evidence. If that conversation surfaces finance work, Intuit, Xero, and Microsoft already have recent finance agents and reconciliation features. Therefore:

- Ask which system is the source of truth and which AI features the company has already tried.
- Locate a narrow exception or handoff that remains manual across systems, if one exists.
- Interview the operator as well as the buyer. A CFO may not experience the daily workflow.
- Stop if current software handles the case at acceptable cost, quality, and trust.
- Do not build generic invoice extraction, bookkeeping chat, or bank matching without verified gap evidence.

## Positioning direction

Weak: "NOMO is private AI for every company."

Stronger hypothesis: "NOMO helps [named role] complete [one repeated workflow] with approved company evidence, explicit escalation, and controlled actions. We measure [customer-approved outcome] against the current process."

Treat source citations, policy approvals, local inference, and ledgers as proof and product mechanisms. They are not customer outcomes by themselves.

## Sources and retrieval date

- YC, Requests for Startups, Winter 2027: https://www.ycombinator.com/rfs
- Eurostat, Use of artificial intelligence in enterprises: https://ec.europa.eu/eurostat/statistics-explained/SEPDF/cache/106920.pdf?v=1383188104890435
- Eurostat, 20% of EU enterprises use AI technologies: https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20251211-2
- Czech Statistical Office, ICT in enterprises: https://csu.gov.cz/ict-in-enterprises
- Eurostat, cloud computing in enterprises, 2025: https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260203-1
- Microsoft, Finance Agent: https://learn.microsoft.com/en-us/copilot/finance/welcome
- Microsoft, Finance Agent capabilities: https://learn.microsoft.com/en-us/dynamics365/fin-ops-core/fin-ops/copilot/copilot-for-finance-operations
- Intuit, Intuit Intelligence: https://quickbooks.intuit.com/learn-support/en-us/help-article/intuit-assist/introducing-intuit-intelligence/L189976Da_US_en_US
- Xero, Auto Bank Reconciliation: https://blog.xero.com/product-updates/auto-bank-rec-updates/
- Glean, product overview: https://docs.glean.com/user-guide/about/what-is-glean
- Glean, deployment models: https://docs.glean.com/get-started/build/about-self-hosted
- Dust, product: https://dust.tt/home/product
- Dust, pricing: https://dust.tt/home/pricing
- Onyx, secure AI: https://onyx.app/solutions/secure-ai
- European Commission, AI Act: https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai

## Confidence and limitations

High confidence in what YC and each vendor publicly describes, subject to vendor changes. High confidence in Eurostat's survey population and the broad rates shown. Medium confidence in relevance to NOMO because segment and workflow are unselected. Low confidence in a purchase forecast because no buyer interview, authorized example, priced proposal, or signed pilot exists.
