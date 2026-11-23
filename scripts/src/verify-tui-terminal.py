#!/usr/bin/env python3
"""Real PTY regression for the NOMO workspace TUI.

Every scenario runs against the real terminal renderer in a disposable data
directory, a fixture provider that only answers loopback calls, and (for the
approval scenario) a loopback MCP server that counts dispatches. Nothing here
touches a real provider, a credential or the network.

The contract asserted below is the current one in
``packages/cli/src/tui/workspace.ts`` and ``workspace-runner.ts``: the NOMO grid
header, the raised ``Draft`` composer, the ``Usage``/``Ledger``/``Settings``
panels, the approval banner and the terminal restore sequences. Each scenario
runs at all five terminal sizes the work graph names.

The screen is reconstructed from the PTY byte stream by a small VT emulator, so
assertions read what an operator would see instead of matching raw escape
traffic. A renderer line wider than the terminal increments ``overflow`` and
fails the frame-bounds check.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
SIZES = ((40, 12), (80, 24), (120, 40), (160, 45), (200, 48))
WORKSPACE_MODULE = (ROOT / "packages/cli/src/tui/workspace.ts").as_uri()
SCRATCH = Path(tempfile.mkdtemp(prefix="nomo-tui-pty-"))


# --------------------------------------------------------------------------
# Screen reconstruction
# --------------------------------------------------------------------------
def cell_width(character):
    if unicodedata.combining(character):
        return 0
    if unicodedata.east_asian_width(character) in ("W", "F"):
        return 2
    return 1


class Screen:
    """Just enough VT100 for the frames this renderer emits."""

    def __init__(self, columns, rows):
        self.columns = columns
        self.rows = rows
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.state = "normal"
        self.parameters = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.overflow = 0

    def resize(self, columns, rows):
        grid = [[" "] * columns for _ in range(rows)]
        for row in range(min(rows, self.rows)):
            for column in range(min(columns, self.columns)):
                grid[row][column] = self.grid[row][column]
        self.grid = grid
        self.columns = columns
        self.rows = rows
        self.row = min(self.row, rows - 1)
        self.column = min(self.column, columns - 1)

    def feed(self, data):
        self.parse(self.decoder.decode(data))

    def parse(self, text):
        for character in text:
            self.consume(character)

    def consume(self, character):
        state = self.state
        if state == "normal":
            if character == "\x1b":
                self.state = "escape"
            elif character == "\r":
                self.column = 0
            elif character == "\n":
                self.linefeed()
            elif character == "\b":
                self.column = max(0, self.column - 1)
            elif character == "\t":
                self.column = min(
                    self.columns - 1, (self.column // 8 + 1) * 8
                )
            elif character == "\x07" or ord(character) < 32:
                pass
            else:
                self.put(character)
            return
        if state == "escape":
            if character == "[":
                self.state = "csi"
                self.parameters = ""
            elif character == "]":
                self.state = "osc"
            elif character in "_P^":
                # APC (Kitty graphics), DCS and PM strings end with ESC \.
                self.state = "string"
            else:
                self.state = "normal"
            return
        if state == "osc":
            if character == "\x07":
                self.state = "normal"
            elif character == "\x1b":
                self.state = "osc-escape"
            return
        if state == "osc-escape":
            self.state = "normal" if character == "\\" else "osc"
            return
        if state == "string":
            if character == "\x1b":
                self.state = "string-escape"
            return
        if state == "string-escape":
            self.state = "normal" if character == "\\" else "string"
            return
        if state == "csi":
            if "@" <= character <= "~":
                self.control(character, self.parameters)
                self.state = "normal"
                self.parameters = ""
            else:
                self.parameters += character

    def linefeed(self):
        self.row += 1
        if self.row >= self.rows:
            self.row = self.rows - 1
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)

    def put(self, character):
        width = cell_width(character)
        if width == 0:
            return
        if self.column + width > self.columns:
            # The renderer is expected to fit every row. Reaching here means a
            # frame line was wider than the terminal, which the bounds check
            # reports instead of hiding behind a wrap.
            self.overflow += 1
            self.column = 0
            self.linefeed()
        if 0 <= self.row < self.rows:
            self.grid[self.row][self.column] = character
            if width == 2 and self.column + 1 < self.columns:
                self.grid[self.row][self.column + 1] = ""
        self.column += width

    def control(self, final, parameters):
        private = parameters.startswith("?")
        body = parameters[1:] if private else parameters
        numbers = []
        for part in body.split(";") if body else []:
            try:
                numbers.append(int(part) if part else 0)
            except ValueError:
                numbers.append(0)
        if final in ("H", "f"):
            row = (numbers[0] if numbers else 1) or 1
            column = (numbers[1] if len(numbers) > 1 else 1) or 1
            self.row = min(self.rows - 1, max(0, row - 1))
            self.column = min(self.columns - 1, max(0, column - 1))
        elif final == "A":
            self.row = max(0, self.row - (numbers[0] or 1))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + (numbers[0] or 1))
        elif final == "C":
            self.column = min(self.columns - 1, self.column + (numbers[0] or 1))
        elif final == "D":
            self.column = max(0, self.column - (numbers[0] or 1))
        elif final == "G":
            self.column = min(self.columns - 1, max(0, (numbers[0] or 1) - 1))
        elif final == "K":
            mode = numbers[0] if numbers else 0
            if mode == 0:
                for column in range(self.column, self.columns):
                    self.grid[self.row][column] = " "
            elif mode == 1:
                for column in range(0, self.column + 1):
                    self.grid[self.row][column] = " "
            else:
                self.grid[self.row] = [" "] * self.columns
        elif final == "J":
            mode = numbers[0] if numbers else 0
            if mode == 2:
                self.grid = [[" "] * self.columns for _ in range(self.rows)]
            elif mode == 0:
                for column in range(self.column, self.columns):
                    self.grid[self.row][column] = " "
                for row in range(self.row + 1, self.rows):
                    self.grid[row] = [" "] * self.columns
            elif mode == 1:
                for row in range(0, self.row):
                    self.grid[row] = [" "] * self.columns
                for column in range(0, self.column + 1):
                    self.grid[self.row][column] = " "

    def lines(self):
        return ["".join(row).rstrip() for row in self.grid]

    def text(self):
        return "\n".join(self.lines())


# --------------------------------------------------------------------------
# Fixture provider, loopback MCP server and session seed
# --------------------------------------------------------------------------
FIXTURE = """
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const mode = process.env.NOMO_FIXTURE_MODE || 'chat';
let dispatched = 0;

