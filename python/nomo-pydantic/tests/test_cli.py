import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TRANSPORT = ROOT / "python" / "nomo-transport"
sys.path[:0] = [str(TRANSPORT / "src"), str(TRANSPORT / "tests")]
from support_proxy import _DENY_ALL_POLICY, ProxyEndpoint


class CliTests(unittest.TestCase):
    def test_harness_cli_uses_real_proxy_and_reports_denial(self):
        with ProxyEndpoint(_DENY_ALL_POLICY) as endpoint:
            request = {
                "tool": "nomo_reconcile",
                "arguments": {"operationId": "op-denied"},
                "idempotency_key": "cli-test-1",
            }
            run = subprocess.run(
                [
                    str(ROOT / "scripts" / "nomo-pydantic.sh"),
                    "--port",
                    str(endpoint.port),
                    "--model",
                    "test",
                    "--allow",
                    "nomo_reconcile",
                ],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                timeout=30,
                check=False,
                env={**os.environ, "PYDANTIC_AI_NO_BANNER": "1"},
            )
            self.assertEqual(run.returncode, 3, run.stderr)
            result = json.loads(run.stdout)
            self.assertEqual(result["status"], "tool_error")
            self.assertIsNone(result["summary"])
            self.assertNotIn("raw_result", result)

    def test_harness_cli_rejects_unallowed_tool_before_contact(self):
        request = {"tool": "delete", "arguments": {}, "idempotency_key": "cli-test-2"}
        run = subprocess.run(
            [
                str(ROOT / "scripts" / "nomo-pydantic.sh"),
                "--port",
                "1",
                "--model",
                "test",
                "--allow",
                "read_status",
            ],
            input=json.dumps(request),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            env={**os.environ, "PYDANTIC_AI_NO_BANNER": "1"},
        )
        self.assertEqual(run.returncode, 2)
        self.assertEqual(json.loads(run.stdout)["status"], "invalid_request")
