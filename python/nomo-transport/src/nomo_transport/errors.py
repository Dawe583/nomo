"""The four NOMO error codes, and the transport refusals around them.

``packages/sdk/src/errors.ts`` publishes exactly four codes:
``NOMO_HOLD_DENIED``, ``NOMO_LEDGER_VERIFY``, ``NOMO_POLICY_STARTUP`` and
``NOMO_REFUSED``. Each type here carries the same ``code``, the same message
text and the same payload fields, so a Python caller can branch on
``error.code`` exactly as the TypeScript SDK does.

:class:`NomoTransportError` itself carries the code ``NOMO_TRANSPORT``. That
code is not a NOMO wire code: it is what this client raises when it refuses to
put a request on the socket at all, or refuses to believe a response. Keeping
it distinct from the four means a caller can always tell "NOMO said no" from
"this client would not ask", which is the difference a fail-closed client has
to be able to report.
"""

from __future__ import annotations

from typing import Any, Final

__all__ = [
    "HOLD_DENIED",
    "LEDGER_VERIFY",
    "POLICY_STARTUP",
    "REFUSED",
    "TRANSPORT",
    "HoldDeniedError",
    "LedgerVerifyError",
    "PolicyStartupError",
    "RefusedError",
    "RefusalReason",
    "NomoTransportError",
]

TRANSPORT: Final = "NOMO_TRANSPORT"
HOLD_DENIED: Final = "NOMO_HOLD_DENIED"
LEDGER_VERIFY: Final = "NOMO_LEDGER_VERIFY"
POLICY_STARTUP: Final = "NOMO_POLICY_STARTUP"
REFUSED: Final = "NOMO_REFUSED"

#: ``ReplayRefusal["reason"]`` in ``packages/connectors/src/registry.ts``.
RefusalReason = str

#: The refusal reasons the registry can produce. A reason outside this set is
#: an unknown shape, and an unknown shape is a refusal, not a guess.
_REFUSAL_REASONS: Final = frozenset(
    {"drift", "missing_target", "permission_denied", "internal_error"}
)


class NomoTransportError(Exception):
    """Base class for every refusal this package raises.

    ``code`` is a class attribute, so ``type(error).code`` works without an
    instance, and every instance keeps it available on the instance too.
    """

    code: str = TRANSPORT

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class HoldDeniedError(NomoTransportError):
    """A human or an expiry refused a held call. The body is on ``data``."""

    code = HOLD_DENIED

    def __init__(self, message: str, hold_id: str | None = None, data: Any = None) -> None:
        super().__init__(message)
        self.hold_id = hold_id
        self.data = data


class LedgerVerifyError(NomoTransportError):
    """A ledger chain check failed. ``checked`` counts the lines actually read."""

    code = LEDGER_VERIFY

    def __init__(
        self, message: str, reason: str | None = None, checked: int = 0
    ) -> None:
        super().__init__(message)
        self.reason = reason
        self.checked = checked


class PolicyStartupError(NomoTransportError):
    """The proxy refused to start because its policy would not load."""

    code = POLICY_STARTUP


class RefusedError(NomoTransportError):
    """A replay step was refused. Mirrors ``RefusedError`` in the TS SDK."""

    code = REFUSED

    def __init__(self, refusal: Any) -> None:
        if not isinstance(refusal, dict):
            raise TypeError("refusal must be the registry's replay refusal object")
        step_id = refusal.get("stepId")
        reason = refusal.get("reason")
        if not isinstance(step_id, str) or not step_id:
            raise TypeError("replay refusal is missing a stepId")
        if reason not in _REFUSAL_REASONS:
            raise TypeError(f"unknown replay refusal reason: {reason!r}")
        super().__init__(f"NOMO refused replay step {step_id}: {reason}")
        self.step_id = step_id
        self.reason: RefusalReason = reason
        self.refusal = refusal

    @classmethod
    def from_report(cls, report: Any) -> RefusedError | None:
        """Return the first refusal in an ``ApplyReport``, or ``None``.

        The TS SDK's ``RefusedError.fromReport`` takes the first entry of
        ``report.refused``; an empty or absent list means the replay was clean.
        """
        if not isinstance(report, dict):
            raise TypeError("apply report must be an object")
        refused = report.get("refused", [])
        if not isinstance(refused, list):
            raise TypeError("apply report carries a refused value that is not a list")
        if not refused:
            return None
        return cls(refused[0])
