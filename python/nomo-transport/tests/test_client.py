"""What the client does with a response it did not ask for.

Every case here is a refusal the Swift client also makes: a scope mismatch, a
body over the limit, a shape the protocol does not define, a redirect, and a
mutating call that would go out without an idempotency key.
"""

from __future__ import annotations

import json
import os
import threading
import unittest
from typing import Any

from tests.support_http import ScriptedReply, ScriptedServer, json_reply, sse_reply
from nomo_transport.client import NomoTransportClient
from nomo_transport.errors import HoldDeniedError, NomoTransportError

TOKEN_ENV = "NOMO_TRANSPORT_TEST_TOKEN"


def echo_method(request_body: bytes) -> str:
    return json.loads(request_body)["method"]


class ClientContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self._servers: list[ScriptedServer] = []

    def tearDown(self) -> None:
        for server in self._servers:
            server.__exit__()

    def serve(self, handler: Any) -> tuple[ScriptedServer, NomoTransportClient]:
        server = ScriptedServer(handler)
        server.__enter__()
        self._servers.append(server)
        return server, NomoTransportClient(server.host, server.port, timeout=10)

    # ------------------------------------------------------------ refusals

    def test_response_for_another_request_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({"jsonrpc": "2.0", "id": 99, "result": {"tools": []}})

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("not the 1 that was sent", str(caught.exception))

    def test_string_id_is_not_coerced_to_the_numeric_one(self) -> None:
        # session.ts drops a string id rather than reading it as its numeric
        # lookalike. This client refuses the whole response instead.
        def handler(request: Any) -> ScriptedReply:
            return json_reply({"jsonrpc": "2.0", "id": "1", "result": {"tools": []}})

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("not numeric", str(caught.exception))

    def test_boolean_id_is_not_an_integer(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({"jsonrpc": "2.0", "id": True, "result": {"tools": []}})

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError):
            client.list_tools()

    def test_oversize_response_is_refused_on_the_declared_length(self) -> None:
        oversized = b"x" * 4096

        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(
                headers={"content-type": "application/json"}, body=oversized
            )

        server, client = self.serve(handler)
        client._max_response_bytes = 128
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("byte limit", str(caught.exception))
        self.assertEqual(len(server.requests), 1)

    def test_oversize_response_without_content_length_is_still_refused(self) -> None:
        # A chunked answer has no declared length, so the cap has to come from
        # the read loop rather than from a header.
        class ChunkedServer(ScriptedServer):
            pass

        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(
                headers={
                    "content-type": "application/json",
                    "transfer-encoding": "chunked",
                },
                body=b"x" * 4096,
            )

        _server, client = self.serve(handler)
        client._max_response_bytes = 64
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("byte limit", str(caught.exception))

    def test_unknown_shape_is_refused(self) -> None:
        cases: list[tuple[str, Any]] = [
            ("no jsonrpc field", {"id": 1, "result": {}}),
            ("wrong jsonrpc version", {"jsonrpc": "1.0", "id": 1, "result": {}}),
            ("no id", {"jsonrpc": "2.0", "result": {}}),
            ("result and error together", {
                "jsonrpc": "2.0", "id": 1, "result": {}, "error": {"code": 1, "message": "x"},
            }),
            ("neither result nor error", {"jsonrpc": "2.0", "id": 1}),
            ("not an object", [1, 2, 3]),
            ("a bare string", "hello"),
        ]
        for name, payload in cases:
            with self.subTest(case=name):
                def handler(request: Any, payload: Any = payload) -> ScriptedReply:
                    return json_reply(payload)

                _server, client = self.serve(handler)
                with self.assertRaises(NomoTransportError):
                    client.list_tools()

    def test_malformed_json_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(
                headers={"content-type": "application/json"},
                body=b'{"jsonrpc":"2.0","id":1,"result":',
            )

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("malformed JSON", str(caught.exception))

    def test_empty_body_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(headers={"content-type": "application/json"}, body=b"")

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("empty body", str(caught.exception))

    def test_tools_list_without_a_tools_array_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({"jsonrpc": "2.0", "id": 1, "result": {"nope": []}})

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("tools array", str(caught.exception))

    def test_tools_list_with_an_unusable_name_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"tools": [{"name": "bad/name"}]},
            })

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("tool name", str(caught.exception))

    def test_unsupported_protocol_version_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "1999-01-01",
                    "capabilities": {},
                    "serverInfo": {"name": "x", "version": "1"},
                },
            })

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.initialize()
        self.assertIn("unsupported protocol version", str(caught.exception))

    def test_initialize_without_server_info_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {"protocolVersion": "2025-06-18", "capabilities": {}},
            })

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.initialize()
        self.assertIn("serverInfo", str(caught.exception))

    def test_redirect_is_refused_rather_than_followed(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(
                status=307, headers={"location": "http://elsewhere.invalid/mcp"}, body=b""
            )

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("redirect", str(caught.exception))

    def test_unauthorised_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(status=401, body=b"")

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("401", str(caught.exception))

    def test_server_error_is_refused_without_a_retry(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return ScriptedReply(status=500, body=b"")

        server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("HTTP 500", str(caught.exception))
        # Exactly one attempt: a second POST would be a second side effect.
        self.assertEqual(len(server.requests), 1)

    # ------------------------------------------------------- before sending

    def test_call_tool_without_an_idempotency_key_never_reaches_the_wire(self) -> None:
        def handler(request: Any) -> ScriptedReply:  # pragma: no cover - must not run
            raise AssertionError("the request must be refused before the socket")

        server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.call_tool("nomo_execute", {"operationId": "op-1"}, None)
        self.assertIn("idempotency key", str(caught.exception))
        self.assertEqual(server.requests, [])

    def test_call_tool_with_a_malformed_idempotency_key_never_sends(self) -> None:
        def handler(request: Any) -> ScriptedReply:  # pragma: no cover - must not run
            raise AssertionError("the request must be refused before the socket")

        server, client = self.serve(handler)
        for bad in ("", "has space", "a" * 161, "sémantique", "semi;colon"):
            with self.subTest(key=bad):
                with self.assertRaises(NomoTransportError):
                    client.call_tool("nomo_execute", {}, bad)
        self.assertEqual(server.requests, [])

    def test_call_tool_with_an_unusable_name_never_sends(self) -> None:
        def handler(request: Any) -> ScriptedReply:  # pragma: no cover - must not run
            raise AssertionError("the request must be refused before the socket")

        server, client = self.serve(handler)
        for bad in ("", "bad/name", "back\\slash", "a" * 161, "new\nline"):
            with self.subTest(name=bad):
                with self.assertRaises(NomoTransportError):
                    client.call_tool(bad, {}, "key-1")
        self.assertEqual(server.requests, [])

    def test_oversize_request_is_refused_before_the_socket(self) -> None:
        def handler(request: Any) -> ScriptedReply:  # pragma: no cover - must not run
            raise AssertionError("the request must be refused before the socket")

        server, client = self.serve(handler)
        client._max_request_bytes = 64
        with self.assertRaises(NomoTransportError) as caught:
            client.call_tool("nomo_execute", {"blob": "x" * 4096}, "key-1")
        self.assertIn("byte limit", str(caught.exception))
        self.assertEqual(server.requests, [])

    # -------------------------------------------------------------- tokens

    def test_missing_token_variable_is_refused_at_construction(self) -> None:
        os.environ.pop(TOKEN_ENV, None)
        with self.assertRaises(NomoTransportError) as caught:
            NomoTransportClient("127.0.0.1", 1, token_env=TOKEN_ENV)
        self.assertIn("unset or empty", str(caught.exception))

    def test_empty_token_variable_is_refused_at_construction(self) -> None:
        os.environ[TOKEN_ENV] = ""
        try:
            with self.assertRaises(NomoTransportError):
                NomoTransportClient("127.0.0.1", 1, token_env=TOKEN_ENV)
        finally:
            os.environ.pop(TOKEN_ENV, None)

    def test_token_with_a_header_break_is_refused(self) -> None:
        os.environ[TOKEN_ENV] = "abc\r\nX-Injected: 1"
        try:
            with self.assertRaises(NomoTransportError) as caught:
                NomoTransportClient("127.0.0.1", 1, token_env=TOKEN_ENV)
            self.assertIn("cannot be sent", str(caught.exception))
        finally:
            os.environ.pop(TOKEN_ENV, None)

    def test_token_value_never_reaches_repr(self) -> None:
        os.environ[TOKEN_ENV] = "super-secret-value"
        try:
            client = NomoTransportClient("127.0.0.1", 1, token_env=TOKEN_ENV)
            self.assertNotIn("super-secret-value", repr(client))
        finally:
            os.environ.pop(TOKEN_ENV, None)

    def test_token_is_sent_as_a_bearer_header(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            if echo_method(request.body) == "notifications/initialized":
                return ScriptedReply(status=202, body=b"")
            return json_reply({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": "nomo-recovery", "version": "0.1.0"},
                },
            })

        os.environ[TOKEN_ENV] = "token-value-for-test"
        try:
            server, client = self.serve(handler)
            client = NomoTransportClient(
                server.host, server.port, token_env=TOKEN_ENV, timeout=10
            )
            client.initialize()
            self.assertEqual(
                server.requests[0].headers["authorization"], "Bearer token-value-for-test"
            )
        finally:
            os.environ.pop(TOKEN_ENV, None)

    # ------------------------------------------------------- event streams

    def test_event_stream_answer_is_accepted(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return sse_reply([
                json.dumps({"jsonrpc": "2.0", "method": "notifications/progress",
                            "params": {"progress": 1}}),
                json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"tools": [
                    {"name": "nomo_execute", "description": "d", "inputSchema": {}},
                ]}}),
            ])

        _server, client = self.serve(handler)
        tools = client.list_tools()
        self.assertEqual([tool.name for tool in tools], ["nomo_execute"])

    def test_event_stream_answering_another_id_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return sse_reply([json.dumps({"jsonrpc": "2.0", "id": 42, "result": {}})])

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("not the 1 that was sent", str(caught.exception))

    def test_event_stream_with_no_matching_frame_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return sse_reply([json.dumps({
                "jsonrpc": "2.0", "method": "notifications/progress", "params": {},
            })])

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("no response for request id", str(caught.exception))

    def test_malformed_event_frame_is_refused(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return sse_reply(['{"jsonrpc":"2.0",'])

        _server, client = self.serve(handler)
        with self.assertRaises(NomoTransportError) as caught:
            client.list_tools()
        self.assertIn("malformed event frame", str(caught.exception))

    # -------------------------------------------------------------- errors

    def test_hold_denial_becomes_a_hold_denied_error(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": json.loads(request.body)["id"],
                "error": {
                    "code": -32003,
                    "message": "The call to nomo_execute was denied by a human.",
                    "data": {"held": "nomo_execute", "result": "denied", "rule": 2},
                },
            })

        _server, client = self.serve(handler)
        call = client.call_tool("nomo_execute", {"operationId": "op-1"}, "key-1")
        with self.assertRaises(HoldDeniedError) as caught:
            client.await_hold(call.hold_id, timeout=10)
        self.assertEqual(caught.exception.code, "NOMO_HOLD_DENIED")
        self.assertEqual(caught.exception.data["result"], "denied")

    def test_expired_hold_becomes_a_hold_denied_error(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": json.loads(request.body)["id"],
                "error": {
                    "code": -32000,
                    "message": "The call to nomo_execute expired without a human decision.",
                    "data": {"held": "nomo_execute", "result": "expired"},
                },
            })

        _server, client = self.serve(handler)
        call = client.call_tool("nomo_execute", {}, "key-1")
        with self.assertRaises(HoldDeniedError):
            client.await_hold(call.hold_id, timeout=10)

    def test_plain_error_is_a_transport_refusal_not_a_hold(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({
                "jsonrpc": "2.0",
                "id": json.loads(request.body)["id"],
                "error": {"code": -32602, "message": "unknown tool"},
            })

        _server, client = self.serve(handler)
        call = client.call_tool("nope", {}, "key-1")
        with self.assertRaises(NomoTransportError) as caught:
            client.await_hold(call.hold_id, timeout=10)
        self.assertEqual(caught.exception.code, "NOMO_TRANSPORT")
        self.assertEqual(str(caught.exception), "unknown tool")

    def test_unknown_hold_id_is_refused_immediately(self) -> None:
        _server, client = self.serve(lambda request: json_reply({}))
        with self.assertRaises(NomoTransportError) as caught:
            client.await_hold("hold-does-not-exist", timeout=10)
        self.assertIn("unknown hold", str(caught.exception))

    def test_await_hold_times_out_rather_than_hanging(self) -> None:
        release = threading.Event()

        def handler(request: Any) -> ScriptedReply:
            release.wait(timeout=30)
            return json_reply({"jsonrpc": "2.0", "id": 1, "result": {}})

        try:
            _server, client = self.serve(handler)
            call = client.call_tool("nomo_execute", {}, "key-1")
            with self.assertRaises(NomoTransportError) as caught:
                client.await_hold(call.hold_id, timeout=0.2)
            self.assertIn("did not settle", str(caught.exception))
        finally:
            release.set()

    # ---------------------------------------------------------- lifecycle

    def test_close_fails_a_pending_call_with_an_unknown_outcome(self) -> None:
        release = threading.Event()

        def handler(request: Any) -> ScriptedReply:
            release.wait(timeout=30)
            return json_reply({"jsonrpc": "2.0", "id": 1, "result": {}})

        try:
            _server, client = self.serve(handler)
            call = client.call_tool("nomo_execute", {}, "key-1")
            client.close()
            with self.assertRaises(NomoTransportError) as caught:
                client.await_hold(call.hold_id, timeout=5)
            self.assertIn("outcome unknown", str(caught.exception))
            with self.assertRaises(NomoTransportError):
                client.list_tools()
        finally:
            release.set()

    def test_session_id_is_remembered_and_carried_forward(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            if echo_method(request.body) == "tools/list":
                return json_reply(
                    {"jsonrpc": "2.0", "id": 2, "result": {"tools": []}},
                    **{"mcp-session-id": "sid-1"},
                )
            return json_reply(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "protocolVersion": "2025-06-18",
                        "capabilities": {},
                        "serverInfo": {"name": "n", "version": "1"},
                    },
                },
                **{"mcp-session-id": "sid-1"},
            )

        server, client = self.serve(handler)
        client.initialize()
        self.assertEqual(client.session_id, "sid-1")
        client.list_tools()
        self.assertEqual(server.requests[-1].headers["mcp-session-id"], "sid-1")

    def test_accept_header_matches_the_transport(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            return json_reply({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})

        server, client = self.serve(handler)
        client.list_tools()
        self.assertEqual(
            server.requests[0].headers["accept"], "application/json, text/event-stream"
        )
        self.assertEqual(server.requests[0].headers["content-type"], "application/json")

    def test_handshake_before_initialize_is_refused(self) -> None:
        _server, client = self.serve(lambda request: json_reply({}))
        with self.assertRaises(NomoTransportError) as caught:
            _ = client.handshake
        self.assertIn("initialize has not completed", str(caught.exception))

    def test_handshake_is_remembered_after_initialize(self) -> None:
        def handler(request: Any) -> ScriptedReply:
            if echo_method(request.body) == "notifications/initialized":
                return ScriptedReply(status=202, body=b"")
            return json_reply({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": "nomo-recovery", "version": "0.1.0"},
                },
            })

        _server, client = self.serve(handler)
        returned = client.initialize()
        self.assertIs(client.handshake, returned)

    def test_endpoint_arguments_are_validated(self) -> None:
        for host in ("", " http://x", "http://127.0.0.1", "127.0.0.1/mcp", "a@b"):
            with self.subTest(host=host):
                with self.assertRaises(NomoTransportError):
                    NomoTransportClient(host, 8080)
        for port in (0, 65536, -1, True, "8080"):
            with self.subTest(port=port):
                with self.assertRaises(NomoTransportError):
                    NomoTransportClient("127.0.0.1", port)  # type: ignore[arg-type]
        for path in ("mcp", "/a?b=1", "/a/../b", "/a b"):
            with self.subTest(path=path):
                with self.assertRaises(NomoTransportError):
                    NomoTransportClient("127.0.0.1", 8080, path)
        for name in ("", "1BAD", "has-dash", "has space"):
            with self.subTest(token_env=name):
                with self.assertRaises(NomoTransportError):
                    NomoTransportClient("127.0.0.1", 8080, token_env=name)


if __name__ == "__main__":
    unittest.main()
