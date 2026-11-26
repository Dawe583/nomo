#!/usr/bin/env python3
"""Bounded real-PTY smoke for the isolated Rust Help spike."""
import fcntl
import importlib.util
import os
from pathlib import Path
import pty
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "nomo_tui_vt", ROOT / "scripts/src/verify-tui-terminal.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def run_case(columns, rows):
    directory = Path(tempfile.mkdtemp(prefix="nomo-rust-spike-pty-"))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(directory),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
    }
    process = subprocess.Popen(
        [str(ROOT / "scripts/tui-rs-spike/target/debug/nomo-tui-rs-spike"), "interactive", str(columns), str(rows)],
        cwd=ROOT,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    screen = MODULE.Screen(columns, rows)
    output = bytearray()
    def pump(seconds=0.1):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([master], [], [], 0.02)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError:
                return
            if not chunk:
                return
            output.extend(chunk)
            screen.feed(chunk)
    try:
        deadline = time.monotonic() + 5
        while "NOMO" not in screen.text() and time.monotonic() < deadline:
            pump(0.1)
        visible = screen.text()
        assert "NOMO" in visible, "interactive frame did not render"
        assert ("HELP" in visible or "QUICK KEYS" in visible), "help body did not render"
        assert screen.overflow == 0, f"terminal rows overflowed: {screen.overflow}"
        assert b"\x1b[?1049h" in output, "alternate screen was not entered"
        os.write(master, b"q")
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            pump(0.1)
        assert process.poll() == 0, "q did not exit the interactive spike"
        pump(0.2)
        assert b"\x1b[?1049l" in output, "alternate screen was not restored"
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        shutil.rmtree(directory, ignore_errors=True)
    print(f"PASS: Rust spike real PTY smoke at {columns}x{rows}", flush=True)


def main():
    subprocess.run(
        ["cargo", "build", "--offline", "--quiet"],
        cwd=ROOT / "scripts/tui-rs-spike",
        check=True,
    )
    for columns, rows in [(40, 12), (80, 24), (120, 40)]:
        run_case(columns, rows)
    print("PASS: Rust spike real PTY smoke matrix", flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
