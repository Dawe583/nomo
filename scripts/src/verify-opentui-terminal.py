#!/usr/bin/env python3
"""Capture local, credential-free NOMO TUI frames across panels and terminal modes."""
from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")
if not NODE:
    raise SystemExit("PTY verification requires node on PATH")

PANELS = {
    "chat": "chat",
    "overview-runs": "runs",
    "sessions": "sessions",
    "documents": "documents",
    "ledger": "ledger",
    "approvals": "approvals",
    "policy": "policy",
    "tools": "tools",
    "models": "models",
    "settings": "chat",
    "usage": "usage",
    "help": "help",
}
VIEW_MARKERS = {
    "chat": "workspace",
    "overview-runs": "RUNS ·",
    "sessions": "SESSIONS ·",
    "documents": "Documents",
    "ledger": "Ledger",
    "approvals": "Approvals",
    "policy": "POLICY,",
    "tools": "Tools",
    "models": "MODELS ·",
    "settings": "APPLICATION SETTINGS",
    "usage": "USAGE,",
    "help": "HELP,",
}
if set(VIEW_MARKERS) != set(PANELS) or len(set(VIEW_MARKERS.values())) != len(PANELS):
    raise SystemExit("each PTY panel needs one unique view marker")


def assert_requested_view(name: str, rows: list[str]) -> None:
    marker = VIEW_MARKERS[name]
    screen = strip_ansi("\n".join(rows))
    if marker.casefold() not in screen.casefold():
        raise RuntimeError(
            f"{name}: final rendered frame lacks view marker {marker!r}; "
            f"output={screen[-1200:]}"
        )


VIEWPORTS = ((40, 12), (80, 24), (160, 45))
MODES = (("color", False), ("no-color", True))
CAPTURES = Path(tempfile.mkdtemp(prefix="nomo-tui-pty-captures-"))


def strip_ansi(value: bytes | str) -> str:
    text = value.decode("utf-8", "replace") if isinstance(value, bytes) else value
    return re.sub(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))", "", text)


def screen_rows(value: bytes) -> list[str]:
    text = value.decode("utf-8", "replace")
    rows: dict[int, str] = {}
    for match in re.finditer(r"\x1b\[(\d+);1H(.*?)\x1b\[K", text, re.DOTALL):
        rows[int(match.group(1))] = match.group(2)
    if not rows:
        return []
    return [rows.get(row, "") for row in range(1, max(rows) + 1)]


