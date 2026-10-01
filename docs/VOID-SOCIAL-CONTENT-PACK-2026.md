# VOID Social Content Pack — 2026

**Status:** publication-ready copy templates, contingent on evidence fields being filled and the claim-review gate passing.  
**Audience:** VOID founder/growth operator  
**Use with:** `VOID-MARKETING-MONETIZATION-RESEARCH-2026.md`

> **Non-negotiable publishing rule:** Every `[[VARIABLE]]` below must be replaced with a real, reviewable value before publishing. If the underlying fixture, receipt, verifier result, or known-limit text does not exist, **do not publish the post.** A social asset may show a synthetic or staged lab—but it may never imply production certification, customer adoption, compliance, universal reversibility, or proof of model reasoning.

## Publishing variables and review checklist

Use the same values consistently across the post, linked GitHub artifact, video description, and CRM attribution record.

| Variable | Required value | Example shape—not a value to invent |
| --- | --- | --- |
| `[[ARTIFACT_URL]]` | Public GitHub release, README, or immutable artifact URL | `https://github.com/.../releases/tag/...` |
| `[[RECEIPT_SHA256]]` | Actual receipt/bundle digest | `sha256:…` |
| `[[VERIFIER_COMMAND]]` | Exact command tested in a clean environment | Copy from release test output |
| `[[VERIFIER_OUTPUT]]` | Exact success/failure result | Copy from terminal transcript |
| `[[FIXTURE_VERSION]]` | Fixture/policy/adapter version | `lab-v0.1.0` |
| `[[ENVIRONMENT_LABEL]]` | Synthetic/disposable/customer-approved label | `Synthetic ticketing fixture; no customer data` |
| `[[KNOWN_LIMIT]]` | Specific non-claim | `Does not prove model reasoning or complete capture outside the adapter` |
| `[[CTA_URL]]` | Submission/evaluation/Discussion URL | GitHub Discussion or request form |
| `[[FOUNDER_NAME]]` | Named accountable speaker | Founder’s actual name |
| `[[POLICY_VERSION]]` | Exact policy version used | `policy/ticket-close@…` |

### Preflight: answer “yes” to every line

- The action, effect class, policy decision, recovery class, and environment are all stated accurately.
- A separate operator ran `[[VERIFIER_COMMAND]]` on the exported bundle and retained `[[VERIFIER_OUTPUT]]`.
- The post’s limit is adjacent to the claim—not buried in a linked page.
- No customer, data, identity, token, credential, or live production configuration is visible.
- The asset has a source-and-rights manifest and the named author/approver has signed off.
- The artifact link and hash resolve at publication time.
- CRM/source tracking is assigned to this asset before it goes live.

---

## 12 ready-to-publish posts

### Post 1 — LinkedIn founder post: **The unclassified write**

**Objective:** start the category with an operational claim, not a feature list.  
**Visual:** 4-slide native PDF or one terminal capture: (1) proposed action, (2) effect class unknown, (3) fail-closed hold, (4) verifier result.  
**Alt text:** “A synthetic CRM agent write is held because its effect cannot be classified; a detached verifier checks the receipt.”

**Post copy**

> An agent asked to update a CRM record.  
> 
> The important result was not “the policy denied it.”  
> 
> The result was: **we could not classify what would change, so the write did not proceed.**  
> 
> In this synthetic fixture, VOID recorded:
> - the proposed tool and redacted argument digest;
> - the policy version that required a hold;
> - the decision and correlation context;
> - the recovery state: `[[RECOVERY_CLASS]]`; and
> - a signed receipt that a separate verifier checked.
> 
> Fixture: `[[FIXTURE_VERSION]]`  
> Receipt: `[[RECEIPT_SHA256]]`  
> Verify it: `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`
> 
> This is **[[ENVIRONMENT_LABEL]]**. `[[KNOWN_LIMIT]]`
> 
> The question I am testing with platform and security teams is simple:  
> **Which agent write in your stack should fail closed if nobody can classify its effect?**
> 
> Artifact: [[ARTIFACT_URL]]  
> Add one tool surface here: [[CTA_URL]]

