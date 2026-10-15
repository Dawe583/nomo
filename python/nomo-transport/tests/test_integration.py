"""The client against a real spawned NOMO proxy HTTP endpoint.

The endpoint is the repository's own ``createHttpRequestRelay`` bound to a
loopback port by ``tests/fixtures/nomo_proxy_http.mjs``, with the real
``nomo recovery serve`` MCP server behind it as a child process. See
``support_proxy.py`` for the exact chain.

One thing these tests establish about the real wire, which the scripted unit
tests cannot: the relay answers a refused or unknown tool as a successful
JSON-RPC ``result`` carrying MCP ``isError`` content, not as a JSON-RPC
``error``. The refusal is real and structured, but it arrives on the result
channel. A client that only looked at ``error`` would read a policy denial as
a success.
"""

from __future__ import annotations

import json
import unittest

from tests.support_proxy import (
    _ALLOW_ALL_POLICY,
    _DENY_ALL_POLICY,
    _READ_ONLY_TOOL,
    ProxyEndpoint,
)
from nomo_transport.client import NomoTransportClient
from nomo_transport.errors import NomoTransportError


def payload_text(result: object) -> str:
    """The JSON a recovery tool put in its first text content block."""
    assert isinstance(result, dict), result
    content = result.get("content")
    assert isinstance(content, list) and content, result
    first = content[0]
    assert isinstance(first, dict), result
    return str(first.get("text", ""))


class RealProxyTest(unittest.TestCase):
    """One endpoint and one client for the whole class.

    Starting the relay and the MCP server per test would cost about a second
    each, and it would hide a real property: the relay's Session remembers
    every agent id it has seen for the life of the process, so two clients
    that both start at id 1 collide on "Duplicate JSON-RPC request id". One
    client per endpoint is also the honest shape -- a session id stream belongs
    to one session.
    """

    endpoint: ProxyEndpoint
    shared: NomoTransportClient

    @classmethod
    def setUpClass(cls) -> None:
        cls.endpoint = ProxyEndpoint(_ALLOW_ALL_POLICY).__enter__()
        cls.shared = NomoTransportClient(
            "127.0.0.1", cls.endpoint.port, path="/mcp", timeout=60
        )
        cls.shared.initialize()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.shared.close()
        cls.endpoint.__exit__()

    def client(self) -> NomoTransportClient:
        return self.__class__.shared

    def test_initialize_against_the_real_relay(self) -> None:
        info = self.client().handshake
        self.assertEqual(info.name, "nomo-recovery")
        self.assertTrue(info.version)
        self.assertIn(info.protocol_version, {
            "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07",
        })

    def test_list_tools_returns_the_real_tool_catalogue(self) -> None:
        tools = self.client().list_tools()
        names = [tool.name for tool in tools]
        self.assertIn(_READ_ONLY_TOOL, names)
        self.assertIn("nomo_execute", names)
        for tool in tools:
            self.assertTrue(tool.name)
            self.assertIsInstance(tool.description, str)

    def test_call_tool_against_a_policy_that_allows(self) -> None:
        client = self.client()
        call = client.call_tool(
            "nomo_reconcile", {"operationId": "op-does-not-exist"}, "py-it-allow-1"
        )
        result = client.await_hold(call.hold_id, timeout=60)
        # An unknown operation is answered with structured content on the
        # result channel; that the call completed is what this asserts.
        self.assertIsInstance(result, dict)
        self.assertIn("content", result)

    def test_two_calls_in_flight_keep_their_own_answers(self) -> None:
        client = self.client()
        first = client.call_tool(
            "nomo_reconcile", {"operationId": "op-one"}, "py-it-allow-2"
        )
        second = client.call_tool(
            "nomo_reconcile", {"operationId": "op-two"}, "py-it-allow-3"
        )
        # The relay allocates one upstream id per request. A client that
        # accepted a crossed answer would attribute one tool's result to
        # another tool's call, so both handles must settle independently.
        self.assertNotEqual(first.hold_id, second.hold_id)
        first_result = client.await_hold(first.hold_id, timeout=60)
        second_result = client.await_hold(second.hold_id, timeout=60)
        self.assertNotEqual(payload_text(first_result), "")
        self.assertNotEqual(payload_text(second_result), "")

    def test_unknown_tool_is_refused_by_the_upstream_not_the_transport(self) -> None:
        client = self.client()
        call = client.call_tool("nomo_no_such_tool", {}, "py-it-allow-4")
        result = client.await_hold(call.hold_id, timeout=60)
        # The request reached NOMO, the relay worked, and the upstream refused
        # the tool. Reading that as a transport failure would be wrong; reading
        # it as a success would be worse, which is what isError says.
        self.assertIsInstance(result, dict)
        self.assertIs(result.get("isError"), True)
        self.assertIn("unknown", payload_text(result))

    def test_missing_idempotency_key_never_reaches_the_real_relay(self) -> None:
        client = self.client()
        with self.assertRaises(NomoTransportError) as caught:
            client.call_tool("nomo_reconcile", {"operationId": "op-1"}, None)
        self.assertIn("idempotency key", str(caught.exception))
        # No handle was minted, so nothing is on the wire.
        self.assertEqual(client.pending_holds, ())

    def test_malformed_idempotency_key_never_reaches_the_real_relay(self) -> None:
        client = self.client()
        with self.assertRaises(NomoTransportError):
            client.call_tool("nomo_reconcile", {"operationId": "op-1"}, "not a valid key")
        self.assertEqual(client.pending_holds, ())

    def test_session_id_is_absent_from_a_relay_that_issues_none(self) -> None:
        # createHttpRequestRelay never mints an mcp-session-id. The client must
        # cope with that rather than inventing one or refusing the session.
        self.client().list_tools()
        self.assertIsNone(self.client().session_id)

    def test_close_stops_further_work(self) -> None:
        # A throwaway client on the shared endpoint, so closing it does not
        # disturb the session the other cases are using.
        throwaway = NomoTransportClient("127.0.0.1", self.endpoint.port, timeout=60)
        throwaway.initialize()
        throwaway.close()
        with self.assertRaises(NomoTransportError) as caught:
            throwaway.list_tools()
        self.assertIn("closed", str(caught.exception))


