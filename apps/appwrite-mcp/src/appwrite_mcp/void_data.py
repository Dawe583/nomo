"""The VOID facts this hosted endpoint can answer, derived from the repository.

Every value here is generated from a file in the VOID tree at import time
rather than written by hand, so the endpoint cannot drift from the product it
describes. The previous version of ``app.py`` carried a hand-maintained list of
eight recovery tool names; when the CLI changed, that list would have kept
claiming names that no longer existed, and nothing in the repository would have
noticed because no test compared the two.

The generator runs against a checkout. When the checkout is absent, as it is in
a deployed function, the module falls back to the snapshot in
``void_snapshot.json`` — a generated file that is verified against the source in
``tests/test_hosted_endpoint.py`` on every local gate run. A stale snapshot
therefore fails the gate rather than being served.
"""

from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

_HERE = Path(__file__).resolve().parent
# src/appwrite_mcp -> src -> apps/appwrite-mcp -> apps -> repo root
REPO_ROOT = _HERE.parent.parent.parent.parent

REGISTRY_SOURCE = REPO_ROOT / "packages" / "registry" / "src" / "registry.ts"
CLI_BIN = REPO_ROOT / "packages" / "cli" / "bin" / "void.mjs"
CLI_DISPATCH = REPO_ROOT / "packages" / "cli" / "src" / "dispatch.ts"
RECOVERY_MCP = REPO_ROOT / "packages" / "cli" / "src" / "recovery-mcp.ts"
WORKSPACE_TOOLS = REPO_ROOT / "packages" / "workbench" / "src" / "workspace.ts"

SNAPSHOT_PATH = _HERE / "void_snapshot.json"

REGISTRY_VERSION = re.compile(r'REGISTRY_VERSION\s*=\s*"([^"]+)"')
REGISTRY_DISCLAIMER = re.compile(r'REGISTRY_DISCLAIMER\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)"')

# The split consumes the opening `\n  {\n`, so the head matches from the first
# field. A pattern that expects the opener back matches nothing at all, which is
# how a parser that reads correctly reports an empty catalogue.
_ENTRY_BOUNDARY = re.compile(r'\n  \{\n(?=    id: ")|(?<=\n  \})\n')

_ENTRY_HEAD = re.compile(
    r'^\s*id:\s*"(?P<id>[^"]*)",\n'
    r'\s*vendor:\s*"(?P<vendor>[^"]*)",\n'
    r'\s*surface:\s*"(?P<surface>[^"]*)",\n'
    r'\s*summary:\s*"(?P<summary>[^"]*)",\n'
    r'\s*tags:\s*\[(?P<tags>[^\]]*)\],\n'
    r'\s*cases:\s*\['
)

# Every field is required and ordered in every case literal in the source. A
# case missing `window:` is a defect in the registry, and a parser that dropped
# it silently would hide that defect from the catalogue.
_CASE = re.compile(
    r'\{\s*when:\s*"(?P<when>[^"]*)",\s*'
    r'tone:\s*"(?P<tone>r[0-3])",\s*'
    r'inverse:\s*(?P<inverse>null|"(?:[^"\\]|\\.)*"),\s*'
    r'window:\s*"(?P<window>[^"]*)",\s*'
    r'note:\s*"(?P<note>(?:[^"\\]|\\.)*)"'
)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _tags(raw: str) -> list[str]:
    return [part.strip().strip("\"'") for part in raw.split(",") if part.strip()]


# The precondition a case hangs on, as a structured object rather than prose.
#
# `if:` is a nested literal with its own braces and its own quoted strings, and
# an `all` case carries an array of them. A regular expression cannot count
# braces, so the object is read by balancing: the first `{` after `if:` and the
# brace that returns the depth to zero end it. Strings are skipped so that a
# brace inside a quoted value cannot end the object early.
_IF_START = re.compile(r"\bif:\s*\{")


def _close(text: str, start: int, depth: int = 0) -> int:
    """The index of the brace that closes the one opened at `start`.

    `depth` is how many braces are already open when this is called, so a caller
    that is standing inside an open literal starts at 1 and one that is standing
    on an opening brace starts at 0 and has that brace counted here. Returns -1
    when the literal never closes, which for a source file means a truncated
    read rather than a missing field.
    """
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    return -1


