import unittest
from types import SimpleNamespace

from nomo_pydantic import run_governed_call
from pydantic_ai.models.test import TestModel


class StubTransport:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def call_tool(self, name, arguments, idempotency_key):
        self.calls.append((name, arguments, idempotency_key))
        return SimpleNamespace(hold_id="hold-1")

    def await_hold(self, hold_id, timeout=None):
        if self.error:
            raise self.error
        return self.result


class GovernedWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def test_governed_call_passes_exact_request_once_and_uses_agent(self):
        transport = StubTransport({"content": [{"type": "text", "text": "ok"}]})
        result = await run_governed_call(
            transport=transport,
            tool="read_status",
            arguments={"id": "a"},
            idempotency_key="request-1",
            allowed_tools={"read_status"},
            model=TestModel(custom_output_text="summary"),
        )
        self.assertEqual(transport.calls, [("read_status", {"id": "a"}, "request-1")])
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.summary, "summary")
        self.assertEqual(
            result.raw_result, {"content": [{"type": "text", "text": "ok"}]}
        )
        self.assertNotIn("content", repr(result))

    async def test_denied_tool_is_never_summarized_as_success(self):
        transport = StubTransport(
            {"isError": True, "content": [{"type": "text", "text": "tool_error"}]}
        )
        result = await run_governed_call(
            transport=transport,
            tool="read_status",
            arguments={},
            idempotency_key="request-2",
            allowed_tools={"read_status"},
            model=TestModel(custom_output_text="incorrect success"),
        )
        self.assertEqual(result.status, "tool_error")
        self.assertIsNone(result.summary)
        self.assertEqual(len(transport.calls), 1)

    async def test_out_of_scope_call_never_reaches_transport(self):
        transport = StubTransport()
        with self.assertRaises(ValueError):
            await run_governed_call(
                transport=transport,
                tool="delete",
                arguments={},
                idempotency_key="request-3",
                allowed_tools={"read_status"},
                model=TestModel(),
            )
        self.assertEqual(transport.calls, [])

    async def test_invalid_timeout_is_rejected_before_dispatch(self):
        transport = StubTransport()
        for timeout in (0, -1, float("nan"), float("inf"), True):
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                await run_governed_call(
                    transport=transport,
                    tool="read_status",
                    arguments={},
                    idempotency_key="request-5",
                    allowed_tools={"read_status"},
                    model=TestModel(),
                    timeout=timeout,
                )
        self.assertEqual(transport.calls, [])

    async def test_model_failure_reports_completed_dispatch_without_retry(self):
        from unittest.mock import AsyncMock, patch

        transport = StubTransport({"content": [{"type": "text", "text": "ok"}]})
        with patch("nomo_pydantic.workflow.Agent") as agent:
            agent.return_value.run = AsyncMock(
                side_effect=RuntimeError("private provider error")
            )
            result = await run_governed_call(
                transport=transport,
                tool="read_status",
                arguments={},
                idempotency_key="request-6",
                allowed_tools={"read_status"},
                model=TestModel(),
            )
        self.assertEqual(result.status, "summary_failed")
        self.assertIsNone(result.summary)
        self.assertEqual(len(transport.calls), 1)
        self.assertNotIn("private provider error", repr(result))

    async def test_unknown_outcome_is_raised_without_retry(self):
        transport = StubTransport(error=TimeoutError("outcome unknown"))
        with self.assertRaises(TimeoutError):
            await run_governed_call(
                transport=transport,
                tool="read_status",
                arguments={},
                idempotency_key="request-4",
                allowed_tools={"read_status"},
                model=TestModel(),
            )
        self.assertEqual(len(transport.calls), 1)


class EvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_evaluation_records_success_and_mismatch(self):
        from nomo_pydantic import RunResult
        from nomo_pydantic.evaluation import evaluate_statuses
        from pydantic_evals import Case

        async def task(value):
            return RunResult(value, None)

        report = await evaluate_statuses(
            [
                Case(name="correct", inputs="tool_error", expected_output="tool_error"),
                Case(name="mismatch", inputs="succeeded", expected_output="tool_error"),
            ],
            task,
        )
        self.assertEqual(len(report.failures), 0)
        self.assertEqual(
            [next(iter(case.assertions.values())).value for case in report.cases],
            [True, False],
        )


class LoopbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_nomo_transport_receives_one_governed_request(self):
        import json
        import sys
        from pathlib import Path

        transport_root = Path(__file__).resolve().parents[2] / "nomo-transport"
        sys.path[:0] = [
            str(transport_root / "src"),
            str(transport_root / "tests"),
        ]
        from nomo_transport import NomoTransportClient
        from support_http import ScriptedServer, json_reply

        def handler(request):
            payload = json.loads(request.body)
            return json_reply(
                {
                    "jsonrpc": "2.0",
                    "id": payload["id"],
                    "result": {"content": [{"type": "text", "text": "ok"}]},
                }
            )

        with ScriptedServer(handler) as server:
            client = NomoTransportClient(server.host, server.port)
            try:
                result = await run_governed_call(
                    transport=client,
                    tool="read_status",
                    arguments={"id": "a"},
                    idempotency_key="loopback-1",
                    allowed_tools={"read_status"},
                    model=TestModel(custom_output_text="ok"),
                )
                self.assertEqual(result.status, "succeeded")
                self.assertEqual(len(server.requests), 1)
                payload = server.requests[0].json()
                self.assertEqual(payload["method"], "tools/call")
                self.assertEqual(
                    payload["params"]["_meta"]["idempotencyKey"], "loopback-1"
                )
            finally:
                client.close()


class RealProxyPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_proxy_denial_is_not_summarized_as_success(self):
        import sys
        from pathlib import Path

        transport_root = Path(__file__).resolve().parents[2] / "nomo-transport"
        sys.path[:0] = [
            str(transport_root / "src"),
            str(transport_root / "tests"),
        ]
        from nomo_transport import NomoTransportClient
        from support_proxy import _DENY_ALL_POLICY, ProxyEndpoint

        with ProxyEndpoint(_DENY_ALL_POLICY) as endpoint:
            client = NomoTransportClient("127.0.0.1", endpoint.port, timeout=60)
            try:
                client.initialize()
                result = await run_governed_call(
                    transport=client,
                    tool="nomo_reconcile",
                    arguments={"operationId": "op-denied"},
                    idempotency_key="pydantic-deny-1",
                    allowed_tools={"nomo_reconcile"},
                    model=TestModel(custom_output_text="incorrect success"),
                    timeout=60,
                )
                self.assertEqual(result.status, "tool_error")
                self.assertIsNone(result.summary)
            finally:
                client.close()

    async def test_allowed_request_reports_unknown_operation_as_tool_error(self):
        import sys
        from pathlib import Path

        transport_root = Path(__file__).resolve().parents[2] / "nomo-transport"
        sys.path[:0] = [
            str(transport_root / "src"),
            str(transport_root / "tests"),
        ]
        from nomo_transport import NomoTransportClient
        from support_proxy import _ALLOW_ALL_POLICY, ProxyEndpoint

        with ProxyEndpoint(_ALLOW_ALL_POLICY) as endpoint:
            client = NomoTransportClient("127.0.0.1", endpoint.port, timeout=60)
            try:
                client.initialize()
                result = await run_governed_call(
                    transport=client,
                    tool="nomo_reconcile",
                    arguments={"operationId": "op-does-not-exist"},
                    idempotency_key="key1",
                    allowed_tools={"nomo_reconcile"},
                    model=TestModel(custom_output_text="fixture summary"),
                    timeout=60,
                )
                self.assertEqual(result.status, "tool_error")
                self.assertIsInstance(result.raw_result, dict)
                self.assertIn("content", result.raw_result)
            finally:
                client.close()