def save_case(name: str, view: str, width: int, height: int, no_color: bool) -> None:
    case = f"{name}-{width}x{height}-{'no-color' if no_color else 'color'}"
    with tempfile.TemporaryDirectory(prefix="nomo-tui-pty-", dir=CAPTURES) as data:
        data_dir = Path(data) / "data"
        env = {
            "PATH": os.environ["PATH"],
            "HOME": data,
            "NOMO_DATA_DIR": str(data_dir),
            "TERM": "xterm-256color",
            "NOMO_TUI_COLOR": "0" if no_color else "1",
            "NOMO_TUI_MOTION": "0",
        }
        if no_color:
            env["NO_COLOR"] = "1"
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
        process = subprocess.Popen(
            [NODE, "packages/cli/bin/nomo.mjs", "tui", "--view", view],
            cwd=ROOT,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 12
        try:
            while time.monotonic() < deadline and not screen_rows(output):
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
                if process.poll() is not None:
                    break
            if not screen_rows(output):
                raise RuntimeError(
                    f"{case}: TUI did not render a frame; exit={process.poll()}; "
                    f"output={strip_ansi(bytes(output[-1200:]))}"
                )
            if name == "settings":
                marker = VIEW_MARKERS[name]
                os.write(master, b"/settings\r")
                settings_deadline = time.monotonic() + 3
                while time.monotonic() < settings_deadline:
                    screen = strip_ansi("\n".join(screen_rows(output)))
                    if marker.casefold() in screen.casefold():
                        break
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            output.extend(os.read(master, 65536))
                        except OSError:
                            break
                else:
                    raise RuntimeError(
                        f"{case}: Settings command did not render marker "
                        f"{marker!r}; output={strip_ansi(bytes(output[-1200:]))}"
                    )
            time.sleep(0.1)
            if select.select([master], [], [], 0)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    pass
            rows = screen_rows(output)
            if not rows:
                raise RuntimeError(f"{case}: PTY output contained no rendered rows")
            assert_requested_view(name, rows)
            (CAPTURES / f"{case}.frame.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            (CAPTURES / f"{case}.screen.txt").write_text(
                strip_ansi("\n".join(rows)), encoding="utf-8"
            )
            (CAPTURES / f"{case}.pty.ansi").write_bytes(bytes(output))
            os.write(master, b"\x03")
            first_press_deadline = time.monotonic() + 0.3
            while time.monotonic() < first_press_deadline and process.poll() is None:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            os.write(master, b"\x03")
            exit_deadline = time.monotonic() + 8
            while time.monotonic() < exit_deadline and process.poll() is None:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if process.poll() is None:
                raise RuntimeError(f"{case}: double Ctrl+C did not exit; output={strip_ansi(bytes(output[-1200:]))}")
            process.wait()
            (CAPTURES / f"{case}.pty.ansi").write_bytes(bytes(output))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
            os.close(master)


def capture_double_left() -> None:
    name = "chat-double-left-sessions"
    with tempfile.TemporaryDirectory(prefix="nomo-tui-left-", dir=CAPTURES) as data:
        env = {
            "PATH": os.environ["PATH"],
            "HOME": data,
            "NOMO_DATA_DIR": str(Path(data) / "data"),
            "TERM": "xterm-256color",
            "NOMO_TUI_MOTION": "0",
            "NOMO_TUI_COLOR": "0",
            "NO_COLOR": "1",
        }
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        process = subprocess.Popen(
            [NODE, "packages/cli/bin/nomo.mjs", "tui", "--view", "chat"],
            cwd=ROOT,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        output = bytearray()
        deadline = time.monotonic() + 12
        try:
            while time.monotonic() < deadline and not screen_rows(output):
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if not screen_rows(output):
                raise RuntimeError(
                    f"double-Left PTY: Chat did not render; "
                    f"output={strip_ansi(bytes(output[-1200:]))}"
                )
            os.write(master, b"\x1b[D")
            single_left_deadline = time.monotonic() + 0.14
            while time.monotonic() < single_left_deadline:
                remaining = single_left_deadline - time.monotonic()
                if not select.select([master], [], [], remaining)[0]:
                    break
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            chat_rows = screen_rows(output)
            single_left_screen = strip_ansi("\n".join(chat_rows))
            if "← Sessions ×2" not in single_left_screen:
                raise RuntimeError("single Left did not remain in Chat")
            if (
                "No conversations yet." in single_left_screen
                or "← Chat" in single_left_screen
            ):
                raise RuntimeError("single Left unexpectedly opened Sessions")
            previous_screen = chat_rows
            os.write(master, b"\x1b[D")
            frame_deadline = time.monotonic() + 3
            while time.monotonic() < frame_deadline and screen_rows(output) == previous_screen:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if screen_rows(output) == previous_screen:
                raise RuntimeError("double-Left PTY: second key did not redraw")
            while select.select([master], [], [], 0)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
            rows = screen_rows(output)
            screen = strip_ansi("\n".join(rows))
            if "No conversations yet." not in screen:
                raise RuntimeError("double-Left PTY: final rendered frame did not open Sessions")
            (CAPTURES / f"{name}.frame.json").write_text(
                json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            (CAPTURES / f"{name}.screen.txt").write_text(screen, encoding="utf-8")
            os.write(master, b"\x03")
            first_press_deadline = time.monotonic() + 0.3
            while time.monotonic() < first_press_deadline and process.poll() is None:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            os.write(master, b"\x03")
            exit_deadline = time.monotonic() + 8
            while time.monotonic() < exit_deadline and process.poll() is None:
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        output.extend(os.read(master, 65536))
                    except OSError:
                        break
            if process.poll() is None:
                raise RuntimeError(f"double-Left PTY: double Ctrl+C did not exit; output={strip_ansi(bytes(output[-1200:]))}")
            process.wait()
            (CAPTURES / f"{name}.pty.ansi").write_bytes(bytes(output))
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
            os.close(master)


for panel, view in PANELS.items():
    for width, height in VIEWPORTS:
        for mode, no_color in MODES:
            save_case(panel, view, width, height, no_color)

capture_double_left()
manifest = {
    "root": str(CAPTURES),
    "viewports": [f"{width}x{height}" for width, height in VIEWPORTS],
    "modes": [mode for mode, _ in MODES],
    "panels": list(PANELS),
    "captures": sorted(path.name for path in CAPTURES.iterdir() if path.is_file()),
}
(CAPTURES / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(f"PTY captures: {CAPTURES}")
print(f"Captured {len(manifest['captures'])} files for {len(PANELS)} panels, 3 viewports, and 2 color modes.")
