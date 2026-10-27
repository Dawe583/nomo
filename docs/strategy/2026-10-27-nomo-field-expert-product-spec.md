# NOMO Field Expert: pilot product and implementation specification

> Status: proposed pilot specification, 2026-10-27. It adds a customer-facing
> use case to the existing NOMO control-plane plan. It is not authorization to
> deploy or to weaken existing identity, authorization, evidence, or recovery
> rules. It assumes a field-service workflow that is not yet selected; see the
> [private AI opportunity research memo](2026-10-27-nomo-private-ai-market-research.md)
> before treating these requirements as the active product scope.
> The currently reported buyer access is an SME owner or CFO in finance
> operations. Use this field-service specification only if discovery shows a
> stronger accessible job and buyer than the finance path.

## 1. Product boundary

### Objective

Let one field worker answer one recurring operational question using one
customer-approved source set and the current job context. The answer must show
where its guidance came from, ask for missing facts, and defer when evidence is
not sufficient. The first release prepares a draft outcome. It does not perform
an external write.

### Intended pilot user

- **Worker:** asks a job question and confirms what happened.
- **Expert:** reviews source quality and escalations.
- **Operator or manager:** owns the customer workspace, approved source set,
  access, and pilot outcomes.
- **NOMO administrator:** verifies policy, run identity, evidence, and any
  permitted integration.

One person can hold multiple roles in the first pilot, but privileges remain
explicit.

### In-scope

- One customer workspace and one pilot team.
- One agreed job type and one recurring decision.
- Approved PDF, text, or structured source material.
- Job context entered by the worker or supplied from a fixture during the first
  demo.
- Source-grounded answers, targeted follow-up questions, explicit abstention,
  and escalation.
- Feedback that is stored as an unverified suggestion until an authorized
  expert reviews it.
- A structured draft of the selected job outcome.
- A verified audit event for each policy decision and any later approved tool
  call, following existing NOMO contracts.

### Out-of-scope

- Automatic work assignment, scheduling, dispatch, or customer messaging.
- Unreviewed updates to ERP, CRM, finance, inventory, payroll, or safety records.
- Unsupervised diagnosis that could cause injury, property damage, or regulatory
  breach.
- A new foundation model or unrestricted memory across customer workspaces.
- Offline mode, general fleet control, or broad integrations in the pilot.
- Promises that an answer is correct solely because it has a citation or a
  confidence score.

## 2. Core user flows

### Flow A: ask an operational question

1. User signs in to the pilot workspace and starts from a selected job or enters
   a minimal job identifier.
2. The UI collects only the minimum facts required for the chosen workflow,
   such as equipment type, model, location type, and symptom.
3. The retrieval layer searches only approved sources in that workspace.
4. The answer generator receives the question, permitted job context, and a
   bounded set of retrieved source passages.
5. A response validator checks that each material instruction has source
   references and that the referenced source IDs and versions exist.
6. If required context is missing, the assistant asks a specific question. If
   sources conflict, the assistant explains the conflict and routes to the
   named expert. If there is no adequate source, it abstains.
7. The user opens a citation to see the source name, version, page or section,
   and relevant excerpt in the app.
8. The user marks the guidance helpful, incorrect, incomplete, or unsafe. The
   feedback is not training data and cannot alter policy.

### Flow B: prepare a job outcome

1. The worker describes what they did or selects a short outcome form.
2. The assistant maps the input to a typed draft with explicit unknown fields.
3. The worker reviews and edits the draft.
4. In the initial pilot, the worker copies or exports the reviewed draft through
   the supported current surface. The system performs no hidden write.
5. A later release may submit one narrowly scoped tool call through the NOMO
   proxy. The proxy uses registered identity, current scope, policy, approval,
   and evidence rules.

### Flow C: expert reviews an answer correction

1. A user submits correction feedback with source and job references.
2. The expert sees the candidate correction and supporting evidence.
3. The expert approves, rejects, or asks for a source update.
4. Only an approved record with provenance can enter the workspace knowledge
   index.
5. An approved answer record cannot change permissions, policy, credentials, or
   connector scope.

## 3. Data and service boundaries

### Logical components

1. **Worker UI:** responsive, low-friction, keyboard and touch accessible.
   Start with text input. Add voice only after field observations show it is
   needed and safe in noisy environments.
2. **Job context resolver:** validates the active workspace and permitted job
   fields. It does not trust model-provided identifiers or authority.