**First comment (post immediately after publishing)**

> A useful distinction: this fixture does not say an agent should never write. It says a team should be able to state *what can change*, *which policy applies*, *who has authority*, and *how recovery is classified* before the write crosses a consequential boundary.

**Reply guide**

- If someone asks “Does this replace IAM?” reply: “No. We are testing an evidence layer around the consequential write; native IAM/policy can remain the source of authorization. The receipt binds the stated policy/version and result for later review.”
- If someone asks “Is it reversible?” reply: “The receipt carries a recovery class. We do not claim every action has a true inverse; this fixture is `[[RECOVERY_CLASS]]`.”

---

### Post 2 — X: **The tamper test**

**Objective:** make the verifier tangible in one post.  
**Asset:** 20–30 second video/GIF showing original success, one edited field, then verifier failure.

**Post copy (≤280 characters before URL where possible)**

> A signed receipt is only interesting if it fails when changed.
> 
> In our synthetic `[[FIXTURE_VERSION]]` fixture, changing `[[TAMPERED_FIELD]]` changes the verification result:
> 
> `[[VERIFIER_COMMAND]]`  
> → `[[VERIFIER_OUTPUT]]`
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> Artifact: [[ARTIFACT_URL]]

**Reply 1**

> The success path is not the proof. The negative case is part of it: original bundle + modified bundle + expected verifier failure. Receipt digest: `[[RECEIPT_SHA256]]`.

**Reply 2**

> Question for incident reviewers: could you run this check without trusting the application runtime that produced the record?

---

### Post 3 — LinkedIn founder post: **Approval has to name the held effect**

**Objective:** differentiate from generic human-in-the-loop messaging.  
**Visual:** approval screen mock/fixture with five plain-language fields: action, target, effect class, recovery class, expiry.

**Post copy**

> “Human approval” is not a useful control if the human cannot answer one question:  
> **What exactly am I authorizing to change?**
> 
> In our `[[FIXTURE_VERSION]]` fixture, an approval request carries five things before the write can move:
> 
> 1. the proposed action and target;
> 2. the effect class;
> 3. the policy version requiring approval;
> 4. the recovery classification; and
> 5. the approval expiry/session context.
> 
> After the decision, the exported receipt binds the disposition and `[[DOWNSTREAM_RESULT_FIELD]]`; a detached verifier checks the bundle.
> 
> `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`  
> Artifact: [[ARTIFACT_URL]]
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> For the people who own agent permissions: **what information would your approver need before allowing a ticket close, CRM update, or runbook action?**
> 
> Submit one example: [[CTA_URL]]

**Comment prompt**

> I am specifically *not* asking whether every tool call needs a human click. The test is whether the high-impact path has a legible effect and authority boundary.

---

### Post 4 — GitHub Discussion opening post: **The seven questions before a write**

**Objective:** turn a marketing proposition into a technical decision thread.  
**Discussion title:** `What evidence would you require before allowing an agent to write to an internal system?`  
**Labels:** `discussion`, `governed-writes-lab`, `feedback-request`

**Post copy**

> We are building a synthetic governed-write lab around one question: what should a reviewer be able to inspect before and after an agent changes an internal system?
> 
> Our current checklist has seven questions:
> 
> 1. What was requested?
> 2. What could change?
> 3. Which policy applied?
> 4. Who had authority?
> 5. What was decided?
> 6. What effect occurred?
> 7. Can a reviewer verify the stated record and understand the recovery boundary?
> 
> The linked fixture contains an allow/hold/deny path, a signed receipt, and a detached verifier:
> - Fixture: `[[FIXTURE_VERSION]]`
> - Receipt digest: `[[RECEIPT_SHA256]]`
> - Verification: `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`
> - Artifact: [[ARTIFACT_URL]]
> 
> Environment: `[[ENVIRONMENT_LABEL]]`  
> Limit: `[[KNOWN_LIMIT]]`
> 
> I would value concrete counterexamples, especially for ticketing, CRM, storage, database, MCP, or remediation workflows:
> 
> - What field is missing?
> - Which field is unsafe to retain?
> - Which action needs a different recovery class?
> - What must an approver see before the write?
> 
> Please use synthetic descriptions and do not include customer data, tokens, or credentials.

