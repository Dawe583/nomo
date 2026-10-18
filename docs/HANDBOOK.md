# NOMO handbook

The complete operator guide: what NOMO is, what it refuses to claim, how to
install it, and every command, key, route and file it exposes. Read sections 1
to 7 in order the first time. The rest is reference.

Everything here is checked. [how this handbook is kept true](../scripts/src/handbook.test.mjs) extracts every
command, script, file path and link in this document and fails if any of them
stops existing, if a command disappears, or if the two language editions drift
apart. A handbook that lies is worse than no handbook, so this one is a gate,
not prose.

- [1. What NOMO is](#1-what-nomo-is)
- [2. What NOMO does not do](#2-what-nomo-does-not-do)
- [3. Vocabulary](#3-vocabulary)
- [4. Install](#4-install)
- [5. Your first ten minutes](#5-your-first-ten-minutes)
- [6. Connect a model provider](#6-connect-a-model-provider)
- [7. Choose a surface](#7-choose-a-surface)
- [8. The terminal interface](#8-the-terminal-interface)
- [9. The web and desktop app](#9-the-web-and-desktop-app)
- [10. The command line](#10-the-command-line)
- [11. Policy files](#11-policy-files)
- [12. The ledger](#12-the-ledger)
- [13. Undo and recovery](#13-undo-and-recovery)
- [14. Hosting an MCP server](#14-hosting-an-mcp-server)
- [15. The desktop applications](#15-the-desktop-applications)
- [16. Platform differences](#16-platform-differences)
- [17. Troubleshooting](#17-troubleshooting)
- [18. Before you point this at production](#18-before-you-point-this-at-production)
- [19. Where to go deeper](#19-where-to-go-deeper)

---

## 1. What NOMO is

NOMO is a layer between an AI agent and the tools that agent can write to. For
every intercepted tool call it decides four things and then records them:

1. **Intercept** the call. NOMO terminates the MCP session; the agent does not
   talk to its tools directly.
2. **Classify** it. How reversible is this call, given the state of the target?
   The answer is one of R0, R1, R2, R3.
3. **Decide** what to do with it, from a policy file you control: allow, deny, or
   hold for a human.
4. **Record** the decision in a signed, hash-chained ledger **before** the write
   proceeds.

Later you can read the ledger, verify it offline, attest a slice of it, and undo
a write when a connector captured enough state to invert it exactly.

The value is not the block. The value is that you can answer, months later and
without trusting the vendor: what did this agent do, on whose authority, and can
it be put back.

**What this is not pitched as.** Undo for agent actions has been on sale since
August 2025, so this handbook does not lead with it. Two narrower things are
what is actually demonstrated, and both are checkable:

- **An inverse runs against a live system and touches only the effect it names.**
  Restoring a database to a moment ago discards every legitimate write made
  since; an inverse restores the affected rows and leaves the writes other people
  made in the meantime alone. `scripts/receipt-demo/run.mjs` shows both on one
  table: an agent write, a finance write made outside NOMO, then the inverse,
  after which the first row is back and the second keeps its later value.
- **The receipt lands in the database the effect happened in.** After a verified
  managed Postgres restore the record is written to `${schema}.recoveries`
  (`packages/connectors/src/postgres/managed.ts:1399`), so anyone who can reach
  that database checks it with plain SQL and no NOMO process.
  `docs/RECEIPT-VERIFY.sql` is that query. It prints `PASS` only when the row
  each receipt names is the row the live table holds, and `FAIL` when it is not;
  it was run against a deliberately tampered table to prove it can fail
  (`scripts/receipt-demo/README.md`).

The restore is refused before any receipt is written, if the rows do not match
the capture (`packages/connectors/src/postgres/managed.ts:1393`).

## 2. What NOMO does not do

Read this section before section 1 makes you trust the product. Every item here
is a current, measured limit, not a roadmap item.

- **It does not make a call safe by trusting the model.** It constrains the write
  path. A call it classifies as R0 and your policy allows is still a call the
  model chose to make.
- **It is not a sandbox.** It is cooperative. It governs the tools an operator
  configures it to govern. It does not intercept arbitrary shell commands, other
  programs, or a second agent that was never pointed at it.
- **Undo exists only where a connector captured the before image.** An R2 or R3
  call may have no inverse at all. `nomo` will tell you so rather than pretend.
- **The ledger is tamper-evident, not tamper-proof.** Anyone who owns the machine
  can rewrite a JSONL file. What a signature buys you is proof that the record was
  not edited _after_ it was written, by someone who did not hold the key.
  The signature establishes that the bytes came from a process holding that key,
  and nothing more: the recorder, the signer and the verifier run as one OS
  principal (`docs/OPERATIONS.md`). A receipt in your database is a durable
  claim written beside the rows it describes, and the check reads the rows.
- **A hold is not a lock on the world.** A hold pauses one call. A writer that
  never went through NOMO is unaffected.
- **Reversibility classes are draft classifications, not vendor certifications.**
  See `NOTICE` in the repository root for the exact wording that travels with the
  registry data.
- **There is no cross-system plan.** One recovery job covers managed documents,
  managed Postgres, and the managed filesystem on one host. It does not coordinate
  a database, a bucket and a git remote into a single transaction.
- **The iOS companion cannot write.** It is a bounded read-only surface. The
  executor is always the Mac or the cloud, and the app says so.
- **On Windows the owner-only guarantee on approval state is not established.**
  The check verifies the directory is real and not a link; the ACL is inherited
  from your user profile. POSIX hosts narrow the mode explicitly.

## 3. Vocabulary

**Reversibility class.** Every call gets one, from the registry plus the observed
state of the target:

| Class | Meaning                                                                | Usual posture                                         |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| R0    | Fully reversible with a direct inverse.                                | Allow, with the ledger keeping the inverse.           |
| R1    | Reversible with a trace or a before image.                             | Allow for a small blast radius, hold for a large one. |
| R2    | Mitigable only. You can reduce the damage; you cannot undo the action. | Hold or deny.                                         |
| R3    | Irreversible.                                                          | Hold or deny.                                         |

An **unclassified** call is treated as R3. A registry gap therefore widens into
caution rather than into a silent allow.

**Blast radius.** How many resources the call would affect. NOMO refuses to guess:
only a measured count satisfies a radius rule, and a missing measurement leaves
the radius unknown, which matches no radius rule at all.

**Hold.** A decision deferred to a human. The call waits; the agent is told what
rule held it and that it must not retry the same call.

**Ledger.** An append-only file of signed, hash-chained records. One line per
intercepted call. Never updated, never deleted.

**Inverse.** An operation that returns the target to its exact prior state. Only
R0 and R1 have one. R2 has compensations, which reduce harm and are not the same
thing.

**Managed document.** A file NOMO itself created and owns. Its writes are
captured, so its Undo is real. A file an outside program is also editing is
cooperative only, and the drift check will refuse the Undo.

## 4. Install

NOMO needs **Node.js 24 or newer** and **pnpm 10**. Check both:

```sh
node --version
pnpm --version
```

From a Git checkout, install the workspace and link its `nomo` command:

```sh
pnpm install --frozen-lockfile
pnpm setup # run once only if pnpm's global bin directory is not already on PATH
```

`pnpm setup` prepares pnpm's user-level command directory when needed;
if it changes your shell configuration, open a new terminal. Then make the
current checkout's `nomo` command available from any directory:

```sh
pnpm link --global
nomo doctor
```

Repeat the link if you move the checkout or switch clones. From the repository
root, `pnpm nomo`, `./nomo` on macOS/Linux, or `.\nomo.cmd` on Windows works
without a global link. `nomo doctor` reports the terminal, the Node version,
writable data and ledger directories, and owner-only checks for the signing
key and default ledger. For configured recovery state, pass its config file:

```sh
nomo doctor --recovery-config ./nomo-recovery.json
```

That check walks the configured state tree, including journal, vault and
temporary files. It reads only config paths; it does not print config contents
or secret values and does not change permissions; diagnostic failures may name
the affected filesystem path. On POSIX it checks mode `0700` for
directories and `0600` for files. On Windows it checks the current user's ACL
and allows the operating system's SYSTEM and Administrators principals. It
does not use DPAPI for the signing key and cannot isolate another process
running as the same user or an administrator. The scan is a read-only snapshot;
run it when the recovery executor is idle for a stable report.

The reserved vault is never collected implicitly: an operator drives it, and
the shipped default policy is `manual`, so a collection without a policy
deletes nothing and prints the report of what it saw:

```sh
nomo recovery collect --config ./nomo-recovery.json
nomo recovery collect --config ./nomo-recovery.json --retention-policy ./retention.json
nomo recovery collect --config ./nomo-recovery.json --retention-policy ./retention.json --dry-run
```

An age policy names a TTL for unpinned artifacts. Collection deletes only
artifacts whose recorded lifecycle leaves them unpinned and provably past
that TTL: a pinned artifact stays until a named release, an artifact with no
recorded evidence is protected rather than assumed unpinned, and a schema 1
vault, which carries no write time, stays protected for the same reason.
Every run writes the same signed journal chain a runtime capture does, so a
shell-driven delete is audited exactly like a runtime one. `nomo recovery
health` summarizes the same evidence as one `retention` section: how much
is recorded, how much is pinned, how much is released, and how much of the
vault is protected with nothing an operator can read.

Check the complete source installation:

```sh
pnpm run check
```

`pnpm run check` is the full typecheck plus every test suite. It should exit 0.

The prebuilt desktop applications are on the download page linked from
`README.md`. They bundle their own Node runtime, verified against a pinned
official SHA-256, so the end user needs nothing installed.

If `corepack enable` fails with a permissions error, you do not need it. Run
`corepack pnpm <command>` instead, which uses the pinned package manager without
writing a shim into your Node installation.

## 5. Your first ten minutes

Do these in order. Each step is a command that either works or tells you exactly
what is missing.

**1. Create the workspace layout.**

```sh
nomo init
```

It prints the directory it created and the next three steps. It writes nothing
else and destroys nothing.

**2. Check the environment.**

```sh
nomo doctor
```

Expect `PASS` for the Node version and the data directory. A `WARN` for the
ledger directory on a fresh machine is normal: it appears on first write.

**3. Connect a provider.** See section 6. Until you do this, every conversation
reports `Setup required` and dispatches nothing. That is the designed state, not
a bug.

**4. Open the workspace.**

```sh
pnpm tui
```

Type `/help` for the command list, `?` to reach the help tab, and `/status` to
see what NOMO resolved. The mode indicator in the status bar always reads
`local only, not enforced`; section 9 explains why that is not a defect in your
setup.

**5. Write something, then look at the evidence.**

Type a sentence, let it write a document, then run `/ledger`. The entries there
are the record of what happened. Run `/verify` to check the chain.

If you prefer the web app, `pnpm gui` builds the client and starts the local API.
It opens the same workspace, in a browser.

## 6. Connect a model provider

**NOMO has no default provider and no default model.** A new workspace has
neither until you connect one. Settings lists the providers on offer, and the
first conversation asks which model to use from the catalog the connected
provider returns. Existing conversations keep the provider and model they were
created with; connecting a different provider never rewrites history.

There are two ways to supply a credential, and they are different on purpose.

**Ambient, for a developer.** Set the key in the host environment before starting
NOMO:

```sh
export NVIDIA_API_KEY=...
nomo tui
```

This is the only ambient credential NOMO reads, and it is a choice you made, not
a default it made for you. The TUI says so directly: `Set NVIDIA_API_KEY in the
host environment, then reopen NOMO. No key is accepted in chat.`

**Stored, for an operator.** In the GUI, open **Settings**, then **Model
provider**. Pick a preset, paste the key into the password field, press **Connect
and validate**. The key is encrypted on the server and the field is cleared. The
success notice is `Provider connected. The key is encrypted on the server.`

**Never type a key into the chat.** The TUI refuses commands that look like
credential material, and the GUI has no field in the composer.

When no credential resolves, the status badge reads **Setup required** and
nothing dispatches. This is deliberate: NOMO does not fall back to another
provider, because a silent provider switch is exactly the failure an operator
cannot see.

The presets available in the GUI are NVIDIA NIM (`https://integrate.api.nvidia.com/v1`),
OpenCode Zen, Pollinations (free, no key), TokenRouter, OpenRouter, Anthropic,
Google Gemini, Groq, DeepSeek and the Vercel AI Gateway, plus a custom
OpenAI-compatible endpoint. They are the choices on offer, and choosing one is
what connects it. The TUI lists two more, Ollama and LM Studio, because those are
local and the GUI filters them out. Provider status is one of: `Ready`, `Setup
required`, `Rate limited` (with the earliest retry time), `Unavailable`.

Provider cost and quota figures are never estimated. Where no provider reported a
number, NOMO prints `unknown`, never `$0.00`.

## 7. Choose a surface

| Surface        | Start it                                 | Use it when                                                                                                   |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Terminal (TUI) | `pnpm tui`                               | You live in a terminal, want the ledger adjacent, and want keyboard control. Full approval and recovery keys. |
| Web app        | `pnpm gui`                               | You want a browser, a phone-sized layout, or the document and recovery review views.                          |
| Desktop app    | `pnpm desktop:setup` then `pnpm desktop` | You want the desktop shell with bundled runtime and native key storage.                                       |
| CLI            | `nomo <command>`                         | You are scripting, auditing, or checking state from another tool.                                             |
| MCP host       | `nomo recovery serve --config <file>`    | Another agent is the caller and you want interception in front of its tools.                                  |

The TUI and the GUI are the same engine against the same workspace. Approvals
resolved in one are visible in the other. The TUI has keys the GUI does not, and
the GUI has a document history view the TUI does not.

## 8. The terminal interface

`pnpm tui`, or `nomo tui`. Options: `--once` renders one static frame and exits
(the one-shot render is always colourless), `--view <tab>`, `--session <id>`,
`--data-dir <path>`, `--import-provider opencode:zen|opencode:tokenrouter`, and
`--help`.

### 8.1 The eleven tabs

`overview`, `chat`, `sessions`, `documents`, `ledger`, `approvals`, `policy`,
`tools`, `models`, `usage`, `help`.

`Tab`, `Shift+Tab`, `Left` and `Right` move between them, and `/runs` is an alias
for `/overview`. A narrow terminal shows a three-tab window around the active one.

Each tab has a slash command of the same name, and an argument to any of them
becomes that panel's filter. So `/ledger postgres` filters the ledger panel to
entries mentioning postgres.

### 8.2 Commands

Navigation and session: `/new [prompt]`, `/clear`, `/quit`, `/exit`,
`/resume <conversation-number-or-ID>`, `/open <conversation-number-or-ID>`,
`/rename <title>`, `/archive`, `/bottom`, `/find <text>`, `/stop`, `/cancel`,
`/branch [seq]`, `/retry [seq]`.

Context and state: `/status`, `/context`, `/cost`, `/stats`, `/diff`, `/todos`,
`/memory`, `/history`, `/config`, `/sources`, `/queue [resume]`, `/compact`,
`/expand`, `/edit`, `/bottom`, `/theme <color|mono|motion|still|reset>`,
`/keybindings`, `/command-palette`.

Workspace configuration: `/policy`, `/tools`, `/models`, `/permissions` (also
`/mcp`), `/policy-file <connector-ID> <path-to-YAML>`, `/connector-file
<path.json>`, `/test-connector <ID>`, `/hooks`, `/hook-file <path.json>`,
`/projects`, `/project <ID|none>`, `/project-file <path.json>`, `/agents`,
`/agent <ID>`, `/agent-file <path.json>`.

Providers: `/providers`, `/model <exact-ID>`, `/connect <source-ID>` (also
`/login`), `/logout`.

Approval and recovery: `/approvals`, `/approve [hold-ID] [reason...]`, `/deny
[hold-ID] [reason...]`, `/undo [operation-ID]`, `/rewind`, `/recovery [job-ID]`,
`/verify`, `/document <path>`, `/attest`, `/export <ledger|chat|document>`.

Setup and diagnostics: `/doctor`, `/init`, `/conformance`, `/harness
<cloud|prime-agent>`. The two external agent binaries behind `/harness` are
documented in `docs/AGENT-BINARIES.md`.

Every command above takes its argument in the same place; running one with no
argument prints its own usage line rather than failing opaquely. A command with
no argument at all, or an unknown one, is refused by name.

**Two refusals are permanent and deliberate.** `/vim`, `/terminal-setup` and
`/output-style` exist so that an operator arriving from another agent CLI gets a
clear answer instead of silence. NOMO has no equivalent.

**Completion covers most commands, not all.** Fifteen dispatchable commands are
reachable but are not offered by `/` completion: `/open`, `/sources`, `/filter`,
`/document`, `/approve`, `/deny`, `/rename`, `/archive`, `/policy-file`,
`/connector-file`, `/test-connector`, `/command-palette`, and the three refusals
above. `/help` lists all but `/command-palette`.

**Fuzzy matching is real but narrow.** Typing `/rs` reaches `/resume` and `/conf`
reaches `/conformance`. Matching is an ordered subsequence over the command name,
so a query that is not a subsequence of the name does not match, and names
starting with what you typed sort first.

### 8.3 Keys

Confirmation modal, which is where the decisions that matter happen:

| Key             | Effect                                                     |
| --------------- | ---------------------------------------------------------- |
| `y`             | Accept.                                                    |
| `n`             | Reject. Nothing is applied and the notice says so.         |
| `Esc`           | Cancel and clear the review.                               |
| `1` to `9`      | Toggle that diff hunk, so you can review part of a change. |
| `PgUp` / `PgDn` | Scroll the review by ten lines.                            |

The status line inside a review reads `[!] REVIEW / y accept / n reject / Esc
cancel / PgDn preview`.

Hunk toggling narrows what you are looking at. It does not yet narrow what the
server will execute; see section 18.

Navigation and panels: `i` or `/` to type, `q` to quit, `n` for a new
conversation, `u` to preview an Undo, `a` to prepare an approval, `d` to prepare a
denial, `r` to refresh, `?` for help, `Enter` to open the selected row, `Esc` to
step back out, `{` and `}` to jump between your own messages, `PgUp` and `PgDn`
to scroll, `Up`/`k` and `Down`/`j` to move the selection, `Ctrl+End` to follow the
live tail, `Alt+P` to jump to models.

Running and composing: `Ctrl+C` stops a run when one is active and says plainly
that a dispatched tool may still complete; with a non-empty draft it clears the
draft; on an empty draft it exits. `Ctrl+D` exits only on a **second press within
800 ms**; the first press says so. `Ctrl+L` redraws, and twice within two seconds
clears the conversation. `Ctrl+O` toggles compact and full tool output. `Ctrl+R`
searches prompt history. `Ctrl+S` stashes the draft and a second press restores
it. `Ctrl+G` opens `$EDITOR`. `Ctrl+T` runs `/todos`. `Ctrl+X` then `Ctrl+E`
within 1.5 s also opens the editor. `Shift+Tab` cycles the mode
`normal` to `accept` to `plan`, with `Alt+M` as the fallback for terminals where
Shift+Tab never arrives. `Ctrl+P` opens the command palette. Inside the composer,
`Enter` sends, `Shift+Enter` or `Alt+Enter` or `Ctrl+Enter` or `Ctrl+J` inserts a
newline, a trailing `\` then `Enter` inserts one too, and `Alt+B`, `Alt+F`,
`Alt+D`, `Ctrl+W`, `Ctrl+K`, `Ctrl+U` and `Ctrl+Y` do word and line editing over
a small in-memory kill ring. Nothing here is persisted except the `Ctrl+S` stash
for the current session.

**Nothing is configurable.** There is no keymap file and no environment variable
for rebinding. The confirmation keys are fixed on purpose: a safety decision
should not be one keystroke away from a typo.

### 8.4 The sticky approval banner

A pending hold is pinned above the body on **every** tab, in this form:

```
[!] APPROVAL PENDING[R3] postgres.row.delete a1b2c3d4 | [a] approve [d] deny (/approvals)
```

The `[R3]` suffix appears for irreversible classes, and `(+N more, /approvals)`
appears when more than one call is waiting. The banner exists so a hold cannot be
missed because you are on a different tab.

### 8.5 The local shell escape

Typing `!` followed by a command runs it once, locally, outside the agent.
`!echo hello` works. The output is shown once and **never written to the
ledger**; the detail header says `LOCAL SHELL, not stored in the ledger`.

The command is refused, before it runs, if it mentions anything that looks like
credential material: a variable whose name contains KEY, TOKEN, SECRET or
PASSWORD, the words api_key, authorization or bearer, `tokenharbor` or
`tokenrouter`, a private key or `.pem`, or `.env`, `.nomo` or `keychain`. Any
recognised secret **value** in the environment is replaced with `[redacted]` in
the output regardless.

The shell is the operator's own: `sh -c` on macOS and Linux, `cmd.exe /d /s /c`
on Windows, with `PATH` narrowed to `/usr/bin:/bin` or `%SystemRoot%\System32`
either way. The timeout is 10 s and the output cap is 64 KiB.

### 8.6 What the status bar will not invent

The status row shows the model, the mode, the message count, tokens and cost.
Several of those are honestly `unknown` rather than a number, and the distinction
matters:

| Field    | Reads `unknown` when                   |
| -------- | -------------------------------------- |
| `tokens` | the provider reported no total         |
| `cost`   | the provider reported no cost          |
| `ctx`    | the session has no context measurement |
| `model`  | nothing is connected                   |

The mode indicator **always** reads `mode: <m> (local only, not enforced)`. The
TUI mode is a prompt prefix. It shapes what the model is asked to do; it is not
an enforcement point, and the interface says so rather than implying otherwise.
When the status line is too narrow, `cost` is dropped entirely and the full
figures are under `/cost`.

`/compact` states `Token savings are unknown. No provider summarization is
promised.` and then confirms that the transcript and the ledger are preserved.

## 9. The web and desktop app

`pnpm gui` builds the client and starts the local API server. For frontend work,
run `node apps/control-plane/api/server.ts` and `pnpm dev:web` in two terminals.

The interface is English by default and Czech if you choose it in Settings. The
language choice persists in that browser profile only.

### 9.1 Routes

| Route          | What it holds                                                                |
| -------------- | ---------------------------------------------------------------------------- |
| `/chat`        | The conversation. The default route, and what an unknown path falls back to. |
| `/overview`    | Workspace counters and activity.                                             |
| `/sessions`    | Conversations, archived ones included.                                       |
| `/runs`        | Runs and activity.                                                           |
| `/documents`   | Managed documents, their history, and the recovery review.                   |
| `/approvals`   | The approval inbox, risk-first.                                              |
| `/ledger`      | Signed entries and verification scope.                                       |
| `/connections` | Tools and MCP connectors, with their tool catalogue and schemas.             |
| `/models`      | Models and usage.                                                            |
| `/settings`    | Workspace, provider, projects, custom agents, hooks, appearance, language.   |

`/demo` is a public, isolated sandbox with four managed-document tools and no
access to your workspace. There is no onboarding tour; the welcome view offers
starter actions instead.

### 9.2 Commands in the composer

Type `/` to open the menu. It matches by substring over name and description, not
fuzzily. Arrow keys move, `Enter` or `Tab` selects, `Esc` closes and keeps your
draft.

`/new`, `/plan`, `/review`, `/tools`, `/model`, `/context`, `/undo`,
`/approvals`, `/ledger`, and two that are conditional: `/export` appears only
when a conversation exists, `/stop` only while a run is in flight. Selecting a
tool row opens that tool's parameter schema and prefills a prompt describing it.
It does not execute the tool.

`Esc` in the composer, with a run in flight and no menu open, stops the run.
`ArrowUp` on an empty draft loads your previous message for editing. `Cmd` or
`Ctrl+Enter` always sends. Plain `Enter` sends only if you set **Desktop send
behavior** to `enter` **and** the window is at least 768 px wide; the default is
that plain `Enter` inserts a newline, which is why the composer looks like it is
ignoring you the first time.

At the application level: `Cmd`/`Ctrl+K` opens the command palette,
`Cmd`/`Ctrl+Shift+O` starts a new conversation, `Esc` closes whatever drawer or
dialog is open. Both are suppressed while a dialog has focus, and while an input
method editor is composing.

### 9.3 Permission modes, and who chooses them

Three modes: `plan`, `read-only`, `normal`. `plan` and `read-only` prefix your
prompt so the model is asked to describe rather than act; `normal` adds no
prefix.

**The server chooses.** The switcher in the app renders disabled and says `Server
controls this mode; it cannot be changed here.` A client cannot grant itself
permission: the preference endpoint refuses a client-supplied mode, and the
workbench tests cover write calls, the tool catalogue, crafted calls, recovery and
Undo, and branching under each mode. If the server does not answer, the app falls
back to `read-only` and says so in the banner.

This is the important difference from the TUI: the GUI mode is authoritative, the
TUI mode is a prompt prefix.

### 9.4 Approving a call

The inbox polls every five seconds and sorts irreversible and mitigable calls to
the top. Each card gives a plain-language action, the class, the blast radius,
the workspace, the local expiry time and the policy rationale.

**Review and decide** opens the modal. It shows the facts, the rationale, the
proposed change as a real diff when the server sent a before image and an
explicit statement when it did not, and a disclosure holding the redacted full
record. Secret-looking keys are masked before they reach the DOM.

- **Approve** and **Deny** are the only two actions.
- **A denial requires a note.** An empty reason is refused client-side with
  `Denials require a short reason for the audit record.` The note is capped at
  500 characters and is stored with the decision.
- **R3 and unknown need a second press.** The first click only arms, the hint
  says press again within eight seconds, and the arm lapses. This slows a
  deliberate hand, and the server remains the authority.
- **A late or duplicate decision is a conflict, not a second write.** The server
  answers 409 or 404 and the modal says `This approval was already decided
elsewhere or expired. No second write was made`. Expiry is the server's call.

### 9.5 Undo and recovery in the app

**Single operation.** Documents, then **Document history**. Search by path or
operation id, choose **Review change**, and the modal shows a side-by-side before
and after diff with line numbers, and the server's reason for the operation.
**Confirm Undo** is enabled only when the server says the change can be applied;
it posts the operation id back as the confirmation token. The success text is
`Change reversed. Evidence remains preserved.` A failure offers **Refresh
preview**, and the preview is re-fetched from the server rather than reused.

**Several operations.** Tick the operations and press **Preview recovery of
selected changes (N)**. The dialog plans a job, then shows the job id, the plan
digest, each step with its sequence and resources, and any residual or uncertain
operations. The plan stays fixed until you refresh it, and a refresh mints a new
job id, so a refresh really is a new plan. **Approve and apply this plan** posts
the plan digest with the approval, so the approval cannot be moved onto different
work. **Check job status** is read-only.

The result names the outcome: Restored, Partially restored, Conflict, Outcome
unknown, Paused, Missing source, Not successful, Compensated, or Blocked by
conflict. A conflict or an unknown outcome is never retried automatically, and
the evidence is never deleted.

A read-only status chip for the last recovery job stays visible in the composer.
It reports status and offers only a refresh. **It grants no recovery authority.**

## 10. The command line

Twenty-two commands. `nomo --help` prints the list; `nomo <command>` with no
arguments prints that command's usage.

| Command          | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| `nomo tui`       | The terminal workspace.                                                   |
| `nomo watch`     | A full-screen live ledger view.                                           |
| `nomo run`       | The MCP proxy: `nomo-proxy` in front of an agent's tools.                 |
| `nomo classify`  | Classify the tool calls in a transcript, or one named call.               |
| `nomo feed`      | Print ledger entries, optionally following.                               |
| `nomo verify`    | Verify a ledger's chain and signatures.                                   |
| `nomo ledger`    | The ledger group. `nomo ledger verify <dir>` verifies a ledger directory. |
| `nomo attest`    | Write a signed attestation over a workspace's entries.                    |
| `nomo export`    | Write a recovery evidence bundle.                                         |
| `nomo replay`    | Replay or dry-run a recorded inverse.                                     |
| `nomo taint`     | Show the dependency neighbourhood of a ledger entry.                      |
| `nomo metrics`   | Machine-readable counters over the ledger and journal.                    |
| `nomo policy`    | List, show and validate policy packs and files.                           |
| `nomo approvals` | List pending holds.                                                       |
| `nomo approve`   | Record a decision against a hold.                                         |
| `nomo recovery`  | The managed executor: inspect, plan, apply, reconcile, serve.             |
| `nomo agent`     | Run one agent turn non-interactively.                                     |
| `nomo doctor`    | Report the environment.                                                   |
| `nomo config`    | Print resolved configuration. Never prints secret values.                 |
| `nomo init`      | Create the workspace layout.                                              |
| `nomo update`    | Move the installed tree to the tracked branch, fast-forward only.         |
| `nomo state`     | Summarise or migrate persisted workspace state.                           |

The ones that take arguments, exactly:

```sh
nomo classify --transcript <file> [--facts <file>]
nomo classify --tool <id> [--facts <file>] [--fact k=v] [--args <json>]
nomo feed --ledger <dir> [--json] [--follow]
nomo verify --ledger <dir> [--attestation <file>]
nomo attest --ledger <dir> --workspace <id>
nomo taint --ledger <dir> --seq <n> [--depth <n>] [--json]
nomo replay --ledger <path> --snapshot-dir <dir> --seq <n> [--dry-run] [--key base64-spki]
nomo replay --list-connectors
nomo agent --model <id> [--prompt <text>]
nomo recovery conformance [--adapter filesystem.managed|git.managed|managed-documents]
nomo recovery <install|migrate|health|inspect|execute|plan|plan-job|apply-job|status-job|apply|reconcile|reconcile-recovery|serve> --config <file> [--input <file>] [--approve <digest>]
nomo policy list | show <name> | validate <file>
nomo approve <hold-id> --by <who> [--deny] [--reason <text>] [--dir <path>]
nomo approvals --dir <path> [--json]
nomo update [--check] [--force]
```

Notes that save time:

- `nomo config` prints the resolved data, ledger and approvals directories and
  whether a verification key is set. It never prints the key.
- `nomo verify` on a ledger with no entries in the current directory fails with a
  plain `ENOENT` naming the path. That is the first-run state, not a fault.
- `nomo classify --tool <id>` classifies one call instead of a transcript and
  exits 0 when the registry decided, 2 when it could not. Read the `facts:`
  line before the `tone:` line: with no declared facts the evaluator can only
  reach the entry's terminal case, so an `r3` there is the fail-closed
  posture rather than a reading of your account. `--fact k=v` overrides
  `--facts <file>` for that call, and the value is the literal text the
  registry compares against.
- `nomo replay --dry-run` reports what an inverse would do without performing it.
  Use it before any real replay.
- Every `nomo recovery` action that changes something requires `--approve <digest>`
  from the preceding `plan`. The digest is what binds your approval to that exact
  work.
- `nomo policy` with no argument lists the shipped packs: `strict`, `balanced`,
  `dev`.
- `nomo update` moves the installed tree, which lives at `~/.local/share/nomo-cli`
  by default and is set by `NOMO_HOME`. It is a fast-forward only: a tree with
  uncommitted changes is refused, and `--force` still refuses one, because no
  flag is a reason to delete an operator's edits. Local commits are dropped only
  when `--force` says so out loud, and even then with `git reset --keep`, so a
  mistake stops at a modified file.
- `nomo update --check` changes nothing and prints four facts then one verdict
  line: `installed:`, `installed-commit:`, `tracked-branch:`, `target-commit:`,
  then `up to date` or `update available`. It exits 3 when an update exists and
  0 when the tree is current. A tree that cannot reach the remote also exits 0
  and reports `target-commit: unknown`, so read the verdict line rather than
  trusting the exit code alone.
- `nomo update` has no channel flag. There is no `--stable` and no `--canary`;
  the target is whatever the installed tree's tracked branch points at.

## 11. Policy files

A policy file is YAML. The whole grammar is five match keys, one decision per
rule, and first match wins.

```yaml
version: 1
rules:
  - match:
      tool: postgres.table.drop
    decision: deny
    rationale: schema drops never recover from a rollback
  - match:
      class: r0
    decision: allow
    rationale: fully reversible calls go through, the ledger keeps the inverse
  - match:
      class: r1
      blast_radius: { lt: 100 }
    decision: allow
    rationale: a cheap inverse on fewer than a hundred things is below the line
  - match:
      class: [r2, r3]
    decision: hold
    seconds: 120
    notify: [cli, slack]
    rationale: the damage is visible or permanent, so a human looks first
  - match: {}
    decision: hold
    seconds: 300
    rationale: nothing matched, so the call waits for a person
```

**The five match keys**: `class` (r0 to r3, or a list), `tool` (an exact id or
one trailing wildcard such as `postgres.row.*`), `connector`, `workspace`, and
`blast_radius` with `lt`, `lte`, `gt` or `gte`. Keys inside one `match` are ANDed.
A list in one key is ORed.

**The three decisions**: `allow`, `deny`, and `hold` with `seconds` and `notify`.

Four properties make the format growable without breaking your file:

1. `version: 1` is required. An unknown version is a load error, never a guess.
2. An unknown key or an unknown value anywhere is a loud load error. A typo like
   `blast_radus` fails the load instead of quietly widening a narrow rule to
   everything of that class.
3. Because keys AND together, adding a sixth key later is additive and cannot
   change what an existing file means.
4. Every rule carries a stable `id`, and the ledger records the matched rule
   together with a digest of the policy text, so an audit can say which file
   produced a decision.

**Defaults, and the distinction between two different failures:**

- **No rule matched in a valid file: hold.** Hold is the only decision that is
  itself reversible, and the notification names the rule you are missing. The
  schema still requires a terminal catch-all rule, so in a well-formed file this
  never fires.
- **The file is missing, unreadable, invalid, or of an unknown version: deny,
  loudly.** That is a broken configuration, not an unmatched call, and the two
  must not resolve the same way.

**What the format cannot express, so you do not look for it:** no rule relates
two calls. There is no rate, no running total, no time window, and no rule about
the human behind the agent beyond the workspace. Irreversibility budgets, which
are stateful rules of exactly that kind, are separate work.

`nomo policy validate <file>` checks a file without installing it. Validate
before you point a proxy at it, because an invalid file denies everything.

## 12. The ledger

The ledger is one JSON object per line in an append-only file, under
`~/.nomo/ledger/<workspace>.jsonl` by default. `nomo feed` prints it, `nomo verify`
checks it, and `/verify` in the TUI does the same with the scope on screen.

**Verify it offline.** `packages/verifier/verify-ledger.mjs` is a
single-file verifier with no dependencies, runnable without installing NOMO:

```sh
node packages/verifier/verify-ledger.mjs --selftest
```

Its self-test exercises a round trip, an edited body, a wrong key, integrity
without a key, and a tampered attestation. It is the check a third party can run
to decide whether they believe you.

**What verification proves.** Each entry is signed with Ed25519 over a
domain-separated, versioned preimage that binds the algorithm and the key id, and
each entry's hash chains to its predecessor. So verification proves the sequence
is unbroken, the bodies match their digests, and the signatures were made with
the key that signed them. It does not prove nobody with that key wrote something
false, and it does not prove the process was not rolled back to an earlier head.
Trust the key's custody as much as the mathematics.

**A development key is labelled as one.** When no key is configured, NOMO
generates one under `~/.nomo/keys/`, says loudly that a development key is in
use, and gives the key id a `dev-` prefix. The verifier reports an entry signed by
such a key as valid under a development key, never as plain valid. On Windows the
key file is narrowed with an ACL; on POSIX it is mode 0600.

**Reading the app's verify view.** The GUI ledger page and the TUI `/verify` show
what was checked, the head digest, the key id and the number of entries examined.
The cache is keyed to the head, so a changed head re-verifies. The server verifies
the whole ledger on each call, which is honest and not fast; a scoped job is not
shipped.

**`/export` refuses on an unverified ledger** with `Export refused: a ledger has
not been verified.` Verify first.

## 13. Undo and recovery

Recovery is a **separate, confirmed action on a plan**, never a side effect of a
write. That separation is the entire point of holding a before image.

The flow is always the same shape:

1. **Plan.** `nomo recovery plan`, `/undo`, or `/rewind` in the TUI. You get a
   digest, the steps in order, the resources each touches, and the residuals.
2. **Review.** Read it. A drift or a missing artifact shows here.
3. **Approve.** The approval binds the plan digest, so it cannot be moved onto
   different work.
4. **Apply.** Each step is performed through the same single-operation path.
5. **Reconcile if needed.** An uncertain outcome stays uncertain until durable
   evidence resolves it. It is never retried on its own.

**Statuses you will meet**: `restored`, `partial`, `conflict`, `unknown`,
`paused`, `missing`, `not-successful`, `compensated`, `blocked-by-conflict`.
`partial` means a compensation ran, which is not the same as an exact restore,
and the interface says which one you got.

**Rules the runner does not bend:**

- Reusing a plan digest with different content is refused.
- A human edit between capture and Undo is a conflict. The newer value is kept.
- An interrupted inverse is `unknown`, and the next start does not repeat it.
- Recovery writes a new signed event linked to the original. **It never deletes
  the original evidence.**
- A repeat of the same job produces no second effect. A restart after an inverse
  reads the receipt instead of authorising another inverse.
- One Undo at a time in a workspace, and new forward writes are blocked while a
  recovery job is unterminal.

**Drift is a refusal, not a warning.** After Undo, `filesystem.managed` binds the
managed root to its original path and its inode and ctime revision. Copy or move
that directory and Undo returns `conflict` with no evidence attached. The
operation does not silently rebind to the new path.

**Where the proof ends up.** For the managed Postgres adapter it is durable and
it is local. The restore re-reads the rows it wrote, refuses unless they equal
the capture (`packages/connectors/src/postgres/managed.ts:1393`), and only then
writes the record into `${schema}.recoveries` in your own database
(`packages/connectors/src/postgres/managed.ts:1399`). Nobody has to trust NOMO
to read it: `docs/RECEIPT-VERIFY.sql` is plain SQL over tables you own, and it
was run against a tampered row to confirm it reports `FAIL`
(`scripts/receipt-demo/README.md`).

**What is not covered.** Managed Postgres, the managed filesystem and managed
Git commits are the adapters with real capture. R08 and R09, managed S3 and
managed GitHub and Vercel adapters, do not exist as executable adapters yet.
Staged holds and cascading cancel, the R11 work, are not implemented. There is
no cross-system plan, and no independent branch continuation: a conflict stops
the dependent steps.

**A repeated caveat worth reading twice.** Git recovery on Windows is refused.
`git.managed` is POSIX only and says so. Filesystem capture on Windows covers
bytes and not POSIX mode, because Windows has no mode to capture.

## 14. Hosting an MCP server

`nomo recovery serve --config <file>` exposes the managed executor as a local
stdio MCP server for an agent to call. The configuration names the workspace, a
stable `agentId`, a state directory, the environment variable holding the
encryption key, and the adapters to expose.

```json
{
  "workspace": "test",
  "agentId": "test-agent",
  "stateDir": "state",
  "encryptionKeyEnv": "NOMO_RECOVERY_KEY",
  "filesystem": { "root": "project", "cooperative": true }
}
```

**Eight tools are implemented.** `nomo_execute`, `nomo_recovery_plan`,
`nomo_recovery_apply`, `nomo_recovery_plan_job`, `nomo_recovery_status_job`,
`nomo_recovery_apply_job`, `nomo_reconcile`, `nomo_recovery_reconcile`.

**A host may authorize fewer.** The Prime dogfood setup authorizes five:
`nomo_execute`, `nomo_recovery_plan`, `nomo_recovery_apply`, `nomo_reconcile`,
`nomo_recovery_reconcile`. The three job tools are implemented and not authorized
there. Which set is live is a host decision, recorded per deployment.

**The boundary is enforced server-side.** The agent may not supply its own
workspace, adapter identity or approval grant. A tool call carrying those is
refused, and the tests cover exactly that. The policy is reloaded per request, so
editing the policy file takes effect on the next call.

**Interactive approval is not implemented on this transport.** Hold and deny
refuse execution; there is no prompt inside the MCP session. Approve from the TUI,
the GUI, or `nomo approve`.

**A plan digest is not policy authorization.** A digest says what would be done.
Permission comes from the policy and, where the policy says hold, from a human.

## 15. The desktop applications

The desktop shell is a Tauri 2 application that bundles its own Node runtime,
verified at build time against a pinned official SHA-256 for each target. The end
user installs nothing.

```sh
pnpm desktop:setup   # install the isolated desktop workspace
pnpm desktop         # development build
pnpm desktop:build   # packaged application
pnpm desktop:test    # desktop runtime and release metadata tests
```

**Targets.** macOS arm64 and x64, and Windows x64 through NSIS. **Linux is not
supported**: the runtime preparation refuses an unsupported host, and the shell
refuses to start.

**Signing is honest about its state.** A local macOS build is ad-hoc signed by
default. There is no Developer ID signature, no notarization and no Mac App Store
path in this repository, and the packaging policy refuses store mode rather than
producing an artifact that cannot be distributed. The Windows installer is
unsigned and SmartScreen will warn.

**Smoke tests are built in.** The packaged binary accepts `--smoke-test`,
`--smoke-mobile` and `--smoke-runtime-exit`. These start the bundled runtime, load
the web view, check the render, exercise a download byte for byte, and exit with
a code you can gate on.

**The iOS companion is read-only.** It pairs to one explicitly paired Mac over a
trusted local network. The pairing control is disabled in the current build, and
the executor is always the Mac. Nothing it shows implies local execution.

## 16. Platform differences

These are real, current, and worth knowing before you file a bug.

| Area                           | macOS and Linux       | Windows                                                |
| ------------------------------ | --------------------- | ------------------------------------------------------ |
| Filesystem recovery scope      | bytes and POSIX mode  | bytes only; Windows has no mode to capture             |
| Git managed recovery           | supported             | refused, POSIX only                                    |
| TUI local shell                | `sh -c`               | `cmd.exe /d /s /c`                                     |
| Approval state privacy         | mode narrowed to 0700 | directory checked, ACL inherited from the user profile |
| Dev signing key                | mode 0600             | ACL narrowed to the current user                       |
| Line endings in the repository | LF                    | LF, via `.gitattributes`                               |

Two Windows-only rough edges, stated rather than hidden: `nomo recovery
conformance --adapter git.managed` reports a `platform-refusal` failure there by
design, and the TUI's `/harness` detection splits `PATH` on `:` only, so it
reports nothing found on Windows.

## 17. Troubleshooting

**`pnpm install` fails on a machine with no POSIX shell.** Fixed in this
repository. If you see it, your checkout predates the fix; the preinstall hook is
now a Node script.

**`ERR_SQLITE_ERROR: unable to open database file`.** The state directory is not
writable, or the path is wrong. Run `nomo config` and check the reported data
directory, then `nomo doctor`, which reports writability.

**`ERR_UNSUPPORTED_ESM_URL_SCHEME ... protocol 'd:'`.** A Windows path reached an
import. Fixed in this repository; if you hit it you are running an older build.

**`No local Chromium binary found`.** The browser layout gate needs a Chromium.
Set `NOMO_QA_CHROMIUM` to point at one. Without it the gate reports a named skip
and a todo rather than passing quietly.

**`Ledger verification reports hash integrity but no signature check`.** No
verification key is set. `nomo config` shows `verify-key: unset`. Set
`NOMO_SIGNING_KEY` or accept integrity-only verification and say so.

**Every call is denied and you do not know why.** Read the refusal: it names the
rule id, the class, and what approval would require. Then run
`nomo policy validate <file>`. An unreadable or invalid policy denies loudly by
design.

**A hold never appears anywhere.** The call was allowed, not held. Check
`/ledger` for the decision and its matched rule, and `nomo approvals` for
anything still pending.

**The TUI shows `mode: plan (local only, not enforced)` and you expected a
block.** Read the section on permission modes. The TUI mode is a prompt prefix.
The GUI mode is the enforced one.

**`Setup required` and nothing dispatches.** No provider credential resolves. See
section 6. NOMO does not fall back to another provider.

**`Export refused: a ledger has not been verified.`** Run `nomo verify` first, on
the same directory.

**Undo returns `conflict`.** Something changed the target after capture. That is
the drift check working. Read the conflict rather than retrying.

**The GUI says `Multi-operation recovery is not available on this host.`** The
host did not advertise recovery jobs. Single-operation Undo still works.

## 18. Before you point this at production

A checklist, in the order that catches the most.

1. **Run `nomo doctor` and read every line.** An unwritable ledger directory is
   the failure that matters most.
2. **Connect a provider and confirm the badge says Ready.** A workspace that
   cannot dispatch is safe but useless, and you want to know which one you have.
3. **Run `nomo init`, then `nomo doctor` again.** Confirm the second run has no
   warning about the ledger directory.
4. **Decide the permission mode's owner.** In the GUI the server owns it. Confirm
   what your host returns from `GET /api/capabilities`, because the app falls back
   to read-only if the server does not answer.
5. **Write and verify your own policy.** Start from `nomo policy show dev` and
   tighten. Validate it. A typo in a match key fails the load rather than
   widening a rule, but only once you have validated.
6. **Confirm which resources are managed.** Undo is real only for files NOMO
   owns. A cooperative directory that another program also writes will produce a
   conflict on Undo, and that is the correct outcome.
7. **Prove the ledger on a machine that is not the one running NOMO.** Take a
   `nomo export` bundle and run the standalone verifier against it elsewhere.
8. **Rehearse a real hold.** Run the simulated moment from the repository root
   with `node scripts/src/moment.mjs`. It shows one denied delete, one approved
   delete, and the exact text the agent reads after a hold resolves.
9. **Rehearse a real Undo.** Write a document, stop, restart, and undo. If the
   host cannot do that, your recovery claim is not real.
10. **Know what you have not certified.** Physical devices, browser zoom, screen
    readers, notarization, a production KMS and a store submission are all outside
    anything this repository can prove. [the release evidence matrix](RELEASE-1.0.1-MATRIX.md) records each
    one as open or witnessed, per item.
11. **Accept the per-hunk limit.** Toggling a hunk in the review narrows what you
    inspect. The server does not yet narrow what it executes, so a partial review
    is not a partial approval. Until that lands, approve the whole call or none.
12. **Decide about credentials deliberately.** Keys in the host environment are
    convenient and readable by that process. Keys stored through the GUI are
    encrypted server-side. Neither is a hardware boundary.

## 19. Where to go deeper

| Subject                                                 | Document                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The terminal workspace in Czech, with the full key list | [the terminal workspace in Czech, with the full key list](TUI-WORKSPACE.md)                                                         |
| GUI commands and tool catalogue                         | [GUI commands and the tool catalogue](GUI-COMMANDS.md)                                                                              |
| Operating the proxy, approvals and the ledger layout    | [operating the proxy, approvals and the ledger layout](OPERATIONS.md)                                                               |
| The policy grammar reference                            | [the policy grammar reference](POLICY-REFERENCE.md)                                                                                 |
| What is certified, and what is not                      | [the executable recovery contract and its limits](RECOVERY-CONTRACT.md), [what is certified, and what is not](RECOVERY-COVERAGE.md) |
| The executable recovery contract and its limits         | [the executable recovery contract and its limits](RECOVERY-CONTRACT.md)                                                             |
| Adding a connector                                      | [adding a connector](CONNECTOR-GUIDE.md)                                                                                            |
| The embedding SDK                                       | [the embedding SDK](SDK.md)                                                                                                         |
| Cloud deployment                                        | [cloud deployment](CLOUD-INTEGRATION.md)                                                                                            |
| Managed Postgres recovery                               | [managed Postgres recovery](MANAGED-RECOVERY.md)                                                                                    |
| Managed filesystem recovery                             | [managed filesystem recovery](MANAGED-FILESYSTEM.md)                                                                                |
| Managed Git recovery                                    | [managed Git recovery](MANAGED-GIT.md)                                                                                              |
| Adapter conformance and what a certification means      | [adapter conformance and what a certification means](ADAPTER-CONFORMANCE.md)                                                        |
| The receipt, and who can check it without NOMO          | [a recovery receipt, verified without NOMO](../scripts/receipt-demo/README.md), [the SQL a third party runs](RECEIPT-VERIFY.sql)    |
| The decisions behind the design                         | [context](CONTEXT.md), [decision log](DECISIONS.md)                                                                                 |
| The standards this repository holds itself to           | [the standards](STANDARDS.md)                                                                                                       |
| The release evidence matrix                             | [the release evidence matrix](RELEASE-1.0.1-MATRIX.md)                                                                              |
| Current NOMO MVP plan and roadmap                      | [active NOMO implementation plan](superpowers/plans/2026-10-08-nomo-agent-identity-fleet-mvp-and-roadmap.md)                           |
| Windows desktop specifics                               | [Windows desktop specifics](WINDOWS-DESKTOP.md)                                                                                     |
| Beta boundaries                                         | [beta boundaries](BETA.md)                                                                                                          |
| How this handbook is kept true                          | [how this handbook is kept true](../scripts/src/handbook.test.mjs)                                                                  |
