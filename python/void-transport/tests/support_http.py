"""A scripted HTTP server for the client unit tests.

The point of these tests is what the client does with a *hostile or wrong*
body, so the server has to be able to send exactly what a test asks for:
a chosen status, chosen headers, and a body built byte by byte rather than
through a JSON encoder that would repair the mistake under test.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

#: One canned answer. ``body`` is raw bytes on purpose: several cases need a
#: body that is not valid JSON at all, or a Content-Length that lies.
@dataclass(slots=True)
class ScriptedReply:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


@dataclass(slots=True)
class RecordedRequest:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        import json

        return json.loads(self.body)


Handler = Callable[[RecordedRequest], ScriptedReply]


class ScriptedServer:
    """A loopback HTTP server that answers from a per-request handler.

    One request is answered per POST. The handler runs on the server thread,
    so a test that needs to stall a response (a held call) can block there
    and release it with an event.
    """

    def __init__(self, handler: Handler) -> None:
        self.requests: list[RecordedRequest] = []
        self._handler = handler
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def __enter__(self) -> ScriptedServer:
        owner = self

        class _Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args: object) -> None:
                # The suite is not a place for request logs.
                return
            def handle_one_request(self) -> None:
                # A case under test closes the connection mid-answer on
                # purpose. The resulting reset is the expected outcome, not a
                # suite failure, so the server must not print a traceback.
                try:
                    super().handle_one_request()
                except (ConnectionResetError, BrokenPipeError):
                    self.close_connection = True


            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                length = int(self.headers.get("content-length", "0"))
                record = RecordedRequest(
                    method=self.command,
                    path=self.path,
                    headers={key.lower(): value for key, value in self.headers.items()},
                    body=self.rfile.read(length),
                )
                owner.requests.append(record)
                reply = owner._handler(record)
                self.send_response(reply.status)
                for key, value in reply.headers.items():
                    self.send_header(key, value)
                self.send_header("content-length", str(len(reply.body)))
                self.end_headers()
                if reply.body:
                    self.wfile.write(reply.body)

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
                self.send_response(405)
                self.send_header("allow", "POST")
                self.send_header("content-length", "0")
                self.end_headers()

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._thread = threading.Thread(
            target=self._server.serve_forever, name="scripted-http", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        assert self._server is not None
        self._server.shutdown()
        self._server.server_close()
        assert self._thread is not None
        self._thread.join(timeout=5)

    @property
    def host(self) -> str:
        assert self._server is not None
        return "127.0.0.1"

    @property
    def port(self) -> int:
        assert self._server is not None
        return int(self._server.server_address[1])


def json_reply(payload: Any, status: int = 200, **headers: str) -> ScriptedReply:
    """A reply whose body is exactly ``json.dumps(payload)``."""
    import json

    merged = {"content-type": "application/json"}
    merged.update(headers)
    return ScriptedReply(
        status=status,
        headers=merged,
        body=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
    )


def sse_reply(frames: list[str], status: int = 200, **headers: str) -> ScriptedReply:
    """A reply framed as one SSE event per entry of ``frames``."""
    merged = {"content-type": "text/event-stream", "cache-control": "no-cache"}
    merged.update(headers)
    body = "".join(f"data: {frame}\n\n" for frame in frames).encode("utf-8")
    return ScriptedReply(status=status, headers=merged, body=body)
