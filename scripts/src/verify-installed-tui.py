#!/usr/bin/env python3
"""Smoke the packed TUI through its installed bin launcher in a real PTY.

The verifier intentionally uses the `.bin` launcher rather than the JavaScript
target: a tarball is not packaged for a consumer until the executable npm
installs can start the interactive program and restore the terminal on exit.
"""
import fcntl
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

USAGE = "usage: python3 scripts/src/verify-installed-tui.py <installed-nomo-launcher>"


def main(argv):
    if len(argv) != 2 or argv[1].startswith("-"):
        print(USAGE, file=sys.stderr)
        return 2
    launcher = Path(argv[1]).resolve()
    if not launcher.exists():
        print(f"installed launcher does not exist: {launcher}", file=sys.stderr)
        return 2

    directory = Path(tempfile.mkdtemp(prefix="nomo-installed-tui-"))
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(directory),
        "NOMO_DATA_DIR": str(directory),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "NOMO_TUI_MOTION": "0",
    }
    process = subprocess.Popen(
        [str(launcher), "tui"],
        cwd=directory,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    output = bytearray()
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and (
            b"\x1b[?2004h" not in output or b"NOMO" not in output or b"Draft" not in output
        ):
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
        assert b"\x1b[?2004h" in output, "installed TUI never entered interactive mode"
        assert b"NOMO" in output, "installed TUI did not render the NOMO header"
        assert b"Draft" in output, "installed TUI did not render the composer"

        os.write(master, b"\t")
        time.sleep(0.2)
        os.write(master, b"\x04")
        time.sleep(0.2)
        assert process.poll() is None, "one Ctrl+D exited the installed TUI"
        os.write(master, b"\x04")
        deadline = time.monotonic() + 15
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
        assert process.poll() == 0, "double Ctrl+D did not exit the installed TUI cleanly"
        process.wait(timeout=1)
        while select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 65536))
        assert b"NOMO: stopping" in output, "stopping message was not emitted"
        assert b"\x1b[?1049l" in output, "alternate screen was not restored"
        assert b"\x1b[?2004l" in output, "bracketed paste was not restored"
        restored = termios.tcgetattr(slave)
        restored[3] &= ~getattr(termios, "PENDIN", 0)
        original[3] &= ~getattr(termios, "PENDIN", 0)
        assert restored == original, "termios was not restored"
        print("PASS: installed launcher renders the TUI and restores the terminal", flush=True)
        return 0
    except AssertionError as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 1
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
