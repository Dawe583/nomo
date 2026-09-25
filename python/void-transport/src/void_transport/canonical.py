"""Canonical JSON, byte-identical to ``packages/ledger/src/canonical.ts``.

The ledger's canonical form is what makes an offline verifier possible: two
runtimes hashing the same entry must produce the same bytes. This module is
the Python half of that promise, so every rule in the TypeScript original is
reproduced rather than approximated:

* object keys sorted at every depth, by UTF-16 code unit, the way ``<``
  compares JavaScript strings (which is what ``canonical.ts`` sorts with);
* no insignificant whitespace;
* strings escaped as ``JSON.stringify`` escapes them, including the
  well-formed ``\\uXXXX`` escapes for lone surrogates;
* numbers in their shortest round-tripping form, including JavaScript's
  exponent threshold, so ``1e21`` and ``1.0`` come out the way the ledger
  writes them.

Anything that is not a JSON value -- a non-finite float, a cycle, a nesting
deeper than the TypeScript ceiling, a non-string key, a set, a ``bytes`` --
raises :class:`CanonicalError` instead of being silently coerced. A
canonicaliser that quietly invented a value would let two runtimes disagree
on the entry while both claimed to have sealed it.

The walk is iterative rather than recursive. ``MAX_DEPTH`` is 1000 levels and
CPython's default recursion limit is 1000 frames, so a recursive walk would
die with a ``RecursionError`` well before the ledger's own ceiling -- a crash
with no name, where a refusal with a name is what the caller needs.
"""

from __future__ import annotations

import hashlib
from typing import Any, Final

__all__ = [
    "MAX_DEPTH",
    "CanonicalError",
    "canonical_bytes",
    "canonical_json",
    "digest",
    "is_lowercase_sha256",
]

#: The same ceiling ``canonical.ts`` applies. Deeper than this is hostile, not
#: a legitimate tool argument.
MAX_DEPTH: Final = 1000

_DIGEST_PREFIX: Final = "sha256:"
_LOWERCASE_SHA256_LENGTH: Final = 64
_HEX_DIGITS: Final = frozenset("0123456789abcdef")

#: The two-character escapes ``JSON.stringify`` prefers over ``\\u00XX``.
_SHORT_ESCAPES: Final = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}

_SURROGATE_START: Final = 0xD800
_SURROGATE_END: Final = 0xDFFF

_EXPAND: Final = "expand"
_TEXT: Final = "text"
_LEAVE: Final = "leave"


class CanonicalError(TypeError):
    """A value has no canonical JSON form in this runtime."""


def canonical_json(value: Any) -> str:
    """Return the canonical JSON text of ``value``.

    Raises :class:`CanonicalError` for anything that is not a JSON value, so a
    caller learns the payload cannot be sealed instead of sealing a guess.
    """
    out: list[str] = []
    # Frames, last pushed first processed. A frame's first element says what
    # it is: expand a value at a depth, emit literal text, or drop a container
    # from the current path.
    stack: list[tuple[str, Any, int]] = [(_EXPAND, value, 0)]
    # The containers on the current path, keyed on id(). CPython interns small
    # ints and short strings, so a set keyed on the value itself would report a
    # false cycle. The frame that pushed a container holds it alive until the
    # matching leave frame pops it.
    on_path: dict[int, object] = {}

    while stack:
        kind, payload, depth = stack.pop()
        if kind == _TEXT:
            out.append(payload)
            continue
        if kind == _LEAVE:
            del on_path[payload]
            continue
        if depth > MAX_DEPTH:
            raise CanonicalError(f"payload nests deeper than {MAX_DEPTH} levels")
        value = payload
        # bool before int: in Python True is an int, and canonical JSON has to
        # agree with the ledger that it is not the number 1.
        if value is None:
            out.append("null")
        elif isinstance(value, bool):
            out.append("true" if value else "false")
        elif isinstance(value, int):
            out.append(_canonical_integer(value))
        elif isinstance(value, float):
            out.append(_canonical_number(value))
        elif isinstance(value, str):
            out.append(_canonical_string(value))
        elif isinstance(value, (list, tuple)):
            _enter(value, on_path)
            last = len(value) - 1
            stack.append((_LEAVE, id(value), 0))
            stack.append((_TEXT, "]", 0))
            for index in range(last, -1, -1):
                # Push the separator before the item: the stack pops last-in
                # first, so this emits item, then separator, then the next item.
                stack.append((_TEXT, "," if index < last else "", 0))
                stack.append((_EXPAND, value[index], depth + 1))
            stack.append((_TEXT, "[", 0))
        elif isinstance(value, dict):
            for key in value:
                if not isinstance(key, str):
                    raise CanonicalError(
                        f"object key {key!r} is not a string and cannot be canonical JSON"
                    )
            _enter(value, on_path)
            pairs = sorted(value.items(), key=lambda pair: _sort_key(pair[0]))
            stack.append((_LEAVE, id(value), 0))
            stack.append((_TEXT, "}", 0))
            # Emit key, colon, value, and a leading comma on every member but
            # the first. The stack pops last-in first, so each member is pushed
            # in reverse of the order it must appear in.
            for index in range(len(pairs) - 1, -1, -1):
                key, item = pairs[index]
                stack.append((_EXPAND, item, depth + 1))
                stack.append((_TEXT, ":", 0))
                stack.append((_TEXT, _canonical_string(key), 0))
                if index > 0:
                    stack.append((_TEXT, ",", 0))
            stack.append((_TEXT, "{", 0))
        else:
            raise CanonicalError(f"{type(value).__name__} is not a JSON value")
    return "".join(out)


