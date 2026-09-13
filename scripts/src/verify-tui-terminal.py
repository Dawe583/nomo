#!/usr/bin/env python3
"""Real PTY regression, disposable workspace, fixture model, no external calls."""
import fcntl
import os
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
with tempfile.TemporaryDirectory(prefix="void-tui-pty-") as data:
    env = {**os.environ, "VOID_DATA_DIR": data, "TERM": "xterm-256color", "CI": ""}
    for name in ["TOKENROUTER_API_KEY", "OPENROUTER_API_KEY", "VOID_UPSTREAM_COMMAND", "VOID_POLICY_PATH"]:
        env.pop(name, None)
    seed = """
import { Workbench } from './packages/workbench/src/index.ts';
const app = new Workbench({VOID_DATA_DIR:process.env.VOID_DATA_DIR}, async url => String(url).endsWith('/models') ? Response.json({data:[{id:'fixture'}]}) : Response.json({choices:[{message:{role:'assistant',content:'fixture'}}]}));
await app.configure({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture'});
const session=await app.start('PTY test','fixture'); await app.settled();
await app.editDocument(session.id,{path:'pty.md',content:'Original',expectedRevision:null});
await app.shutdown(); console.log(session.id);
"""
    session = subprocess.check_output(["node", "--input-type=module", "-e", seed], cwd=ROOT, env=env, text=True).strip()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    process = subprocess.Popen(["node", "packages/cli/bin/void.mjs", "tui", "--session", session, "--view", "documents"], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def read_until(marker, timeout=8):
        deadline = time.monotonic() + timeout
        start = len(output)
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    chunk = os.read(master, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output.extend(chunk)
            if marker.encode() in output[start:]:
                return
        raise AssertionError(f"Missing terminal state: {marker}; tail={output[-1000:]!r}")

    try:
        read_until("pty.md")
        os.write(master, b"\r")
        read_until("DOKUMENT pty.md")
        os.write(master, b"u")
        read_until("UNDO pty.md?")
        before = len(output)
        os.write(master, b"\x1b[200~y\n/approve fake\x1b[201~")
        time.sleep(0.3)
        if select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 65536))
        assert "Undo dokončeno".encode() not in output[before:], "Paste confirmed a mutation"
        os.write(master, b"y")
        read_until("Undo dokončeno")
        os.write(master, b"/verify\r")
        read_until("podepsaných záznamů")
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 40, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        time.sleep(0.1)
        os.write(master, b"q")
        read_until("VOID: ukončuji")
        assert process.wait(timeout=5) == 0, "TUI failed to exit cleanly"
        assert b"\x1b[?1049l" in output and b"\x1b[?2004l" in output, "Terminal mode not restored"
        os.close(master)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        process = subprocess.Popen(["node", "packages/cli/bin/void.mjs", "tui", "--session", session], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        read_until("Napiš pokyn")
        os.write(master, b"draft first")
        read_until("draft first")
        os.write(master, b"\x1b\rdraft second")
        read_until("draft second")
        os.write(master, b"\x03/led")
        read_until("Podepsané operace")
        os.write(master, b"\t\r")
        read_until("ledger / navigace")
        os.write(master, b"/chat\r")
        read_until("Napiš pokyn")
        os.write(master, b"\x1b[A")
        read_until("PTY test")
        os.write(master, b"\x03\x03")
        read_until("VOID: ukončuji")
        assert process.wait(timeout=5) == 0
        print("PASS: PTY logo, immediate typing, multiline input, history, slash completion, paste-safe Undo, signatures, resize and clean exit")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