**Maintainer replies to prepare**

- “We record/expect `[[FIELD]]` because…; we do not infer `[[UNPROVEN_FACT]]` from a signature.”
- “That is a scenario submission; please add it through `[[SCENARIO_ISSUE_URL]]` with a synthetic target.”

---

### Post 5 — LinkedIn founder post: **No inverse is an answer**

**Objective:** establish recovery-aware positioning without overpromising.  
**Visual:** one R1–R4 recovery matrix with a highlighted R4 fixture.

**Post copy**

> The most useful recovery answer is sometimes: **there is no safe inverse.**
> 
> A deletion, external send, payment, or third-party state change may not have an honest rollback. Pretending otherwise turns “reversibility” into a marketing adjective.
> 
> In our synthetic `[[FIXTURE_VERSION]]` scenario, the proposed write is classified as:
> 
> `[[RECOVERY_CLASS]] — [[RECOVERY_PLAIN_LANGUAGE]]`
> 
> The policy response is `[[DECISION]]`. The receipt retains the requested effect, policy/version, authority context, recovery class, and downstream result field; the verifier checks the exported bundle.
> 
> `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`  
> Artifact: [[ARTIFACT_URL]]
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> **Which agent write in your environment has no honest rollback—and should be treated that way before execution?**

**Optional first comment**

> Our working vocabulary: inverse available; compensation planned; manual recovery required; no safe inverse. The last state is not a product failure. It is a decision input.

---

### Post 6 — X: **The metric we will not optimize**

**Objective:** explain the evidence-oriented benchmark stance.  
**Asset:** a compact scorecard image with columns: allowed correctly / held correctly / denied correctly / exported / independently verified / recovery classification correct.

**Post copy**

