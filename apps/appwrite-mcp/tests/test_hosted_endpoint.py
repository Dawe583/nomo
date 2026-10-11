"""The hosted code path, driven offline through a fake Appwrite context.

The function has no registered domain, so the edge router answers
``router_rule_not_found`` for every public URL form and no MCP handshake has
ever been observed against it. These tests answer the question that leaves:
does the code the runtime executes actually complete ``initialize``,
``tools/list`` and ``tools/call``? They assert on the bytes the handler
returned, because a transport that returns a well formed 200 carrying the
wrong body is the failure this endpoint would have shipped unnoticed.

The tool names, the payload keys of ``nomo_project_info`` and the JSON-RPC
envelope are written out rather than imported from ``app.py``: a test that
reads its expectation out of the code it is checking cannot fail.

The registry counts in ``RegistryCoverageTest`` are the one exception, and
they are read from the source tree rather than hard-coded, because a literal
268 is a claim that goes stale the next time somebody adds a vendor. What is
asserted is that the endpoint's own numbers equal the source's own numbers,
which is the property that has to hold.
"""

from __future__ import annotations

import json
import unittest

from mcp_types.version import HANDSHAKE_PROTOCOL_VERSIONS

from appwrite_mcp import nomo_data
from tests.support_context import invoke

TOOL_NAMES = [
    "nomo_project_info",
    "nomo_registry_search",
    "nomo_registry_entry",
    "nomo_registry_summary",
    "nomo_local_tools",
    "nomo_cli_commands",
]

