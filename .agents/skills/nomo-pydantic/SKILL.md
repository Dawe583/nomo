---
name: nomo-pydantic
description: Required Pydantic AI, Graph and Evals routing for every NOMO harness.
---

# NOMO Pydantic integration

Read this skill on every NOMO task. Pydantic AI, Graph and Evals are the
shared typed workflow components across Pi, OMP and Prime. Their implemented
scope is the governed proxy-call workflow and fixture-backed evaluation; they
do not execute arbitrary editor, shell, Git or GitHub actions.

- Use Pydantic Graph in `python/nomo-pydantic/` to order one explicit proxy
  tool call and its result summarization.
- Use Pydantic AI to summarize only an authorized proxy result using an
  explicitly configured provider and model.
- Use Pydantic Evals for fixture-backed expected-status checks where that
  workflow is changed.
- `.nomo/work-state.json` remains the durable task execution graph for all
  harnesses. Pydantic Graph is not a replacement or persistence layer.

All NOMO proxy tool calls must use `run_governed_call` and the NOMO transport;
do not bypass policy with direct server calls. Read
`python/nomo-pydantic/README.md` before invoking `scripts/nomo-pydantic.sh`.
Require an explicit model, tool allowlist and loopback proxy. Send request
data through stdin. Do not pass secrets, production data or unapproved private
output to a model. Treat summaries and raw results as potentially sensitive;
omit `--include-raw` unless the receiving context is approved.

The workflow sends one tool call and never retries uncertain dispatch. If the
outcome is unknown, reconcile it before another attempt. Model failure after a
completed tool call is `summary_failed`, not a safe retry signal. The caller
owns authorization, idempotency key and transport lifecycle.

Evaluations invoke their supplied task and do not make side effects safe or
measure general model quality. This integration does not provide durable
checkpoints, resumability, OS permissions or extra harness tools. Verify native
Pi, OMP and Prime behavior separately; prompt loading is not a permission
boundary.