> We are not going to publish one “agent safety score.”
> 
> A governed write can fail in different ways: wrong allow, false hold, missing receipt, unverifiable export, or invented recovery.
> 
> Our fixture scorecard records each. `[[FIXTURE_VERSION]]`:
> [[ARTIFACT_URL]]
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`

**Reply**

> The next scenario pack needs both positive and negative cases: actions that should proceed, actions that should hold, and artifacts that should fail verification when altered. Contribute a synthetic case: [[CTA_URL]]

---

### Post 7 — Developer community post: **Request for synthetic scenarios**

**Objective:** recruit useful technical feedback without pretending broad adoption.  
**Where:** GitHub Discussions first; adapt only after moderators approve in a relevant developer community.  
**Title:** `Request for synthetic governed-write scenarios: what should be held, denied, or marked no-safe-inverse?`

**Post copy**

> I’m looking for synthetic scenarios for a small, reproducible governed-write fixture pack—not generic “AI agent risk” stories.
> 
> The lab currently tests a proposed write through an effect class, policy decision, receipt export, and detached verifier. It distinguishes:
> 
> - allow;
> - hold/approval/expiry;
> - deny;
> - unclassified effect; and
> - recovery: inverse, compensation, manual, or no safe inverse.
> 
> Current artifact: [[ARTIFACT_URL]]  
> Fixture: `[[FIXTURE_VERSION]]`  
> Verifier result: `[[VERIFIER_OUTPUT]]`
> 
> Good submissions look like this:
> 
> ```text
> Tool surface: synthetic ticketing / CRM / storage / database / runbook
> Proposed write: [one mutation]
> What can change: [effect]
> Why it is consequential: [one sentence]
> Expected decision: allow / hold / deny / unclassified
> Recovery class: inverse / compensation / manual / no safe inverse
> Evidence an approver needs: [fields]
> ```
> 
> Please do not paste tokens, real customer records, production URLs, or exploit instructions. I will publish only scenarios that can be represented safely in a synthetic target.
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> Submission thread: [[CTA_URL]]

**Maintainer follow-up**

> I will label accepted cases as visible fixture, hidden holdout candidate, or rejected with rationale. A fixture result will be labeled self-reported unless another party reproduces it.

---

### Post 8 — LinkedIn founder post: **A trace is useful. A detached receipt answers a different question.**

**Objective:** create a non-hostile contrast with observability.  
**Visual:** split panel: “debugging question” and “review question.”

**Post copy**

> Agent traces are useful for debugging.
> 
> But after a consequential write, an incident reviewer may have a different question:
> 
> **Can I inspect the proposed effect, policy/version, authority context, decision, downstream result, and an integrity check without treating the runtime’s UI as the final authority?**
> 
> That is the question we are testing in VOID’s `[[FIXTURE_VERSION]]` fixture.
> 
> The fixture produces a normal execution record *and* a redacted, signed receipt. A second environment runs:
> 
> `[[VERIFIER_COMMAND]]`  
> → `[[VERIFIER_OUTPUT]]`
> 
> Receipt: `[[RECEIPT_SHA256]]`  
> Artifact: [[ARTIFACT_URL]]
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> This is not an argument against tracing. It is a narrower question about what evidence leaves the runtime after an agent changes something consequential.
> 
> **What would your reviewer need to see beyond a trace?** [[CTA_URL]]

**Comment response to prepare**

> We should be precise: a signed receipt does not prove every event was captured or that the model’s reasoning was correct. Its value depends on the interception boundary, the fields captured, and an independently runnable verifier.

---

### Post 9 — LinkedIn founder post: **Identity is not just a label in an MCP path**

**Objective:** open conversations around on-behalf-of attribution without fear marketing.  
**Visual:** request path diagram with fields at each hop: invoking user → agent → MCP/tool → target; mark a missing identity/context edge.

**Post copy**

> In an agent-to-tool path, “the agent did it” is often not enough.
> 
> The reviewer may need to know:
> - which agent identity invoked the tool;
> - whether it acted on behalf of a person or workflow;
> - which effective scope applied;
> - which policy version decided the write; and
> - which correlation context linked the proposed action to the target-system result.
> 
> Our `[[FIXTURE_VERSION]]` lab does not solve identity architecture. It records these fields—or explicitly marks them unavailable—alongside a governed write receipt.
> 
> Verification: `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`  
> Artifact: [[ARTIFACT_URL]]
> 
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> **Where does on-behalf-of context disappear in your current agent or MCP path?**

**First comment**

> Native IAM/MCP authorization should remain the authority for authentication and permissions. The practical test here is whether a later reviewer can see the stated context attached to this particular consequential action.

---

### Post 10 — GitHub release note: **Governed Writes Lab v0.1**

**Objective:** create a durable source asset with transparent methodology.  
**Release title:** `Governed Writes Lab [[FIXTURE_VERSION]] — visible fixtures, verifier, and known limits`

**Release body**

> ## What this release is
> 
> A small synthetic fixture pack for testing a governed agent write through:
> 
> 1. effect classification;
> 2. policy allow/hold/deny;
> 3. optional approval/expiry;
> 4. receipt export; and
> 5. detached verification.
> 
> ## Included
> 
> | Scenario | Expected decision | Recovery class | Verification expectation |
> | --- | --- | --- |
> | `[[SCENARIO_1]]` | `[[EXPECTED_1]]` | `[[RECOVERY_1]]` | `[[VERIFY_1]]` |
> | `[[SCENARIO_2]]` | `[[EXPECTED_2]]` | `[[RECOVERY_2]]` | `[[VERIFY_2]]` |
> | `[[SCENARIO_3]]` | `[[EXPECTED_3]]` | `[[RECOVERY_3]]` | `[[VERIFY_3]]` |
> 
> ## Reproduce
> 
> ```bash
> [[INSTALL_COMMAND]]
> [[RUN_FIXTURE_COMMAND]]
> [[EXPORT_COMMAND]]
> [[VERIFIER_COMMAND]]
> ```
> 
> Expected verifier result:
> 
> ```text
> [[VERIFIER_OUTPUT]]
> ```
> 
> Sample receipt digest: `[[RECEIPT_SHA256]]`
> 
> ## Tamper check
> 
> ```bash
> [[TAMPER_COMMAND]]
> [[TAMPER_VERIFY_COMMAND]]
> ```
> 
> Expected failure:
> 
> ```text
> [[TAMPER_FAILURE_OUTPUT]]
> ```
> 
> ## What this release does not prove
> 
> - `[[KNOWN_LIMIT]]`
> - It uses `[[ENVIRONMENT_LABEL]]`.
> - It does not establish compliance, customer deployment, model reasoning correctness, complete history outside the adapter, universal reversibility, or production performance.
> 
> ## Feedback requested
> 
> Please open a Discussion with a **synthetic** scenario. Include the proposed write, effect, expected decision, recovery classification, and evidence fields a reviewer would require: [[CTA_URL]]

---

### Post 11 — LinkedIn founder post: **Decision Postmortem (staged)**

**Objective:** demonstrate operational trade-offs and correction loop.  
**Visual:** timeline card: belief → observed evidence → hold → operator decision → recovery boundary → corrective test.  
**Mandatory label at top of visual:** `STAGED SYNTHETIC FIXTURE — NOT A CUSTOMER INCIDENT`

**Post copy**

> **Decision Postmortem — staged synthetic fixture, not a customer incident**
> 
> We set out to let an agent close a ticket automatically.
> 
> **What we believed:** the action was low-risk because the target was “only” an internal ticket.  
> **What the fixture showed:** the request could close a ticket with an unresolved dependency, and the recovery semantics were `[[RECOVERY_CLASS]]`.  
> **What the policy did:** `[[DECISION]]`.  
> **What the operator did:** `[[OPERATOR_ACTION]]`.  
> **What reached the target:** `[[DOWNSTREAM_RESULT]]`.  
> **What a second environment checked:** `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`.  
> **What changed next:** `[[CORRECTIVE_TEST]]`.
> 
> The point is not that every ticket close needs a manual approval. The point is that the cost of holding a write should be explicit—and the reason for allowing it should remain inspectable after the run.
> 
> Artifact: [[ARTIFACT_URL]]  
> Fixture: `[[FIXTURE_VERSION]]`; receipt: `[[RECEIPT_SHA256]]`  
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> **Where would your team accept a deliberate hold to avoid an unexplainable write?** [[CTA_URL]]

**First comment**

> We will publish corrections to staged fixtures as versioned changes. A changed policy, expected outcome, or verifier behavior should yield a new artifact—not a silently edited social post.

---

### Post 12 — Conditional Show HN post: **Runnable lab for a ticket write**

**Status:** publish only after every Show HN prerequisite is met: anonymous visitor can try it without sales contact, download a sample bundle, independently verify it, read known limits, and a maker can stay in the comments.  
**Title:** `Show HN: A runnable lab for holding and independently verifying an agent ticket write`

**Post copy**

> Hi HN — I’m `[[FOUNDER_NAME]]`, building VOID.
> 
> This is a small synthetic lab for one narrow problem: an agent proposes a ticket write; the lab classifies the effect, applies a policy, allows/holds/denies it, exports a signed receipt, and lets a separate environment verify the bundle.
> 
> You can run the path here: [[ARTIFACT_URL]]
> 
> The shortest route is:
> 
> ```bash
> [[INSTALL_COMMAND]]
> [[RUN_FIXTURE_COMMAND]]
> [[VERIFIER_COMMAND]]
> ```
> 
> Expected output:
> 
> ```text
> [[VERIFIER_OUTPUT]]
> ```
> 
> There is also a tamper fixture:
> 
> ```bash
> [[TAMPER_VERIFY_COMMAND]]
> ```
> 
> It should fail with:
> 
> ```text
> [[TAMPER_FAILURE_OUTPUT]]
> ```
> 
> The scope is intentionally narrow. `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`
> 
> It does not replace IAM, solve prompt injection, prove the model reasoned correctly, prove all actions are captured, or make every write reversible. I’m interested in the harder question: **what evidence would you require before allowing an agent to modify an internal system?**
> 
> I’ll be here to answer technical questions and will turn reproducible issues into lab documentation.

**Maker reply templates**

- “That is a fair limitation. The current interception boundary is `[[INTERCEPTION_BOUNDARY]]`; writes outside it are not claimed as covered.”
- “The target is synthetic. We did not use a customer system or production credential.”
- “The policy decision is `[[POLICY_VERSION]]`; the scenario’s expected decision and receipt fields are documented here: [[ARTIFACT_URL]].”

---

## Four production-ready video scripts

### Video 1 — 90-second “Proof of a Hold”

**Format:** LinkedIn native / X / YouTube Short (vertical or 16:9 crop)  
**Purpose:** demonstrate an unclassified write failing closed and a detached verification.  
**Required screen assets:** terminal, synthetic target dashboard, policy snippet, receipt summary, fresh verifier environment.  
**On-screen permanent footer:** `SYNTHETIC FIXTURE • [[FIXTURE_VERSION]] • [[KNOWN_LIMIT]]`

| Time | Visual direction | Spoken script | On-screen text |
| --- | --- | --- | --- |
| 0:00–0:08 | Show agent proposal / tool call | “An agent is about to change a CRM record. The question is not whether it can call a tool. The question is whether we can classify the effect before it writes.” | `Proposed write: [[ACTION]]` |
| 0:08–0:22 | Show effect classifier returning unknown | “This fixture cannot classify what this argument changes. So the policy does not guess.” | `Effect class: UNKNOWN` |
| 0:22–0:35 | Show hold/deny decision | “The write is held, before the target is changed. The receipt records the requested action, the policy version, the decision, and the recovery state.” | `Decision: [[DECISION]] • Policy: [[POLICY_VERSION]]` |
| 0:35–0:52 | Show receipt fields with sensitive content redacted | “We export a redacted receipt—not a claim that the model reasoned correctly. It is evidence of the stated decision path under this fixture’s trust boundary.” | `Receipt: [[RECEIPT_SHA256]]` |
| 0:52–1:10 | Change to clean/fresh verifier window | “Now a separate environment verifies the exported bundle.” | `[[VERIFIER_COMMAND]]` |
| 1:10–1:20 | Show terminal result | “The verifier result is: `[[VERIFIER_OUTPUT]]`.” | `[[VERIFIER_OUTPUT]]` |
| 1:20–1:30 | Show CTA/end card | “This is `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`. Which agent write in your stack should fail closed when its effect is unknown?” | `Try the artifact: [[ARTIFACT_URL]]` |

**Description/caption**

> A synthetic agent write is held because the effect is unclassified, then its receipt is verified outside the runtime. `[[KNOWN_LIMIT]]`  
> Artifact: [[ARTIFACT_URL]]  
> Submit a synthetic workflow: [[CTA_URL]]

---

### Video 2 — 8-minute walkthrough: “Verify a signed record of an agent ticket write without trusting the runtime”

**Format:** YouTube long-form, 16:9  
**Purpose:** searchable, durable technical proof.  
**Title:** `Verify a signed record of an agent ticket write without trusting the runtime | VOID [[FIXTURE_VERSION]]`  
**Thumbnail text:** `HOLD → EXPORT → VERIFY`  
**Required chapters:** use exact timestamps after final edit.

| Time | Visual direction | Spoken script |
| --- | --- | --- |
| 0:00–0:30 | Terminal shows final verifier pass and tamper failure quickly | “This video shows one narrow synthetic workflow: an agent proposes a ticket write, policy holds or allows it, the lab exports a signed receipt, and a fresh environment checks it. I will also change the export and show the check fail.” |
| 0:30–0:55 | Full-screen scope card | “Scope first: `[[ENVIRONMENT_LABEL]]`. The lab does not prove model reasoning, complete event capture outside its adapter, production reliability, compliance, or universal reversibility. `[[KNOWN_LIMIT]]`.” |
| 0:55–1:45 | Repository/README and version view | “This is the exact release: `[[FIXTURE_VERSION]]`. The fixture, policy, expected outcomes, receipt digest, and verifier instructions are at the linked artifact. We are using a synthetic target and no customer data.” |
| 1:45–2:35 | Show proposed action and effect classification | “The agent proposes `[[ACTION]]`. The lab classifies the effect as `[[EFFECT_CLASS]]` and the recovery state as `[[RECOVERY_CLASS]]`. Those are input to the policy; they are not a promise that a real-world inverse exists.” |
| 2:35–3:35 | Run the policy path | “The relevant policy is `[[POLICY_VERSION]]`. Here the result is `[[DECISION]]`. Notice that the held action is explicit: target, intended effect, policy, and expiry or approver context where the scenario uses one.” |
| 3:35–4:25 | Show target state / downstream result | “Now we inspect the synthetic target-system result: `[[DOWNSTREAM_RESULT]]`. The receipt references this result with `[[CORRELATION_FIELD]]`. That link is important, but it does not by itself prove exactly-once execution.” |
| 4:25–5:30 | Export receipt and explain fields | “This is the export. Sensitive content is redacted or hashed in this scenario. The fields we can inspect are action intent, identity/on-behalf-of context where available, policy/version, disposition, result reference, recovery class, signature/key reference, and verifier version.” |
| 5:30–6:35 | Move to clean environment; run exact command | “I am now in a separate environment. I will run the published command exactly as documented: `[[VERIFIER_COMMAND]]`.” |
| 6:35–6:55 | Capture verification output | “The result is `[[VERIFIER_OUTPUT]]`. Receipt digest: `[[RECEIPT_SHA256]]`.” |
| 6:55–7:30 | Modify artifact and rerun | “Next, I alter `[[TAMPERED_FIELD]]` without updating the relevant integrity material. The verifier should not accept the original record.” |
| 7:30–7:45 | Show failure | “The expected failure is `[[TAMPER_FAILURE_OUTPUT]]`.” |
| 7:45–8:15 | End card / invitation | “That is the whole claim: a governed synthetic write produced a record that a separate verifier checked, and a modified record failed. If you own an agent tool surface, add a synthetic scenario or run the lab. Links are below.” |

**YouTube description**

> **Scope:** `[[ENVIRONMENT_LABEL]]`  
> **Limit:** `[[KNOWN_LIMIT]]`  
> 
> **Run it:** [[ARTIFACT_URL]]  
> **Fixture:** `[[FIXTURE_VERSION]]`  
> **Receipt:** `[[RECEIPT_SHA256]]`  
> **Verifier:** `[[VERIFIER_COMMAND]]` → `[[VERIFIER_OUTPUT]]`  
> 
> This walkthrough does not claim production certification, compliance, complete history outside the adapter, correct model reasoning, or universal reversibility.  
> Submit a synthetic scenario: [[CTA_URL]]

---

### Video 3 — 60-second “One character changed” tamper demo

**Format:** LinkedIn native / X / YouTube Short  
**Purpose:** make the signature/verifier claim falsifiable.  
**Visual:** split terminal (left original; right edited) or sequential screen recording.  
**On-screen permanent footer:** `SYNTHETIC FIXTURE • [[FIXTURE_VERSION]] • [[KNOWN_LIMIT]]`

| Time | Visual direction | Spoken script | On-screen text |
| --- | --- | --- | --- |
| 0:00–0:07 | Show receipt hash and original verifier command | “Here is a receipt from a synthetic governed write.” | `Receipt [[RECEIPT_SHA256]]` |
| 0:07–0:18 | Run original verification | “First, a fresh environment checks the original export.” | `[[VERIFIER_COMMAND]]` |
| 0:18–0:24 | Show output | “Result: `[[VERIFIER_OUTPUT]]`.” | `PASS: [[VERIFIER_OUTPUT]]` |
| 0:24–0:38 | Edit highlighted field | “Now I change one field: `[[TAMPERED_FIELD]]`. The action did not rerun. Only the exported evidence changed.” | `Changed: [[TAMPERED_FIELD]]` |
| 0:38–0:52 | Re-run verifier | “The verifier is checking whether it should still accept the record.” | `[[TAMPER_VERIFY_COMMAND]]` |
| 0:52–0:58 | Show failure | “It should reject it: `[[TAMPER_FAILURE_OUTPUT]]`.” | `REJECTED` |
| 0:58–1:00 | End card | “Try both paths before trusting the success demo.” | `[[ARTIFACT_URL]]` |

**Caption**

> The negative case belongs beside the demo: original export passes; changed export fails.  
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`  
> Artifact: [[ARTIFACT_URL]]

