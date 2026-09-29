"""The hosted code path, driven offline through a fake Appwrite context.

The function has no domain, so the edge router answers
``router_rule_not_found`` for every public URL form and no MCP handshake has
ever been observed against it. These tests answer the question that leaves:
does the code the runtime executes actually complete ``initialize``,
``tools/list`` and ``tools/call``? They assert on the bytes the handler
returned, because a transport that returns a well formed 200 carrying the
wrong body is the failure this endpoint would have shipped unnoticed.

The two tool names, the payload keys of ``void_project_info`` and the JSON-RPC
envelope are written out rather than imported from ``app.py``: a test that
reads its expectation out of the code it is checking cannot fail.
"""

from __future__ import annotations

import json
import unittest

from mcp_types.version import HANDSHAKE_PROTOCOL_VERSIONS

from tests.support_context import invoke

TOOL_NAMES = ["void_project_info", "void_recovery_capabilities"]

# The keys `docs/DISTRIBUTION-PATH.md` and the function README promise a
# client: what this endpoint is, and where recovery actually runs.
PROJECT_INFO_KEYS = {"name", "summary", "hosted_mcp", "local_recovery"}


def envelope(response):
    """The decoded JSON-RPC envelope, with the envelope itself checked."""
    payload = response.json()
    assert response.status == 200, response
    assert payload["jsonrpc"] == "2.0", payload
    assert "id" in payload, payload
    return payload


class InitializeTest(unittest.TestCase):
    """The handshake a client performs before anything else."""

    def test_initialize_returns_the_server_identity(self) -> None:
        response = invoke(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "void-hosted-test", "version": "0.1.0"},
                },
            }
        )

        result = envelope(response)["result"]
        self.assertEqual(result["serverInfo"], {"name": "VOID", "version": "0.1.0"})
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertEqual(result["instructions"][:4], "Read")
        self.assertEqual(response.headers["content-type"], "application/json")

    def test_initialize_echoes_the_request_id(self) -> None:
        # A dropped id is the failure a client cannot recover from, so the
        # envelope is checked for correlation rather than for shape alone.
        response = invoke(
            {
                "jsonrpc": "2.0",
                "id": "handshake-7",
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "void-hosted-test", "version": "0.1.0"},
                },
            }
        )

        self.assertEqual(envelope(response)["id"], "handshake-7")

    def test_initialize_never_answers_a_version_the_sdk_cannot_speak(self) -> None:
        # A client may ask for a revision the SDK has never heard of. The
        # answer has to name a version both sides implement, or every call
        # that follows is made on a protocol nobody agreed to.
        response = invoke(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "initialize",
                "params": {
                    "protocolVersion": "1999-01-01",
                    "capabilities": {},
                    "clientInfo": {"name": "void-hosted-test", "version": "0.1.0"},
                },
            }
        )

        negotiated = envelope(response)["result"]["protocolVersion"]
        self.assertIn(negotiated, HANDSHAKE_PROTOCOL_VERSIONS)
        self.assertNotEqual(negotiated, "1999-01-01")


class ToolCatalogueTest(unittest.TestCase):
    """What ``tools/list`` publishes is the whole public surface."""

    def test_tools_list_publishes_exactly_the_documented_tools(self) -> None:
        response = invoke({"jsonrpc": "2.0", "id": 3, "method": "tools/list", "params": {}})

        tools = envelope(response)["result"]["tools"]
        self.assertEqual([tool["name"] for tool in tools], TOOL_NAMES)

    def test_every_tool_carries_a_description_and_an_input_schema(self) -> None:
        response = invoke({"jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": {}})

        for tool in envelope(response)["result"]["tools"]:
            with self.subTest(tool=tool["name"]):
                self.assertTrue(tool["description"].strip())
                self.assertEqual(tool["inputSchema"]["type"], "object")
                self.assertIsInstance(tool["inputSchema"]["properties"], dict)


class ToolCallTest(unittest.TestCase):
    """A call has to produce the documented payload, not a shape."""

    def call(self, name: str, request_id: int = 5):
        return invoke(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": {}},
            }
        )

    def test_project_info_returns_json_with_the_documented_keys(self) -> None:
        response = self.call("void_project_info")

        result = envelope(response)["result"]
        self.assertFalse(result["isError"])
        data = json.loads(result["content"][0]["text"])
        self.assertEqual(set(data), PROJECT_INFO_KEYS)
        self.assertEqual(data["name"], "VOID")
        self.assertIn("local", data["local_recovery"])

    def test_recovery_capabilities_states_that_execution_stays_local(self) -> None:
        # The one claim the hosted endpoint must never blur: it names the
        # recovery tools, it does not run them.
        response = self.call("void_recovery_capabilities", request_id=6)

        data = json.loads(envelope(response)["result"]["content"][0]["text"])
        self.assertFalse(data["hosted_execution"])
        self.assertEqual(data["transport"], "local stdio")
        self.assertIn("void_recovery_apply", data["tools"])

    def test_an_unknown_tool_is_refused_on_the_result_channel(self) -> None:
        # The SDK reports a refused tool as a successful envelope carrying
        # MCP isError content, not as a JSON-RPC error. That is the wire
        # contract the rest of VOID already documents, so the test pins the
        # contract a client actually has to handle: never a 500, never an
        # empty body, always an envelope that names the refused tool.
        response = self.call("void_recovery_apply", request_id=7)

        payload = envelope(response)
        self.assertNotIn("error", payload)
        result = payload["result"]
        self.assertTrue(result["isError"])
        self.assertIn("void_recovery_apply", result["content"][0]["text"])

    def test_a_malformed_body_is_a_json_rpc_parse_error(self) -> None:
        response = invoke(raw_text='{"jsonrpc":"2.0","id":8,"method":')

        payload = response.json()
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], -32700)
        self.assertIsNone(payload["id"])


class StatelessEndpointTest(unittest.TestCase):
    """The endpoint is one buffered POST, and says so when it is not."""

    def test_get_is_refused_with_the_reason(self) -> None:
        # A Streamable HTTP client opens the server message stream with GET.
        # Refusing it with the reason is what stops a client from retrying.
        response = invoke(method="GET")

        payload = response.json()
        self.assertEqual(response.status, 405)
        self.assertIn("POST", payload["error"]["message"])
        self.assertEqual(response.headers["Allow"], "POST, OPTIONS")

    def test_options_answers_the_preflight(self) -> None:
        response = invoke(method="OPTIONS")

        self.assertEqual(response.status, 204)
        self.assertEqual(response.body, b"")
        self.assertIn("POST", response.headers["Access-Control-Allow-Methods"])
        self.assertIn(
            "Authorization",
            response.headers["Access-Control-Allow-Headers"],
        )

    def test_the_answer_does_not_depend_on_which_body_field_the_runtime_filled(self) -> None:
        # Appwrite populates the raw text and the parsed body together and the
        # adapter may read either. A change in that precedence would change
        # what every client gets, so the two paths are compared byte for byte.
        message = {"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {}}

        from_raw = invoke(message)
        from_parsed = invoke(message, body_only=True)

        self.assertEqual(from_raw.body, from_parsed.body)
        self.assertEqual(from_raw.status, from_parsed.status)