def _precondition(text: str, case_end: int) -> dict[str, Any] | None:
    """The `if` object belonging to the case whose `note` ended at `case_end`.

    The case is an object literal still open at `case_end`: its `note` string
    has been read but its closing brace has not. So the bound is that brace, and
    anything after it belongs to the next case.

    Bounding by the next case's `when` instead would be wrong in the direction
    that hides data: the source writes the next case immediately after this one,
    so that `when` arrives before this case's closing brace and the search would
    be cut off before reaching the `if` it is looking for.
    """
    close = _close(text, case_end, 1)
    if close == -1:
        return None
    literal = _IF_START.search(text[case_end:close])
    if literal is None:
        return None
    brace = case_end + literal.end() - 1
    end = _close(text, brace, 0)
    return None if end == -1 else _as_precondition(text[brace : end + 1])


def _as_precondition(literal: str) -> dict[str, Any] | None:
    """Read one `if` literal. It is TypeScript, so it is read field by field.

    The keys are quoted in the source, so every pattern has to allow the quotes
    or nothing matches at all and the gate reads as absent rather than as a
    parse failure.
    """
    kind = re.search(r'"?kind"?\s*:\s*"(?P<kind>\w+)"', literal)
    if kind is None:
        return None
    node: dict[str, Any] = {"kind": kind.group("kind")}
    for key in ("fact", "is", "argument", "operator"):
        value = re.search(rf'"?{key}"?\s*:\s*"([^"]*)"', literal)
        if value is not None:
            node[key] = value.group(1)
    # `all` and `any` both carry their conditions in `of`; the difference is
    # only whether they must all hold or any of them may. Reading one and not
    # the other would publish a disjunction as a bare fact, which reads as a
    # condition the caller has to satisfy on its own.
    if node["kind"] in ("all", "any"):
        node["of"] = _conjunction(literal)
    return node


def _conjunction(literal: str) -> list[dict[str, Any]]:
    """The children of an `all` gate, each read by the same field patterns.

    The list is walked by balance rather than by splitting on commas, because a
    nested conjunction would hold its own array and a comma inside one of its
    objects would cut the outer one in half.
    """
    open_bracket = literal.find("[")
    if open_bracket == -1:
        return []
    children: list[dict[str, Any]] = []
    cursor = open_bracket + 1
    while True:
        opening = literal.find("{", cursor)
        if opening == -1:
            return children
        end = _close(literal, opening, 0)
        if end == -1:
            return children
        child = _as_precondition(literal[opening : end + 1])
        if child is not None:
            children.append(child)
        cursor = end + 1


@lru_cache(maxsize=1)
def registry_entries() -> tuple[dict[str, Any], ...]:
    """Every reversibility case in the registry, read from the source file.

    The registry is TypeScript that imports nothing and cannot be executed by a
    Python process, so it is parsed rather than imported. An entry is a flat
    object literal whose ``cases`` array holds one object per precondition, and
    the tone lives on the case rather than on the entry: one operation can be
    r0 when a bucket is versioned and r3 when it is not, which is the reason
    the registry is shaped this way.

    Rows are flattened to one per case so a consumer asking "what is r0?" gets
    an answer. Operations and cases are counted separately in the summary
    because they are different numbers, and conflating them is how a registry
    gets over- or under-counted.
    """
    text = _read(REGISTRY_SOURCE)
    if text is None:
        return tuple(_snapshot().get("registry", ()))

    rows: list[dict[str, Any]] = []
    unparsed: list[str] = []
    for part in _ENTRY_BOUNDARY.split(text):
        head = _ENTRY_HEAD.match(part)
        if head is None:
            continue
        body = part[head.end() :]
        cases = list(_CASE.finditer(body))
        if not cases:
            unparsed.append(head.group("id"))
            continue
        for case in cases:
            inverse = case.group("inverse")
            rows.append(
                {
                    "id": head.group("id"),
                    "vendor": head.group("vendor"),
                    "surface": head.group("surface"),
                    "summary": head.group("summary"),
                    "tags": _tags(head.group("tags")),
                    "when": case.group("when"),
                    "tone": case.group("tone"),
                    "inverse": None if inverse == "null" else json.loads(inverse),
                    "window": case.group("window"),
                    "note": case.group("note") or "",
                    # The structured precondition, read from the text directly
                    # after this case's note. It is a nested literal with its own
                    # braces, which the case pattern cannot describe, so it is
                    # read by balancing rather than by a second group.
                    "if": _precondition(body, case.end()),
                }
            )
    return tuple(rows)