---

### Video 4 — 90-second “No safe inverse” recovery classification

**Format:** LinkedIn native / YouTube Short / embedded sales asset  
**Purpose:** show recovery truth before execution.  
**Visual:** proposed external/delete-like synthetic action → recovery classifier R4 → policy hold → receipt → verifier. Do **not** show a real payment, external-send target, or exploit path.

| Time | Visual direction | Spoken script | On-screen text |
| --- | --- | --- | --- |
| 0:00–0:10 | Show synthetic request summary | “This agent wants to perform a consequential write. Before policy asks ‘allow or deny,’ the workflow asks a harder question: what is the recovery truth?” | `Proposed effect: [[ACTION]]` |
| 0:10–0:24 | Highlight recovery matrix | “This scenario is not ‘reversible.’ It is `[[RECOVERY_CLASS]]`: `[[RECOVERY_PLAIN_LANGUAGE]]`.” | `Recovery: [[RECOVERY_CLASS]]` |
| 0:24–0:38 | Show hold policy | “The policy responds with `[[DECISION]]`. We do not label a compensating process as a true inverse.” | `Decision: [[DECISION]]` |
| 0:38–0:55 | Receipt fields | “The receipt records the requested effect, policy version, authority context, decision, downstream result reference, and recovery classification.” | `Policy: [[POLICY_VERSION]]` |
| 0:55–1:08 | Fresh verifier | “A separate environment runs `[[VERIFIER_COMMAND]]`.” | `[[VERIFIER_COMMAND]]` |
| 1:08–1:17 | Output | “The bundle check returns `[[VERIFIER_OUTPUT]]`.” | `[[VERIFIER_OUTPUT]]` |
| 1:17–1:30 | End frame and CTA | “This does not promise a rollback. It makes the lack of one visible before execution. Which write in your environment deserves that answer?” | `[[CTA_URL]]` |

