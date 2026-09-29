"""A fake Appwrite Function context for the hosted MCP endpoint.

The function is exercised through ``handle_http`` exactly the way
``src/main.py`` calls it, with a context built here instead of the Appwrite
runtime. The fake records the single ``res.*`` call the handler made and
returns the shape the runtime returns, so a test can assert on the bytes the
endpoint would put on the wire with no deployment, no domain and no
credential.

Only the Appwrite plumbing is local. The request bytes, the dispatch and the
response bytes are the real ones, so a green run here is evidence about the
hosted code path rather than about this file.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any

from app import server
from appwrite_mcp import handle_http


# Capitalised on purpose. A real client sends `Content-Type`, and the adapter
# lowercases header names itself, so a suite that only ever sent lowercase
# headers would prove nothing about the case handling.
JSON_HEADERS = {"Content-Type": "application/json"}


class FakeRequest:
    """The request half of the Appwrite Function context.

    ``body_text``, ``body`` and ``body_binary`` mirror the three views the
    runtime exposes on one request. The adapter takes ``body_binary`` only when
    it is bytes and otherwise falls back through ``body_text`` to ``body``,
    so a test may hold fields back to exercise that chain.
    """

    def __init__(
        self,
        *,
        method: str = "POST",
        path: str = "/",
        headers: dict[str, str] | None = None,
        text: str = "",
        body: Any = None,
        body_binary: Any = "",
    ) -> None:
        self.method = method
        self.path = path
        self.headers = dict(JSON_HEADERS if headers is None else headers)
        self.scheme = "https"
        self.host = "mcp.invalid"
        self.body_text = text
        self.body = body
        self.body_json = body
        self.body_binary = body_binary


@dataclass
class Response:
    """What the handler handed back through ``context.res``."""

    kind: str
    status: int
    headers: dict[str, str]
    body: bytes

    def text(self) -> str:
        return self.body.decode("utf-8")

    def json(self) -> Any:
        return json.loads(self.text())


class FakeResponse:
    """Records the ``res.*`` call the handler made.

    The runtime serialises whatever a ``res`` method is given, so the fake
    serialises it too. Without that a ``res.json`` call would be compared as a
    dict and a test could pass on a response that never had valid bytes.
    """

    def __init__(self) -> None:
        self.record: Response | None = None

    def _record(self, kind: str, body: Any, status: Any, headers: Any) -> dict[str, Any]:
        if isinstance(body, str):
            payload = body.encode("utf-8")
        elif isinstance(body, (bytes, bytearray)):
            payload = bytes(body)
        else:
            payload = json.dumps(body).encode("utf-8")
        self.record = Response(kind, int(status), dict(headers or {}), payload)
        return {"body": body, "status": status, "headers": headers}

    def text(self, body: str, statusCode: int = 200, headers: Any = None) -> dict[str, Any]:
        return self._record("text", body, statusCode, headers)

    def json(self, body: Any, statusCode: int = 200, headers: Any = None) -> dict[str, Any]:
        return self._record("json", body, statusCode, headers)

    def binary(self, body: Any, statusCode: int = 200, headers: Any = None) -> dict[str, Any]:
        return self._record("binary", body, statusCode, headers)


class FakeContext:
    """The Appwrite Function context the handler receives."""

    def __init__(self, request: FakeRequest) -> None:
        self.req = request
        self.res = FakeResponse()
        self.logs: list[str] = []

    def log(self, message: Any) -> None:
        self.logs.append(str(message))


def invoke(
    payload: Any = None,
    *,
    method: str = "POST",
    path: str = "/",
    headers: dict[str, str] | None = None,
    raw_text: str | None = None,
    body_only: bool = False,
) -> Response:
    """Send one request through ``handle_http`` and return what it answered.

    ``raw_text`` sends bytes no JSON encoder produced, which is how a
    malformed body reaches the endpoint. ``body_only`` publishes the parsed
    dict without the raw text, which is the other end of the adapter's body
    fallback chain.
    """
    if raw_text is None and payload is not None:
        raw_text = json.dumps(payload)
    request = FakeRequest(
        method=method,
        path=path,
        headers=headers,
        text="" if body_only else (raw_text or ""),
        body=payload if body_only else None,
    )
    context = FakeContext(request)
    asyncio.run(handle_http(server, context))
    assert context.res.record is not None, "handle_http answered without a res.* call"
    return context.res.record