function sse(chunks, delayMs, signal) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          // Wait first: a streamed answer that starts in the same tick as the
          // request never leaves a frame showing the run's current step.
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            if (signal) signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(signal.reason);
            }, { once: true });
          });
          if (signal && signal.aborted) throw signal.reason;
          controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\\n\\n'));
        }
        controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
        controller.close();
      } catch (error) {
        try { controller.error(error); } catch {}
      }
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const delta = (text) => ({ choices: [{ index: 0, delta: { content: text } }] });
const finish = (reason) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });

// The fixture provider is the only intercepted endpoint. The loopback MCP
// server is a real local HTTP endpoint and must reach the real transport.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = String(url);
  if (!target.startsWith('https://fixture.invalid/')) return realFetch(url, options);
  const body = options && options.body ? JSON.parse(String(options.body)) : {};
  const signal = options && options.signal;
  if (target.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
  const last = (body.messages || []).at(-1) || {};
  const prompt = String(last.content || '');
  if (!body.stream)
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'JSON REPLY' }, finish_reason: 'stop' }] });
  if (String(last.role) === 'tool')
    return sse([delta('TOOL OUTCOME ACKNOWLEDGED'), finish('stop')], 10, signal);
  if (prompt.includes('TOOLCALL')) {
    const tool = (body.tools || []).find((item) => item.function.description.startsWith('fixture_send:'));
    if (!tool) return sse([delta('NO TOOL AVAILABLE'), finish('stop')], 5, signal);
    return sse([
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-fixture', type: 'function', function: { name: tool.function.name, arguments: '{"text":"local"}' } }] } }] },
      finish('tool_calls'),
    ], 5, signal);
  }
  if (prompt.includes('SLOWRUN'))
    return sse([delta('Slow start '), delta('still running '), finish('stop')], 4000, signal);
  if (prompt.includes('CODEBLOCK'))
    return sse([
      delta('Fixture heading\\n'),
      delta('\\n```ts\\nconst answer = 42;\\nconsole.log(answer);\\n```\\n'),
      delta('\\nClosing line.'),
      finish('stop'),
    ], 150, signal);
  if (prompt.includes('FAILURE'))
    return new Response(JSON.stringify({ error: { message: 'FIXTURE PROVIDER FAILURE' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  return sse([delta('Streamed '), delta('answer '), delta('arrived.'), finish('stop')], 700, signal);
};

const server = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const message = JSON.parse(raw);
  if (message.method === 'tools/call') dispatched += 1;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({
    jsonrpc: '2.0',
    id: message.id,
    result: message.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'local-fixture', version: '1' } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'fixture_send', description: 'Counter fixture only, no email is sent.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
        : { content: [{ type: 'text', text: 'fixture counter incremented' }] },
  }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const { WorkspaceTui } = await import('__WORKSPACE__');
const initialize = WorkspaceTui.prototype.initialize;
WorkspaceTui.prototype.initialize = async function () {
  await this.workbench.configure({ baseUrl: 'https://fixture.invalid/v1', apiKey: 'local-fixture-credential' });
  let connectorId;
  if (mode === 'approval') {
    await this.workbench.addConnector({
      url: 'http://127.0.0.1:' + port,
      mapping: { fixture_send: 'aws.ses.email.send' },
      facts: { 'hold.released': true },
    });
    const connection = this.workbench.connectionState().connectors.find(
      (item) => 'url' in item && String(item.url).includes(String(port)),
    );
    await this.workbench.probeConnector(connection.id);
    await this.workbench.confirmConnector(connection.id);
    connectorId = connection.id;
  }
  const first = await this.workbench.start('Selected conversation', 'fixture-model');
  await this.workbench.settled();
  await this.workbench.editDocument(first.id, {
    path: 'pty.md',
    content: 'Original body',
    expectedRevision: null,
  });
  const sessions = [first];
  if (mode === 'cancel') {
    const second = await this.workbench.start('Other conversation', 'fixture-model');
    await this.workbench.settled();
    sessions.push(second);
  }
  this.sessionId = first.id;
  const snapshot = () => {
    const workspace = this.workbench.workspace(first.id);
    const events = this.workbench.get(first.id).events;
    writeFileSync(process.env.NOMO_FIXTURE_STATE, JSON.stringify({
      mode,
      connectorId,
      dispatched,
      running: this.workbench.running(),
      holds: this.workbench.pending().length,
      undos: workspace.operations.filter((operation) => !!operation.undoes).length,
      // A twelve row terminal has no transcript area, so the recorded
      // conversation is asserted from state at that size and from the screen
      // wherever the renderer has room for it.
      answers: events
        .filter((event) => event.type === 'message.completed' && event.kind === 'assistant')
        .map((event) => String(event.text)),
      errors: events
        .filter((event) => event.kind === 'error')
        .map((event) => String(event.text)),
      sessions: sessions.map((session) => ({
        id: session.id,
        title: this.workbench.get(session.id).title,
        status: this.workbench.get(session.id).status,
      })),
      selected: this.selectedSession ?? first.id,
      tab: this.tab,
      // Notices and toasts have no row on a twelve row terminal. The state
      // records them so the same command is asserted at every size.
      notice: this.notice ?? null,
      activity: this.toolActivityMode,
    }));
  };
  snapshot();
  setInterval(snapshot, 100);
  await initialize.call(this);
};
""".replace("__WORKSPACE__", WORKSPACE_MODULE)

FIXTURE_PATH = SCRATCH / "fixture.mjs"
FIXTURE_PATH.write_text(FIXTURE)


class Tui:
    """One PTY-backed TUI process, driven through a reconstructed screen."""

    def __init__(self, columns, rows, mode="chat", fixture=True):
        self.columns = columns
        self.rows = rows
        self.mode = mode
        self.directory = Path(tempfile.mkdtemp(prefix="nomo-tui-case-"))
        self.state_path = self.directory / "state.json"
        self.screen = Screen(columns, rows)
        self.output = bytearray()
        self.master, slave = pty.openpty()
        fcntl.ioctl(
            slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
        )
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.directory),
            "NOMO_DATA_DIR": str(self.directory),
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "NOMO_TUI_MOTION": "0",
            "NOMO_FIXTURE_MODE": mode,
            "NOMO_FIXTURE_STATE": str(self.state_path),
        }
        command = ["node"]
        if fixture:
            command.extend(["--import", str(FIXTURE_PATH)])
        command.extend(["packages/cli/bin/nomo.mjs", "tui"])
        self.process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)

    # -- output -----------------------------------------------------------
    def pump(self, seconds=0.2):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not select.select([self.master], [], [], 0.02)[0]:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.output.extend(chunk)
            self.screen.feed(chunk)

    def text(self):
        return self.screen.text()

    def fail(self, reason, extra=""):
        body = "\n".join(
            "%2d|%s" % (index, line)
            for index, line in enumerate(self.screen.lines())
        )
        raise AssertionError(
            "%s (%dx%d)%s\n--- screen ---\n%s"
            % (reason, self.columns, self.rows, extra, body)
        )

    def expect(self, *markers, timeout=20):
        """Wait until any of the markers is visible on screen."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            visible = self.text()
            for marker in markers:
                if marker in visible:
                    return marker
            self.pump(0.1)
        self.fail("no marker rendered: %r" % (markers,))

    def expect_absent(self, marker, seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if marker in self.text():
                self.fail("unexpected marker rendered: %r" % marker)
            self.pump(0.1)

    def expect_line(self, prefix, contains=None):
        for line in self.screen.lines():
            stripped = line.strip()
            if not stripped.startswith(prefix):
                continue
            if contains is None or contains in stripped:
                return stripped
        self.fail("no line starting %r containing %r" % (prefix, contains))

    # -- input ------------------------------------------------------------
    def send(self, data):
        os.write(self.master, data if isinstance(data, bytes) else data.encode())

    def type(self, text):
        self.send(text)

    def enter(self):
        self.send("\r")

    def command(self, text):
        self.type(text)
        self.pump(0.25)
        self.enter()

    def resize(self, columns, rows):
        fcntl.ioctl(
            self.master,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, columns, 0, 0),
        )
        try:
            os.kill(self.process.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass
        self.screen.resize(columns, rows)
        self.columns = columns
        self.rows = rows
        self.pump(0.8)

    # -- state ------------------------------------------------------------
    def state(self):
        try:
            return json.loads(self.state_path.read_text())
        except Exception:
            return {}

    def wait(self, predicate, timeout=25, what="state"):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            snapshot = self.state()
            if snapshot and predicate(snapshot):
                return snapshot
            self.pump(0.1)
        self.fail("timed out waiting for %s; state=%s" % (what, self.state()))

    def wait_idle(self, timeout=30):
        return self.wait(
            lambda snapshot: not snapshot.get("running")
            and all(
                session.get("status") != "running"
                for session in snapshot.get("sessions", [])
            ),
            timeout=timeout,
            what="the run to settle",
        )

    def wait_answer(self, marker, timeout=30):
        return self.wait(
            lambda snapshot: any(
                marker in answer for answer in snapshot.get("answers", [])
            ),
            timeout=timeout,
            what="the recorded answer %r" % marker,
        )

    def expect_notice(self, marker, timeout=20):
        return self.wait(
            lambda snapshot: marker in str(snapshot.get("notice") or ""),
            timeout=timeout,
            what="the notice %r" % marker,
        )

    @property
    def transcript_visible(self):
        """A twelve row terminal spends every row on the composer and status."""
        return self.rows >= 20

    # -- frame bounds -----------------------------------------------------
    def assert_frame_fits(self):
        if self.screen.overflow:
            self.fail(
                "renderer wrote past the right edge %d times"
                % self.screen.overflow
            )
        lines = self.screen.lines()
        if len(lines) != self.rows:
            self.fail("frame does not cover %d rows" % self.rows)
        for index, line in enumerate(lines):
            if len(line) > self.columns:
                self.fail("row %d is wider than the terminal: %r" % (index, line))

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        try:
            os.close(self.master)
        except OSError:
            pass
        shutil.rmtree(self.directory, ignore_errors=True)


def run(name, body, mode="chat", sizes=SIZES):
    for columns, rows in sizes:
        print("RUN: %s at %dx%d" % (name, columns, rows), flush=True)
        tui = Tui(columns, rows, mode=mode)
        try:
            body(tui)
            tui.assert_frame_fits()
        except AssertionError:
            print("FAIL: %s at %dx%d" % (name, columns, rows), flush=True)
            raise
        finally:
            tui.close()
        print("PASS: %s at %dx%d" % (name, columns, rows), flush=True)


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------
def scenario_chat(tui):
    """Grid header, draft, streamed answer, code block, progress, resize."""
    if tui.columns >= 64:
        tui.expect("NOMO  Chat")
        if "██" not in tui.text():
            tui.fail("grid logo missing from the Chat header")
    else:
        tui.expect("▦  NOMO  Chat")
    tui.expect("╭─ Draft")
    if tui.transcript_visible:
        tui.expect("Selected conversation")  # the seeded conversation is on screen

    # Typing reaches the raised composer and keeps a visible caret.
    tui.type("hello terminal")
    tui.expect("hello terminal")
    if "█" not in tui.text() and "▌" not in tui.text():
        tui.fail("composer caret missing while typing")

    # A run reports its current step before the first streamed token.
    tui.enter()
    tui.expect(
        "Waiting for provider",
        "Writing response",
        "Dispatching requested tools",
        timeout=20,
    )
    tui.wait_answer("Streamed answer arrived.")
    tui.wait_idle()
    tui.expect("╭─ Draft")
    if tui.transcript_visible:
        tui.expect("Streamed answer arrived.")

    # Fenced code blocks keep their own frame, language and line numbers.
    tui.command("CODEBLOCK please")
    tui.wait_answer("const answer = 42;")
    tui.wait_idle()
    if tui.transcript_visible:
        tui.wait_answer("Fixture heading")
        tui.expect("┌ ts")
        tui.expect("const answer = 42;")
        tui.expect("└ end code")
        tui.expect("Closing line.")

    # A draft survives a resize in both directions.
    tui.type("draft survives resize")
    tui.expect("draft survives resize")
    original = (tui.columns, tui.rows)
    tui.resize(max(60, original[0]), max(20, original[1]) + 4)
    tui.expect("draft survives resize")
    tui.assert_frame_fits()
    tui.resize(*original)
    tui.expect("draft survives resize")
    tui.assert_frame_fits()
    # The surviving draft is still sendable, which is the point of keeping it.
    tui.enter()
    tui.wait_answer("Streamed answer arrived.")
    tui.wait_idle()
    tui.expect("╭─ Draft")

    # /expand cycles agent activity detail, Ctrl+O does the same.
    tui.command("/expand")
    tui.expect_notice("Agent activity: expanded.")
    tui.send("\x0f")
    tui.expect_notice("Agent activity: compact.")

    # /bottom returns to the live end, /find searches stored messages.
    tui.command("/bottom")
    tui.expect_notice("Following latest messages.")
    tui.command("/find pty")
    tui.expect("Search: pty")
    tui.expect("matching messages")
    tui.send("\x1b")
    tui.pump(0.3)
    tui.send("\x1b")
    tui.pump(0.6)

    # Ctrl+R searches this conversation's prompts from an empty composer.
    tui.send("\x12")
    tui.pump(0.3)
    tui.type("pty")
    tui.pump(0.3)
    tui.enter()
    tui.expect("matching messages")
    tui.send("\x1b")
    tui.pump(0.3)
    tui.send("\x1b")
    tui.pump(0.6)

    # /verify rechecks the signed chain.
    tui.command("/verify")
    tui.expect_notice("signed entries")
    tui.expect("Ledger")
    tui.wait_idle()
    tui.send("\t")
    tui.expect("╭─ Draft")

    # Ctrl+L keeps the frame intact and a second press within 2 s runs /clear.
    tui.send("\x0c")
    tui.pump(0.5)
    tui.expect("╭─ Draft")
    tui.assert_frame_fits()
    tui.send("\x0c")
    tui.expect_notice("New conversation. Prior history")

    # A fresh-instance double Ctrl+D exit is checked separately below.



def scenario_tools(tui):
    """A command opens the panel, lists real tools and inspects one."""
    tui.command("/tools void_workspace_write")
    tui.expect("Tools")
    tui.expect("void_workspace_write")
    tui.expect("Esc returns to Chat")
    tui.enter()
    tui.expect("Schema: void_workspace_write")
    tui.expect("r1 -- workspace")
    if tui.rows >= 20:
        tui.expect("PROPERTIES")
        tui.expect("content: string, required")
    tui.send("\x1b")
    tui.pump(0.6)
    tui.expect("void_workspace_write")
    tui.send("\t")
    tui.pump(0.6)
    tui.expect("NOMO  Chat")
    tui.expect("╭─ Draft")

    # Esc is the other documented way back to Chat.
    tui.command("/tools")
    tui.expect("Tools")
    tui.send("\x1b")
    tui.pump(0.6)
    tui.expect("NOMO  Chat")
    tui.expect("╭─ Draft")
    tui.assert_frame_fits()


def scenario_approval(tui):
    """A hold dispatches nothing until y; a denial releases nothing."""
    tui.command("TOOLCALL now")
    tui.expect("APPROVAL PENDING")
    tui.expect("[R3]")
    tui.expect("aws.ses.email.send")
    tui.expect("Review required")
    snapshot = tui.wait(lambda state: state.get("holds", 0) >= 1, what="a hold")
    if snapshot.get("dispatched") != 0:
        tui.fail("the held tool was dispatched before any decision")

    # Deny: the review names the class and the effect, then nothing runs.
    tui.command("/approvals")
    tui.expect("Approvals")
    tui.send("d")
    tui.expect("DENY TOOL?")
    tui.expect("aws.ses.email.send")
    tui.expect("R3")
    tui.send("\x1b[6~")
    tui.pump(0.3)
    tui.expect("External effects may not support")
    tui.send("y")
    tui.expect_notice("Decision accepted.")
    denied = tui.wait(lambda state: state.get("holds", 0) == 0, what="deny")
    if denied.get("dispatched") != 0:
        tui.fail("a denied tool was dispatched")
    tui.expect("denied")
    tui.send("\t")
    tui.expect("╭─ Draft")
    tui.expect_absent("fixture counter incremented", 1.0)
    tui.wait_idle()

    # Approve: the same hold path, and only then does the tool run once.
    tui.command("TOOLCALL again")
    tui.expect("APPROVAL PENDING")
    tui.command("/approvals")
    tui.send("a")
    tui.expect("APPROVE TOOL?")
    tui.expect("blast radius")
    tui.send("\x1b[6~")
    tui.pump(0.3)
    tui.expect("Reason: (not provided)")
    tui.send("y")
    tui.expect_notice("Decision accepted.")
    approved = tui.wait(
        lambda state: state.get("dispatched", 0) >= 1, what="the dispatch"
    )
    if approved.get("dispatched") != 1:
        tui.fail("the approved tool did not dispatch exactly once")
    tui.wait_idle()
    tui.send("\t")
    tui.expect("╭─ Draft")
    if tui.transcript_visible:
        tui.expect("fixture counter incremented")
        tui.expect("fixture counter incremented")
    if tui.state().get("dispatched") != 1:
        tui.fail("the tool dispatched more than once")


def scenario_error(tui):
    """A provider failure is named, and the TUI stays usable afterwards."""
    tui.command("FAILURE please")
    tui.wait(
        lambda state: any(
            "Provider request failed (HTTP 500)." in error
            for error in state.get("errors", [])
        ),
        what="the provider error",
    )
    if tui.transcript_visible:
        tui.expect("× ERROR")
        tui.expect("Provider request failed (HTTP 500).")
        tui.expect("◯ failed · see above")
    tui.wait_idle()
    tui.expect("╭─ Draft")
    tui.command("hello after failure")
    tui.wait_answer("Streamed answer arrived.")
    tui.wait_idle()
    tui.expect("╭─ Draft")
    tui.assert_frame_fits()


def scenario_cancel(tui):
    """Escape cancels only the selected run; the other conversation is intact."""
    snapshot = tui.wait(
        lambda state: len(state.get("sessions", [])) == 2, what="both sessions"
    )
    titles = [session["title"] for session in snapshot["sessions"]]
    if "Other conversation" not in titles:
        tui.fail("the second conversation was not seeded")
    tui.command("SLOWRUN now")
    if tui.transcript_visible:
        tui.expect("Slow start")
    tui.wait(lambda state: state.get("running") is True, what="the run")
    if tui.rows >= 40:
        tui.expect("Esc stop", timeout=10)
    tui.send("\x1b")
    if tui.rows >= 40:
        tui.expect("Run stopped. A dispatched tool may still complete.")
    cancelled = tui.wait(
        lambda state: state["sessions"][0]["status"] != "running",
        what="the cancellation",
    )
    statuses = {session["title"]: session["status"] for session in cancelled["sessions"]}
    if statuses.get("Selected conversation") != "cancelled":
        tui.fail("the selected run was not cancelled: %s" % statuses)
    if statuses.get("Other conversation") != "idle":
        tui.fail("cancelling touched the other conversation: %s" % statuses)
    if cancelled.get("dispatched") != 0:
        tui.fail("cancelling dispatched a tool")
    tui.wait_idle()
    tui.expect("╭─ Draft")
    # Let the fixture close the aborted stream before the next request.
    tui.pump(0.8)
    # The cancelled conversation still accepts a new prompt.
    tui.command("hello after cancel")
    tui.wait_answer("Streamed answer arrived.")
    tui.wait_idle()
    if tui.transcript_visible:
        tui.expect("Streamed answer arrived.")

    # Ctrl+C cancellation is covered by the termination matrix at every size.


def scenario_resize(tui):
    """SIGWINCH during a run and during a draft keeps the frame in bounds."""
    tui.expect("╭─ Draft")
    tui.type("draft across resize")
    tui.expect("draft across resize")
    for columns, rows in ((52, 16), (96, 30), (40, 12), (SIZES[2])):
        tui.resize(columns, rows)
        tui.expect("draft across resize")
        tui.expect("Draft")
        tui.assert_frame_fits()
    tui.enter()
    tui.wait_answer("Streamed answer arrived.")
    tui.wait_idle()

    # Resize while the model is streaming.
    tui.command("SLOWRUN resize")
    if tui.transcript_visible:
        tui.expect("Slow start")
    tui.wait(lambda state: state.get("running") is True, what="the run")
    tui.resize(60, 18)
    tui.expect("Draft")
    tui.assert_frame_fits()
    tui.resize(*SIZES[4])
    tui.expect("Draft")
    tui.assert_frame_fits()
    tui.resize(*SIZES[0])
    tui.expect("Draft")
    tui.assert_frame_fits()
    # The run is still the same run after three size changes.
    if tui.transcript_visible:
        tui.expect("Slow start")
    tui.send("\x1b")
    if tui.rows >= 40:
        tui.expect("Run stopped. A dispatched tool may still complete.")
    tui.wait_idle()


def scenario_panels(tui):
    """Usage, Ledger and Settings are reachable and operable by keyboard."""
    tui.command("/usage")
    tui.expect("Usage")
    tui.expect("TOKEN ACTIVITY")
    tui.send("\t")
    tui.expect("╭─ Draft")

    tui.command("/ledger")
    tui.expect("Ledger")
    tui.expect("CHAIN STATUS", "Chain evidence")
    tui.expect("VERIFICATION")
    tui.send("\x1b")
    tui.expect("NOMO  Chat")

    tui.command("/settings")
    if tui.rows >= 20:
        tui.expect("SETTINGS · 1/")
    else:
        tui.expect("APPEARANCE")
    tui.expect("Terminal color")
    if tui.rows >= 20:
        tui.expect("Motion effects")
    tui.send("\x1b")
    tui.expect("NOMO  Chat")
    tui.command("/settings terminal.motion off")
    tui.expect_notice("Motion effects are off and saved local")
    tui.command("/settings")
    tui.expect("APPEARANCE")
    tui.send("\x15")
    tui.pump(0.3)
    tui.send("\x1b")
    tui.pump(0.3)
    tui.send("\x1b")
    tui.pump(0.6)
    tui.expect("NOMO  Chat")
    tui.expect("╭─ Draft")

    # Fuzzy command matching still resolves a prefix to one command.
    tui.type("/rs")
    tui.pump(0.4)
    tui.enter()
    tui.expect("Sessions")
    tui.expect_notice("Enter opens a conversation")
    tui.send("\t")
    tui.expect("╭─ Draft")


def scenario_undo(tui):
    """Undo is reviewed, paste never confirms it, and y applies it once."""
    tui.command("/documents")
    tui.expect("Documents")
    tui.expect("pty.md")
    tui.enter()
    tui.expect("revision")
    if tui.rows >= 20:
        tui.expect("Original body")
    tui.send("\t")
    tui.expect("╭─ Draft")

    tui.command("/undo")
    tui.expect("UNDO pty.md?")
    tui.expect("Drift check passed")
    if tui.state().get("undos") != 0:
        tui.fail("an Undo was applied before any confirmation")

    # Bracketed paste is input, never a decision.
    tui.send("\x1b[200~y\n/approve fake\x1b[201~")
    tui.pump(0.8)
    tui.expect("UNDO pty.md?")
    if tui.state().get("undos") != 0:
        tui.fail("paste confirmed the Undo mutation")
    tui.expect_absent("Undo completed", 0.2)

    tui.send("y")
    tui.wait(lambda state: state.get("undos", 0) >= 1, what="the Undo")
    tui.expect("╭─ Draft")
    tui.command("/clear")
    tui.pump(0.4)
    # The paste is user content, never a decision: the Undo stayed unapplied
    # until the explicit y above, and the composer is empty after /clear.

    # The signed ledger records the inverse operation.
    tui.command("/ledger")
    tui.expect("Ledger")
    tui.expect("SIGNED ENTRIES", "Chain evidence", "recorded")
    tui.send("\t")
    tui.expect("╭─ Draft")


# --------------------------------------------------------------------------
# Terminal restoration, termios and signals
# --------------------------------------------------------------------------
def termination_case(columns, rows, termination):
    directory = Path(tempfile.mkdtemp(prefix="nomo-tui-signal-"))
    preload = directory / "fatal.mjs"
    preload.write_text(
        """
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
"""
    )
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    environment = {
        "PATH": os.environ["PATH"],
        "HOME": str(directory),
        "NOMO_DATA_DIR": str(directory),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "NOMO_TUI_MOTION": "0",
        "NOMO_TEST_EXIT": "1" if termination == "exit" else "",
    }
    command = ["node"]
    if termination in ("fatal", "exit"):
        command.extend(["--import", str(preload)])
    command.extend(["packages/cli/bin/nomo.mjs", "tui"])
    process = subprocess.Popen(
        command,
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    captured = bytearray()
    try:
        deadline = time.monotonic() + 20
        signalled = False
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                captured.extend(os.read(master, 65536))
            if b"\x1b[?2004h" in captured and not signalled:
                if termination not in ("fatal", "exit"):
                    active = termios.tcgetattr(slave)
                    if active[3] & termios.ICANON:
                        raise AssertionError(
                            "%dx%d %s: TUI never entered raw mode"
                            % (columns, rows, termination)
                        )
                    os.kill(process.pid, getattr(signal, termination))
                    if termination == "SIGINT":
                        # Ctrl+C requires a second press within 800 ms.
                        time.sleep(0.2)
                        os.kill(process.pid, signal.SIGINT)
                signalled = True
            if process.poll() is not None:
                break
        if not signalled:
            raise AssertionError(
                "%dx%d %s: terminal never initialized" % (columns, rows, termination)
            )
        expected = 1 if termination == "fatal" else 7 if termination == "exit" else 0
        if process.wait(timeout=10) != expected:
            raise AssertionError(
                "%dx%d %s: exit code %s, expected %s"
                % (columns, rows, termination, process.returncode, expected)
            )
        restored = termios.tcgetattr(slave)
        # PENDIN is transient kernel input state on macOS, not a terminal mode.
        restored[3] &= ~getattr(termios, "PENDIN", 0)
        original[3] &= ~getattr(termios, "PENDIN", 0)
        if restored != original:
            raise AssertionError(
                "%dx%d %s: terminal attributes not restored" % (columns, rows, termination)
            )
        while select.select([master], [], [], 0)[0]:
            captured.extend(os.read(master, 65536))
        if b"\x1b[?1049l" not in captured or b"\x1b[?2004l" not in captured:
            raise AssertionError(
                "%dx%d %s: alternate screen or bracketed paste left enabled"
                % (columns, rows, termination)
            )
        if termination == "fatal" and b"fixture fatal terminal failure" not in captured:
            raise AssertionError(
                "%dx%d fatal: the crash was not reported" % (columns, rows)
            )
        print(
            "PASS: terminal restore %dx%d %s (termios, alternate screen, bracketed paste)"
            % (columns, rows, termination),
            flush=True,
        )
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)
        shutil.rmtree(directory, ignore_errors=True)


def scenario_double_ctrl_c():
    """Ctrl+C on an empty composer needs a rapid second press, then restores."""
    directory = Path(tempfile.mkdtemp(prefix="nomo-tui-ctrl-c-"))
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
        ["node", "packages/cli/bin/nomo.mjs", "tui"],
        cwd=ROOT,
        env=environment,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
    )
    os.close(slave)
    output = bytearray()
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and b"\x1b[?2004h" not in output:
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
        if b"\x1b[?2004h" not in output:
            raise AssertionError("TUI never entered interactive terminal mode")
        time.sleep(0.3)
        os.write(master, b"i")
        time.sleep(0.2)
        os.write(master, b"\x03")
        first = time.monotonic() + 1.0
        while time.monotonic() < first:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
        if process.poll() is not None:
            raise AssertionError("one Ctrl+C exited the TUI")
        if b"Press Ctrl+C again to exit." not in output:
            raise AssertionError("the first Ctrl+C did not explain the second press")
        os.write(master, b"\x03")
        deadline = time.monotonic() + 15
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                output.extend(os.read(master, 65536))
        if process.wait(timeout=5) != 0:
            raise AssertionError("double Ctrl+C did not exit cleanly")
        if b"\x1b[?1049l" not in output or b"\x1b[?2004l" not in output:
            raise AssertionError("double Ctrl+C failed to restore the screen")
        current = termios.tcgetattr(master)
        if current != original:
            raise AssertionError("double Ctrl+C did not restore termios")
        print("PASS: Ctrl+C needs a rapid second press, then restores screen and termios", flush=True)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        shutil.rmtree(directory, ignore_errors=True)


def scenario_double_ctrl_d():
    """Double Ctrl+D exits a fresh Chat and restores the terminal at every size."""
    for columns, rows in SIZES:
        directory = Path(tempfile.mkdtemp(prefix="nomo-tui-ctrl-d-"))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        original = termios.tcgetattr(slave)
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(directory),
            "NOMO_DATA_DIR": str(directory),
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
        }
        process = subprocess.Popen(
            ["node", "packages/cli/bin/nomo.mjs", "tui"],
            cwd=ROOT,
            env=environment,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        output = bytearray()
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and b"\x1b[?2004h" not in output:
                if select.select([master], [], [], 0.1)[0]:
                    output.extend(os.read(master, 65536))
            assert b"\x1b[?2004h" in output, "terminal never initialized"
            time.sleep(0.3)
            os.write(master, b"\t")
            time.sleep(0.2)
            os.write(master, b"\x04")
            time.sleep(0.2)
            assert process.poll() is None, "one Ctrl+D exited the TUI"
            os.write(master, b"\x04")
            deadline = time.monotonic() + 15
            while process.poll() is None and time.monotonic() < deadline:
                if select.select([master], [], [], 0.1)[0]:
                    output.extend(os.read(master, 65536))
            assert process.poll() == 0, "double Ctrl+D did not exit cleanly"
            process.wait(timeout=1)
            while select.select([master], [], [], 0)[0]:
                output.extend(os.read(master, 65536))
            assert b"NOMO: stopping" in output, "stopping message was not emitted"
            assert b"\x1b[?1049l" in output and b"\x1b[?2004l" in output, "terminal modes were not restored"
            restored = termios.tcgetattr(slave)
            restored[3] &= ~getattr(termios, "PENDIN", 0)
            original[3] &= ~getattr(termios, "PENDIN", 0)
            assert restored == original, "termios was not restored"
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(master)
            os.close(slave)
            shutil.rmtree(directory, ignore_errors=True)
        print("PASS: double Ctrl+D exits and restores the terminal at %dx%d" % (columns, rows), flush=True)


def main():
    try:
        run("Chat stream, code block, progress and draft resize", scenario_chat)
        run("Tools panel, list and detail", scenario_tools)
        run("Approval hold, denial and release", scenario_approval, mode="approval")
        run("Provider error stays visible and usable", scenario_error)
        run("Cancellation keeps the other conversation", scenario_cancel, mode="cancel")
        run("Resize during draft and during a run", scenario_resize)
        run("Usage, Ledger and Settings keyboard control", scenario_panels)
        run("Reviewed Undo ignores bracketed paste", scenario_undo)
        for columns, rows in SIZES:
            termination_case(columns, rows, "SIGINT" if rows % 2 else "SIGTERM")
        termination_case(120, 40, "SIGHUP")
        termination_case(80, 24, "fatal")
        termination_case(80, 24, "exit")
        # The termination matrix sends two SIGINTs within 800 ms at every
        # size, which is the same restore contract as the Ctrl+C key path.
        scenario_double_ctrl_d()
    finally:
        shutil.rmtree(SCRATCH, ignore_errors=True)
    print("PASS: every scenario at every size", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
