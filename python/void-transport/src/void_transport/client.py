"""A fail-closed Python client for the VOID proxy HTTP transport.

The wire this speaks is the one in ``packages/proxy/src/transport/http.ts``:
JSON-RPC 2.0 over HTTP ``POST`` to one explicit ``host:port``, with
``accept: application/json, text/event-stream`` and an ``mcp-session-id``
carried forward once the server hands one out. The server side of the same
protocol is ``packages/proxy/src/relay/http-requests.ts``.

Three rules shape every method here, and all three come from the Swift client
in ``CompanionHTTPClient.swift``:

* **The response must be the response.** A reply whose ``id`` is not the id
  that was sent is refused, even though it is otherwise well formed. So is a
  string id where a number was sent: the proxy allocates numeric upstream ids
  and never coerces a lookalike.
* **Bounded or nothing.** A response larger than the configured limit is
  refused without being parsed, using the declared ``Content-Length`` when
  there is one and a hard read cap when there is not.
* **Unknown shape is an error.** No "best effort" parse of a message that is
  not a JSON-RPC response, no falling back to a substring of the body.

There is no silent retry anywhere in this module. A POST whose outcome is
unknown has to be reconciled by the caller, exactly as ``transport/http.ts``
reports "outcome unknown after deadline; reconcile before retry".
"""

from __future__ import annotations

import http.client
import json
import os
import re
import secrets
import threading
from dataclasses import dataclass, field
from typing import Any, Final

from .errors import HoldDeniedError, VoidTransportError

__all__ = [
    "DEFAULT_MAX_REQUEST_BYTES",
    "DEFAULT_MAX_RESPONSE_BYTES",
    "PROTOCOL_VERSION",
    "PendingCall",
    "ServerInfo",
    "ToolSummary",
    "VoidTransportClient",
]

#: Same ceilings the Swift client publishes. A tool argument is small; a
#: megabyte of "tool result" is somebody else's bug or an attack.
DEFAULT_MAX_REQUEST_BYTES: Final = 65_536
DEFAULT_MAX_RESPONSE_BYTES: Final = 1_048_576

#: Newest first, matching ``SUPPORTED_PROTOCOL_VERSIONS`` in
#: ``packages/proxy/src/session.ts``. A server that answers a version this
#: client does not know is an unknown shape.
PROTOCOL_VERSION: Final = "2025-11-25"
_SUPPORTED_PROTOCOL_VERSIONS: Final = frozenset(
    {"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"}
)

_ACCEPT: Final = "application/json, text/event-stream"
_SESSION_HEADER: Final = "mcp-session-id"
#: Read granularity. Small enough that a hostile body cannot make the client
#: buffer a megabyte before the cap is checked.
_READ_CHUNK: Final = 8192
#: The bounded-identifier rule the Swift client and the workbench server share:
#: non-empty, at most 160 characters, no control characters, no path separators.
_MAX_ID_LENGTH: Final = 160
#: The key rule the workbench and control-plane servers enforce.
_IDEMPOTENCY_PATTERN: Final = re.compile(r"\A[A-Za-z0-9_.:-]{1,160}\Z")
_ENV_NAME_PATTERN: Final = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*\Z")
_HOLD_DENIAL_RESULTS: Final = frozenset({"denied", "expired"})


def _is_bounded_id(value: Any) -> bool:
    """The bounded-identifier predicate shared with the Swift client."""
    if not isinstance(value, str) or not value or len(value) > _MAX_ID_LENGTH:
        return False
    return all(
        point >= 0x20 and point != 0x7F and character not in "/\\"
        for character, point in ((character, ord(character)) for character in value)
    )


def _is_method_name(value: Any) -> bool:
    """Bounded and printable, but a method name may contain a slash.

    The MCP method namespace is literally ``tools/list``, so the Swift
    identifier rule -- which bans path separators because those appear in
    identifiers that get used as path segments -- is the wrong predicate here.
    The control-character ban still applies: a method name goes into a log line
    and onto the wire.
    """
    if not isinstance(value, str) or not value or len(value) > _MAX_ID_LENGTH:
        return False
    return all(point >= 0x20 and point != 0x7F for point in map(ord, value))


