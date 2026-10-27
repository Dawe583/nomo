# Own Your Intelligence: product and technical plan

> Stage: phase 2 hypothesis. No buyer has requested or funded this product. It follows a repeated first workflow and reviewed customer corrections.

## Product definition

Own Your Intelligence means a company can control the approved knowledge, workflow examples, evaluation cases, model route, and improvement history that its AI uses. It does not require owning or training a foundation model.

The customer problem to test is not "we want our own model." It is: "our repeated work depends on company-specific rules, and we cannot reliably see whether our assistant improves when those rules, models, or workflows change."

## Customer outcome

- The company knows which approved source and version informed each workflow.
- An expert can convert a reviewed correction into a versioned evaluation case or approved source update.
- The company can compare a candidate model or retrieval change against the same cases.
- The customer chooses what to retain, where inference runs, and when a version becomes active.
- Every change is reversible and cannot change access policy or user permissions.

## Non-goals

- Training a base model from scratch.
- Automatically learning permissions, policy, authority, or escalation behavior.
- Learning from every raw chat or using one customer's data for another.
- Treating a larger dataset as a moat without rights, quality, or measured value.
- Fine-tuning because it is technically possible.

## Product stages

### Stage 1: governed sources

Version sources with owner, effective date, approval, allowed groups, provenance, digest, and deletion state. Make stale, conflicting, and unapproved sources visible. Keep documents in the customer's chosen data plane.

### Stage 2: expert-reviewed evaluations

Capture a case identifier, task, minimal permitted input, expected answer or state, source references, rubric, reviewer, review time, and quality label. Store any personal or confidential content only with explicit purpose, access, and retention approval. Prefer synthetic or minimized examples when adequate.

### Stage 3: regression and model comparison

Run the fixed evaluation set against the current version and proposed configuration. Compare supported-answer quality, critical errors, abstention, source grounding, latency, cost, and human review time. Include separate reporting for Czech language and hard edge cases where relevant.

### Stage 4: approved change proposals

A proposed source, retrieval, prompt, model, or adapter change is immutable until a named expert or administrator approves it. Show exact diffs, case-level regressions, affected tasks, data route, and rollback target. Promotion creates a new version, never an in-place silent update.

### Stage 5: optional adaptation

Only test adapters or fine-tuning when repeated evaluation shows a material gap that source quality, retrieval, deterministic validation, or a better model choice cannot solve. Require data rights, acceptable license, measurable quality/cost improvement, held-out evaluation, rollback, and customer approval.

## NOMO integration

NOMO can govern who may approve a change and which agent may use a selected configuration. Its ledger can record the proposal ID, source/config version, policy decision, approver identity, evaluation digest, and promotion result. Keep evaluation examples, prompts, and source content in a separate tenant-scoped store. Never infer that a signed approval authorizes broader model training than the customer's contract allows.

Reuse `packages/workbench/src/learned-harness.ts` only as a provenance and proposal pattern after reviewing its domain assumptions. It learns code-oriented harness knowledge and is not a ready-made customer memory system. Reuse `packages/workbench/src/harness-scores.ts` only after a domain-specific evaluation schema and isolation model exist.

## Validation before implementation

1. The same workflow runs repeatedly with customer-specific exceptions.
2. An expert currently corrects or updates source material or answers.
3. The correction changes a measurable result in a future case.
4. The buyer wants a controlled history and accepts ownership/retention rules.
5. A fixed case set distinguishes good and bad behavior beyond subjective thumbs-up.
6. The improvement loop is worth more than source maintenance and evaluation work costs.

## Acceptance gates

- 100% of promoted sources and configurations have an owner, version, and approval record.
- Every promoted change runs against the frozen regression set.
- No severe case regression ships without an explicit exception and approver.
- Rollback restores the prior source, prompt, model route, and policy-compatible configuration.
- Tenant isolation tests return zero cross-customer records.
- Evaluation improvements are measured against a baseline with case count and rubric disclosed.
- No change to permissions, identity, policy, or tool scope can be made through the learning pipeline.

## Commercial packaging hypothesis

Test an add-on only after the first product has repeated use. Possible pricing units are per workflow, per workspace, or an annual governance/evaluation plan. The buyer should pay for demonstrated quality stability, auditability, and controlled change, not for a promise to "own AI." Do not price this feature before its recurring cost and buyer value are known.
