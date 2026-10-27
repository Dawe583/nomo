# NOMO private AI opportunity: market research memo

**Status:** exploratory research, not a validated product decision  
**Date:** 27 October 2026  
**Purpose:** connect the YC Winter 2027 signals around expert work, air-gapped AI, and customer-owned intelligence to a credible NOMO product wedge.

## Executive summary

The strongest strategic connection is not a generic private chatbot. It is a **private, governed workflow that lets a less-specialized employee complete a bounded piece of expert work**. This connects three related YC Winter 2027 Requests for Startups:

1. **The $15-an-Hour Expert:** AI helps a capable generalist perform work that previously needed a specialist.
2. **AI for the Air-Gapped Economy:** bring AI into environments that cannot call an external API or connect to the internet.
3. **Own Your Intelligence:** help companies turn their workflows, expertise, and outcomes into intelligence they control and can improve.

YC says Requests for Startups are ideas it wants founders to explore, not a complete map of what it funds or proof that a particular customer will buy. The overlap is a useful strategic signal. It does not validate our market, buyer, or chosen workflow.

Public evidence supports a real adoption and integration gap. It does **not** support treating every business that handles confidential data as unable to use cloud AI. EU cloud services are common, including accounting and finance applications. UK survey respondents also distinguish discomfort with training external models from use of AI in their businesses. These facts argue for connecting to the customer's existing system of record and validating the exact data boundary, not for assuming every SME wants either cloud AI or air-gap.

**Working recommendation:** start with one outcome-focused workflow. For sensitive cases, test a customer-controlled data plane with a local model, blocked prompt egress, and no cloud fallback. Let the accounting system remain the system of record. Keep approved API inference as a separately enabled route for data the buyer explicitly classifies as safe; reserve full air-gap for a buyer who requires and funds it. Put NOMO underneath as the identity, policy, approval, and evidence layer. Do not start by training a proprietary model or selling a universal on-prem platform.

The first market remains unselected. Accounting operations are a promising research candidate because they combine repetitive document work, sensitive records, existing AI adoption, and public evidence of local deployments. Insurance claims, medical billing, and other financial operations remain alternatives. We need compare buyer access, workflow frequency, measurable value, deployment constraints, integration effort, and competition before committing.

The founder reports a direct route to an SME owner or CFO in accounting or finance operations and can request an interview this week. The contact has not yet been asked. This is access to one conversation, not a validated workflow or purchase signal.

## 1. What YC is signalling

The Winter 2027 RFS page describes a shift in AI bottlenecks from models toward hardware, infrastructure, financial systems, and specialized software. Its three relevant ideas create a coherent product direction:

| RFS | Core customer outcome | Implication for NOMO |
|---|---|---|
| The $15-an-Hour Expert | A non-specialist completes more complex work with AI support. | Sell completed, reviewed work and improved staff capacity, not model access. |
| AI for the Air-Gapped Economy | AI works inside environments that cannot use external APIs or internet connectivity. | Make deployment boundaries, offline operation, updates, and evidence first-class. |
| Own Your Intelligence | A company improves and controls the intelligence that encodes its own work. | Capture workflow decisions and expert corrections as evals and reusable knowledge before considering fine-tuning. |

The RFS gives examples in benefits, taxes, insurance claims, medical billing, immigration paperwork, factories, banks, hospitals, and defense. These are starting points for research, not recommended verticals. RFS explicitly says it represents only a fraction of what YC funds and that founders do not need to follow it.