@dataclass(frozen=True, slots=True)
class ServerInfo:
    """The ``serverInfo`` a VOID proxy reported during ``initialize``."""

    name: str
    version: str
    protocol_version: str


@dataclass(frozen=True, slots=True)
class ToolSummary:
    """One entry of a ``tools/list`` answer."""

    name: str
    description: str
    input_schema: Any


@dataclass(slots=True)
class PendingCall:
    """A ``tools/call`` on the wire, and the hold id it is filed under.

    ``hold_id`` is a correlation token this client mints, not an id the proxy
    hands out: the HTTP transport exposes no hold identifier on the wire, so
    there is nothing else a caller could pass to
    :meth:`VoidTransportClient.await_hold`. The token is a handle for the
    in-flight call, and the error it eventually raises is still mapped from the
    server's own body.
    """

    hold_id: str
    tool: str
    idempotency_key: str
    _done: threading.Event = field(default_factory=threading.Event)
    _value: Any = None
    _error: BaseException | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _settle(self, value: Any, error: BaseException | None) -> None:
        with self._lock:
            self._value = value
            self._error = error
        self._done.set()

    def done(self) -> bool:
        return self._done.is_set()

    def wait(self, timeout: float | None = None) -> Any:
        """Block until the call settles, then return its result or raise."""
        if not self._done.wait(timeout):
            raise VoidTransportError(
                f"hold {self.hold_id} for {self.tool} did not settle within {timeout}s"
            )
        with self._lock:
            if self._error is not None:
                raise self._error
            return self._value