def canonical_bytes(value: Any) -> bytes:
    """Return the canonical JSON of ``value`` encoded as UTF-8."""
    return canonical_json(value).encode("utf-8")


def digest(value: Any) -> str:
    """Return ``sha256:<hex>`` over the canonical JSON of ``value``.

    The digest covers the canonical text, not the caller's own serialisation.
    Two runtimes that disagree about key order therefore cannot produce the
    same digest, which is the property the ledger chain depends on.
    """
    return _DIGEST_PREFIX + hashlib.sha256(canonical_bytes(value)).hexdigest()


def is_lowercase_sha256(value: Any) -> bool:
    """Report whether ``value`` is 64 lowercase hex characters.

    The same check the Swift client makes on a certificate fingerprint: an
    upper-case or truncated digest is not the identity the peer means.
    """
    if not isinstance(value, str) or len(value) != _LOWERCASE_SHA256_LENGTH:
        return False
    return all(character in _HEX_DIGITS for character in value)


def _enter(value: object, on_path: dict[int, object]) -> None:
    key = id(value)
    if key in on_path:
        raise CanonicalError("reference cycle in ledger payload")
    on_path[key] = value


def _sort_key(key: str) -> bytes:
    """Order keys the way ``canonical.ts`` does.

    ``canonical.ts`` sorts with ``a[0] < b[0]``, which compares JavaScript
    strings by UTF-16 code unit. Python compares ``str`` by code point, and the
    two disagree for anything outside the BMP: U+FFFD sorts before U+10000 by
    code point but after it by code unit. UTF-16 big endian bytes compare code
    unit by code unit, so encoding the key reproduces the ledger's order
    exactly. ``surrogatepass`` keeps a lone surrogate comparable instead of
    raising halfway through a sort.
    """
    return key.encode("utf-16-be", "surrogatepass")


def _canonical_integer(value: int) -> str:
    if abs(value) > 2**53 - 1:
        raise CanonicalError(
            f"integer {value} is outside the range JSON numbers round trip through"
        )
    return str(value)


def _canonical_number(value: float) -> str:
    if value != value or value in (float("inf"), float("-inf")):
        raise CanonicalError(f"{value!r} does not round trip through JSON")
    if value == 0.0:
        # JSON.stringify(-0) is "0"; a negative zero has no canonical form.
        return "0"
    sign = "-" if value < 0 else ""
    digits, exponent = _shortest_digits(abs(value))
    count = len(digits)
    if count <= exponent <= 21:
        return sign + digits + "0" * (exponent - count)
    if 0 < exponent <= 21:
        return sign + digits[:exponent] + "." + digits[exponent:]
    if -6 < exponent <= 0:
        return sign + "0." + "0" * (-exponent) + digits
    mantissa = digits if count == 1 else digits[0] + "." + digits[1:]
    power = exponent - 1
    marker = "e+" if power >= 0 else "e-"
    return f"{sign}{mantissa}{marker}{abs(power)}"


def _shortest_digits(value: float) -> tuple[str, int]:
    """Split ``value`` into shortest round-tripping digits and an exponent.

    The returned pair satisfies ``int(digits) * 10 ** (exponent - len(digits))``
    for ``value``. Python's ``repr`` already produces the shortest round-trip
    digits, so this only re-reads that text rather than searching for it.
    """
    text = repr(value)
    if "e" in text:
        mantissa, _, raw_exponent = text.partition("e")
        exponent = int(raw_exponent)
    else:
        mantissa, exponent = text, 0
    whole, _, fraction = mantissa.partition(".")
    combined = whole + fraction
    stripped = combined.lstrip("0")
    leading_zeros = len(combined) - len(stripped)
    digits = stripped.rstrip("0") or "0"
    # whole has len(whole) digits before the point, so the value is
    # 0.<digits> times 10 ** (len(whole) - leading_zeros + exponent).
    return digits, len(whole) - leading_zeros + exponent


def _canonical_string(value: str) -> str:
    out = ['"']
    for character in value:
        point = ord(character)
        short = _SHORT_ESCAPES.get(point)
        if short is not None:
            out.append(short)
        elif point < 0x20 or _SURROGATE_START <= point <= _SURROGATE_END:
            # JSON.stringify is well-formed since ES2019: a lone surrogate
            # becomes an escape rather than invalid UTF-8 on the wire.
            out.append(f"\\u{point:04x}")
        else:
            out.append(character)
    out.append('"')
    return "".join(out)