class RealProxyDenyTest(unittest.TestCase):
    """A policy that refuses everything, so a live denial is exercised."""

    def test_denial_arrives_as_structured_refusal_content(self) -> None:
        with ProxyEndpoint(_DENY_ALL_POLICY) as endpoint:
            client = NomoTransportClient("127.0.0.1", endpoint.port, timeout=60)
            try:
                client.initialize()
                call = client.call_tool(
                    "nomo_reconcile", {"operationId": "op-denied"}, "py-it-deny-1"
                )
                result = client.await_hold(call.hold_id, timeout=60)
                # Operator policy refused the call. The proof is in the
                # upstream's own category string, not in an exception: a
                # NOMO denial on this transport is content, and the client
                # hands it back byte for byte.
                self.assertIsInstance(result, dict)
                self.assertIs(result.get("isError"), True)
                self.assertIn("policy_denied", payload_text(result))
            finally:
                client.close()

    def test_denial_under_a_concurrent_call_does_not_cross_answers(self) -> None:
        with ProxyEndpoint(_DENY_ALL_POLICY) as endpoint:
            client = NomoTransportClient("127.0.0.1", endpoint.port, timeout=60)
            try:
                client.initialize()
                allowed_shape = client.call_tool(
                    "nomo_reconcile", {"operationId": "op-a"}, "py-it-deny-2"
                )
                denied_shape = client.call_tool(
                    "nomo_recovery_plan", {"operationId": "op-b"}, "py-it-deny-3"
                )
                first = client.await_hold(allowed_shape.hold_id, timeout=60)
                second = client.await_hold(denied_shape.hold_id, timeout=60)
                for result in (first, second):
                    self.assertIsInstance(result, dict)
                    self.assertIs(result.get("isError"), True)
                    self.assertIn("policy_denied", json.dumps(result))
            finally:
                client.close()


if __name__ == "__main__":
    unittest.main()
