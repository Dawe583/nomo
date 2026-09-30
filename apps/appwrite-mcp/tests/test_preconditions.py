"""Every case's machine-readable precondition is read, not guessed at.

The registry carries each case's gate twice: once as the prose in `when`, and
once as the structured literal in `if`. The prose is what a person reads and
the literal is what a tool can evaluate, so a parser that drops the second one
silently publishes a catalogue that cannot answer the question it exists for.

Every kind is asserted against a case in the source, because the bug this file
exists for was a pattern that matched nothing and reported `None` rather than
failing: 445 of 491 cases parsed cleanly and 46 silently lost their gate.
"""

from __future__ import annotations

import unittest

from appwrite_mcp import void_data


class PreconditionParsingTest(unittest.TestCase):
    def setUp(self) -> None:
        void_data.registry_entries.cache_clear()
        void_data.unparsed_entries.cache_clear()
        void_data.registry_summary.cache_clear()
        self.rows = void_data.registry_entries()

    def test_every_case_carries_its_precondition(self) -> None:
        # The registry writes an `if` on every case. One that reads back as None
        # is a parse that matched the fields around it and missed the gate, and
        # it is indistinguishable from a case that has no gate at all.
        missing = [row for row in self.rows if not row.get("if")]
        self.assertEqual(
            missing,
            [],
            f"{len(missing)} of {len(self.rows)} cases lost their precondition",
        )

    def test_the_registry_still_parses_completely(self) -> None:
        # A precondition reader that swallows the following cases would show up
        # here as a falling case count, not as a precondition failure.
        self.assertEqual(void_data.unparsed_entries(), ())
        summary = void_data.registry_summary()
        self.assertEqual(summary["cases"], len(self.rows))
        self.assertEqual(summary["operations"], len({row["id"] for row in self.rows}))

    def test_a_fact_gate_carries_the_fact_and_its_value(self) -> None:
        facts = [row for row in self.rows if (row["if"] or {}).get("kind") == "fact"]
        self.assertGreater(len(facts), 0, "the registry has no fact gates at all")
        for row in facts:
            self.assertIn("fact", row["if"])
            self.assertIn("is", row["if"])
            self.assertTrue(row["if"]["fact"])

    def test_an_always_gate_asks_for_nothing(self) -> None:
        always = [row for row in self.rows if (row["if"] or {}).get("kind") == "always"]
        self.assertGreater(len(always), 0)
        for row in always:
            self.assertEqual(set(row["if"]), {"kind"}, row["if"])

    def test_an_argument_gate_names_the_argument_and_the_operator(self) -> None:
        arguments = [row for row in self.rows if (row["if"] or {}).get("kind") == "argument"]
        self.assertGreater(len(arguments), 0)
        for row in arguments:
            self.assertTrue(row["if"].get("argument"))
            self.assertTrue(row["if"].get("operator"))

    def test_a_conjunction_gate_keeps_every_child(self) -> None:
        # This is where the quoted-key bug hid: the children of an `all` are
        # read by the same field patterns as the parent, so a pattern that
        # misses them yields an empty `of` and a gate that can never be true.
        conjunctions = [row for row in self.rows if (row["if"] or {}).get("kind") == "all"]
        self.assertGreater(len(conjunctions), 0)
        for row in conjunctions:
            children = row["if"].get("of") or []
            self.assertGreater(
                len(children), 0, f"{row['id']} is a conjunction with no children"
            )
            for child in children:
                self.assertIn("kind", child)
                if child["kind"] == "fact":
                    self.assertIn("fact", child)

    def test_the_gate_is_read_from_the_case_it_belongs_to(self) -> None:
        # A gate belongs to the case whose `when` sits above it. Reading the
        # next one instead would give every case in an entry the same answer,
        # and the total count would still be right.
        by_id: dict[str, set[str]] = {}
        for row in self.rows:
            by_id.setdefault(row["id"], set()).add(str(row["if"]))
        shared = {key: value for key, value in by_id.items() if len(value) == 1 and len(
            [r for r in self.rows if r["id"] == key]
        ) > 1}
        for key, value in shared.items():
            rows = [r for r in self.rows if r["id"] == key]
            distinct = {str(r["if"]) for r in rows}
            self.assertGreater(
                len(distinct), 1, f"{key} gives all {len(rows)} cases the same gate"
            )

    def test_the_published_case_carries_the_gate(self) -> None:
        # The endpoint publishes these rows, so the gate has to be part of what
        # it publishes rather than something only the parser can see.
        from appwrite_mcp import snapshot_builder

        built = snapshot_builder.build()["registry"]
        self.assertEqual(len(built), len(self.rows))
        with_gate = [row for row in built if row.get("if")]
        self.assertEqual(len(with_gate), len(built))


if __name__ == "__main__":
    unittest.main()
