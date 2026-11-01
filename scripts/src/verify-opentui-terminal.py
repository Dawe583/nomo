"""Isolated OpenTUI PTY smoke: launch, keyboard, monochrome, and terminal restore."""
import fcntl
import os
import shutil
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
CLI_BIN = Path(os.environ.get("NOMO_TUI_BIN", ROOT / "packages/cli/bin/nomo.mjs")).resolve()
CLI_CWD = Path(os.environ.get("NOMO_TUI_CWD", ROOT)).resolve()
BUN = shutil.which("bun")
NODE = shutil.which("node")
if not BUN or not NODE:
    raise SystemExit("OpenTUI verification requires Node and Bun on PATH")

with tempfile.TemporaryDirectory(prefix="nomo-opentui-pty-") as data:
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = {
        "PATH": os.environ["PATH"],
        "HOME": data,
        "NOMO_DATA_DIR": str(Path(data) / "data"),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "NOMO_TUI_COLOR": "0",
        "NOMO_TUI_MOTION": "0",
    }
    process = subprocess.Popen(
        [NODE, str(CLI_BIN), "tui"],
        cwd=CLI_CWD,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()

    def read_until(markers, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
                if any(marker.encode() in output for marker in markers):
                    return
            if process.poll() is not None:
                break
        tail = bytes(output[-1200:]).decode("utf-8", "replace")
        raise AssertionError(f"expected one of {markers!r}; tail={tail}")

    try:
        read_until(["NOMO", "No provider", "No messages yet"])
        assert b"\x1b[?1049h" in output, "OpenTUI did not acquire alternate screen"
        assert b"\x1b[?2004h" in output, "OpenTUI did not enable bracketed paste"
        os.write(master, b"\x03")
        read_until(["Press Ctrl+C again to exit."])
        assert process.poll() is None, "first Ctrl+C exited the TUI"
        os.write(master, b"\x03")
        deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
        assert process.wait(timeout=2) == 0, "double Ctrl+C did not exit cleanly"
        assert b"\x1b[?1049l" in output, "alternate screen was not restored"
        assert b"\x1b[?2004l" in output, "bracketed paste was not restored"
        restored = termios.tcgetattr(master)
        assert restored[3] & termios.ICANON, "canonical mode was not restored"
        print("PASS: OpenTUI PTY launch, color option, keyboard input, double Ctrl+C and terminal restoration")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
