"""Standard library Python client for the NOMO proxy HTTP transport.

The public surface is small on purpose: canonical JSON and its digest, the
four NOMO error codes, and one client that refuses a response it did not ask
for. See ``README.md`` for what this does and does not cover.
"""

from __future__ import annotations

from .canonical import (
    MAX_DEPTH,
    CanonicalError,
    canonical_bytes,
    canonical_json,
    digest,
    is_lowercase_sha256,
)
from .client import (
    DEFAULT_MAX_REQUEST_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    PROTOCOL_VERSION,
    PendingCall,
    ServerInfo,
    ToolSummary,
    NomoTransportClient,
)
from .errors import (
    HOLD_DENIED,
    LEDGER_VERIFY,
    POLICY_STARTUP,
    REFUSED,
    TRANSPORT,
    HoldDeniedError,
    LedgerVerifyError,
    PolicyStartupError,
    RefusedError,
    RefusalReason,
    NomoTransportError,
)

__version__ = "0.1.0"

__all__ = [
    "DEFAULT_MAX_REQUEST_BYTES",
    "DEFAULT_MAX_RESPONSE_BYTES",
    "HOLD_DENIED",
    "LEDGER_VERIFY",
    "MAX_DEPTH",
    "POLICY_STARTUP",
    "PROTOCOL_VERSION",
    "REFUSED",
    "TRANSPORT",
    "CanonicalError",
    "HoldDeniedError",
    "LedgerVerifyError",
    "PendingCall",
    "PolicyStartupError",
    "RefusedError",
    "RefusalReason",
    "ServerInfo",
    "ToolSummary",
    "NomoTransportClient",
    "NomoTransportError",
    "__version__",
    "canonical_bytes",
    "canonical_json",
    "digest",
    "is_lowercase_sha256",
]
