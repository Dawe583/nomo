"""The ``MCP_AUTH_MODE`` gate, as ``auth.py`` actually implements it.

``auth.py`` reads two environment variables and returns either ``(True, None)``
or a ``(False, payload)`` pair the transport turns into a JSON-RPC error with
a status. The suite covers the whole decision table rather than the happy
path, because the failure nobody notices is the one where a mode the operator
did not intend silently opens the endpoint or locks it shut with a 500.

Two properties are asserted beyond the status codes. A refusal body must
never carry the configured token or the token the caller presented, since that
body is what a client is shown and what a log line would capture. And the gate
must be decided before the body is parsed, so a request that fails
authentication never reaches the dispatcher.

Every value here is fabricated. No Appwrite credential is read, written or
passed anywhere by this file.
"""

from __future__ import annotations

import contextlib
import json
import os
import unittest
from collections.abc import Iterator

from tests.support_context import invoke

# Long and obviously synthetic, so that a substring search over a refusal body
# means something. A short token would also match unrelated words.
FAKE_TOKEN = "void-unit-test-bearer-token-not-a-secret"
WRONG_TOKEN = "void-unit-test-bearer-token-wrong"

AUTH_VARS = ("MCP_AUTH_MODE", "MCP_AUTH_TOKEN", "MCP_DEBUG")

LIST_TOOLS = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}


@contextlib.contextmanager
def auth_env(**values: str) -> Iterator[None]:
    """Run the block with exactly these auth variables set.

    The three variables are removed first rather than merged, because a
    developer's own shell must not decide whether the default-mode test
    passes, and the block restores whatever was there.
    """
    saved = {name: os.environ.pop(name, None) for name in AUTH_VARS}
    os.environ.update(values)
    try:
        yield
    finally:
        for name in AUTH_VARS:
            os.environ.pop(name, None)
        os.environ.update({k: v for k, v in saved.items() if v is not None})


class OpenModeTest(unittest.TestCase):
    """No token configured means no gate, which is the deployed default."""

    def test_an_endpoint_with_no_auth_variables_answers(self) -> None:
        with auth_env():
            response = invoke(LIST_TOOLS)

        self.assertEqual(response.status, 200)
        self.assertEqual(len(response.json()["result"]["tools"]), 2)

    def test_every_mode_name_that_means_open_answers(self) -> None:
        for mode in ("none", "open", "false", "0", "  NONE  "):
            with self.subTest(mode=mode):
                with auth_env(MCP_AUTH_MODE=mode):
                    response = invoke(LIST_TOOLS)

                self.assertEqual(response.status, 200)


class BearerModeTest(unittest.TestCase):
    """``MCP_AUTH_MODE=bearer`` requires the exact token to be presented."""

    def test_a_request_without_the_token_is_refused(self) -> None:
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=FAKE_TOKEN):
            response = invoke(LIST_TOOLS)

        payload = response.json()
        self.assertEqual(response.status, 401)
        self.assertEqual(response.headers["WWW-Authenticate"], "Bearer")
        self.assertEqual(payload["error"]["code"], -32001)
        self.assertIn("Authorization", payload["error"]["message"])

    def test_a_wrong_token_is_refused(self) -> None:
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=FAKE_TOKEN):
            response = invoke(
                LIST_TOOLS, headers={"Authorization": f"Bearer {WRONG_TOKEN}"}
            )

        payload = response.json()
        self.assertEqual(response.status, 401)
        self.assertEqual(payload["error"]["code"], -32001)
        self.assertIn("Invalid", payload["error"]["message"])

    def test_the_right_token_is_accepted_whatever_the_header_case(self) -> None:
        # A real client sends `Authorization`, and the transport lowercases
        # header names before the gate sees them.
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=FAKE_TOKEN):
            response = invoke(
                LIST_TOOLS, headers={"Authorization": f"Bearer {FAKE_TOKEN}"}
            )

        self.assertEqual(response.status, 200)

    def test_a_refusal_carries_neither_token(self) -> None:
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=FAKE_TOKEN):
            missing = invoke(LIST_TOOLS)
            wrong = invoke(
                LIST_TOOLS, headers={"Authorization": f"Bearer {WRONG_TOKEN}"}
            )

        for response in (missing, wrong):
            body = response.text()
            with self.subTest(status=response.status):
                self.assertNotIn(FAKE_TOKEN, body)
                self.assertNotIn(WRONG_TOKEN, body)
                # A refused request must not leak the catalogue either.
                self.assertNotIn("void_project_info", body)

    def test_bearer_mode_without_a_configured_token_fails_loudly(self) -> None:
        # Silently accepting would be the dangerous reading of a blank token.
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=""):
            response = invoke(LIST_TOOLS)

        payload = response.json()
        self.assertEqual(response.status, 500)
        self.assertEqual(payload["error"]["code"], -32000)
        self.assertIn("MCP_AUTH_TOKEN", payload["error"]["message"])


class AuthBeforeDispatchTest(unittest.TestCase):
    """The gate is decided before the body is looked at."""

    def test_an_unauthenticated_malformed_request_is_refused_not_parsed(self) -> None:
        with auth_env(MCP_AUTH_MODE="bearer", MCP_AUTH_TOKEN=FAKE_TOKEN):
            response = invoke(raw_text="{not json")

        self.assertEqual(response.status, 401)
        self.assertEqual(response.json()["error"]["code"], -32001)


class MisconfiguredModeTest(unittest.TestCase):
    """A mode nobody implemented is an operator error, reported as one."""

    def test_an_unknown_mode_is_refused_with_the_offending_value(self) -> None:
        with auth_env(MCP_AUTH_MODE="sideways"):
            response = invoke(LIST_TOOLS)

        payload = response.json()
        self.assertEqual(response.status, 500)
        self.assertEqual(payload["error"]["code"], -32000)
        self.assertIn("sideways", payload["error"]["message"])

    def test_the_mode_error_body_is_a_json_rpc_envelope(self) -> None:
        with auth_env(MCP_AUTH_MODE="sideways", MCP_AUTH_TOKEN=FAKE_TOKEN):
            response = invoke(LIST_TOOLS)

        payload = json.loads(response.text())
        self.assertEqual(payload["jsonrpc"], "2.0")
        self.assertIsNone(payload["id"])
        self.assertNotIn(FAKE_TOKEN, response.text())
