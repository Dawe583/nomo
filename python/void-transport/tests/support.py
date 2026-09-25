"""Shared test support: repo paths and the canonical sample corpus.

The samples live in ``fixtures/canonical_samples.json`` rather than inside one
test because two suites need them: the pure-Python unit tests, and the Node
cross check that has to agree with them byte for byte.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

TESTS_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = TESTS_DIR.parent
REPO_ROOT = PACKAGE_ROOT.parent.parent
FIXTURES_DIR = TESTS_DIR / "fixtures"
CANONICAL_SAMPLES = FIXTURES_DIR / "canonical_samples.json"
CANONICAL_NODE_FIXTURE = FIXTURES_DIR / "canonical_node.mjs"


def load_samples() -> list[tuple[str, Any]]:
    """Return the ``(name, value)`` pairs both runtimes canonicalise.

    The corpus covers every rule ``canonical.ts`` states: keys sorted at
    depth, an empty object, an empty array, Unicode that must stay raw,
    characters that must be escaped, the JavaScript number boundaries at 1e21
    and 1e-7, and nesting past the depth ceiling, which both runtimes must
    refuse rather than seal.
    """
    entries: list[dict[str, Any]] = json.loads(CANONICAL_SAMPLES.read_text("utf-8"))
    return [(entry["name"], entry["value"]) for entry in entries]


def run_node_canonical(samples: list[tuple[str, Any]]) -> list[dict[str, Any]]:
    """Run the real ``packages/ledger/src/canonical.ts`` over ``samples``.

    Returns one record per sample, in the same order. Each record carries the
    canonical text, the ``sha256:<hex>`` digest, the base64 of the exact UTF-8
    bytes, and the error message when the value has no canonical form. A
    missing ``node`` or a fixture failure raises: a cross check that quietly
    skips itself proves nothing.
    """
    # ensure_ascii escapes the lone surrogate in the corpus as \\ud800, which is
    # one of the things both runtimes have to agree about. A raw lone
    # surrogate cannot be written to a pipe as UTF-8 in the first place.
    payload = json.dumps([{"name": name, "value": value} for name, value in samples])
    completed = subprocess.run(
        ["node", str(CANONICAL_NODE_FIXTURE)],
        input=payload.encode("utf-8"),
        capture_output=True,
        cwd=str(REPO_ROOT),
        timeout=120,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(
            "node canonical fixture failed: "
            f"{completed.stderr.decode('utf-8', 'replace')}"
        )
    return json.loads(completed.stdout.decode("utf-8"))