3. **Knowledge service:** parses, versions, indexes, and retrieves only
   customer-approved documents. It enforces tenant boundaries before model
   context is assembled.
4. **Answer service:** turns bounded evidence into a structured answer with
   citations, follow-up questions, or abstention. It cannot call customer tools.
5. **Expert review queue:** records corrections as proposals and applies an
   explicit human decision before indexing them.
6. **NOMO Workbench and Harness:** host the agent workflow when appropriate.
   User and agent identities remain distinct.
7. **NOMO proxy, policy, approvals, ledger, and connectors:** remain the only
   authorized path for a future external write. Do not create a second policy
   implementation in the UI or knowledge service.

### Existing Nomo modules to evaluate first

| Existing area | Reuse for pilot | Boundary |
|---|---|---|
| `packages/workbench` | Existing managed agent interaction and provider boundary, where current contracts fit. | Do not assume it is a field-worker mobile product or a production fleet runtime. |
| `packages/proxy` | The interception path for any MCP tool call. | Keep model intent separate from enforcement. The proxy decides whether and how a call proceeds. |
| `packages/policy` | Existing `Allow`, `Deny`, `Hold`, and `observe-only` rules. | Do not duplicate or weaken policy for the new app. |
| `packages/ledger` | Existing append-only signed decisions and results. | Keep prompts, credentials, and document bodies out of ledger payloads. |
| `packages/connectors` | Existing connector contracts when a pilot requires a supported target. | Reuse only an available connector with proven preconditions and accurate reversibility. |
| `apps/control-plane` | Existing UI and API patterns as a possible pilot surface. | Verify authentication, tenant boundaries, and deploy scope before exposing customer data. |
| Leadora | Candidate for document retrieval or interface patterns after audit. | No direct dependency until data isolation, provenance, active code, and licensing are verified. |

The product paper is a go-to-market overlay. It does not introduce a new
identity package, database, vector store, provider, or deployment service by
assumption. First inventory existing code and customer constraints. Any external
service integration requires a separately approved and provisioned choice.

## 4. Proposed data contracts

These are conceptual records, not an instruction to add database tables before
the pilot workflow is confirmed.

### Knowledge source

- `workspaceId`
- `sourceId`
- `sourceType`
- `title`
- `version`
- `effectiveAt`
- `reviewedAt`
- `ownerId`
- `contentDigest`
- `status`: `pending`, `approved`, `stale`, `rejected`, `retired`
- access classification and retention policy

### Retrieved passage reference

- `sourceId`, `version`, `pageOrSection`, `passageId`
- offsets or stable locator when available
- retrieval timestamp and index version
- no cross-workspace references

### Answer

- `answerId`, `workspaceId`, `jobContextId`
- `status`: `answered`, `needs-context`, `conflicting-evidence`, `abstained`,
  `escalated`
- answer body stored under the customer data policy, not copied to the signed
  ledger by default
- citations with source and version
- missing facts and next question
- model and prompt version metadata appropriate for evaluation
- user feedback reference

### Action proposal

- `proposalId`, `workspaceId`, `runId`, `toolId`
- canonical operation digest
- target resource and fields
- policy version, risk class, and reversibility conditions
- approval identity and timestamp when applicable
- outcome: `not-submitted`, `held`, `approved`, `denied`, `succeeded`,
  `failed`, `unknown`

Never treat a proposal ID, conversation, user-entered agent ID, or generated
answer as authorization. Existing NOMO specs govern token audience, caller
identity, approvals, append order, revocation, and unresolved side effects.

## 5. Trust, safety, and privacy requirements

- Workspace, user, agent, and run are distinct principals.
- Authorization comes from the trusted host and server-side state, never from
  prompt text or a client-supplied `agentId` or `runId`.
- Retrieval filters by workspace before ranking and before model context
  construction. Check that each citation belongs to the same workspace.
- No answer can cause an external tool write in the initial pilot.
- Any later write is scoped to the least-privilege target and tool. The policy
  is evaluated at dispatch. `Hold` approval binds to the exact canonical
  operation digest and policy version.
- Unknown identity, scope, policy, source status, or ledger state fails closed
  for writes. Read-only mode is explicit, never an error fallback.
- Do not put credentials, prompt text, private document contents, or sensitive
  personal information in the NOMO ledger, logs, analytics, or screenshots.
- Keep the customer document body in an access-controlled store with a named
  retention policy. Use only the minimum information necessary for the job.