PROJECT_INFO_KEYS = {
    "name",
    "version",
    "summary",
    "connect",
    "hosted_mcp",
    "local_recovery",
    "hosted_execution",
    "registry",
}


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
                    "clientInfo": {"name": "nomo-hosted-test", "version": "0.1.0"},
                },
            }
        )

        result = envelope(response)["result"]
        self.assertEqual(result["serverInfo"]["name"], "NOMO")
        self.assertIn("version", result["serverInfo"])
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertEqual(result["instructions"][:4], "NOMO")
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
                    "clientInfo": {"name": "nomo-hosted-test", "version": "0.1.0"},
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
                    "clientInfo": {"name": "nomo-hosted-test", "version": "0.1.0"},
                },
            }
        )

        negotiated = envelope(response)["result"]["protocolVersion"]
        self.assertIn(negotiated, HANDSHAKE_PROTOCOL_VERSIONS)
        self.assertNotEqual(negotiated, "1999-01-01")

    def test_the_instructions_say_recovery_runs_locally(self) -> None:
        # A client reads the server instructions once, before any tool call, and
        # decides from them whether this endpoint can execute. An instruction
        # that only said "read-only" would be the claim; the local stdio server
        # and the retained key are the reason, and they belong in the text a
        # client actually reads.
        response = invoke(
            {
                "jsonrpc": "2.0",
                "id": 21,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "nomo-hosted-test", "version": "0.1.0"},
                },
            }
        )

        instructions = envelope(response)["result"]["instructions"]
        self.assertIn("read-only", instructions)
        self.assertIn("stdio", instructions)


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

    def test_every_tool_is_annotated_read_only(self) -> None:
        # The endpoint executes nothing, so every tool it publishes must say so
        # in the annotation a host reads before prompting. A tool published
        # without readOnlyHint is presented as a write and a client may ask the
        # user to approve a search.
        response = invoke({"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}})

        for tool in envelope(response)["result"]["tools"]:
            with self.subTest(tool=tool["name"]):
                annotations = tool.get("annotations") or {}
                self.assertTrue(
                    annotations.get("readOnlyHint"),
                    f"{tool['name']} is published without readOnlyHint",
                )


class ToolCallTest(unittest.TestCase):
    """A call has to produce the documented payload, not a shape."""

    def call(self, name: str, arguments: dict | None = None, request_id: int = 6):
        return invoke(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )

    def payload(self, name: str, arguments: dict | None = None, request_id: int = 6) -> dict:
        result = envelope(self.call(name, arguments, request_id))["result"]
        self.assertFalse(result["isError"], result)
        return json.loads(result["content"][0]["text"])

    def test_project_info_says_how_to_connect(self) -> None:
        # The first thing a caller needs is where it is talking to. Without
        # this the endpoint answers what it knows about NOMO and leaves the
        # address that reached it to be discovered by reading the config the
        # caller already had.
        connect = self.payload("nomo_project_info")["connect"]
        self.assertEqual(connect["tools"], 6)
        self.assertIn("HTTP", connect["transport"])
        self.assertIn("read-only", connect["authentication"])

    def test_a_declared_endpoint_is_reported_and_is_pasteable(self) -> None:
        import os

        declared = "https://chat.voidagent.tech"
        previous = os.environ.get("NOMO_MCP_ENDPOINT")
        os.environ["NOMO_MCP_ENDPOINT"] = declared
        try:
            connect = self.payload("nomo_project_info")["connect"]
            self.assertEqual(connect["endpoint"], declared)
            parsed = json.loads(connect["mcp_client_config"])
            self.assertEqual(parsed["mcpServers"]["nomo"]["url"], declared)
            self.assertEqual(parsed["mcpServers"]["nomo"]["type"], "http")
        finally:
            if previous is None:
                os.environ.pop("NOMO_MCP_ENDPOINT", None)
            else:
                os.environ["NOMO_MCP_ENDPOINT"] = previous

    def test_an_undeclared_endpoint_emits_no_pasteable_config(self) -> None:
        # A configuration with an empty `url` looks pasteable and then fails on
        # use, which is worse than reporting nothing: the caller pastes it, it
        # fails, and the failure looks like a broken server rather than an
        # undeclared address.
        import os

        previous = os.environ.get("NOMO_MCP_ENDPOINT")
        os.environ.pop("NOMO_MCP_ENDPOINT", None)
        try:
            connect = self.payload("nomo_project_info")["connect"]
            self.assertEqual(connect["endpoint"], "")
            self.assertEqual(connect["mcp_client_config"], "")
        finally:
            if previous is not None:
                os.environ["NOMO_MCP_ENDPOINT"] = previous

    def test_project_info_returns_json_with_the_documented_keys(self) -> None:
        data = self.payload("nomo_project_info")
        self.assertEqual(set(data), PROJECT_INFO_KEYS)
        self.assertEqual(data["name"], "NOMO")
        self.assertIn("local", data["local_recovery"])
        self.assertFalse(data["hosted_execution"])

    def test_registry_summary_reports_the_source_registry(self) -> None:
        # The number is not hard-coded here. What is asserted is that the
        # endpoint's own total equals the registry file's own total, which is
        # the property that has to survive somebody adding a vendor.
        data = self.payload("nomo_registry_summary")
        source = nomo_data.registry_summary()
        self.assertEqual(data["operations"], source["operations"])
        self.assertEqual(data["cases"], source["cases"])
        self.assertEqual(data["vendors"], source["vendors"])
        self.assertEqual(data["unparsed_entries"], 0)

    def test_registry_search_returns_matching_cases_and_says_when_it_truncates(self) -> None:
        data = self.payload("nomo_registry_search", {"query": "aws.s3.object.put"})
        self.assertTrue(data["total_matched"] >= 1)
        self.assertFalse(data["truncated"])
        for row in data["results"]:
            self.assertEqual(row["id"], "aws.s3.object.put")

    def test_registry_search_matches_the_precondition_not_only_the_id(self) -> None:
        # The words a person searches for live in `when`, `window` and `inverse`,
        # not in the id. "delete marker" and "lifecycle rule" are the phrases
        # this registry is actually consulted for, and neither appears in any
        # identifier, so a search that only read the id returned nothing at all
        # for them — indistinguishable from an empty catalogue.
        for phrase in ("delete marker", "lifecycle rule"):
            with self.subTest(phrase=phrase):
                data = self.payload("nomo_registry_search", {"query": phrase, "limit": 5})
                self.assertGreaterEqual(
                    data["total_matched"],
                    1,
                    f"{phrase!r} matched nothing, though the registry holds it",
                )
                for row in data["results"]:
                    haystack = " ".join(
                        str(row.get(field, ""))
                        for field in ("id", "summary", "when", "inverse", "window", "surface", "note")
                    ).lower()
                    # Every word has to be in the row, not the phrase as one
                    # string: "delete marker" is a precondition on one case and
                    # the marker itself is named in another field, so asserting
                    # the phrase would be asserting a layout, not the search.
                    for word in phrase.split():
                        self.assertIn(word, haystack)

    def test_registry_search_matches_every_word_not_the_phrase(self) -> None:
        # A person types the words that describe the row, not the literal text of
        # the row. "stripe refund" appears nowhere as a phrase — the vendor is in
        # one field and the summary in another — so a substring match answered
        # zero for the most obvious query against this registry, while each word
        # on its own found rows. Every word has to match, in any field.
        data = self.payload("nomo_registry_search", {"query": "stripe refund", "limit": 5})
        self.assertGreaterEqual(data["total_matched"], 1, "'stripe refund' matched nothing")
        for row in data["results"]:
            haystack = json.dumps(row).lower()
            self.assertIn("stripe", haystack)
            self.assertIn("refund", haystack)

    def test_registry_search_filters_by_class(self) -> None:
        data = self.payload("nomo_registry_search", {"tone": "r3", "limit": 5})
        self.assertLessEqual(len(data["results"]), 5)
        for row in data["results"]:
            self.assertEqual(row["tone"], "r3")

    def test_registry_search_refuses_a_class_that_does_not_exist(self) -> None:
        # A typo in the class must not be answered as an empty result set,
        # which a client reads as "nothing is r9" rather than "that is not a
        # class". The refusal names what it received.
        data = self.payload("nomo_registry_search", {"tone": "r9"})
        self.assertIn("error", data)
        self.assertIn("r9", data["received"])

    def test_registry_entry_publishes_the_gate_and_the_note(self) -> None:
        # The prose in `when` is what a person reads; the `if` literal is what a
        # tool evaluates. Publishing one without the other answers a different
        # question than the one the catalogue exists for, so both are asserted
        # on a case that carries a conjunction rather than on the first row.
        data = self.payload("nomo_registry_entry", {"operation_id": "stripe.refund.create"})
        self.assertTrue(data["found"])
        gates = [case for case in data["cases"] if case.get("if")]
        self.assertGreaterEqual(len(gates), 1, "no case published its gate")
        for case in data["cases"]:
            self.assertIn("note", case, "a case published without its note")
            self.assertIn("if", case, "a case published without its gate")
        conjunction = next(
            (case for case in gates if (case.get("if") or {}).get("kind") == "all"),
            None,
        )
        self.assertIsNotNone(conjunction, "the conjunction case did not publish its gate")
        gate = (conjunction or {}).get("if") or {}
        self.assertTrue(
            gate.get("of"),
            "a conjunction published with no children, so it can never be true",
        )

    def test_registry_search_matches_a_gate_by_its_fact_name(self) -> None:
        # A caller checks `stripe.balance_covers_refund` and a caller searches
        # for it by that name. It appears in no prose field, so a search that
        # read only the prose answered zero for a string the registry holds.
        data = self.payload("nomo_registry_search", {"query": "balance_covers_refund", "limit": 5})
        self.assertGreaterEqual(data["total_matched"], 1)
        for row in data["results"]:
            self.assertIn("if", row, "a search result published without its gate")

    def test_registry_search_matches_a_condition_nested_in_a_gate(self) -> None:
        # A disjunction's second arm is a condition the caller holds and
        # searches for by name, and it sits one level down inside `of`. Reading
        # only the gate's own fields finds the first arm and misses this one,
        # which answers zero for a name the registry carries.
        data = self.payload("nomo_registry_search", {"query": "tip_recorded", "limit": 5})
        self.assertGreaterEqual(data["total_matched"], 1)
        for row in data["results"]:
            gate = row.get("if") or {}
            nested = gate.get("of") or []
            self.assertTrue(
                nested or gate.get("kind") == "always",
                "a compound result published without its conditions",
            )

    def test_registry_entry_returns_every_precondition_for_one_operation(self) -> None:
        data = self.payload("nomo_registry_entry", {"operation_id": "aws.s3.object.put"})
        self.assertTrue(data["found"])
        self.assertEqual(data["vendor"], "aws")
        self.assertGreaterEqual(data["case_count"], 2)
        for case in data["cases"]:
            self.assertIn(case["tone"], {"r0", "r1", "r2", "r3"})
            self.assertIn("when", case)
            self.assertIn("window", case)

    def test_an_unknown_operation_is_an_answer_not_a_failure(self) -> None:
        data = self.payload("nomo_registry_entry", {"operation_id": "not.a.real.operation"})
        self.assertFalse(data["found"])
        self.assertEqual(data["cases"], [])

    def test_local_tools_publishes_the_annotations_the_local_server_declares(self) -> None:
        data = self.payload("nomo_local_tools")
        self.assertFalse(data["hosted_execution"])
        self.assertEqual(data["transport"], "local stdio")
        names = {tool["name"] for tool in data["tools"]}
        self.assertIn("nomo_execute", names)
        self.assertIn("nomo_recovery_plan", names)
        # Read-only and write tools both exist locally, and the endpoint has to
        # carry that distinction rather than flattening the catalogue.
        self.assertIn(True, {tool["readOnly"] for tool in data["tools"]})
        self.assertIn(False, {tool["readOnly"] for tool in data["tools"]})

    def test_cli_commands_lists_the_dispatcher_surface(self) -> None:
        data = self.payload("nomo_cli_commands")
        self.assertEqual(data["count"], len(data["commands"]))
        for expected in ("replay", "verify", "recovery", "classify"):
            self.assertIn(expected, data["commands"])

    def test_an_unknown_tool_is_refused_on_the_result_channel(self) -> None:
        # The SDK reports a refused tool as a successful envelope carrying
        # MCP isError content, not as a JSON-RPC error. That is the wire
        # contract the rest of NOMO already documents, so the test pins the
        # contract a client actually has to handle: never a 500, never an
        # empty body, always an envelope that names the refused tool.
        response = self.call("nomo_recovery_apply", request_id=7)

        payload = envelope(response)
        self.assertNotIn("error", payload)
        result = payload["result"]
        self.assertTrue(result["isError"])
        self.assertIn("nomo_recovery_apply", result["content"][0]["text"])

    def test_a_malformed_body_is_a_json_rpc_parse_error(self) -> None:
        response = invoke(raw_text='{"jsonrpc":"2.0","id":8,"method":')

        payload = response.json()
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error"]["code"], -32700)
        self.assertIsNone(payload["id"])


class RegistryCoverageTest(unittest.TestCase):
    """The parser must read the whole registry, not a prefix of it.

    Every assertion is a relation between what the parser produced and what
    the source file contains, counted independently. A parser that silently
    stops at the first entry produces a plausible, small, entirely wrong
    catalogue, and only a comparison against an independent count catches it.
    """

    def test_every_registry_entry_became_at_least_one_case(self) -> None:
        cases = nomo_data.registry_entries()
        self.assertGreater(len(cases), 0)
        self.assertEqual(nomo_data.unparsed_entries(), ())
        self.assertTrue(all(case["tone"] in {"r0", "r1", "r2", "r3"} for case in cases))

    def test_the_case_count_exceeds_the_operation_count(self) -> None:
        # One operation with several preconditions is the normal shape, so the
        # flattened catalogue is larger than the operation set. An equal count
        # means the parser collapsed preconditions, which loses the answer to
        # the only question the registry exists to answer.
        summary = nomo_data.registry_summary()
        self.assertGreater(summary["cases"], summary["operations"])

    def test_every_local_tool_kept_its_annotation(self) -> None:
        tools = nomo_data.local_tool_schema()
        self.assertEqual(len(tools), 8)
        for tool in tools:
            with self.subTest(tool=tool["name"]):
                self.assertIsInstance(tool["readOnlyHint"], bool)
                self.assertTrue(tool["description"].strip())

    def test_the_snapshot_shipped_with_the_function_matches_this_checkout(self) -> None:
        # The deployed function has no repository, so it serves the snapshot.
        # That is only honest while the snapshot equals the source, and this is
        # what keeps it equal. A stale snapshot fails the gate instead of being
        # published as a current catalogue.
        from appwrite_mcp import snapshot_builder

        self.assertEqual(
            json.dumps(snapshot_builder.build(), sort_keys=True),
            json.dumps(snapshot_builder.committed_snapshot(), sort_keys=True),
            "nomo_snapshot.json is stale; run apps/appwrite-mcp/scripts/generate-snapshot.py",
        )


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
