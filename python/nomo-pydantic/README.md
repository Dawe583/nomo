# NOMO Pydantic integration

This optional Python module connects Pydantic AI, Pydantic Graph and Pydantic
Evals to the existing `nomo-transport` client. It does not replace the NOMO
proxy, policy, ledger, existing TypeScript harness or the dependency-free
transport package.

`run_governed_call` checks an explicit tool allowlist, submits **one** call
through the supplied transport, and waits for its result. A Pydantic agent with
no registered tools summarizes a successful result. A result marked `isError`
ends as `tool_error` without calling the model. Transport exceptions, including unknown or expired outcomes, propagate without
an automatic retry. A model error or timeout after dispatch returns
`summary_failed`, so it cannot be mistaken for an undispatched operation. The
caller owns the idempotency key, reconciliation, authorization and transport
lifecycle. The returned `raw_result` preserves the proxy response, including
errors, but is excluded from the object representation. Treat both it and the
summary as potentially sensitive.

```python
from pydantic_ai.models.test import TestModel
from nomo_pydantic import run_governed_call
from nomo_transport import NomoTransportClient

client = NomoTransportClient("127.0.0.1", 8787, token_env="NOMO_PROXY_TOKEN")
try:
    client.initialize()
    result = await run_governed_call(
        transport=client,
        tool="read_status",
        arguments={"id": "example"},
        idempotency_key="run-123-step-1",
        allowed_tools={"read_status"},
        model=TestModel(custom_output_text="Fixture summary"),
    )
finally:
    client.close()
```

The result is sent to the selected model as input. Use a model appropriate for
that data; this module does not redact results or provide a prompt-injection
boundary. The caller supplies its own installed provider/model and must not
send credentials or private data to an unapproved provider. `TestModel` is
only a deterministic offline test model. The local HTTP transport is intended
for loopback and does not provide TLS. A test model is not a production agent.

`nomo_pydantic.evaluation.evaluate_statuses` runs supplied Pydantic Evals
cases sequentially and compares the workflow result status to each expected
status. Use fixture-backed tasks: evaluations invoke the supplied task and do
not make side effects safe or prove model quality. Reports may contain case inputs
and outputs; keep secrets and production payloads out of them.

From this directory, install locked dependencies and run the offline tests:

```sh
uv sync --locked
PYDANTIC_AI_NO_BANNER=1 uv run --locked python -m unittest discover -s tests
```

To import both source packages from another directory, add this directory and
`../nomo-transport/src` to `PYTHONPATH`. No Pi, OMP, Prime, CLI or production
runtime is wired to this module yet. The integration does not persist graph
state, resume interrupted runs, enforce operating-system permissions, or grant
agents new tools. Configure those independently and verify each runtime before
relying on them.

## Harness command

Pi, OMP and Prime can invoke `scripts/nomo-pydantic.sh` as an ordinary local
command. The operator must configure a running loopback NOMO proxy, explicitly
choose a model and list permitted tools. Provider-specific Pydantic model
packages must already be available in the environment. Send the request on
stdin, rather than in command-line arguments:

```sh
printf '%s' '{"tool":"read_status","arguments":{"id":"example"},"idempotency_key":"run-123-step-1"}' |
  scripts/nomo-pydantic.sh --port 8787 --model '<provider:model>' --allow read_status --token-env NOMO_PROXY_TOKEN
```

The command prints one JSON result and exits 0 for success, 3 for a tool error,
4 if summarization failed after the tool completed, 2 for invalid input or
model configuration, and 1 when the outcome is unknown. Reconcile an unknown
outcome before another attempt. `--include-raw` explicitly includes the proxy
response in the output; omit it when the receiving context must not see that
data. The command does not set up provider credentials, start the proxy, or
change any harness permissions. The caller must prevent sensitive input and
output from entering logs or an unapproved model provider.