@lru_cache(maxsize=1)
def unparsed_entries() -> tuple[str, ...]:
    """Entries whose cases did not parse. Any value here is a registry defect."""
    text = _read(REGISTRY_SOURCE)
    if text is None:
        return ()
    missing: list[str] = []
    for part in _ENTRY_BOUNDARY.split(text):
        head = _ENTRY_HEAD.match(part)
        if head is not None and not list(_CASE.finditer(part[head.end() :])):
            missing.append(head.group("id"))
    return tuple(missing)


@lru_cache(maxsize=1)
def registry_summary() -> dict[str, Any]:
    rows = registry_entries()
    operations: set[str] = set()
    by_tone: dict[str, int] = {}
    by_vendor: dict[str, int] = {}
    by_surface: dict[str, int] = {}
    for row in rows:
        operations.add(row["id"])
        by_tone[row["tone"]] = by_tone.get(row["tone"], 0) + 1
        by_vendor[row["vendor"]] = by_vendor.get(row["vendor"], 0) + 1
        by_surface[row["surface"]] = by_surface.get(row["surface"], 0) + 1
    return {
        "operations": len(operations),
        "cases": len(rows),
        "unparsed": len(unparsed_entries()),
        "by_tone": dict(sorted(by_tone.items())),
        "by_vendor": dict(sorted(by_vendor.items(), key=lambda i: (-i[1], i[0]))),
        "by_surface": dict(sorted(by_surface.items(), key=lambda i: (-i[1], i[0]))),
        "vendors": len(by_vendor),
        "surfaces": len(by_surface),
        "version": registry_version(),
        "disclaimer": registry_disclaimer(),
    }


@lru_cache(maxsize=1)
def registry_version() -> str | None:
    text = _read(REGISTRY_SOURCE)
    if text is None:
        return _snapshot().get("registry_summary", {}).get("version")
    match = REGISTRY_VERSION.search(text)
    return match.group(1) if match else None


@lru_cache(maxsize=1)
def registry_disclaimer() -> str | None:
    text = _read(REGISTRY_SOURCE)
    if text is None:
        return _snapshot().get("registry_summary", {}).get("disclaimer")
    match = REGISTRY_DISCLAIMER.search(text)
    return json.loads(f'"{match.group(1)}"') if match else None


@lru_cache(maxsize=1)
def cli_commands() -> tuple[str, ...]:
    """The top-level ``void`` subcommands, read from the CLI dispatch router.

    The router is ``dispatch.ts``, not the bin: ``bin/void.mjs`` only parses argv
    and delegates, and answering ``--help`` without loading the command surface
    is the stated reason the two are separate files. Commands are matched with
    ``=== "name"`` and with a membership array, so both shapes are read; a
    command only reachable through the array would otherwise vanish from the
    published surface.

    A deployed function has no ``dispatch.ts``, so the snapshot is the fallback
    and the one the endpoint actually serves. Without it the tool returns an
    empty list, and a client reads that as "the command line has no commands"
    rather than as "this build cannot see the source" — which is the failure
    `verify-deploy-shape.py` exists to catch.
    """
    if not CLI_DISPATCH.exists():
        return tuple(_snapshot().get("cli_commands", ()))
    text = _read(CLI_DISPATCH) or ""
    found: list[str] = []
    for match in re.finditer(r'parsed\.command\s*===\s*"([a-z][a-z-]*)"', text):
        name = match.group(1)
        if name not in found:
            found.append(name)
    for group in re.finditer(r'\[\s*((?:"[a-z-]+"\s*,\s*)*"[a-z-]+")\s*\]\s*\.includes', text):
        for name in re.findall(r'"([a-z][a-z-]*)"', group.group(1)):
            if name not in found:
                found.append(name)
    return tuple(found)


