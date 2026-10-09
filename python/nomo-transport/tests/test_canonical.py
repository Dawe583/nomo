"""Canonical JSON and the digest, checked against the ledger's own rules."""

from __future__ import annotations

import base64
import hashlib
import math
import unittest

from tests import support
from nomo_transport.canonical import (
    MAX_DEPTH,
    CanonicalError,
    canonical_bytes,
    canonical_json,
    digest,
    is_lowercase_sha256,
)


class CanonicalJsonTest(unittest.TestCase):
    def test_scalars_render_as_json(self) -> None:
        self.assertEqual(canonical_json(None), "null")
        self.assertEqual(canonical_json(True), "true")
        self.assertEqual(canonical_json(False), "false")
        # bool is an int in Python; canonical JSON must not read True as 1.
        self.assertEqual(canonical_json(1), "1")
        self.assertEqual(canonical_json("x"), '"x"')

    def test_keys_sort_at_every_depth(self) -> None:
        self.assertEqual(
            canonical_json({"b": 1, "a": {"d": 2, "c": 3}}), '{"a":{"c":3,"d":2},"b":1}'
        )

    def test_empty_containers_survive(self) -> None:
        self.assertEqual(canonical_json({}), "{}")
        self.assertEqual(canonical_json([]), "[]")
        self.assertEqual(canonical_json({"a": {}, "b": []}), '{"a":{},"b":[]}')

    def test_no_insignificant_whitespace(self) -> None:
        text = canonical_json({"a": [1, 2], "b": {"c": 3}})
        self.assertNotIn(" ", text)
        self.assertNotIn("\n", text)

    def test_solidus_and_unicode_stay_raw(self) -> None:
        self.assertEqual(canonical_json({"a/b": "ř/日"}), '{"a/b":"ř/日"}')

    def test_control_characters_are_escaped(self) -> None:
        self.assertEqual(
            canonical_json("\n\t\r\b\f\u0001\u001f"),
            '"\\n\\t\\r\\b\\f\\u0001\\u001f"',
        )

    def test_lone_surrogate_is_escaped_not_emitted(self) -> None:
        # JSON.stringify has been well-formed since ES2019; emitting a raw
        # lone surrogate would be invalid UTF-8 on the wire.
        self.assertEqual(canonical_json("\ud800"), '"\\ud800"')
        canonical_bytes("\ud800")

    def test_keys_sort_by_utf16_code_unit(self) -> None:
        # U+FFFD is one code unit; U+10000 is a surrogate pair starting at
        # 0xD800. Code point order puts U+FFFD first, UTF-16 order does not.
        text = canonical_json({"\ufffd": 1, "\U00010000": 2})
        self.assertTrue(text.startswith('{"\U00010000"'), text)

    def test_floats_use_javascript_form(self) -> None:
        self.assertEqual(canonical_json(1.0), "1")
        self.assertEqual(canonical_json(-0.0), "0")
        self.assertEqual(canonical_json(0.1), "0.1")
        # The threshold where JSON.stringify switches to exponential form.
        self.assertEqual(canonical_json(1e20), "1" + "0" * 20)
        self.assertEqual(canonical_json(1e21), "1e+21")
        self.assertEqual(canonical_json(1e-6), "0.000001")
        self.assertEqual(canonical_json(1e-7), "1e-7")
        self.assertEqual(canonical_json(1.5e-7), "1.5e-7")
        # The denormal minimum, where the exponent is far below the -6
        # threshold. A canonicaliser that always used the plain form here
        # would write 323 zeroes instead of the exponent.
        self.assertEqual(canonical_json(5e-324), "5e-324")
        self.assertEqual(canonical_json(1e-7), "1e-7")
        self.assertEqual(canonical_json(1e-6), "0.000001")

    def test_non_finite_floats_are_refused(self) -> None:
        for value in (math.nan, math.inf, -math.inf):
            with self.assertRaises(CanonicalError):
                canonical_json(value)

    def test_unsafe_integer_is_refused(self) -> None:
        # 2**53 is the first integer a double cannot hold; the ledger's own
        # number domain stops below it.
        canonical_json(2**53 - 1)
        with self.assertRaises(CanonicalError):
            canonical_json(2**53)

    def test_cycle_is_refused(self) -> None:
        cycle: list[object] = [1]
        cycle.append(cycle)
        with self.assertRaises(CanonicalError):
            canonical_json(cycle)

    def test_repeated_value_is_not_a_cycle(self) -> None:
        shared = {"a": 1}
        self.assertEqual(canonical_json([shared, shared]), '[{"a":1},{"a":1}]')

    def test_depth_ceiling_matches_the_ledger(self) -> None:
        def nest(levels: int) -> object:
            value: object = 0
            for _ in range(levels):
                value = [value]
            return value

        canonical_json(nest(MAX_DEPTH))
        with self.assertRaises(CanonicalError):
            canonical_json(nest(MAX_DEPTH + 1))

    def test_non_json_types_are_refused(self) -> None:
        for value in ({"a"}, b"bytes", object(), None.__class__):
            with self.subTest(value=repr(value)):
                with self.assertRaises(CanonicalError):
                    canonical_json(value)

    def test_non_string_key_is_refused(self) -> None:
        with self.assertRaises(CanonicalError):
            canonical_json({1: "one"})

    def test_tuple_is_canonicalised_as_an_array(self) -> None:
        # json.loads never produces a tuple, but a caller building arguments
        # by hand should not get a different byte string for the same JSON.
        self.assertEqual(canonical_json((1, 2)), "[1,2]")


