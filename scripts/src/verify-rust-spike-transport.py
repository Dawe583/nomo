#!/usr/bin/env python3
"""Real-PTY transport proof for the isolated Rust Help spike."""
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


def read_port(process, timeout=5):
    deadline = time.monotonic() + timeout
    data = bytearray()
    while time.monotonic() < deadline:
        if not select.select([process.stdout], [], [], 0.1)[0]:
            continue
        chunk = os.read(process.stdout.fileno(), 256)
        if not chunk:
            break
        data.extend(chunk)
        if b"\n" in data:
            line = data.splitlines()[0].decode()
            assert line.startswith("PORT "), f"unexpected server banner: {line}"
            return int(line.split()[1])
    raise AssertionError("fixture server did not publish a port")


def run_case(columns=80, rows=24):
    directory = Path(tempfile.mkdtemp(prefix="nomo-rust-transport-"))
    server = subprocess.Popen(
        ["node", "scripts/src/tui-protocol-fixture-server.mjs"],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    master = slave = None
    process = None
    try:
        port = read_port(server)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(directory),
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
        }
        process = subprocess.Popen(
            [
                str(ROOT / "scripts/tui-rs-spike/target/debug/nomo-tui-rs-spike"),
                "interactive",
                str(columns),
                str(rows),
                f"--snapshot={ROOT / 'scripts/tui-rs-spike/fixtures/snapshot.json'}",
                f"--connect=127.0.0.1:{port}",
            ],
            cwd=ROOT,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        slave = None
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
        def wait_for(marker, timeout=5):
            deadline = time.monotonic() + timeout
            while marker not in screen.text() and time.monotonic() < deadline:
                pump(0.1)
            assert marker in screen.text(), f"missing {marker}\n{screen.text()}"
        wait_for("host-fixture-live/host")
        wait_for("status running")
        wait_for("live transcript visible")
        assert "█" in screen.text(), "live scrollbar thumb did not render"
        os.write(master, b"g")
        wait_for("tool Host run started")
        assert "live transcript 00" in screen.text(), "top scroll did not expose the oldest assistant row"
        pump(0.7)
        assert "tool Host run started" in screen.text(), "appended rows moved the anchored top viewport"
        os.write(master, b"G")
        wait_for("live transcript visible")
        os.write(master, b"s")
        wait_for("status cancelled", timeout=8)
        os.write(master, b"i")
        os.write(master, b"\x1b[200~hello\nrust composer\x1b[201~")
        wait_for("prompt> hello⏎rust composer")
        os.write(master, b"\r")
        wait_for("assistant live transcript visible: hello⏎rust composer", timeout=8)
        os.write(master, b"[")
        wait_for("assistant live transcript visible: Produce the fixture-live", timeout=5)
        os.write(master, b"]")
        wait_for("assistant live transcript visible: hello⏎rust composer", timeout=5)
        assert "tokens 0" in screen.text(), "host session token count did not render"
        assert "page " in screen.text(), "live transcript page count did not render"
        assert screen.overflow == 0, f"terminal rows overflowed: {screen.overflow}"
        os.write(master, b"q")
        deadline = time.monotonic() + 5
        while process.poll() is None and time.monotonic() < deadline:
            pump(0.1)
        assert process.poll() == 0, "q did not exit the transport spike"
        pump(0.2)
        assert b"\x1b[?1049l" in output, "alternate screen was not restored"
    finally:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        if master is not None:
            os.close(master)
        if slave is not None:
            os.close(slave)
        server.terminate()
        try:
            server.wait(timeout=2)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait()
        shutil.rmtree(directory, ignore_errors=True)
    print(f"PASS: Rust spike Workbench TCP transport updates at {columns}x{rows}", flush=True)


def main():
    subprocess.run(
        ["cargo", "build", "--offline", "--quiet"],
        cwd=ROOT / "scripts/tui-rs-spike",
        check=True,
    )
    run_case()
    print("PASS: Rust spike real-Workbench bounded transport prototype", flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