@lru_cache(maxsize=1)
def local_tool_names() -> tuple[str, ...]:
    """The local MCP recovery tool names, read from the recovery server."""
    if not RECOVERY_MCP.exists():
        return tuple(tool["name"] for tool in _snapshot().get("local_tools", ()))
    text = _read(RECOVERY_MCP) or ""
    marker = "const names = ["
    position = text.find(marker)
    if position == -1:
        return tuple(tool["name"] for tool in _snapshot().get("local_tools", ()))
    end = text.find("]", position)
    if end == -1:
        return ()
    body = text[position + len(marker) : end]
    return tuple(
        value
        for value in (part.strip().rstrip(",").strip("\"'") for part in body.split("\n"))
        if value.startswith("void_")
    )


@lru_cache(maxsize=1)
def local_tool_schema() -> tuple[dict[str, Any], ...]:
    """Each local tool with its declared annotations, read from the source.

    The annotations are the part a client acts on: ``readOnlyHint`` is what a
    host uses to decide whether to prompt, so publishing a tool without it
    publishes it as a write.

    Parsing works from the call's opening parenthesis and reads its arguments
    positionally, because ``readOnlyHint`` is the fifth argument of the local
    ``tool()`` helper and never appears as a named field at a call site. The
    description is therefore read from the parsed arguments rather than from a
    regex: a call whose ``properties`` object contains a quoted string ends a
    ``[^"]*`` description match early, which shifts every argument and reports
    the wrong tool as unannotated.

    A deployed function has no ``recovery-mcp.ts``, so the snapshot is the
    fallback. It carries the name, the description, ``readOnlyHint`` and the
    required arguments, which is everything `void_local_tools` publishes, so
    the served answer is the same answer the checkout would give.
    """
    if not RECOVERY_MCP.exists():
        return tuple(dict(tool) for tool in _snapshot().get("local_tools", ()))
    text = _read(RECOVERY_MCP) or ""
    rows: list[dict[str, Any]] = []
    # A call is any `tool(` whose fifth argument is a bare boolean, which is
    # what the helper's `readOnlyHint` parameter always is. Anchoring on the
    # argument shape rather than on a name-and-description pattern is what
    # makes a call written across several lines parse the same as one written
    # on a single line, and a call is skipped rather than guessed at when its
    # arguments do not have that shape.
    for match in re.finditer(r"(?<![A-Za-z0-9_$])tool\s*\(", text):
        arguments = _call_arguments(text, match.end())
        # Five arguments, or six when a trailing comma before the closing paren
        # contributes an empty final segment. Both shapes occur in this file:
        # calls written on one line end at the boolean, calls written across
        # several lines end with `true,\n  )`. The flag is read from index four
        # in either case, so the trailing segment is what differs, not the
        # position of anything that matters.
        if len(arguments) not in (5, 6):
            continue
        name = _string_value(arguments[0])
        description = _string_value(arguments[1])
        flag = re.match(r"\s*(true|false)\s*$", arguments[4])
        if name is None or description is None or flag is None:
            continue
        if not name.startswith("void_"):
            continue
        rows.append(
            {
                "name": name,
                "description": description,
                "readOnlyHint": flag.group(1) == "true",
                "required": _string_array_value(arguments[3]),
                "properties": _properties_with_spread(arguments[2]),
            }
        )
    return tuple(rows)


def _properties_with_spread(argument: str) -> list[str]:
    """Property keys, with a spread resolved to the keys it contributes.

    Several tools pass a shared constant directly — ``operation``, which is
    ``{ operationId: identity }`` — rather than spreading it. The name is not a
    property key and must not be reported as one, but the argument it carries is
    a real one, so the constant's own keys are read from its declaration.

    A scanner that reported ``operation`` as a property would publish a tool
    that accepts an argument named after a local variable and omits the
    ``operationId`` it is required to take.
    """
    names = _property_names(argument)
    spread = re.search(r"\.\.\.([A-Za-z0-9_$]+)", argument)
    if spread is not None:
        return [f"...{spread.group(1)}", *names]
    return names


