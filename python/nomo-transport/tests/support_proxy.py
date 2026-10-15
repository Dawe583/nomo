"""Spawning a real local NOMO proxy HTTP endpoint for the integration test.

Two repo processes are started, both real:

* the HTTP endpoint, ``fixtures/nomo_proxy_http.mjs``, which binds the
  repository's own ``createHttpRequestRelay`` to a loopback port;
* behind it, the stdio upstream, ``packages/cli/bin/nomo.mjs recovery serve``,
  which is a real MCP server over a real child process.

That is the whole point: the Python client talks to the production relay code,
which talks to the production MCP server. Nothing in either process is a
stub written for this test.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from typing import Final

REPO_ROOT: Final = Path(__file__).resolve().parent.parent.parent.parent
NOMO_BIN: Final = REPO_ROOT / "packages" / "cli" / "bin" / "nomo.mjs"
HTTP_FIXTURE: Final = Path(__file__).resolve().parent / "fixtures" / "nomo_proxy_http.mjs"

#: The recovery MCP server refuses to start without a key, and the key is read
#: from the environment by name. The value is a throwaway for a temp directory
#: that is deleted with the test; it is not a credential for anything.
_KEY_ENV: Final = "NOMO_TRANSPORT_FIXTURE_KEY"
_FIXTURE_KEY: Final = base64.b64encode(b"nomo-transport-integration-key32").decode()

_ALLOW_ALL_POLICY: Final = (
    "version: 1\n"
    "rules:\n"
    "  - match: {}\n"
    "    decision: allow\n"
    "    rationale: python transport integration fixture\n"
)

_DENY_ALL_POLICY: Final = (
    "version: 1\n"
    "rules:\n"
    "  - match: {}\n"
    "    decision: deny\n"
    "    rationale: python transport integration fixture refuses every call\n"
)

#: A tool that exists on the recovery server and changes nothing when refused.
_READ_ONLY_TOOL: Final = "nomo_recovery_plan"


class ProxyEndpoint:
    """A running proxy HTTP endpoint plus the child MCP server behind it."""

    def __init__(self, policy: str) -> None:
        self._policy = policy
        self._directory: tempfile.TemporaryDirectory[str] | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self.port = 0

    def __enter__(self) -> ProxyEndpoint:
        directory = tempfile.TemporaryDirectory(prefix="nomo-transport-")
        self._directory = directory
        root = Path(directory.name)
        (root / "workspace").mkdir()
        (root / "policy.yaml").write_text(self._policy, encoding="utf-8")
        config = {
            "workspace": "pythontest",
            "stateDir": "./state",
            "encryptionKeyEnv": _KEY_ENV,
            "agentId": "pythontest",
            "policyPath": "./policy.yaml",
            "filesystem": {"root": "./workspace", "cooperative": True},
        }
        config_path = root / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")

        environment = dict(os.environ)
        environment[_KEY_ENV] = _FIXTURE_KEY
        self._process = subprocess.Popen(
            [
                "node",
                str(HTTP_FIXTURE),
                json.dumps(["node", str(NOMO_BIN), "recovery", "serve", "--config", str(config_path)]),
                "0",
            ],
            cwd=str(REPO_ROOT),
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.port = self._await_port()
        return self

    def _await_port(self) -> int:
        assert self._process is not None
        assert self._process.stdout is not None
        announcement: list[str] = []
        read = threading.Thread(
            target=lambda: announcement.append(
                self._process.stdout.readline().decode("utf-8", "replace")  # type: ignore[union-attr]
            ),
            daemon=True,
        )
        read.start()
        read.join(timeout=60)
        if not announcement:
            self._process.kill()
            stderr = b""
            if self._process.stderr is not None:
                stderr = self._process.stderr.read() or b""
            raise unittest.SkipTest(
                "the proxy HTTP fixture did not report a port: "
                + stderr.decode("utf-8", "replace")[-2000:]
            )
        try:
            self.port = int(json.loads(announcement[0])["port"])
        except (ValueError, KeyError, TypeError) as error:
            raise unittest.SkipTest(f"unreadable fixture announcement: {error}") from error
        return self.port

    def __exit__(self, *exc: object) -> None:
        if self._process is not None:
            if self._process.stdin is not None:
                try:
                    self._process.stdin.close()
                except OSError:
                    pass
            try:
                self._process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=10)
            for stream in (self._process.stdout, self._process.stderr):
                if stream is not None:
                    stream.close()
        if self._directory is not None:
            self._directory.cleanup()
