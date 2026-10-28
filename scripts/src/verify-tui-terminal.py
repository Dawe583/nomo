#!/usr/bin/env python3
"""Real PTY regression, disposable workspace, fixture model, no external calls."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="nomo-tui-pty-") as data:
    env = {"PATH": os.environ["PATH"], "HOME": data, "NOMO_DATA_DIR": data,
           "TERM": "xterm-256color", "NO_COLOR": "1"}
    seed = """
import { Workbench } from './packages/workbench/src/index.ts';
const app = new Workbench({NOMO_DATA_DIR:process.env.NOMO_DATA_DIR}, async url => String(url).endsWith('/models') ? Response.json({data:[{id:'fixture'}]}) : Response.json({choices:[{message:{role:'assistant',content:'fixture'}}]}));
await app.configure({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture'});
const session=await app.start('PTY test','fixture'); await app.settled();
await app.editDocument(session.id,{path:'pty.md',content:'Original',expectedRevision:null});
await app.shutdown(); console.log(session.id);
"""
    session = subprocess.check_output(["node", "--input-type=module", "-e", seed], cwd=ROOT, env=env, text=True).strip()
    observer = Path(data) / "frames.mjs"
    observer.write_text("""
import { WorkspaceInkRenderer } from '%s';
import { stripAnsi } from '%s';
const render = WorkspaceInkRenderer.prototype.render;
WorkspaceInkRenderer.prototype.render = function(frame, columns, rows) {
  const result = render.call(this, frame, columns, rows);
  const plain = stripAnsi(frame);
  void this.instance.waitUntilRenderFlush().then(() => {
    if (!plain.includes('Finishing operation'))
      process.stdout.write('\\x1b]777;nomo-test-ready\\x07');
  });
  return result;
};
""" % ((ROOT / "packages/cli/src/tui/workspace-ink.ts").as_uri(),
       (ROOT / "packages/cli/src/tui/layout.ts").as_uri()))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    process = subprocess.Popen(["node", "--import", str(observer), "packages/cli/bin/nomo.mjs", "tui", "--session", session, "--view", "documents"], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def read_until(marker, timeout=8, ready=False):
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
            found = output.find(marker.encode(), start)
            if found >= 0 and (not ready or b"nomo-test-ready" in output[found:]):
                return
        raise AssertionError(f"Missing terminal state: {marker}; tail={output[-1000:]!r}")

    try:
        read_until("pty.md", ready=True)
        assert re.search(
            rb"\x1b\[(?:[0-9]+;)*(?:3[0-7]|9[0-7]|38;(?:5;\d+|2;\d+;\d+;\d+))m",
            output,
        ), "Inherited NO_COLOR disabled TUI colors"
        os.write(master, b"\r")
        read_until("RAW RECORD", ready=True)
        os.write(master, b"u")
        read_until("UNDO pty.md?", ready=True)
        before = len(output)
        os.write(master, b"\x1b[200~y\n/approve fake\x1b[201~")
        time.sleep(0.3)
        if select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 65536))
        assert "Undo completed".encode() not in output[before:], "Paste confirmed a mutation"
        os.write(master, b"y")
        read_until("Undo completed", ready=True)
        os.write(master, b"/verify\r")
        read_until("signed entries", ready=True)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 40, 0, 0))
        os.kill(process.pid, signal.SIGWINCH)
        time.sleep(0.1)
        os.write(master, b"q")
        read_until("NOMO: stopping")
        assert process.wait(timeout=5) == 0, "TUI failed to exit cleanly"
        assert b"\x1b[?1049l" in output and b"\x1b[?2004l" in output, "Terminal mode not restored"
        os.close(master)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        process = subprocess.Popen(["node", "--import", str(observer), "packages/cli/bin/nomo.mjs", "tui", "--session", session], cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        read_until("PTY test", ready=True)
        os.write(master, b"draft first")
        read_until("draft first", ready=True)
        # Ink's incremental line diff writes only the changed suffix ("second" here).
        os.write(master, b"\x15draft second")
        read_until("second", ready=True)
        os.write(master, b"\x03/led")
        read_until("Signed operations", ready=True)
        os.write(master, b"\t\r")
        read_until("2 of 2 ledger entries verified", ready=True)
        os.write(master, b"/chat\r")
        read_until("PTY test", ready=True)
        os.write(master, b"\x1b[A")
        read_until("PTY test", ready=True)
        os.write(master, b"\x03/find PTY test\r")
        read_until("1 matching messages", ready=True)
        os.write(master, b"\x1b")
        read_until("PTY test", ready=True)
        os.write(master, b"/bottom\r")
        read_until("Following latest messages.", ready=True)
        os.write(master, b"/tools write\r")
        read_until("void_workspace_write", ready=True)
        os.write(master, b"\r")
        read_until("PROPERTIES", ready=True)
        # Escape clears a list filter before closing its detail. A diff renderer
        # does not resend unchanged tool text when only the filter notice changes.
        # Ink writes changed suffixes; the visible prefix may not recur in PTY bytes.
        os.write(master, b"\x1b")
        read_until("cleared.", ready=True)
        os.write(master, b"\x1b")
        read_until("void_workspace_write", ready=True)
        os.write(master, b"/chat\r")
        read_until("PTY test", ready=True)
        os.write(master, b"/expand\r")
        read_until("collapses results.", ready=True)
        os.write(master, b"\x0f")
        read_until("shows full results.", ready=True)
        redraw_start = len(output)
        os.write(master, b"\x0c")
        read_until("PTY test", ready=True)
        assert re.search(
            rb"\x1b\[(?:2)?K",
            output[redraw_start:],
        ), "Ctrl+L did not clear and redraw"
        os.write(master, b"\x12PTY test\r")
        read_until("1 matching messages", ready=True)
        os.write(master, b"\x1b")
        # Closing search changes the transcript, not the already visible tab label.
        read_until("PTY test", ready=True)
        os.write(master, b"\x15\x04")
        read_until("Press Ctrl+D again to exit.", ready=True)
        os.write(master, b"\x04")
        read_until("NOMO: stopping")
        assert process.wait(timeout=5) == 0
        print("PASS: PTY logo, typing, history, fuzzy commands, Ctrl+O, Ctrl+L, Ctrl+R, Ctrl+D, safe Undo and clean exit")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
with tempfile.TemporaryDirectory(prefix="nomo-tui-ctrl-c-") as data:
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
    env = {"PATH": os.environ["PATH"], "HOME": data, "NOMO_DATA_DIR": data,
           "TERM": "xterm-256color", "NOMO_TUI_MOTION": "0"}
    observer = Path(data) / "ready.mjs"
    observer.write_text("""
import { WorkspaceInkRenderer } from '%s';
const render = WorkspaceInkRenderer.prototype.render;
WorkspaceInkRenderer.prototype.render = function(frame, columns, rows) {
  const result = render.call(this, frame, columns, rows);
  void this.instance.waitUntilRenderFlush().then(() => process.stdout.write('\\x1b]777;nomo-empty-ready\\x07'));
  return result;
};
""" % (ROOT / "packages/cli/src/tui/workspace-ink.ts").as_uri())
    process = subprocess.Popen(["node", "--import", str(observer), "packages/cli/bin/nomo.mjs", "tui"],
                               cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave,
                               start_new_session=True)
    captured = bytearray()
    try:
        deadline = time.monotonic() + 8
        while b"nomo-empty-ready" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                captured.extend(os.read(master, 65536))
            assert process.poll() is None, "TUI exited before ready"
        assert b"nomo-empty-ready" in captured, "TUI never rendered its ready state"
        assert not termios.tcgetattr(slave)[3] & termios.ICANON, "TUI never entered raw mode"
        os.write(master, b"\x03")
        deadline = time.monotonic() + 3
        while b"NOMO: stopping" not in captured and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                captured.extend(os.read(master, 65536))
        assert b"NOMO: stopping" in captured, f"0x03 did not reach empty-composer quit handler: {captured[-500:]!r}"
        exit_code = process.wait(timeout=8)
        while select.select([master], [], [], 0)[0]:
            captured.extend(os.read(master, 65536))
        restored = termios.tcgetattr(slave)
        original[3] &= ~getattr(termios, "PENDIN", 0)
        restored[3] &= ~getattr(termios, "PENDIN", 0)
        assert exit_code == 0, f"empty-composer Ctrl+C exited {exit_code}"
        assert restored == original, "empty-composer Ctrl+C did not restore termios"
        assert b"\x1b[?1049l" in captured and b"\x1b[?2004l" in captured, "empty-composer Ctrl+C did not restore screen"
        print("PASS: empty-composer Ctrl+C exits cleanly and restores termios")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        os.close(master)
        os.close(slave)


# Keep the slave descriptor: escape bytes alone do not prove termios restoration.
with tempfile.TemporaryDirectory(prefix="nomo-tui-safety-") as data:
    preload = Path(data) / "fatal.mjs"
    preload.write_text("""
const write = process.stdout.write.bind(process.stdout);
let armed = false;
process.stdout.write = (...args) => {
  const result = write(...args);
  if (!armed && String(args[0]).includes('\\x1b[?2004h')) {
    armed = true;
    setImmediate(() => {
      if (process.env.NOMO_TEST_EXIT) process.exit(7);
      throw Error('fixture fatal terminal failure');
    });
  }
  return result;
};
""")
    for width, termination in [(40, "SIGINT"), (80, "SIGINT"), (120, "SIGTERM"), (200, "SIGHUP"), (80, "fatal"), (80, "exit")]:
        master, slave = pty.openpty()
        original = termios.tcgetattr(slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, width, 0, 0))
        env = {"PATH": os.environ["PATH"], "HOME": data, "NOMO_DATA_DIR": data,
               "TERM": "xterm-256color", "NO_COLOR": "1", "NOMO_TUI_MOTION": "0",
               "NOMO_TEST_EXIT": "1" if termination == "exit" else ""}
        command = ["node"]
        if termination in ["fatal", "exit"]:
            command.extend(["--import", str(preload)])
        command.extend(["packages/cli/bin/nomo.mjs", "tui"])
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=slave,
                                   stdout=slave, stderr=slave, start_new_session=True)
        captured = bytearray()
        try:
            deadline = time.monotonic() + 8
            sent = False
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    captured.extend(os.read(master, 65536))
                if b"\x1b[?2004h" in captured and not sent:
                    if termination not in ["fatal", "exit"]:
                        active = termios.tcgetattr(slave)
                        assert not active[3] & termios.ICANON, "TUI never entered raw mode"
                        os.kill(process.pid, getattr(signal, termination))
                    sent = True
                if process.poll() is not None:
                    break
            assert sent, f"{termination}: terminal never initialized"
            expected = 1 if termination == "fatal" else 7 if termination == "exit" else 0
            exit_code = process.wait(timeout=2)
            restored = termios.tcgetattr(slave)
            # PENDIN is transient kernel input state on macOS, not a terminal mode.
            restored[3] &= ~getattr(termios, "PENDIN", 0)
            original[3] &= ~getattr(termios, "PENDIN", 0)
            assert restored == original, f"{termination}: terminal attributes not restored"
            while select.select([master], [], [], 0)[0]:
                captured.extend(os.read(master, 65536))
            assert b"\x1b[?1049l" in captured and b"\x1b[?2004l" in captured
            if termination == "fatal":
                assert b"fixture fatal terminal failure" in captured
            assert exit_code == expected, f"{termination}: exit {exit_code}, expected {expected}"
            print(f"PASS: actual TUI {width} columns {termination}, termios and screen restored")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)

with tempfile.TemporaryDirectory(prefix="nomo-tui-cancel-") as data:
    preload = Path(data) / "runs.mjs"
    state = Path(data) / "cancelled.json"
    workspace_module = (ROOT / "packages/cli/src/tui/workspace.ts").as_uri()
    ink_module = (ROOT / "packages/cli/src/tui/workspace-ink.ts").as_uri()
    preload.write_text("""
import { WorkspaceTui } from '%s';
import { WorkspaceInkRenderer } from '%s';
import { writeFileSync } from 'node:fs';
let cancelKeySeen = false;
const render = WorkspaceInkRenderer.prototype.render;
WorkspaceInkRenderer.prototype.render = function(...args) {
  const result = render.apply(this, args);
  if (cancelKeySeen) {
    cancelKeySeen = false;
    void this.instance.waitUntilRenderFlush().then(() => process.stdout.write('NOMO_CANCEL_UI_FLUSHED'));
  }
  return result;
};
const inputOn = process.stdin.on.bind(process.stdin);
let keypressListeners = 0;
process.stdin.on = function(event, listener) {
  const result = inputOn(event, listener);
  if (event === 'keypress' && ++keypressListeners === 2) process.stdout.write('NOMO_CANCEL_READY');
  return result;
};
let calls = 0;
globalThis.fetch = async (url, options) => {
  const requestUrl = new URL(String(url));
  if (requestUrl.origin !== 'https://fixture.invalid' ||
      !['/v1/models', '/v1/chat/completions'].includes(requestUrl.pathname))
    throw new Error(`Unexpected non-fixture fetch in cancellation test: ${requestUrl.href}`);
  if (requestUrl.pathname === '/v1/models') return Response.json({data:[{id:'fixture'}]});
  if (++calls === 1) return Response.json({choices:[{message:{role:'assistant',content:'Selected reply'}}]});
  return new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
  });
};
const initialize = WorkspaceTui.prototype.initialize;
WorkspaceTui.prototype.initialize = async function () {
  await this.workbench.configure({baseUrl:'https://fixture.invalid/v1',apiKey:'fixture'});
  const first = await this.workbench.start('Selected run', 'fixture');
  await this.workbench.settled();
  const second = await this.workbench.start('Other run', 'fixture');
  this.sessionId = process.env.NOMO_SELECT_ACTIVE ? second.id : first.id;
  process.stdin.on('keypress', (_, key) => {
    if (key.name !== 'escape' && !(key.ctrl && key.name === 'c')) return;
    cancelKeySeen = true;
    setImmediate(() => {
      writeFileSync(process.env.NOMO_CANCEL_STATE, JSON.stringify({
        selected:this.workbench.get(first.id).status,
        other:this.workbench.get(second.id).status
      }));
      process.stdout.write('FIXTURE cancellation checked');
    });
  });
  await initialize.call(this);
};
""" % (workspace_module, ink_module))
    for key, active in [(b"\x1b", False), (b"\x03", False), (b"\x1b", True), (b"\x03", True)]:
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 100, 0, 0))
        with tempfile.TemporaryDirectory(dir=data) as workspace:
            env = {"PATH": os.environ["PATH"], "HOME": workspace, "NOMO_DATA_DIR": workspace,
                   "TERM": "xterm-256color", "NOMO_CANCEL_STATE": str(state),
                   "NOMO_SELECT_ACTIVE": "1" if active else ""}
            process = subprocess.Popen(["node", "--import", str(preload), "packages/cli/bin/nomo.mjs", "tui"],
                                       cwd=ROOT, env=env, stdin=slave, stdout=slave, stderr=slave)
            output = bytearray()
            try:
                read_until("Other run" if active else "Selected run")
                assert b"NOMO_CANCEL_READY" in output, "TUI input handler was not ready before cancellation key"
                os.write(master, key)
                read_until("FIXTURE cancellation checked")
                read_until("NOMO_CANCEL_UI_FLUSHED")
                if not active:
                    assert b"Selected conversation is not running" in output, f"Cancellation guidance hidden by unrelated run: {output[-1200:]!r}"
                assert json.loads(state.read_text()) == {"selected": "idle", "other": "cancelled" if active else "running"}, "Cancellation touched the wrong session"
            finally:
                process.terminate()
                deadline = time.monotonic() + 5
                while process.poll() is None and time.monotonic() < deadline:
                    if select.select([master], [], [], 0.1)[0]:
                        os.read(master, 65536)
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                os.close(master)
                os.close(slave)
    print("PASS: Escape and Ctrl+C cancel selected active run, preserve other conversations")