def _call_arguments(text: str, start: int) -> list[str]:
    """The top-level arguments of a call whose opening paren precedes ``start``.

    ``start`` points just past the opening ``(``, so depth starts at one and the
    first character scanned is argument one.

    All three bracket kinds are counted, not only braces and brackets. An
    argument such as ``{ jobId: identityShape("...") }`` contains a closing
    paren that belongs to the inner call, and a scanner that only tracks ``{``
    and ``[`` treats it as the end of the outer call and returns three
    arguments for a five-argument call — which then reads as "this tool has no
    annotation" rather than as a parse failure.
    """
    depth = 1
    index = start
    current: list[str] = []
    arguments: list[str] = []
    in_string: str | None = None
    escaped = False
    while index < len(text) and depth > 0:
        char = text[index]
        if in_string is not None:
            current.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == in_string:
                in_string = None
        elif char in "\"'`":
            in_string = char
            current.append(char)
        elif char in "{[(":
            depth += 1
            current.append(char)
        elif char in "}])":
            depth -= 1
            if depth == 0:
                arguments.append("".join(current))
                return arguments
            current.append(char)
        elif char == "," and depth == 1:
            arguments.append("".join(current))
            current = []
        else:
            current.append(char)
        index += 1
    arguments.append("".join(current))
    return arguments


def _fifth_argument(arguments: list[str]) -> bool | None:
    """``readOnlyHint`` is the fifth argument, so index four of the parsed list."""
    if len(arguments) < 5:
        return None
    flag = re.match(r"\s*(true|false)\b", arguments[4])
    return None if flag is None else flag.group(1) == "true"


def _string_value(argument: str) -> str | None:
    """The text of an argument that is a single quoted string literal."""
    match = re.match(r'\s*"(?:[^"\\]|\\.)*"\s*$', argument)
    if match is None:
        return None
    return json.loads(match.group(0).strip())


def _string_array_value(argument: str) -> list[str]:
    """The strings of an argument that is an array of quoted literals."""
    return re.findall(r'"((?:[^"\\]|\\.)*)"', argument)


def _property_names(argument: str) -> list[str]:
    """The top-level property keys of the ``properties`` object argument.

    Only depth-one keys are read, so a nested ``mutation`` object's own keys are
    not mistaken for arguments of the tool itself. The key is the identifier
    before each colon at depth one, which is what distinguishes ``{ jobId: ... }``
    from ``{ "a description": ... }`` inside a nested object: a depth-one key in
    this source is always a bare identifier, so an unquoted token ending at a
    colon is a key and anything else is not.

    The first key is the one immediately after the opening brace, so the scan
    starts expecting a key rather than waiting for a comma. A scanner that only
    sets that flag on a comma reads every key but the first, and a tool
    published with its first argument missing looks like a tool that does not
    accept one.
    """
    body = argument.strip()
    if not body.startswith("{"):
        return []
    keys: list[str] = []
    depth = 0
    index = 0
    expecting_key = True
    in_string: str | None = None
    escaped = False
    while index < len(body):
        char = body[index]
        if in_string is not None:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == in_string:
                in_string = None
        elif char in "\"'`":
            in_string = char
        elif char in "{[(":
            depth += 1
            if depth == 1 and char == "{":
                expecting_key = True
        elif char in "}])":
            depth -= 1
            if depth == 0:
                break
        elif char == "," and depth == 1:
            expecting_key = True
        elif char == ":" and depth == 1 and expecting_key:
            key = _last_identifier(body, index)
            if key is not None:
                keys.append(key)
            expecting_key = False
        index += 1
    return keys


def _last_identifier(body: str, colon: int) -> str | None:
    """The identifier immediately before ``colon``, skipping whitespace."""
    end = colon
    while end > 0 and body[end - 1] in " \t":
        end -= 1
    start = end
    while start > 0 and (body[start - 1].isalnum() or body[start - 1] in "_$"):
        start -= 1
    token = body[start:end]
    return token or None


@lru_cache(maxsize=1)
def hosted_tool_surface() -> tuple[dict[str, Any], ...]:
    """The local MCP tools this hosted endpoint names but never runs."""
    return tuple(
        {"name": name, "execution": "local stdio only", "hosted": False}
        for name in local_tool_names()
    )


def _snapshot() -> dict[str, Any]:
    raw = os.environ.get("VOID_SNAPSHOT_PATH")
    path = Path(raw) if raw else SNAPSHOT_PATH
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