class VoidTransportClient:
    """Speaks the VOID proxy HTTP transport over an explicit ``host:port``.

    The endpoint is two separate arguments on purpose. Nothing here parses a
    URL, so there is no scheme to read credentials out of, no authority to be
    redirected to, and no default port to guess. ``path`` is the only other
    piece of the endpoint and it is validated as a path, never as a URL.

    ``token_env`` is the *name* of an environment variable, not a token. The
    value is read at send time and never stored on the instance, never
    included in ``repr``, and never written anywhere: this package has no
    logging at all. An unset or empty variable is a refusal before the socket
    is touched, because a request that goes out unauthenticated is a request
    the server was entitled to see.

    Each request opens its own :class:`http.client.HTTPConnection` on a worker
    thread, because a held call does not come back until a human decides and
    the caller needs to keep running. ``http.client`` reads no proxy
    environment variables and follows no redirect, so a connection reaches
    exactly the host and port given here.
    """

    def __init__(
        self,
        host: str,
        port: int,
        path: str = "/mcp",
        *,
        token_env: str | None = None,
        max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
        max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
        timeout: float = 30.0,
    ) -> None:
        if not isinstance(host, str) or not host or host != host.strip():
            raise VoidTransportError("host must be a non-empty stripped string")
        if any(character in host for character in " \t\r\n/?#@"):
            raise VoidTransportError(
                "host must be a bare hostname or address, not a URL or a path"
            )
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise VoidTransportError("port must be an integer between 1 and 65535")
        if not isinstance(path, str) or not path.startswith("/") or len(path) > 2048:
            raise VoidTransportError(
                "path must be an absolute path of at most 2048 characters"
            )
        if (
            any(character in path for character in " \t\r\n?#")
            or ".." in path.split("/")
        ):
            raise VoidTransportError(
                "path must not carry a query, a space or a parent segment"
            )
        if (
            isinstance(max_request_bytes, bool)
            or not isinstance(max_request_bytes, int)
            or max_request_bytes < 1
        ):
            raise VoidTransportError("max_request_bytes must be a positive integer")
        if (
            isinstance(max_response_bytes, bool)
            or not isinstance(max_response_bytes, int)
            or max_response_bytes < 1
        ):
            raise VoidTransportError("max_response_bytes must be a positive integer")
        if (
            isinstance(timeout, bool)
            or not isinstance(timeout, (int, float))
            or timeout <= 0
        ):
            raise VoidTransportError("timeout must be a positive number of seconds")
        if token_env is not None and (
            not isinstance(token_env, str)
            or _ENV_NAME_PATTERN.match(token_env) is None
        ):
            raise VoidTransportError("token_env must be an environment variable name")
        self._host = host
        self._port = port
        self._path = path
        self._token_env = token_env
        self._max_request_bytes = max_request_bytes
        self._max_response_bytes = max_response_bytes
        self._timeout = float(timeout)
        self._handshake: ServerInfo | None = None
        self._session_id: str | None = None
        self._next_request_id = 1
        self._closed = False
        self._lock = threading.Lock()
        self._holds: dict[str, PendingCall] = {}
        self._workers: list[threading.Thread] = []
        # A configured but unusable token is refused at construction, not at
        # the first send: a client that cannot authenticate should not exist.
        self._require_token()

    def __repr__(self) -> str:
        # The token is an environment variable name, so there is no secret to
        # leak here, but the endpoint is still operator detail and the address
        # is all a caller needs.
        return (
            f"{type(self).__name__}(host={self._host!r}, port={self._port}, "
            f"path={self._path!r}, token_env={self._token_env!r})"
        )

    @property
    def handshake(self) -> ServerInfo:
        """What the proxy reported during ``initialize``.

        Raises when the handshake has not run: a caller that reads this before
        ``initialize`` has no negotiated protocol version and no server
        identity, and inventing a default would be a guess about a peer.
        """
        if self._handshake is None:
            raise VoidTransportError("initialize has not completed on this client")
        return self._handshake

    @property
    def session_id(self) -> str | None:
        """The ``mcp-session-id`` the server handed out, if it has."""
        return self._session_id

    @property
    def pending_holds(self) -> tuple[str, ...]:
        """The hold ids of calls that are still on the wire."""
        with self._lock:
            return tuple(
                hold_id for hold_id, call in self._holds.items() if not call.done()
            )

    # ----------------------------------------------------------------- calls

    def initialize(self) -> ServerInfo:
        """Run the MCP handshake and return the proxy's identity.

        Sends ``initialize``, validates the answer against the shape the
        protocol fixes, then sends ``notifications/initialized``. A version
        this client does not know, a missing ``serverInfo`` or a body that is
        not a JSON-RPC response is refused rather than tolerated.
        """
        self._ensure_open()
        result = self._request(
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "void-transport", "version": "0.1.0"},
            },
        )
        if not isinstance(result, dict):
            raise VoidTransportError("initialize result is not an object")
        version = result.get("protocolVersion")
        if not isinstance(version, str) or version not in _SUPPORTED_PROTOCOL_VERSIONS:
            raise VoidTransportError(
                f"proxy answered an unsupported protocol version: {version!r}"
            )
        if not isinstance(result.get("capabilities"), dict):
            raise VoidTransportError("initialize result carries no capabilities object")
        info = result.get("serverInfo")
        if not isinstance(info, dict):
            raise VoidTransportError("initialize result carries no serverInfo object")
        name = info.get("name")
        reported = info.get("version")
        if not isinstance(name, str) or not name or not isinstance(reported, str):
            raise VoidTransportError("serverInfo must carry a string name and version")
        self._notify("notifications/initialized")
        self._handshake = ServerInfo(
            name=name, version=reported, protocol_version=version
        )
        return self._handshake

    def list_tools(self) -> tuple[ToolSummary, ...]:
        """Return the tool list the proxy publishes, in server order."""
        self._ensure_open()
        result = self._request("tools/list", {})
        if not isinstance(result, dict) or not isinstance(result.get("tools"), list):
            raise VoidTransportError("tools/list result carries no tools array")
        summaries: list[ToolSummary] = []
        for entry in result["tools"]:
            if not isinstance(entry, dict):
                raise VoidTransportError("tools/list returned a non-object tool entry")
            name = entry.get("name")
            if not _is_bounded_id(name):
                raise VoidTransportError(
                    f"tools/list returned an unusable tool name: {name!r}"
                )
            description = entry.get("description", "")
            if not isinstance(description, str):
                raise VoidTransportError(f"tool {name} has a non-string description")
            schema = entry.get("inputSchema")
            if schema is not None and not isinstance(schema, dict):
                raise VoidTransportError(f"tool {name} has a non-object input schema")
            summaries.append(
                ToolSummary(name=name, description=description, input_schema=schema)
            )
        return tuple(summaries)

    def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> PendingCall:
        """Start a ``tools/call`` and return the handle it is filed under.

        Every argument is checked *before* anything is sent. A mutating call
        without an idempotency key is not retryable, and a client that
        discovers that after the POST has already created a second,
        unreconciled attempt is worse than one that refuses to send. The key
        rides in ``params._meta.idempotencyKey``, the passthrough namespace the
        proxy already forwards: ``remapMetaToken`` in ``session.ts`` spreads
        ``_meta`` rather than replacing it.

        The call runs on a worker thread, because a held call does not come
        back until a human decides. :meth:`await_hold` is how the caller waits
        for it.
        """
        self._ensure_open()
        if not _is_bounded_id(name):
            raise VoidTransportError(f"tool name is not a bounded identifier: {name!r}")
        if arguments is not None and not isinstance(arguments, dict):
            raise VoidTransportError("tool arguments must be an object")
        if idempotency_key is None:
            raise VoidTransportError(
                "call_tool requires an idempotency key; a mutating call without one "
                "cannot be retried or reconciled"
            )
        if _IDEMPOTENCY_PATTERN.match(idempotency_key) is None:
            raise VoidTransportError(
                "idempotency key must be 1 to 160 characters of [A-Za-z0-9_.:-]"
            )
        self._require_token()
        params: dict[str, Any] = {
            "name": name,
            "arguments": {} if arguments is None else arguments,
            "_meta": {"idempotencyKey": idempotency_key},
        }
        # Encoded here, not on the worker, so a refusal lands on the caller's
        # own stack and no thread is started for a request that cannot go.
        request_id, body = self._encode("tools/call", params)
        hold_id = f"hold-{secrets.token_hex(8)}"
        call = PendingCall(hold_id=hold_id, tool=name, idempotency_key=idempotency_key)
        with self._lock:
            self._holds[hold_id] = call
            worker = threading.Thread(
                target=self._run_call,
                args=(call, request_id, body),
                name=f"void-transport-{hold_id}",
                daemon=True,
            )
            self._workers.append(worker)
        worker.start()
        return call

    def await_hold(self, hold_id: str, timeout: float | None = None) -> Any:
        """Block until the call filed under ``hold_id`` settles.

        Returns the ``result`` of the original ``tools/call`` or raises the
        error that call produced, including a
        :class:`~void_transport.errors.HoldDeniedError` when the proxy refused
        the call after a hold. An unknown hold id is refused immediately
        rather than waited on: a typo that blocks until a timeout hides the
        mistake.
        """
        if not isinstance(hold_id, str) or not hold_id:
            raise VoidTransportError("hold id must be a non-empty string")
        with self._lock:
            call = self._holds.get(hold_id)
        if call is None:
            raise VoidTransportError(f"unknown hold: {hold_id}")
        return call.wait(timeout)

    def close(self) -> None:
        """Refuse further work and fail every call still on the wire.

        Each request owns its connection and closes it in a ``finally``, so
        there is no pool to drain. A pending call is failed with a refusal that
        says the outcome is unknown, because this client does not retry.
        """
        with self._lock:
            self._closed = True
            pending = list(self._holds.values())
            workers = list(self._workers)
        for call in pending:
            if not call.done():
                call._settle(
                    None,
                    VoidTransportError(
                        f"client closed before hold {call.hold_id} for {call.tool} "
                        "settled; outcome unknown, reconcile before retrying"
                    ),
                )
        for worker in workers:
            worker.join(timeout=min(self._timeout, 1.0))

    # ------------------------------------------------------------- internals

    def _ensure_open(self) -> None:
        with self._lock:
            closed = self._closed
        if closed:
            raise VoidTransportError("client is closed")

    def _run_call(self, call: PendingCall, request_id: int, body: bytes) -> None:
        try:
            _status, response_headers, payload = self._post(body, expect_body=True)
            self._remember_session(response_headers)
            message = self._single_response(payload, response_headers, request_id)
            call._settle(self._unpack(message, request_id), None)
        except BaseException as error:  # noqa: BLE001 - handed to the caller verbatim
            call._settle(None, error)

    def _require_token(self) -> None:
        """Refuse when a configured token variable is missing or unusable."""
        self._authorization()

    def _authorization(self) -> str | None:
        if self._token_env is None:
            return None
        token = os.environ.get(self._token_env)
        if token is None or not token:
            raise VoidTransportError(
                f"authentication environment variable {self._token_env} is unset or empty"
            )
        if any(character in token for character in "\r\n\x00"):
            # A header injection here would let the environment, not the
            # operator, choose what the proxy sees.
            raise VoidTransportError(
                f"token in {self._token_env} contains a character that cannot be sent "
                "in a header"
            )
        return f"Bearer {token}"

    def _headers(self) -> dict[str, str]:
        headers = {"content-type": "application/json", "accept": _ACCEPT}
        if self._session_id is not None:
            headers[_SESSION_HEADER] = self._session_id
        authorization = self._authorization()
        if authorization is not None:
            headers["authorization"] = authorization
        return headers

    def _encode(
        self, method: str, params: dict[str, Any], request_id: int | None = None
    ) -> tuple[int, bytes]:
        """Validate a request and return ``(id, body)`` without sending it.

        Every refusal that has to happen before the socket is open lives here,
        which is why ``call_tool`` runs this on the calling thread rather than
        on its worker: an oversize body or an unusable id is caught while the
        caller still has a stack trace that points at their own call.
        """
        if not _is_method_name(method):
            raise VoidTransportError(f"JSON-RPC method name is unusable: {method!r}")
        with self._lock:
            if request_id is None:
                request_id = self._next_request_id
                self._next_request_id += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        if len(body) > self._max_request_bytes:
            raise VoidTransportError(
                f"request body is {len(body)} bytes, over the "
                f"{self._max_request_bytes} byte limit"
            )
        return request_id, body

    def _request(
        self, method: str, params: dict[str, Any], request_id: int | None = None
    ) -> Any:
        expected_id, body = self._encode(method, params, request_id)
        _status, response_headers, payload = self._post(body, expect_body=True)
        self._remember_session(response_headers)
        return self._unpack(
            self._single_response(payload, response_headers, expected_id), expected_id
        )

    def _notify(self, method: str) -> None:
        if not _is_method_name(method):
            raise VoidTransportError(
                f"notification name is unusable: {method!r}"
            )
        body = json.dumps(
            {"jsonrpc": "2.0", "method": method}, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        if len(body) > self._max_request_bytes:
            raise VoidTransportError(
                f"notification body is {len(body)} bytes, over the "
                f"{self._max_request_bytes} byte limit"
            )
        self._post(body, expect_body=False)

    def _post(self, body: bytes, expect_body: bool) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection(
            self._host, self._port, timeout=self._timeout
        )
        try:
            connection.request("POST", self._path, body=body, headers=self._headers())
            response = connection.getresponse()
            status = response.status
            headers = {key.lower(): value for key, value in response.getheaders()}
            if 300 <= status < 400:
                # http.client follows no redirect, and following one would move
                # the bearer token to a host nobody configured.
                raise VoidTransportError(
                    f"proxy answered {status} with a redirect; this client does not "
                    "follow one"
                )
            if not expect_body:
                response.read(0)
                return status, headers, b""
            if status in (401, 403):
                raise VoidTransportError(
                    f"proxy refused the request with {status}; check the token named by "
                    f"{self._token_env or 'this client'}"
                )
            if status != 200:
                raise VoidTransportError(f"proxy answered HTTP {status}")
            return status, headers, self._read_bounded(response, headers)
        except VoidTransportError:
            raise
        except (OSError, http.client.HTTPException) as error:
            # A connection that died mid-POST has an unknown outcome. Say so
            # instead of retrying; the caller reconciles.
            raise VoidTransportError(
                f"transport failure talking to {self._host}:{self._port}: {error}"
            ) from error
        finally:
            connection.close()

    def _read_bounded(
        self, response: http.client.HTTPResponse, headers: dict[str, str]
    ) -> bytes:
        declared = headers.get("content-length")
        if declared is not None:
            try:
                length = int(declared)
            except ValueError as error:
                raise VoidTransportError(
                    f"proxy sent an unparsable Content-Length: {declared!r}"
                ) from error
            if length < 0:
                raise VoidTransportError("proxy sent a negative Content-Length")
            if length > self._max_response_bytes:
                # Refused on the declared length, before a byte is buffered.
                raise VoidTransportError(
                    f"response declares {length} bytes, over the "
                    f"{self._max_response_bytes} byte limit"
                )
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = response.read(
                min(_READ_CHUNK, self._max_response_bytes - total + 1)
            )
            if not chunk:
                break
            total += len(chunk)
            if total > self._max_response_bytes:
                raise VoidTransportError(
                    f"response exceeded the {self._max_response_bytes} byte limit"
                )
            chunks.append(chunk)
        return b"".join(chunks)

    def _remember_session(self, headers: dict[str, str]) -> None:
        session = headers.get(_SESSION_HEADER)
        if session:
            self._session_id = session

    def _single_response(
        self, payload: bytes, headers: dict[str, str], expected_id: int
    ) -> dict[str, Any]:
        content_type = headers.get("content-type", "").lower()
        if "text/event-stream" in content_type:
            found = self._from_event_stream(payload, expected_id)
            if found is None:
                raise VoidTransportError(
                    f"event stream carried no response for request id {expected_id}"
                )
            return found
        if not payload.strip():
            raise VoidTransportError("proxy returned an empty body for a request")
        try:
            message = json.loads(payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise VoidTransportError(f"proxy returned malformed JSON: {error}") from error
        if isinstance(message, list):
            raise VoidTransportError("proxy returned a batch; this client sends one request")
        if not isinstance(message, dict):
            raise VoidTransportError("proxy returned a JSON value that is not an object")
        return message

    def _from_event_stream(
        self, payload: bytes, expected_id: int
    ) -> dict[str, Any] | None:
        """Pick the response for ``expected_id`` out of an SSE body.

        Framing follows ``readSse`` in ``transport/http.ts``: ``data:`` lines
        accumulate and a blank line flushes them joined by newlines. A frame
        that answers a *different* id is a scope mismatch and refuses the whole
        response, rather than being skipped in favour of a later matching one.
        """
        text = payload.decode("utf-8", "replace")
        frames: list[dict[str, Any]] = []
        for block in text.replace("\r\n", "\n").split("\n\n"):
            data = [
                line[5:].lstrip(" ") if line.startswith("data:") else None
                for line in block.split("\n")
                if line.startswith("data:")
            ]
            if not data:
                continue
            joined = "\n".join(data)
            if not joined.strip():
                continue
            try:
                message = json.loads(joined)
            except json.JSONDecodeError as error:
                raise VoidTransportError(
                    f"proxy sent a malformed event frame: {error}"
                ) from error
            if not isinstance(message, dict):
                raise VoidTransportError("event stream carried a non-object frame")
            if "method" in message and "id" not in message:
                # A server notification, progress for instance. The proxy
                # forwards those; they are not an answer to this request.
                continue
            frames.append(message)
        for message in frames:
            identifier = message.get("id")
            if isinstance(identifier, bool) or not isinstance(identifier, int):
                raise VoidTransportError(
                    f"response id {identifier!r} is not the numeric id that was sent"
                )
            if identifier != expected_id:
                raise VoidTransportError(
                    f"response answers id {identifier}, not the {expected_id} that was sent"
                )
            return message
        return None

    def _unpack(self, message: dict[str, Any], expected_id: int) -> Any:
        if message.get("jsonrpc") != "2.0":
            raise VoidTransportError("response does not declare jsonrpc 2.0")
        identifier = message.get("id")
        if identifier is None:
            raise VoidTransportError("response carries no id")
        if isinstance(identifier, bool) or not isinstance(identifier, int):
            raise VoidTransportError(f"response id {identifier!r} is not numeric")
        if identifier != expected_id:
            raise VoidTransportError(
                f"response answers id {identifier}, not the {expected_id} that was sent"
            )
        has_result = "result" in message
        has_error = "error" in message
        if has_result == has_error:
            raise VoidTransportError("response must carry exactly one of result or error")
        if has_result:
            return message["result"]
        raise self._mapped_error(message)

    def _mapped_error(self, message: dict[str, Any]) -> BaseException:
        body = message["error"]
        if not isinstance(body, dict):
            return VoidTransportError("response error is not an object")
        text = body.get("message")
        if not isinstance(text, str) or not text:
            return VoidTransportError("response error carries no message")
        data = body.get("data")
        if isinstance(data, dict) and data.get("result") in _HOLD_DENIAL_RESULTS:
            return HoldDeniedError(text, hold_id=None, data=data)
        return VoidTransportError(text)
