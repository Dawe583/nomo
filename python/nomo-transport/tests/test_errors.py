"""The four NOMO codes, and the transport refusal that is not one of them."""

from __future__ import annotations

import unittest

from nomo_transport.errors import (
    HOLD_DENIED,
    LEDGER_VERIFY,
    POLICY_STARTUP,
    REFUSED,
    TRANSPORT,
    HoldDeniedError,
    LedgerVerifyError,
    PolicyStartupError,
    RefusedError,
    NomoTransportError,
)


class ErrorCodeTest(unittest.TestCase):
    def test_codes_match_the_typescript_sdk(self) -> None:
        self.assertEqual(HoldDeniedError.code, "NOMO_HOLD_DENIED")
        self.assertEqual(LedgerVerifyError.code, "NOMO_LEDGER_VERIFY")
        self.assertEqual(PolicyStartupError.code, "NOMO_POLICY_STARTUP")
        self.assertEqual(RefusedError.code, "NOMO_REFUSED")
        self.assertEqual((HOLD_DENIED, LEDGER_VERIFY, POLICY_STARTUP, REFUSED),
                         ("NOMO_HOLD_DENIED", "NOMO_LEDGER_VERIFY",
                          "NOMO_POLICY_STARTUP", "NOMO_REFUSED"))

    def test_every_type_descends_from_the_base(self) -> None:
        for error_type in (
            HoldDeniedError,
            LedgerVerifyError,
            PolicyStartupError,
            RefusedError,
        ):
            with self.subTest(error=error_type.__name__):
                self.assertTrue(issubclass(error_type, NomoTransportError))
                self.assertTrue(issubclass(error_type, Exception))

    def test_transport_code_is_distinct_from_the_wire_codes(self) -> None:
        # A caller has to be able to tell "NOMO said no" from "this client
        # would not ask". A shared code would erase that difference.
        self.assertEqual(NomoTransportError.code, TRANSPORT)
        self.assertEqual(NomoTransportError.code, "NOMO_TRANSPORT")
        self.assertNotIn(NomoTransportError.code, {
            HOLD_DENIED, LEDGER_VERIFY, POLICY_STARTUP, REFUSED,
        })

    def test_code_reads_from_the_class_and_the_instance(self) -> None:
        error = HoldDeniedError("denied", hold_id="hold-1", data={"result": "denied"})
        self.assertEqual(type(error).code, "NOMO_HOLD_DENIED")
        self.assertEqual(error.code, "NOMO_HOLD_DENIED")
        self.assertEqual(str(error), "denied")
        self.assertEqual(error.hold_id, "hold-1")
        self.assertEqual(error.data, {"result": "denied"})

    def test_ledger_verify_carries_reason_and_count(self) -> None:
        error = LedgerVerifyError("chain broke", reason="signature", checked=17)
        self.assertEqual(error.reason, "signature")
        self.assertEqual(error.checked, 17)
        self.assertEqual(LedgerVerifyError("plain").checked, 0)
        self.assertIsNone(LedgerVerifyError("plain").reason)


class RefusedErrorTest(unittest.TestCase):
    def refusal(self, **overrides: object) -> dict[str, object]:
        base: dict[str, object] = {
            "stepId": "step-3",
            "reason": "drift",
            "changed": [],
        }
        base.update(overrides)
        return base

    def test_message_names_the_step_and_the_reason(self) -> None:
        error = RefusedError(self.refusal())
        self.assertEqual(str(error), "NOMO refused replay step step-3: drift")
        self.assertEqual(error.step_id, "step-3")
        self.assertEqual(error.reason, "drift")

    def test_from_report_takes_the_first_refusal(self) -> None:
        first = self.refusal()
        second = self.refusal(stepId="step-9", reason="missing_target")
        error = RefusedError.from_report({"applied": ["step-1"], "refused": [first, second]})
        assert error is not None
        self.assertEqual(error.step_id, "step-3")

    def test_from_report_returns_none_when_nothing_was_refused(self) -> None:
        self.assertIsNone(RefusedError.from_report({"applied": [], "refused": []}))
        self.assertIsNone(RefusedError.from_report({}))

    def test_from_report_refuses_a_non_object(self) -> None:
        with self.assertRaises(TypeError):
            RefusedError.from_report(["not", "a", "report"])

    def test_unknown_reason_is_refused(self) -> None:
        # An unknown reason is an unknown shape. Guessing one would invent a
        # refusal reason the registry never produced.
        with self.assertRaises(TypeError):
            RefusedError(self.refusal(reason="because_i_said_so"))

    def test_missing_step_id_is_refused(self) -> None:
        with self.assertRaises(TypeError):
            RefusedError({"reason": "drift", "changed": []})
        with self.assertRaises(TypeError):
            RefusedError({"stepId": "", "reason": "drift", "changed": []})

    def test_every_registry_reason_is_accepted(self) -> None:
        for reason in ("drift", "missing_target", "permission_denied", "internal_error"):
            with self.subTest(reason=reason):
                self.assertEqual(RefusedError(self.refusal(reason=reason)).reason, reason)


if __name__ == "__main__":
    unittest.main()
