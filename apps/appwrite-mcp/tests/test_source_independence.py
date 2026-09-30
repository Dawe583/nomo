"""Every published fact must survive the loss of the source tree.

The offline suite in ``test_hosted_endpoint.py`` runs from a checkout, so
``void_data`` reads the registry, the CLI dispatcher and the recovery server
through relative paths that exist. A deployed Appwrite function receives a
tarball: no ``packages/``, no ``registry.ts``, no ``dispatch.ts``. If a reader
forgets its fallback, every tool returns an empty catalogue and all of those
tests stay green, because none of them is running in the deployed shape.

This file is that missing check, expressed as a suite. It relocates the source
files out of reach and asserts the same numbers the checkout produces, so a
missing fallback fails here rather than in production.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from appwrite_mcp import void_data

REPO_ROOT = void_data.REPO_ROOT


class UnreachableSourceTest(unittest.TestCase):
    """Each reader in turn, with the file it depends on moved away."""

    def setUp(self) -> None:
        # `lru_cache` is what makes the readers cheap, and it is also what would
        # hide a missing fallback: the first call populates the cache and every
        # later call answers from it. Clearing it after the move is what makes
        # this test able to fail at all.
        void_data.registry_entries.cache_clear()
        void_data.registry_summary.cache_clear()
        void_data.unparsed_entries.cache_clear()
        void_data.registry_version.cache_clear()
        void_data.registry_disclaimer.cache_clear()
        void_data.cli_commands.cache_clear()
        void_data.local_tool_names.cache_clear()
        void_data.local_tool_schema.cache_clear()
        void_data.hosted_tool_surface.cache_clear()
        self.moved: list[tuple[Path, Path]] = []
        self.scratch = Path(tempfile.mkdtemp(prefix="void-unreachable-"))

    def tearDown(self) -> None:
        for original, parked in self.moved:
            parked.replace(original)
        shutil.rmtree(self.scratch, ignore_errors=True)
        for cache in (
            void_data.registry_entries,
            void_data.registry_summary,
            void_data.unparsed_entries,
            void_data.registry_version,
            void_data.registry_disclaimer,
            void_data.cli_commands,
            void_data.local_tool_names,
            void_data.local_tool_schema,
            void_data.hosted_tool_surface,
        ):
            cache.cache_clear()

    def hide(self, path: Path) -> None:
        """Move a source file somewhere it cannot be reached from."""
        if not path.exists():
            self.fail(f"{path} does not exist, so this test cannot hide it")
        parked = self.scratch / path.name
        path.replace(parked)
        self.moved.append((path, parked))

    def clear(self) -> None:
        for cache in (
            void_data.registry_entries,
            void_data.registry_summary,
            void_data.unparsed_entries,
            void_data.registry_version,
            void_data.registry_disclaimer,
            void_data.cli_commands,
            void_data.local_tool_names,
            void_data.local_tool_schema,
        ):
            cache.cache_clear()

    def test_the_registry_falls_back_to_the_snapshot(self) -> None:
        expected_operations = void_data.registry_summary()["operations"]
        expected_cases = void_data.registry_summary()["cases"]
        self.assertGreater(expected_operations, 0, "the checkout itself read nothing")

        self.hide(void_data.REGISTRY_SOURCE)
        self.clear()

        summary = void_data.registry_summary()
        self.assertFalse(void_data.REGISTRY_SOURCE.exists())
        self.assertEqual(summary["operations"], expected_operations)
        self.assertEqual(summary["cases"], expected_cases)
        self.assertEqual(summary["unparsed"], 0)
        self.assertTrue(summary["version"], "the snapshot carries no registry version")
        self.assertEqual(len(void_data.registry_entries()), expected_cases)

    def test_the_cli_commands_fall_back_to_the_snapshot(self) -> None:
        expected = void_data.cli_commands()
        self.assertGreater(len(expected), 0, "the checkout itself read nothing")
        self.assertIn("replay", expected)

        self.hide(void_data.CLI_DISPATCH)
        self.clear()

        self.assertFalse(void_data.CLI_DISPATCH.exists())
        # The failure this guards against is a client reading an empty list as
        # "the command line has no commands" rather than as "this build cannot
        # see the source".
        self.assertEqual(void_data.cli_commands(), expected)

    def test_the_local_tool_catalogue_falls_back_to_the_snapshot(self) -> None:
        expected = void_data.local_tool_schema()
        self.assertEqual(len(expected), 8, "the checkout itself read a different count")
        self.assertIn("void_execute", {tool["name"] for tool in expected})

        self.hide(void_data.RECOVERY_MCP)
        self.clear()

        self.assertFalse(void_data.RECOVERY_MCP.exists())
        served = void_data.local_tool_schema()
        self.assertEqual(len(served), len(expected))
        # The annotations are what a host acts on, so the fallback has to carry
        # them and not only the names.
        for tool in served:
            self.assertIsInstance(tool["readOnlyHint"], bool, tool["name"])
            self.assertTrue(tool["description"].strip(), tool["name"])
        self.assertEqual(
            {tool["name"]: tool["readOnlyHint"] for tool in served},
            {tool["name"]: tool["readOnlyHint"] for tool in expected},
        )

    def test_everything_the_endpoint_publishes_survives_no_source_at_all(self) -> None:
        """The whole surface at once, which is the shape a deployment has."""
        for path in (void_data.REGISTRY_SOURCE, void_data.CLI_DISPATCH, void_data.RECOVERY_MCP):
            self.hide(path)
        self.clear()

        from app import (  # noqa: PLC0415 - imported after the files are moved
            void_cli_commands,
            void_local_tools,
            void_project_info,
            void_registry_entry,
            void_registry_search,
            void_registry_summary,
        )

        self.assertIn("VOID", void_project_info())
        self.assertIn("operations", void_registry_summary())
        self.assertIn("replay", void_cli_commands())
        self.assertIn("void_execute", void_local_tools())
        self.assertIn("void_recovery_plan", void_local_tools())

        entry = json.loads(void_registry_entry("aws.s3.object.put"))
        self.assertTrue(entry["found"])
        self.assertGreaterEqual(entry["case_count"], 2)

        search = json.loads(void_registry_search(tone="r3", limit=3))
        self.assertLessEqual(len(search["results"]), 3)
        for row in search["results"]:
            self.assertEqual(row["tone"], "r3")


class NoSourceAtAllTest(unittest.TestCase):
    """The snapshot has to be the whole answer, not a partial one."""

    def test_a_missing_snapshot_is_refused_rather_than_serving_nothing(self) -> None:
        # `VOID_SNAPSHOT_PATH` is the documented way to relocate the snapshot, and
        # it is the lever this uses: pointing it at a file that does not exist
        # leaves every reader with nothing. Each has to come back empty rather
        # than raise, because a deployed function that raises on a tool call
        # answers no request at all — and an empty answer is at least an honest
        # one, which is the difference this module exists to preserve.
        void_data.registry_entries.cache_clear()
        void_data.registry_summary.cache_clear()
        void_data.unparsed_entries.cache_clear()
        void_data.registry_version.cache_clear()
        void_data.registry_disclaimer.cache_clear()
        void_data.cli_commands.cache_clear()
        void_data.local_tool_names.cache_clear()
        void_data.local_tool_schema.cache_clear()
        scratch = Path(tempfile.mkdtemp(prefix="void-no-source-"))
        parked: list[tuple[Path, Path]] = []
        try:
            for path in (void_data.REGISTRY_SOURCE, void_data.CLI_DISPATCH, void_data.RECOVERY_MCP):
                if path.exists():
                    destination = scratch / path.name
                    path.replace(destination)
                    parked.append((path, destination))
            with mock.patch.dict(
                os.environ,
                {"VOID_SNAPSHOT_PATH": str(scratch / "void-no-such-snapshot.json")},
            ):
                self.assertEqual(void_data._snapshot(), {})
                self.assertEqual(void_data.cli_commands(), ())
                self.assertEqual(void_data.local_tool_names(), ())
                self.assertEqual(void_data.local_tool_schema(), ())
                self.assertEqual(void_data.registry_entries(), ())
                # A summary built from nothing is still a summary, and says so.
                summary = void_data.registry_summary()
                self.assertEqual(summary["operations"], 0)
                self.assertEqual(summary["cases"], 0)
        finally:
            for original, destination in parked:
                destination.replace(original)
            shutil.rmtree(scratch, ignore_errors=True)
            for cache in (
                void_data.registry_entries,
                void_data.registry_summary,
                void_data.unparsed_entries,
                void_data.registry_version,
                void_data.registry_disclaimer,
                void_data.cli_commands,
                void_data.local_tool_names,
                void_data.local_tool_schema,
            ):
                cache.cache_clear()
