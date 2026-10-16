"""Does the hosted function work from the tarball alone, with no repository?

This is the question the offline suite cannot answer. Every test in
``apps/appwrite-mcp/tests`` runs from a checkout, so ``nomo_data`` reads
``packages/registry/src/registry.ts`` through a relative path that exists. A
deployed function receives a tarball: no ``packages/``, no registry, no CLI. If
the snapshot fallback is broken, every tool returns an empty catalogue and the
offline suite stays green.

So this extracts the deploy tarball into a scratch directory that has no
repository in it, puts that directory first on ``sys.path``, and asks the tools
the questions a client would. The two lines that matter are ``source reachable``
,  which must be ``False`` ,  and the row count that follows it, which must come
from the snapshot rather than from a file that is not there.

Run it from the repository root:

    /tmp/nomo-mcp-venv/bin/python apps/appwrite-mcp/scripts/verify-deploy-shape.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
FUNCTION = ROOT / "appwrite-mcp"

# What the snapshot must contain, from `docs/APPWRITE-HOSTED-MCP.md`. These are
# the numbers a reader would check the catalogue against, so a snapshot that
# silently lost a family of rows has to fail here rather than in production.
EXPECTED = {
    "operations": 268,
    "cases": 491,
    "local_tools": 8,
    "cli_commands": 20,
}

PROBE = """
import json
import sys
import time

# `main.py` puts `src/` on the path before importing anything, and so does the
# probe, by the same route: a relative path from the working directory the
# subprocess was given. An absolute path derived from `__file__` would be a
# different route that happens to work here, and this probe exists precisely to
# exercise the deployed one.
sys.path.insert(0, "src")

started = time.time()
from app import (  # noqa: E402
    nomo_cli_commands,
    nomo_local_tools,
    nomo_project_info,
    nomo_registry_entry,
    nomo_registry_search,
    nomo_registry_summary,
)
from appwrite_mcp import nomo_data  # noqa: E402

print("import_ms", round((time.time() - started) * 1000, 1))
print("source_reachable", nomo_data.REGISTRY_SOURCE.exists())
print("cli_dispatch_reachable", nomo_data.CLI_DISPATCH.exists())

summary = nomo_data.registry_summary()
print("summary", json.dumps({
    "operations": summary["operations"],
    "cases": summary["cases"],
    "vendors": summary["vendors"],
    "surfaces": summary["surfaces"],
    "unparsed": summary["unparsed"],
    "version": summary["version"],
}))
print("cli_commands", len(nomo_data.cli_commands()))
print("local_tools", len(nomo_data.local_tool_schema()))

# Every tool has to answer, not merely import.
print("project_info", "NOMO" in nomo_project_info())
print("summary_tool", "operations" in nomo_registry_summary())
print("cli_tool", "replay" in nomo_cli_commands())
print("local_tool", "nomo_execute" in nomo_local_tools())
found = nomo_registry_entry("aws.s3.object.put")
print("entry_tool", '"found": true' in found or '"found":true' in found)
search = nomo_registry_search(tone="r3", limit=2)
print("search_tool", '"tone": "r3"' in search or '"tone":"r3"' in search)
"""


def main() -> int:
    tarball = Path(tempfile.gettempdir()) / "nomo-mcp-deploy-shape.tar.gz"
    collected = [
        path
        for path in sorted(FUNCTION.rglob("*"))
        if not path.is_dir() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    ]
    if not collected:
        print(f"no files under {FUNCTION}; the probe would extract an empty tree", file=sys.stderr)
        return 1
    with tarfile.open(tarball, "w:gz") as archive:
        for path in collected:
            archive.add(path, arcname=path.relative_to(FUNCTION))

    scratch = Path(tempfile.mkdtemp(prefix="nomo-mcp-deployed-"))
    try:
        with tarfile.open(tarball) as archive:
            members = archive.getnames()
            archive.extractall(scratch, filter="data")
        print(f"tarball: {len(members)} members; extracted: {sorted(p.name for p in scratch.iterdir())}")
        # The point of the exercise: no repository anywhere above the scratch
        # directory, so a relative path out of the package cannot find one.
        if (scratch / "packages").exists():
            print("scratch directory contains a repository, which invalidates the probe")
            return 1

        (scratch / "probe.py").write_text(PROBE, encoding="utf-8")
        # `main.py` puts `src/` on the path before importing anything, so the
        # probe has to do the same. Without this the import fails for a reason
        # that has nothing to do with what the probe is checking.
        environment = {**os.environ, "PYTHONPATH": str(scratch / "src")}
        result = subprocess.run(
            [sys.executable, "probe.py"],
            cwd=scratch,
            capture_output=True,
            text=True,
            timeout=60,
            env=environment,
        )
        if result.returncode != 0:
            # The scratch contents are the first thing worth seeing: a probe that
            # cannot import is almost always a layout problem, not a logic one.
            print("scratch contents:", sorted(p.name for p in scratch.iterdir()))
            print("src contents:", sorted(p.name for p in (scratch / "src").iterdir()) if (scratch / "src").exists() else "NO src DIRECTORY")
            print("probe.py first line:", (scratch / "probe.py").read_text().splitlines()[0])
            print("interpreter:", sys.executable)
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            return 1

        observed: dict[str, str] = {}
        for line in result.stdout.splitlines():
            key, _, value = line.partition(" ")
            observed[key] = value

        failures: list[str] = []
        if observed.get("source_reachable") != "False":
            failures.append(
                f"the function could still reach the source tree, so this probe proves nothing "
                f"(source_reachable={observed.get('source_reachable')})"
            )
        if observed.get("cli_dispatch_reachable") != "False":
            failures.append("the CLI dispatcher was reachable from the deployed shape")

        summary = json.loads(observed.get("summary", "{}"))
        for key, expected in (
            ("operations", EXPECTED["operations"]),
            ("cases", EXPECTED["cases"]),
        ):
            if summary.get(key) != expected:
                failures.append(f"{key} is {summary.get(key)}, expected {expected}")
        if summary.get("unparsed") != 0:
            failures.append(f"{summary.get('unparsed')} registry entries did not parse")
        if not summary.get("version"):
            failures.append("the snapshot carries no registry version")

        if observed.get("cli_commands") != str(EXPECTED["cli_commands"]):
            failures.append(f"cli_commands is {observed.get('cli_commands')}")
        if observed.get("local_tools") != str(EXPECTED["local_tools"]):
            failures.append(f"local_tools is {observed.get('local_tools')}")
        for tool in (
            "project_info",
            "summary_tool",
            "cli_tool",
            "local_tool",
            "entry_tool",
            "search_tool",
        ):
            if observed.get(tool) != "True":
                failures.append(f"{tool} did not answer from the deployed shape")

        # The import budget covers what this repository's own code costs, not
        # what the MCP SDK costs. Measured on a warm filesystem: 586ms to import
        # `mcp` and 14ms for everything in `app.py` and the package beside it.
        # The domain cap is 30 seconds, so both numbers are comfortable; the
        # budget exists to catch a change that starts parsing the registry on
        # every request, which is a defect rather than a slow start.
        import_ms = float(observed.get("import_ms", "9999"))
        if import_ms > 5_000:
            failures.append(f"import took {import_ms}ms against a 30000ms domain cap")

        print(
            f"deployed shape: {summary.get('operations')} operations, {summary.get('cases')} cases, "
            f"version {summary.get('version')}, import {import_ms}ms, "
            f"source reachable {observed.get('source_reachable')}"
        )
        for failure in failures:
            print(f"FAIL {failure}", file=sys.stderr)
        return 1 if failures else 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        tarball.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