Source: [YC Requests for Startups, Winter 2027](https://www.ycombinator.com/rfs).

### Full Winter 2027 RFS map against NOMO

The current page lists 11 ideas. This table keeps the selected direction in context and prevents us from mistaking one attractive idea for the whole YC opportunity set.

| Winter 2027 RFS | NOMO fit | Current decision |
|---|---|---|
| Startups in a World of Abundant Space Access | Low. Depends on a space-economy business model or customer access not present in NOMO's current product context. | Do not pursue now. |
| The $15-an-Hour Expert | High. Directly matches bounded, reviewed agent workflows that let operations staff perform expert-gated work. | Primary application thesis to explore. |
| Robots Made in America | Low-Medium. Agent governance may support robot fleets, but hardware and domestic supply chains are a different company and sales motion. | Defer. |
| LLMs That Write Well | Low. Requires a language-model research and training advantage, not NOMO's current control-plane assets. | Do not pursue now. |
| Plaid for Government Benefits | Medium. Strong agent identity, data provenance, and workflow authorization fit; requires government integration, trusted records, and procurement. | Research as a later vertical opportunity, not MVP. |
| Wall Street for the Physical Buildout | Low. Financing and underwriting infrastructure do not match current capabilities. | Do not pursue now. |
| Vertical Foundation Models | Medium-High as a later learning loop. NOMO can capture approved outcomes and evals; building a foundation model now would be premature. | Defer model training; design for permissioned eval data. |
| AI for City Hall | Medium. Governed document workflows fit technically; public procurement and municipal integrations constrain speed. | Defer until a reachable city workflow exists. |
| Data Center Supply Chain | Medium. Could fit a specific operations workflow, but no current customer access or domain evidence. | Defer pending a real operator and workflow. |
| AI for the Air-Gapped Economy | High platform fit. Connects to customer-controlled runtime, offline deployment, tool policy, and evidence. | Deployment thesis for a qualified buyer, not a standalone MVP promise. |
| Own Your Intelligence | High long-term fit. A permissioned workflow-to-eval improvement loop is consistent with customer-owned operations and NOMO's ledger/control plane. | Long-term compounding strategy; begin with evals, not fine-tuning. |

**Portfolio view:** pursue the overlap of The $15-an-Hour Expert, AI for the Air-Gapped Economy, and Own Your Intelligence. Treat the first as the customer outcome, the second as a deployment constraint for buyers who require it, and the third as the long-term learning loop.

### Strategic interpretation

These ideas fit together if we define the product around **work**, not around a local model:

> A worker brings an exception, case, or document packet. A private AI workflow gathers approved context, prepares a decision-ready result, cites the evidence, and routes uncertain or consequential steps to an accountable human. NOMO enforces which agent and tools may act, records the decision path, and makes the workflow measurable.

This can serve the $15-an-hour expert thesis. The worker may be an existing employee with lower credentials, or an operations employee who handles more complex cases with expert oversight. The first release should not autonomously make regulated, safety-critical, or financially binding decisions.

## 2. Market evidence and its limits

### Fresh EU evidence: the bottleneck is implementation capability

Eurostat's 2025 enterprise survey puts AI use at 20.0% across EU enterprises
with at least 10 people, 17.7% in Czechia, 40.4% in professional, scientific
and technical services, 62.5% in information and communication, and 10.8% in
construction. The last two sector figures are not a direct ranking of buyer
quality. The survey covers enterprises with at least 10 people and does not
measure willingness to pay, workflow pain, data sensitivity, or local-model
demand.

Among enterprises that had considered AI but did not adopt it, the most common
reported barriers in 2025 were lack of relevant expertise (70.3%), legal
uncertainty (53.6%), privacy concerns (52.7%), and cost (38.4%). Only 17.8%
said AI was not useful for their business. This supports testing a product that
reduces implementation and workflow expertise barriers while making data
boundaries clear. It does not establish that an all-in-one platform or an
air-gapped model is the right purchase.

**Strategic implication:** the first experiment should compare two kinds of
value separately: “the worker can finish more expert work” and “the company can
deploy it under its data rules.” The product needs both only if the same buyer
requires both. Do not allow platform fit to conceal a missing user outcome.

Sources: [Eurostat, AI use by economic activity](https://ec.europa.eu/eurostat/statistics-explained/SEPDF/cache/106920.pdf?v=1383188104890435),
[Eurostat, reasons for not adopting AI](https://ec.europa.eu/eurostat/documents/7870049/23260410/KS-01-26-009-EN-N.pdf/37d063cb-28cf-3b4e-91f3-c3784c970842?t=1774528533658&version=1.1).

### AI adoption is broad, but scaled workflow use remains incomplete

McKinsey's 2025 global survey reports that 88% of respondents' organizations regularly use AI in at least one business function. About one-third say their organization has begun scaling AI programs. For agents, 23% report scaling an agentic system somewhere in the enterprise and another 39% report experimentation. The survey also says respondents commonly see task-level benefits while enterprise-wide financial impact remains limited.

This suggests room for products that move from experimentation to repeatable workflow outcomes. It does not show that local deployment is the reason most pilots fail. McKinsey's figures are self-reported survey results and should be treated as directional.

Source: [McKinsey, The state of AI in 2025](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai-2025).

### UK evidence: adoption, privacy attitudes, and integration are separate questions

The UK Government's 2025-26 Business Data Survey provides useful evidence for a European market hypothesis. Among surveyed UK businesses that handle digitized data:

- 41% reported using AI for at least one purpose; adoption was higher in professional, scientific, and technical services (54%), finance and insurance (48%), and human health and social work (46%).
- 21% of AI-using businesses said their AI tools were integrated into existing business systems. Integration was more common in large firms (57%) than medium firms (31%), small firms (31%), or micro firms (27%).
- 73% said they would be uncomfortable with their business data being used to train external AI models. This question concerns model training. It does **not** establish that these businesses refuse all API processing under enterprise data-protection terms.
- 27% reported using servers on business premises. On-prem infrastructure is more common in larger firms; smaller businesses more often depend on externally managed infrastructure.

This supports three distinct hypotheses: companies want control over how their data improves models; many AI tools are not integrated into real work; and the ability to run on existing customer infrastructure varies sharply by business size. It does not establish willingness to buy NOMO or willingness to operate local models.

Source: [UK Business Data Survey 2026](https://www.gov.uk/government/statistics/uk-business-data-survey-2026/uk-business-data-survey-2026).

### Buying evidence: budgets are moving toward applications

Menlo Ventures estimates that organizations spent $37 billion on generative AI in 2025, of which $19 billion went to application products. It estimates that 76% of enterprise AI solutions are purchased rather than built internally. Menlo reports that spending spans horizontal, departmental, and vertical products, with healthcare among the largest vertical categories.

These are investor estimates, not audited market totals. They still support an important choice: start with a complete, useful application or workflow. A new infrastructure control plane alone competes for a slower and more technical purchase.

Source: [Menlo Ventures, 2025: The State of Generative AI in the Enterprise](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/).

## 3. Privacy claim: separate three buyer requirements

“Sensitive data” can mean different things. The product and sales motion change depending on which requirement applies.

### Cloud use in the target segment

Eurostat reports 52.7% of EU enterprises with 10 or more employees used paid cloud services in 2025. Its category breakdown reports paid cloud finance or accounting applications at 58.2%. The statistics do not cover firms with fewer than 10 employees in this series and do not establish whether buyers permit separate model APIs. They do show that an SME finance workflow is likely to touch an existing cloud system of record, so the product should retrieve only authorized case data and keep model routing explicit.

**Inference:** the best first architecture is a hybrid control/data boundary, not “everything cloud” or “internet-free appliance.” Test one customer-controlled local inference node for sensitive case content. Keep policy and approvals in NOMO; send content to cloud models only through an explicitly approved route. Full air-gap remains an optional profile, not the baseline promise.

Source: [Eurostat, 53% of EU enterprises used paid cloud services in 2025](https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260203-1).

| Requirement | What buyer means | Likely deployment response |
|---|---|---|
| Contractual privacy | Do not train general models on our inputs; protect access and retention. | Enterprise cloud or API may qualify under the customer's approved terms and configuration. |
| Data residency or customer-controlled cloud | Keep content within a selected region, cloud account, or network boundary. | Regional cloud, customer-hosted deployment, private networking, or private cloud. |
| Zero egress / air gap | No prompts, documents, embeddings, telemetry, or model calls leave the controlled environment; possibly no internet at all. | Fully on-prem or disconnected deployment with controlled software and model updates. |

The distinction matters commercially. OpenAI states that API data is not used to train or improve its models by default, and that default abuse-monitoring logs may be retained for up to 30 days; eligible customers may request zero data retention for supported use cases. Anthropic describes a default API retention period of up to 30 days, with approved zero-retention arrangements for some commercial API customers. Microsoft documents customer-data protections for Azure-hosted models. These services still process data in vendor-operated infrastructure, so they do not meet a strict no-egress requirement.

Therefore, “we never send data to an API” can be a hard product requirement for air-gapped buyers. It is not automatically a compelling reason for every company to reject enterprise cloud AI. Lead with the operational outcome and accurately describe the deployment options. Do not claim that cloud APIs train on private business data by default.

Sources: [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), [OpenAI enterprise privacy](https://openai.com/enterprise-privacy/), [Anthropic data retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Microsoft Foundry data privacy](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy).

## 4. Competitive landscape

This is already a competitive category. A private model, knowledge search, connectors, or audit logs are each available from established vendors or open-source projects. NOMO needs a narrow workflow advantage and a control-plane advantage that matters to a real buyer.

| Category | Examples | What they already provide | Opening for NOMO |
|---|---|---|---|
| Enterprise knowledge and work agents | Glean, Dust | Search over company data, permissions, connectors, agents, controls, and hosted or managed deployment options. | A strict disconnected environment or an application that owns a specific business outcome rather than general knowledge search. |
| Customer-hosted enterprise AI | Glean Customer Hosted; cloud vendors' private deployments | Run in a customer cloud boundary with managed operations, policy controls, and enterprise security. | Fully disconnected operation, customer-controlled update path, and a simple narrow workflow for organizations not served by full enterprise platforms. |
| Self-hosted AI workspaces | Onyx Assistant and other open-source/self-hosted stacks | Local orchestration and model serving, document analysis, chat, and agent workflows. | Stronger identity-bound tool authorization, fail-closed action control, verified evidence, workflow-specific evals, and an operator-ready lifecycle. |
| AI security/control planes | Onyx Security and other governance vendors | Visibility across agents/models, policies, monitoring, integrations, and deployment flexibility. | Fine-grained execution identity and authorized tool calls inside the customer's own private workflow, if NOMO's implementation proves easier or safer. |
| Managed private AI installation | Onyx Systems and specialist integrators | Hardware, local models, document access, custom agents, implementation, and ongoing operations. | Productize repeatable workflow controls and customer-owned improvement loops; partner rather than compete on bespoke installation where useful. |
| Hardware and AI infrastructure | NVIDIA, HPE, cloud providers | Compute, model serving, and packaged private or air-gapped infrastructure. | Software that makes a bounded work process useful and auditable on top of these platforms. |

Glean's documentation illustrates the limits of the phrase “self-hosted”: its Customer Hosted deployment runs as a managed service in the customer's cloud, with Glean still retaining operational support access. That is useful for residency and network control, but is not the same as a disconnected appliance. Dust positions itself around company knowledge, agents, integrations, flexible models, and governed collaboration. Onyx Assistant positions itself as an on-prem AI assistant with an on-prem orchestration and vLLM stack. Onyx Systems describes managed local AI deployments and publishes a vendor-reported accounting-firm case study claiming 250 staff hours saved per month and an $8-12K starting cost for a local-model server. Treat this case as a lead for diligence, not as independently verified evidence.

Sources: [Glean deployment models](https://docs.glean.com/get-started/build/about-self-hosted), [Dust product](https://dust.tt/home/product), [Onyx Assistant](https://onyx.id/products/ai-assistant), [Onyx Systems](https://onyxisystems.com/), [Onyx Security](https://www.onyx.security/platform).

### Competitive conclusion

“Private AI with agents and an audit trail” is not enough. Vendors already claim those capabilities. A defensible product needs to own one or more of:

1. A repeated workflow with measurable economics.
2. Customer-approved operational knowledge and evaluation data that improve the workflow over time.
3. Deployment and maintenance that make private AI practical for a defined buyer segment.
4. An enforceable control path that ties every tool action to an authorized agent, policy decision, human approval, and verifiable record.

NOMO's current strongest strategic fit is item 4. The repository's target direction is an Agent Identity and Fleet Control Plane for MCP-capable agents. The README says the fleet identity runtime is not shipped yet. Existing local proxy, policy, approval, signed ledger, Harness, and tool-control work is useful foundation, but product and runtime readiness claims must match the current code and release gates.

Source of product boundary: [NOMO repository README](https://github.com/Dawe583/nomo).

## 5. Candidate first wedges

The score below is a prioritization hypothesis, not a measured market score. “Speed” includes buyer access; we currently have no confirmed access to any target customer. High compliance burden and long integrations reduce speed.

| Workflow candidate | $15/hour fit | Sensitive data / local value | Measurable ROI | MVP speed | NOMO fit | Main risk |
|---|---:|---:|---:|---:|---:|---|
| Accounting operations: organize client documents, reconcile facts, produce exception packets for accountant review | High | High | High | Medium | High | Strong incumbent and services competition; source diversity; need to avoid tax advice or unattended filing. |
| Insurance claims: assemble claim evidence, check completeness, draft adjuster decisions | High | High | High | Low-Medium | High | Core claims systems, insurer procurement, regulation, and liability. |
| Medical billing: prepare denial/appeal packets and identify missing evidence for review | High | Very high | High | Low | High | HIPAA/security, payer-specific rules, EHR/RCM integrations, accuracy and buyer access. |
| Immigration paperwork: collect documents, check case completeness, draft evidence summaries | High | Very high | Medium-High | Low-Medium | Medium-High | Legal boundaries, changing requirements, client confidentiality, jurisdiction-specific rules. |
| Industrial maintenance: help technicians diagnose issues from approved manuals and history | Medium-High | Medium-High | Medium-High | Medium | Medium-High | Hardware/offline deployment, source quality, safety, and field workflow access. |

### Preliminary ranking

1. **Accounting operations** is the best research candidate for a first supervised workflow. The customer usually has repeated document work, a clear expert-review step, and a recognizable labor-cost baseline. A local AI installation provider reports activity in this segment, but that is self-published evidence and does not prove that a repeatable SaaS product sells.
2. **Insurance claims** may offer larger workflow value and a stronger expert-bottleneck thesis, but needs deeper workflow and integration evidence before it can be called faster.
3. **Medical billing** has attractive recurring economics and data sensitivity. Security, specialized integration, and clinical-administrative accuracy make it a poor default for a first build without buyer access.
4. **Immigration paperwork** is close to YC's example but risks drifting into legal advice and has jurisdiction-specific knowledge requirements.
5. **Industrial maintenance** can fit NOMO's earlier field-expert direction, but it does not yet have confirmed access or a demonstrated need for a fully offline model.

**Do not select accounting yet.** The public evidence only justifies taking it into the next comparison round.

## 6. Product hypothesis to carry into brainstorming

### User-facing product

For one chosen operations team, a worker submits a bounded case packet. The system:

1. Reads only approved documents and records, respecting source-level permissions.
2. Extracts facts with links to exact evidence and flags conflicts or missing data.
3. Prepares a structured, review-ready deliverable for the expert.
4. Asks a human to approve any action that changes a financial, legal, safety, or customer-facing state.
5. Records the outcome and expert correction for a customer-owned evaluation set.

The measurable promise is completed cases per staff hour, turnaround time, rework, escalation rate, and expert review time. “Chat with your company knowledge” is a capability, not a product promise.

### NOMO integration boundary

NOMO remains the control plane. The application workflow consumes NOMO-issued identity and short-lived authorization, routes external tool calls through the existing policy and Harness path, requires human approval for consequential operations, and records tamper-evident evidence in the ledger. Product data such as source documents, prompts, answers, and sensitive case content should not be copied into the ledger by default. The customer owns the data, source permissions, retention policy, and evaluation examples.

Initial product hypothesis: one customer-controlled data plane with local inference for sensitive case content, no prompt egress, and no cloud fallback. The existing finance system may remain SaaS; the connector fetches only the authorized case context. Separate customer-approved API inference for explicitly safe data, and disconnected on-prem as a later profile. Do not promise every mode in the first MVP. If “no egress” is a strict requirement, test it with network-deny controls and packet-level evidence, not a marketing statement.

### Model strategy

- Begin with an existing open-weight or approved private model and retrieval over customer-approved sources.
- Build a workflow evaluation set with expert-approved expected outputs and refusal/uncertainty cases.
- Route tasks based on measured quality and deployment policy; a local model may be sufficient for extraction, classification, and structured drafts while a person handles ambiguous judgment.
- Improve prompts, retrieval, workflow state, and evaluation before fine-tuning. Fine-tuning requires permissioned examples, stable evaluation, and a demonstrated performance or cost gap.
- Treat local inference as an explicit data-routing property, not proof that a model is more accurate or secure by itself. Measure local model quality and the full deployment/support cost on approved representative cases.

## 7. Proposed research and product sequence

This is the next working sequence, not an approved build commitment.

### Stage 1 - choose a wedge from evidence

Build a candidate scorecard for accounting, claims, billing, immigration, and field maintenance. For each one, research the operator's repeated task, affected systems, current process, staffing cost, output quality requirements, buyer, purchasing path, deployment constraint, incumbent products, and reachable first channel. Keep sourced facts separate from assumptions.

**Exit evidence:** one workflow with a bounded input/output, clear human owner, observable baseline, buyer who can purchase or approve a pilot, and a credible first-user path.

### Stage 2 - test the result before building a platform surface

Create a synthetic-data demonstration of one end-to-end case. Show the worker's workflow, source citations, exception handling, expert review, and evidence trail. Make no customer-specific data or runtime claims. Use it to support outreach and concrete discovery conversations.

**Exit evidence:** workflow owners recognize the problem in their own process; they can describe recent cases, current workarounds, failure cost, and the person who controls a pilot. Interest in generic AI is not enough.

### Stage 3 - map the actual NOMO reuse boundary

Read the current implementation, not only README or roadmap. Trace the proxy, Harness, registry, policy, approval, ledger, APIs, Workbench/CLI user surfaces, packaging, and tests. Mark each capability as shipped, incomplete, or planned. Identify the narrowest way to host a private model and local retrieval without bypassing identity, policy, or Harness release gates.

**Exit evidence:** a verified architecture map, explicit gap list, no duplicated control path, and a private-deployment threat model.

### Stage 4 - build a supervised, read-only workflow pilot

Use synthetic data first; move to customer-approved sample data only after a named source owner and deployment boundary are agreed. Limit the workflow to reading, extraction, evidence citation, structured drafting, and escalation. Do not enable tool writes or autonomous decisions in this phase.

**Exit evidence:** expert-approved evaluation results, permission correctness, source freshness handling, acceptable latency, and a measured time or quality benefit over the current process.

### Stage 5 - expand to one bounded action only if pilot evidence supports it

Choose one reversible action with an explicit inverse, idempotency, policy classification, approval, ledger evidence, and recovery path. Keep it inside NOMO's product-v1 security gates. Expand only after the customer approves exact behavior and audit evidence.

### Stage 6 - build the customer-owned improvement loop

Store approved correction labels and workflow outcomes in customer-controlled storage. Turn them into versioned evaluation cases. First improve retrieval, instructions, routing, and tool schemas. Test fine-tuning or a vertical model only after the quality and economics baseline demonstrate the need.

## 8. Questions public research cannot answer

Public sources cannot tell us:

- Which buyer we can reach first.
- Which workflow repeatedly causes expensive expert bottlenecks.
- Whether the buyer rejects cloud APIs, requires regional processing, or only needs better contract and retention controls.
- Which documents and systems the workflow actually uses.
- What error rate, review time, and workflow delay the customer will tolerate.
- Who owns the budget and can approve a pilot.
- Whether a customer will pay for workflow outcomes, a local deployment, or an ongoing managed service.
- Whether current NOMO code and deployment artifacts meet the product-v1 release gate for this deployment.

These are the next uncertainties to resolve. Do not treat public market evidence or YC's RFS language as a substitute for a buyer and a real workflow.

## 9. Research sources and confidence

| Source | Use | Confidence and limit |
|---|---|---|
| [YC Winter 2027 RFS](https://www.ycombinator.com/rfs) | The three adjacent founder theses and example domains. | High for what YC published; not demand or product validation. |
| [Eurostat 2025 cloud adoption](https://ec.europa.eu/eurostat/web/products-eurostat-news/w/ddn-20260203-1) | Paid cloud use and finance/accounting app adoption among EU enterprises with 10+ employees. | Official EU statistics; does not measure permission for external model inference or micro-enterprises. |
| [UK Business Data Survey 2026](https://www.gov.uk/government/statistics/uk-business-data-survey-2026/uk-business-data-survey-2026) | AI use, integration, privacy attitude, deployment infrastructure by UK business size/sector. | High-quality government survey; UK-only, responses are self-reported, questions distinguish training from processing. |
| [McKinsey State of AI 2025](https://www.mckinsey.com/capabilities/quantumblack/our-insights/the-state-of-ai-2025) | Global reported adoption, agent experimentation/scaling, workflow maturity. | Large global survey but self-reported; useful as direction, not a specific market size. |
| [Menlo Ventures 2025 enterprise AI report](https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/) | Estimated enterprise AI spending and application-layer purchasing. | Investor estimate; methodology and category definitions matter. |
| [Glean deployment documentation](https://docs.glean.com/get-started/build/about-self-hosted) and [Dust product](https://dust.tt/home/product) | Competitive deployment and platform claims. | First-party vendor descriptions; validate features and access during procurement. |
| [Onyx Assistant](https://onyx.id/products/ai-assistant), [Onyx Systems](https://onyxisystems.com/), [Onyx Security](https://www.onyx.security/platform) | Self-hosted and managed-private AI competition; example implementation economics. | First-party vendor claims; reported hours and pricing are not independently verified. |
| [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), [OpenAI enterprise privacy](https://openai.com/enterprise-privacy/), [Anthropic retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [Microsoft Foundry privacy](https://learn.microsoft.com/en-us/azure/ai-foundry/responsible-ai/openai/data-privacy) | Separate no-training, retention, residency, and no-egress requirements. | Current provider documentation; contracts, endpoints, eligibility, and configuration affect actual guarantees. |

## 10. Decisions pending

1. Exact recurring task and buyer commitment. A reachable SME owner/CFO exists, but no interview is agreed yet.
2. Validate the local inference hypothesis, metadata boundary, and local-node economics with the buyer; reserve full air-gap for demonstrated need.
3. Product boundary between the workflow application and NOMO control plane.
4. Whether first delivery is a repeatable product, a paid deployment service, or a service-assisted product pilot.
5. Access path to the first operator, buyer, and approved sample workflow.

Until these decisions are resolved, keep this memo exploratory. Use gstack Office Hours to pressure-test the wedge, then CEO review for scope, engineering review for the NOMO architecture, an eval plan for model and workflow quality, and the existing security and Harness gates before implementation.