- Record source version so an answer can be reproduced or invalidated when a
  procedure changes.
- Make the system's limits visible at the point of use. Escalate high-consequence
  work to the customer's qualified person.
- The customer owns the source documents and decides which material is
  approved. NOMO does not silently learn from user conversations.
- Any deployment involving sensitive or regulated data requires a separate
  review of location, retention, access, subprocessors, and contractual terms.

## 6. Answer quality and evaluation

### Evaluation set

Create a customer-approved set of representative questions before the pilot.
Include:

- questions answered by a current source;
- wrong-equipment and wrong-version traps;
- questions with missing job context;
- outdated or contradictory procedures;
- unsupported or out-of-scope requests;
- safety-sensitive prompts that must escalate;
- paraphrased questions and Czech domain vocabulary.

The customer's expert labels the expected answer, correct source and required
abstention behavior. Preserve the evaluation set and its source versions. Do not
put personal or confidential material into an external model without customer
approval.

### Pilot acceptance gates

Before real workers use answers in live jobs:

1. Every material claim in the evaluation set is supported by the cited source
   or explicitly labeled as general context outside operational guidance.
2. Wrong asset, stale source, conflicting source, missing context, and unsupported
   question cases all follow their expected escalation or abstention result.
3. No user can read an unapproved source or another workspace's source.
4. The user can tell when the system is uncertain, when a human review is needed,
   and how to reach that person.
5. All external writes remain disabled.
6. The customer process owner approves the source set and evaluation results.

Set numerical thresholds with the customer before running the set. Averages do
not excuse a severe unsupported instruction. Repeat evaluation after changes to
retrieval, source parsing, prompts, or model selection.

## 7. Pilot instrumentation

Capture minimal operational metadata:

- workspace, user role, job category, run ID, source IDs and versions;
- answer outcome and whether the worker opened a citation;
- clarification, abstention, escalation, and expert response;
- task timing where the user consents and collection is proportionate;
- correction category, severity, and reviewer decision;
- NOMO policy decision and tool outcome if the pilot later enables a write.

Do not default to storing whole conversations. Keep user-visible feedback and
business metrics separate from signed enforcement records where their purposes
and retention differ.

## 8. Pilot metrics

Agree the exact baseline and thresholds with the pilot customer before launch.

**Demand and adoption:** active workers, repeat use per worker, percentage of
eligible jobs where the system is tried, manager review rate, and paid renewal or
expansion intent.

**Quality and safety:** expert-confirmed source correctness, unsupported-answer
rate, expected abstention rate, citation open rate, correction severity,
wrong-version incidents, and cross-workspace access failures.

**Operational value:** time to supported answer, expert interruptions per job,
rework, repeat visits, record completion time, and time spent searching
documents.

**Cost to serve:** document onboarding time, support minutes per worker, model
and hosting cost per completed workflow, and gross margin at the pilot's real
usage.

Success requires both safe answers and a customer-valued operational result.
Engagement alone is not proof of value.

## 9. Delivery and release gates

- **Discovery gate:** buyer, repeated task, authorized documents, baseline, and
  pilot owner confirmed.
- **Prototype gate:** representative questions demonstrate source-grounded
  answers, escalation, and abstention to the customer's expert.
- **Read-only pilot gate:** privacy and access boundaries reviewed; evaluation
  passes; no external writes enabled.
- **Action gate:** one concrete action has a named owner, exact target, least
  privilege, idempotency or duplicate protection, policy, human approval,
  append-before-dispatch evidence, result or unknown outcome handling, and a
  recovery story consistent with existing NOMO connector guarantees.
- **Expansion gate:** pilot data supports repeated use and measurable benefit;
  support cost and source maintenance are acceptable.

Do not use public deployment, production credentials, or customer data until
the corresponding security, identity, hosting, and operational gates are
complete.

## 10. Open design decisions

Resolve these from discovery or source inspection, not from preference alone:

1. Initial vertical and actual design partner.
2. One workflow and one job context schema.
3. Whether the existing Workbench UI is usable for field work or a separate
   responsive surface is needed.
4. Whether Leadora has reusable retrieval code and whether it can run with
   customer-controlled data boundaries.
5. Required language coverage, speech input, device, and network constraints.
6. Whether existing NOMO identity and hosted control-plane capabilities meet
   the pilot's minimum security bar.
7. The one structured draft or action that creates enough customer value to
   justify the next implementation phase.

