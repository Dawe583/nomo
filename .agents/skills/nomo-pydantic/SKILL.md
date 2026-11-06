---
name: nomo-pydantic
description: Required NOMO workflow foundation using Pydantic AI, Graph and Evals across Pi, OMP and Prime.
---

# NOMO Pydantic workflow foundation

Load this skill for every NOMO task. Use Pydantic Graph for typed, bounded
multi-step workflow execution; keep `.nomo/work-state.json` as the single
durable task graph and record graph outcomes there. Use Pydantic AI for model
work that consumes governed NOMO tool results. Use Pydantic Evals for
fixture-backed workflow and agent behavior checks when a relevant evaluator
exists. Keep deterministic repository checks authoritative for code facts.

All NOMO proxy tool calls go through `run_governed_call` and the NOMO transport.
Do not bypass the proxy with a direct server call. Harness-native file and shell
tools remain the execution surface for code changes; this package does not
restrict those tools or replace the selected harness.

Read `python/nomo-pydantic/README.md` before invoking
`scripts/nomo-pydantic.sh`. Require an explicit model, tool allowlist and
loopback proxy. Send request data through stdin. Do not pass secrets,
production data or unapproved private output to a model. Treat proxy results and
summaries as sensitive; omit `--include-raw` unless the receiving context is
approved for the raw result. When proxy access or provider configuration is
unavailable, continue independent local work and record the exact limitation;
do not claim the Pydantic runtime executed.

The workflow sends one tool call. It never retries an uncertain dispatch. If
the outcome is unknown, reconcile it before another attempt. The caller owns
the idempotency key, authorization and transport lifecycle. Model failure
after a completed tool call is `summary_failed`, not a safe retry signal.

Use fixture-backed Pydantic Evals to check workflow statuses. An evaluation
invokes its supplied task; it does not make side effects safe or measure model
quality. Pydantic Graph is the typed workflow executor, while the repository
graph remains the durable source of task state. This integration does not
provide durable checkpoints, resume, operating-system permissions or extra
agent tools. Verify each harness runtime separately; prompt loading is not a
permission boundary.