**Caption**

> “No safe inverse” is an operational classification, not a product failure.  
> `[[ENVIRONMENT_LABEL]]`. `[[KNOWN_LIMIT]]`  
> Run the fixture: [[ARTIFACT_URL]]

---

## Publishing cadence and reuse map

| Week | Canonical asset | Social post | Video | Community action |
| --- | --- | --- | --- | --- |
| 1 | Unclassified-write fixture | Post 1 | Video 1 | GitHub artifact release |
| 2 | Tamper fixture | Post 2 | Video 3 | Answer verification questions |
| 3 | Approval/effect brief | Post 3 | — | Open Discussion (Post 4) |
| 4 | Recovery taxonomy fixture | Post 5 | Video 4 | Request synthetic scenarios (Post 7) |
| 5 | Scorecard/methodology | Post 6 | — | Publish release note (Post 10) |
| 6 | Log-vs-receipt comparison | Post 8 | Video 2 | Invite concrete fields/counterexamples |
| 7 | Identity/context diagram | Post 9 | Clip from Video 2 | Target MCP/platform conversations |
| 8 | Staged decision postmortem | Post 11 | 30-sec cut from Video 1 | Collect workflow responses |
| 9+ | Claim-boundary review | Updated Post 10 / new founder recap | Only if proof changes | Conditional Show HN (Post 12) only after prerequisites |

## Metrics to record for every post/video

- Artifact identifier and URL/hash
- Primary channel and post URL
- Views/impressions and substantive technical replies (context only)
- Named ICP conversations created
- Qualified conversations with a dated next step
- Install attempts; first holds; independent-verifier completions
- Evaluation requests; paid scopes; source attribution
- Objection code: urgency, authority, install, trust, recovery, budget, native-controls-enough, or no current write
- Claim correction/revision required (yes/no), owner, and date

> **Success is not a viral post.** Treat engagement as message feedback. Count acquisition only when the asset produces a source-tagged qualified conversation, activated evaluation, or paid scope.