class DigestTest(unittest.TestCase):
    def test_digest_shape_is_prefixed_sha256(self) -> None:
        value = digest({"b": 1, "a": 2})
        self.assertTrue(value.startswith("sha256:"), value)
        self.assertEqual(len(value), len("sha256:") + 64)
        self.assertTrue(is_lowercase_sha256(value.removeprefix("sha256:")))

    def test_digest_covers_canonical_text_not_input_order(self) -> None:
        self.assertEqual(digest({"a": 1, "b": 2}), digest({"b": 2, "a": 1}))
        expected = "sha256:" + hashlib.sha256(
            canonical_bytes({"a": 1, "b": 2})
        ).hexdigest()
        self.assertEqual(digest({"a": 1, "b": 2}), expected)

    def test_digest_changes_when_any_byte_changes(self) -> None:
        self.assertNotEqual(digest({"a": 1}), digest({"a": 2}))

    def test_lowercase_sha256_predicate(self) -> None:
        self.assertTrue(is_lowercase_sha256("a" * 64))
        self.assertFalse(is_lowercase_sha256("A" * 64))
        self.assertFalse(is_lowercase_sha256("a" * 63))
        self.assertFalse(is_lowercase_sha256("g" * 64))
        self.assertFalse(is_lowercase_sha256(None))


class CanonicalNodeParityTest(unittest.TestCase):
    """The cross check: same bytes from Python and from the ledger's own code."""

    def test_python_and_node_agree_byte_for_byte(self) -> None:
        samples = support.load_samples()
        node_records = support.run_node_canonical(samples)
        self.assertEqual(len(node_records), len(samples))
        for (name, value), record in zip(samples, node_records, strict=True):
            self.assertEqual(record["name"], name)
            if record["error"] is not None:
                # The value has no canonical form; this runtime must agree.
                with self.assertRaises(CanonicalError, msg=name):
                    canonical_json(value)
                continue
            with self.subTest(sample=name):
                self.assertEqual(record["canonical"], canonical_json(value))
                self.assertEqual(
                    record["bytesBase64"],
                    base64.b64encode(canonical_bytes(value)).decode(),
                )
                self.assertEqual(record["digest"], digest(value))


if __name__ == "__main__":
    unittest.main()
