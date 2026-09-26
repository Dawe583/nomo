# The reverse-engineering wedge: should VOID become an RE tool, and what is the first defensible move

Written 2026-09-26 against commit `63dbd2c` on `main`. Companion to
`docs/VOID-FUTURE-DIRECTION.md` (the outside-in assessment) and
`docs/PREMISE-VERIFICATION.md` (its adversarial check). This document is a third
thing: it asks a narrower question and answers it with a decision.

**The question.** The stated project goal is an AI agentic reverse-engineering
tool for security. The repository has no binary parsing, no disassembly, no
decompilation, no symbolic execution, no YARA, no PCAP, no firmware work, no
protocol reconstruction, no exploit generation and no fuzzing. It has a signed
hash-chained ledger, an effect-level policy engine, a recovery substrate, an MCP
server, and — as of `63dbd2c` — a record of which policy decided each call and
which rule fired. The question is not whether VOID can analyse binaries. It is
what the defensible first move from a governed-executor substrate into reverse
engineering is.

**The decision, in one sentence:** do not wrap an analyser and do not reframe
the goal; build the one thing every RE MCP server lacks and every RE tool does
locally — a *re-derivable* record of what an agent claimed about a binary, bound
to the exact bytes it claimed it about — and ship the evidence-binding and its
verifier before touching a single third-party tool.

---

## 1. Method, and what I could not check

Local claims were checked by reading source at `63dbd2c` and by reproducing
gits. External claims were checked by fetching **primary sources** — vendor
documentation, vendor blogs, the GitHub REST API, and arXiv — on 2026-09-26.

**Web search was unavailable for this entire session.** The search tool failed on
every provider: Codex returned `429 usage_limit_reached` with a reset window of
about 40 days, Startpage returned no renderable content, DuckDuckGo and Mojeek
returned bot walls, Ecosia timed out, and Google returned no renderable content.
Everything external below therefore rests on first-party pages and the GitHub
API, reached directly by URL. That is a *different* weakness from the one
`PREMISE-VERIFICATION.md` records: it reached primary sources for the same
reasons, but it could not triangulate. Where a fact could only be established by
a third-party summary I have marked it **unverified** rather than assumed it.

I did not run `pnpm test`, did not build, did not boot a simulator, did not touch
git history, and did not read a credential, keychain value, or any signing
private material.

**Things I did not verify and will not guess at:**

- Binary Ninja **Sidekick** subscription pricing. `VOID-FUTURE-DIRECTION.md`
  §2.4 quotes "$0 / $30 / $100 / $300 per month, or $5,000 per concurrent user
  per year self-hosted". I verified the *licence* pricing for Binary Ninja
  itself (below) and found Sidekick's own blog post saying only that "we recently
  launched free Sidekick credits for ALL Binary Ninja users with active support
  … The included free credits refill every month." I did not find the Sidekick
  price list. Treat the FUTURE-DIRECTION figures as **unconfirmed by me**.
- Hex-Rays **Private Lumina** being "a self-hosted function-metadata lookup
  server — hash-only, no LLM". Not checked.
- The **Doyensec** XBOW-vs-Aikido measurement and the **ProjectDiscovery**
  54-target behavioural audit. Both are quoted at second hand from
  `VOID-FUTURE-DIRECTION.md` and I did not re-fetch either primary. I do not
  lean on them below except where I say I do.
- Whether the **181-repository** "ghidra mcp" GitHub search figure still holds. I
  checked the leading repo directly, not the search.
- Any claim about how much of a *federated* IDA fleet the IDA Nexus concurrency
  layer actually coordinates in practice. It is documented; I have no
  measurements.

---

## 2. What RE tooling actually exists for an agent in September 2026

I checked each of these directly. The useful finding is not the list; it is that
**the agent-facing surface has been commoditised into three shapes, and only one
of them has a write surface that can be named.**

### 2.1 Ghidra — the licence-clean incumbent with no agent surface

- **Version.** `Ghidra_12.1.4_build`, published **2026-09-21**, asset
  `ghidra_12.1.4_PUBLIC_20260921.zip`, 569,649,598 bytes,
  `sha256:ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`,
  40,512 downloads at read time. Source: `api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest`.
- **Licence.** **Apache-2.0.** Some NSA-authored portions are additionally
  dedicated to the public domain; the effect is permissive either way. Apache-2.0
  is the same licence VOID ships, so there is no distribution incompatibility
  between a VOID that drives Ghidra and a VOID that is Ghidra.
- **Agent surface.** **None from NSA.** The leading third-party server,
  `LaurieWired/GhidraMCP`, is **Apache-2.0**, **10,188★**, but its last push is
  **2025-06-23** — dormant for fifteen months — with 84 open issues. It is not
  archived, so it is not declared dead, but nothing has landed on it since June
  2025.
- **What this means.** Ghidra is free, permissive, ships
  `analyzeHeadless` in the box, and has no first-party LLM integration. It is the
  right *licence* and the wrong *shape* for a first agent-facing increment.

### 2.2 Binary Ninja — the best agent product, and the licence is not OSS

Binary Ninja **6.0 (Krypton)**, released **2026-09-03** by Jordan Wiens, with a
first-party MCP server.

- **Licence.** Proprietary EULA, not open source. Post-6.0 pricing is
  perpetual-licence-plus-updates: Free $0, Non-Commercial **$199**, Commercial
  **$1,799**, Headless **$1,259**, Ultimate **$3,499**. Non-Commercial went
  *down* from $299; Commercial went *up*.
- **The MCP surface, precisely.** Two variants, and `VOID-FUTURE-DIRECTION.md`
  §2.4's phrase "in every edition, including free" is **only true of one of
  them**. From `docs.binary.ninja/guide/mcp.html`, read today:
  - *GUI server* — binary `binaryninja`, **HTTP only**, "Included with every
    GUI edition and supported on native Windows", default
    `http://127.0.0.1:24642/mcp`, bearer-token capable via `ui.mcp.token`.
  - *Headless server* — binary `binaryninja_mcp`, **stdio only**, "Included with
    Binary Ninja Commercial or Ultimate on macOS and Linux" and, stated twice,
    **"not available in Binary Ninja Free or Personal"**, and not yet shipped for
    native Windows.
- **Free edition limits, verbatim from `binary.ninja/free/`:** "Not for
  commercial purposes", "No API / plugin access", "Limited ILs (Disassembly,
  HLIL, Pseudo C only)", no Sidekick. So a Free user gets the GUI MCP server and
  no way to extend or script it.
- **A material documentation discrepancy, which matters a great deal here.** The
  6.0 release post says the two variants "expose the same data and allow the same
  actions" and that "**They can rename objects, create and apply types, and create
  data variables**". The current reference documentation describes the opposite
  posture three times: "query **read-only** BinaryView information", "the same
  file manager and **read-only** BinaryView inspection tools", and
  "The exact tool list **may change** as the MCP server develops". I cannot
  resolve which is current. **If the docs are right, there is no governed write
  surface to wrap at all, and the whole "wrap the analyser" option has nothing
  to wrap.**
- **What this means.** Binary Ninja is the strongest agentic RE product in
  existence and it is not open source. A VOID that drives it is a VOID that
  requires the user to hold a $199–$1,799 licence, and whose Free tier cannot be
  used commercially. Under the standing constraint that the first step must not
  require the user to pay, **Binary Ninja is disqualified as a first step** and
  admissible later as a paid optional upstream.

### 2.3 Hex-Rays — first-party, MIT, and gated behind a paid IDA

`HexRaysSA/ida-mcp`, "Official Hex-Rays IDA MCP Server."

- **Licence.** **MIT.** `LICENSE` is 1,067 bytes at the repo root. First-party:
  built and maintained by Hex-Rays, not a community project.
- **Vintage.** Repo **created 2026-08-27**; last push **2026-09-26**; **153★**,
  4 forks, 4 open issues. Announced by Duncan Ogilvie on the Hex-Rays blog
  **2026-09-25**. So the date in `VOID-FUTURE-DIRECTION.md` is right; the
  adoption is thirty days old and 153 stars.
- **The incumbent it displaces.** `mrexodia/ida-pro-mcp` is **MIT**, **12,347★**,
  pushed today, and its own README now opens with "I recommend using the
  **Official Hex-Rays IDA MCP Server** instead!". `VOID-FUTURE-DIRECTION.md`
  does not mention this 12k★ project at all. That omission matters more than the
  Hex-Rays launch does, because 12,347★ is the actual adoption number for
  agent-driven IDA and it is what a competitor would measure against.
- **Licence gate.** From `docs.hex-rays.com/core/mcp/overview.md`: "The Hex-Rays
  IDA MCP Server is available with **IDA Home, IDA Pro (Essential/Expert/Ultimate),
  and IDA Classroom**." **IDA Free is not in the list.** Paid licence required.
- **The security posture, verbatim, and this is the most important sentence in
  this section.** From the launch post: "A tradeoff with this approach is that,
  because IDA does not yet isolate its Python interpreter from the wider system,
  **the agent can evaluate scripts that reach beyond IDA's database** … it is
  important to understand this additional surface provided by IDA MCP.
  **Therefore, we recommend running the harness and IDA MCP in a sandboxed
  environment when dealing with untrusted data.**"
- **The tool surface is the problem for a policy engine.** The post lists three
  tool groups: "Database: open, close, list, save"; "**IDAPython: read/write/update
  the database and evaluate logic using Python**"; "Reference: search". The
  *entire* write surface is **arbitrary IDAPython**. A policy engine cannot
  classify `execute_python` into effect classes, because the effect is whatever
  the script does. This is not a gap in IDA MCP; it is a consequence of the Code
  Mode design that Hex-Rays chose on purpose for a stated reason (token
  efficiency: "approximately 20%" token reduction, on an internal benchmark with
  no published numbers). **The design decision and VOID's design requirement are
  in direct conflict, and no amount of integration fixes it.**
- **The evidence artefact is a gist.** The post's demo concludes: "If you're
  curious about how the agent came to these conclusions, you can read through the
  tool call trace that we've exported here." A published gist. Unsigned,
  unanchored, not exportable by a user, not tied to a binary digest.
- **What this means.** The best licence in the field (MIT, first-party) sits
  behind a paid analyser, and its write surface is an unclassifiable escape
  hatch. The one design that *would* fit a governed executor is the one design
  the vendor documented as a sandboxing problem.

### 2.4 angr — the option nobody in this repo has counted, and the only clean one

`angr/angr`, **9,114★**, last push **2026-09-26**, **BSD-2-Clause**. `pip install
angr`. No paid licence, no commercial restriction, no vendor EULA.

**angr ships a full MCP server in mainline.** I read the tree: `angr/mcp/`
contains `__init__.py`, `__main__.py`, `server.py`, `session.py`,
`serializers.py`, `errors.py` and — decisively — **`edit_tools.py`**.

- `angr/mcp/server.py` builds `FastMCP("angr-mcp", instructions="Binary analysis
  server powered by angr")` and then registers **exactly one** middleware:
  `mcp.add_middleware(StdoutGuardMiddleware())`. That middleware's entire job is
  to keep analysis output off stdout so it does not corrupt the stdio JSON-RPC
  channel. **There is no approval gate, no confirmation step, no policy hook, no
  audit, and no human-in-the-loop anywhere in the server.**
- `angr/mcp/edit_tools.py` provides batched `rename`, `set_type` and
  `set_comments` over `kind ∈ {function, variable, global}` / `{function,
  variable, global, return}` / `{address, function}`, with `dry_run`,
  `stop_on_error`, `allow_overwrite`, `auto_decompile`, and a per-item result
  carrying `status`, `old`, `new`, `function_address`, `error`, `error_kind` and
  `candidates`. **Renames persist across re-decompilation.** The module also
  imports `restore_user_edits` from `angr.analyses.decompiler.edits`, so angr has
  the ingredients of an inverse; what it does not have is a journal of one.
- **The two sentences that decide this document, from that file's own
  docstrings.** On `stop_on_error`: "**Edits already applied are NOT rolled
  back; use dry_run as a pre-flight.**" On `dry_run`: "Resolve and validate
  without changing anything. **Not side-effect free: resolving a variable name
  may decompile the function.**"

That is the whole thesis, in a BSD-2-Clause incumbent's mainline source, today:
a named, batched, partially-failing write to durable analysis state, where the
tool's own documentation tells you the failure mode is a torn write with no
rollback and the safety valve is not actually safe.

### 2.5 radare2 — permissive-ish, scriptable, no agent surface of its own

`radareorg/radare2`, **24,877★**, pushed **2026-09-26**. GitHub reports
`NOASSERTION`; the real answer is in `COPYING.md` on `master`: "**Most of
radare2 is licensed under the LGPLv3**, but as its dependencies and plugins are
distributed with different licenses. Probably the only concern for distributing
static builds of radare2 is the **GPL** license, and you can skip the related
code with the `--without-gpl` configure flag."

For a VOID that *subprocesses* `r2` rather than linking it, LGPLv3 is not a
distribution problem. The problem is that r2 has no first-party MCP server, so
integrating it means writing the bridge — which is a project, not an increment.

### 2.6 What the landscape adds up to

| Tool | Licence | Cost | Agent surface | Named write surface | Governed | Undo |
|---|---|---|---|---|---|---|
| Ghidra 12.1.4 | Apache-2.0 | $0 | none (NSA); GhidraMCP Apache-2.0, 10,188★, dormant 15mo | n/a | no | n/a |
| Binary Ninja 6.0 | proprietary EULA | $0 Free (non-commercial, no API) / $199+ | **first-party**, GUI HTTP in Free; `binaryninja_mcp` headless is **Commercial/Ultimate only** | contested: blog says rename/type/data-var, docs say read-only | no | BN `Ctrl+Z` |
| Hex-Rays IDA MCP | **MIT, first-party** | needs **paid** IDA (Home/Pro/Classroom; **not** IDA Free) | first-party, Code Mode | **arbitrary IDAPython** — unclassifiable | no; vendor says "sandbox it" | not documented |
| angr 0.x mainline | **BSD-2-Clause** | $0, `pip install` | **first-party, in mainline** | **`rename`/`set_type`/`set_comments`**, batched, named | no; one middleware, stdout hygiene | partial lib; **tool docs say not rolled back** |
| radare2 | LGPLv3 (+GPL opt-out) | $0 | none first-party | n/a | no | CLI history |
| Sidekick (BN add-on) | proprietary, on a paid BN | unverified | built in | five *Suggest* operations, applied **directly** | per-user permission overrides | `Ctrl+Z`, local SQLite |

**Not one of them has a policy layer, a signed record, or an exportable
third-party-checkable artefact.** That is not my inference; for Hex-Rays it is
their own published recommendation to sandbox the thing, and for angr it is a
countable `mcp.add_middleware()` call in their mainline source.

---

## 3. The failure modes of an LLM driving a disassembler, and what each one implies

This section carries the weight of the recommendation, so I have separated what
is *measured* from what is *asserted by a vendor about its own product*.

### 3.1 Measured: the models are not reliable, and the field knows it

- **REFORGE** (Koller & Schmidt, arXiv **2607.07738**, 2026-07-07) makes the
  methodological point that matters most for VOID: "Existing benchmarks for
  LLM-assisted binary analysis **treat the construction of function-level ground
  truth as a solved pre-processing step and report accuracy without disclosing
  how many functions were reliably evaluable**." Its own controlled
  micro-benchmark shows high-confidence ground-truth yield falling from
  **87.2% to 65.9%** across optimisation levels, and that "unpaired comparisons
  overstate optimization-induced performance decay through **survivorship
  bias**." Read plainly: the published accuracy numbers for LLM RE are not
  reproducible from the published description, because nobody discloses the
  denominator.
- **OASIF** (arXiv **2606.29155**, 2026-06-28) opens by conceding the problem:
  LLMs "remain **brittle under commercial-grade obfuscation**." On Code
  Virtualizer, Themida 3.0.7 and VMProtect 3.5, a *trained* system gains
  +15.9, +5.8 and +16.9 pp. The implication for an ungoverned agent is that the
  base capability on protected binaries is the thing being trained, not the
  thing being shipped.
- **FORGE** (arXiv **2604.15136**, 2026-04-16) is the strongest positive result I
  found: 3,457 firmware binaries, 1,274 vulnerabilities across 591 binaries,
  **72.3% precision**. That is also the counter-evidence in one number — roughly
  **one in four reported vulnerabilities was a false positive**, and the paper
  reports precision with no recall, and no mechanism by which a third party can
  check any individual claim.
- **Udeshi et al.** (arXiv **2509.23970**) get precision 0.98 / recall 0.64 for
  injected-malware detection via binary diffing, on 104 binary versions and
  46,023 functions. High precision, poor recall, and the "functional
  sensitivity score" is a triage heuristic — not an attestation.

### 3.2 Asserted by vendors about their own product, and load-bearing

- **Binary Ninja Sidekick's own docs** (version 26.1.521) describe a product
  that is *careful* about exactly this and *local* about recording it. Each
  Suggest operation runs **Context → Analysis/Identification → Expansion →
  Application → Verification**, where Verification means "Re-reads the local
  region and confirms that the substrate improved enough for downstream work."
  The docs also order the operations by dependency — repair the substrate before
  types, types before names, names before comments — because each depends on the
  last being right. That is an engineering team stating, in its own product
  documentation, that **an AI RE system's output is only as good as a substrate
  it has itself just invalidated.**
- The same docs state the recording posture plainly: "Suggestion-style
  operations **apply changes directly to the binary database**." Undo is
  "Binary Ninja's undo feature (`Ctrl+Z` / `Cmd+Z`)" and "Each operation's
  modifications are grouped as a single undo action, so one undo step reverts
  all changes from that operation." The **Transaction Log** records "the target
  URIs and property values that were modified."
- And the storage reference is decisive for the wedge. Sidekick's own summary
  table, verbatim:

  | Location | Moved with BNDB? | Backed up by BN? |
  |---|---|---|
  | `$BN_USER_DIRECTORY/sidekick/data/workspaces.db` | **No** | **No** |
  | `data/semantics.db` | No | No |
  | `config/`, `cache/`, `filestore/` | No | No |

  `workspaces.db` is where "**transaction history**" lives. The best-funded,
  best-engineered agentic RE product in the market keeps a transaction log in a
  local SQLite file that neither the analysis database nor the vendor backs up,
  and undoes it with an in-process undo stack.
- **mrexodia's ida-pro-mcp README** — 12,347★, the most-used agentic IDA
  integration in existence — spends its prompt-engineering section on working
  around model failure: "**NEVER convert number bases yourself. Use the
  `int_convert` MCP tool if needed!**" and "LLMs will not perform well on
  obfuscated code" with a checklist of what to strip first (string encryption,
  import hashing, control-flow flattening, anti-decompilation tricks).
- **Hex-Rays' own model guidance:** open-weight models "perform on a level
  similar to GPT-6-Luna and Gemini 3.8 Flash. Unfortunately, **they do require
  dedicated hardware**"; the consumer option, Qwen 3.8 27B on one 24 GB GPU,
  "can perform reverse engineering tasks, but **tends to get stuck and overthink**,
  so you need a more hands-on approach"; and of the frontier path, "**cybersecurity
  safeguards frequently interrupt work**, so falling back to Opus 4.6 might be
  necessary."

### 3.3 What each failure mode demands be recorded

| Failure mode | Who says so | What must be captured to make the work checkable |
|---|---|---|
| Model invents a function's purpose from plausible-looking decompilation | mrexodia; Sidekick's substrate-first ordering | the exact bytes at the exact PC the claim was derived from, and the tool+version that produced the decompilation |
| Model mis-handles integer↔byte conversion | mrexodia, verbatim | the *inputs* to the reasoning, in machine form, so the conversion can be redone |
| Batch edit partially fails and leaves torn state | **angr `edit_tools.py`, verbatim** | per-item `old`→`new` pairs with status, committed as one record — i.e. an inverse |
| "Dry run" has side effects | **angr `edit_tools.py`, verbatim** | which calls were pre-flight and which actually mutated state |
| Analysis substrate is wrong, so every downstream claim is wrong | Sidekick's ordering; OASIF on obfuscation | the *tool version and analysis configuration* — a claim is only as good as the decompilation it rests on |
| Agent escapes the tool's boundary via its own scripting surface | **Hex-Rays, verbatim** | the policy decision that permitted the write, and the effect class it was classified as |
| Published accuracy cannot be reproduced | **REFORGE: 87.2%→65.9%, survivorship bias** | a denominator: how many claims were independently checkable |
| Analysis sessions are concurrent and shared | IDA Nexus; angr's `_serialized` project lock | ordering across agents — which is exactly what a hash chain gives and a local log does not |

**Every row in that table is a field VOID's ledger already knows how to carry,
and none of them is a field any RE tool currently records in a portable,
third-party-checkable form.** That is the finding.

---

## 4. The three options, argued

### Option A — Wrap an existing analyser. Rejected.

**What it would look like.** VOID becomes the governed, signed, undoable wrapper
around Ghidra or Binary Ninja over MCP, proxying the agent's analysis calls
through the existing policy engine and into the ledger.

**Why it fails, in order of severity.**

1. **The most permissive option requires the user to pay.** Hex-Rays IDA MCP is
   MIT and first-party and needs IDA Home/Pro/Classroom. Binary Ninja's headless
   MCP server is Commercial/Ultimate only and its Free edition is "Not for
   commercial purposes." Ghidra is free and Apache-2.0 and has no first-party
   agent surface and a 15-month-dormant third-party one. The only option that is
   simultaneously free, permissive and agent-facing is **angr** — which means
   Option A, done right, is Option A against angr specifically. That is fine,
   but it is a narrower claim than it looks.
2. **The best-integrated option's write surface is unclassifiable.** Hex-Rays'
   entire write surface is `execute_python`. VOID's effect classifier decides on
   what an action *did* — effect, reversibility, readiness, resource set. It
   cannot decide on "a Python script." The moment the tool's write surface is a
   general scripting escape, the effect-level policy engine has nothing to
   classify, and the entire differentiator degrades into name-level allowlisting
   — the thing the market already has everywhere.
3. **There may be nothing to wrap.** Binary Ninja's own release post and its own
   current reference documentation disagree about whether the MCP surface can
   write at all. I could not resolve it. Designing a governed wrapper around a
   surface whose write capability is undocumented is not a plan.
4. **Even when the write surface is named, there is nothing to invert.** A
   rename in a `.bndb` or an IDB is not a before-image VOID can capture. The
   state lives inside the analyser's serialisation format, which is
   undocumented, version-specific, and not the analyser's bytes. VOID's one real
   byte-level inversion is S3 object bodies, and it works because an S3 object
   body is a byte array. An IDB is not a byte array with a documented mapping.
   Wrapping Ghidra or Binary Ninja would therefore give VOID a *policy* over RE
   and *no* *recovery* over RE — strictly worse than what VOID does today for
   files, where it has both.
5. **It is the work someone else already did, for free, better.** Shipping
   another RE MCP server in 2026 is shipping a worse version of a free
   download. The first-party offerings are MIT and BSD-2-Clause.

**What Option A gets right, and I am not discarding it:** an effect-level policy
over named analysis writes is a real gap, and angr's `rename`/`set_type`/
`set_comments` are exactly the named, batched, partially-failing writes worth
governing. Option A is the *second* increment, not the first, and it must be
built on top of something that already records claims.

### Option B — Build the layer underneath. **Chosen.**

VOID does not analyse. It governs and attests whatever agent drives whatever
tool. The concrete capability that makes this more than a logging wrapper is
**re-derivation**: every assertion an agent makes about a binary is a ledger
record that names the bytes it was derived from, the tool and tool version that
produced the intermediate representation, the model and version that proposed
it, and a digest binding all of it — so a third party can recompute the claim
from the artefact and the binary, and either reproduce it or see that it cannot
be reproduced.

The reason this is not a logging wrapper: **a log records that a call happened.
A re-derivation record makes a specific claim falsifiable.** The difference is
the same one VOID already draws for policy attribution, generalised from *why a
call was allowed* to *what an agent asserted and on what basis*. Commit `63dbd2c`
is the precedent: the body is `unknown`, the entry hash covers canonical JSON of
whatever is in it, and the chain has no per-field schema. Adding an assertion
record requires **no migration and no format change** — the same property that
commit message already celebrated and that I re-verified in source
(`JsonlEntry.body: unknown` at `packages/ledger/src/store.ts:36`; the only
structural requirement is a string `workspace` field, enforced at
`store.ts:210`).

**And the third-party check is already built.** `packages/verifier/verify-ledger.mjs`
is a single dependency-free file importing only `node:crypto` and `node:fs`,
which re-implements the canonicaliser, entry hash, signing preimage and Merkle
digest byte-for-byte, with a `--selftest` pinning six shared vectors. A RE claim
in the chain is verified by that same file with no VOID installed. That is the
whole delivery mechanism and it already works.

**The honest limit, stated up front.** As of today, every VOID verification
surface says `integrity only` alongside its claim, because in every shipped
topology the recorder, the signer and the verifier are one OS principal. A
signed RE assertion therefore proves *the same thing* the ledger already
proves: a process holding a key wrote these bytes and the chain is internally
consistent. It does **not** prove the analysis is correct. This wedge does not
fix that and is not a claim to fix it. What it does is make the *structure* of a
claim checkable — which bytes, which tool, which version, which model — so that
when the trust model is fixed, the claims become attestable for free. §8 argues
this is still the right move and also states the strongest objection to it.

### Option C — Reframe the goal. Rejected, but its diagnosis is adopted.

The honest position is that VOID is an agent-governance and recovery substrate of
which reverse engineering is one eventual user, and saying so plainly beats
claiming a capability that is not there.

**I agree with the diagnosis and reject the response.** `PREMISE-VERIFICATION.md`
§1b holds: the gap is "real, total, and correctly named." But the diagnosis does
not force a *reframe*; it forces a *sequencing change inside the same goal*. The
question was never "does VOID have disassembly." It was "what is the defensible
first move from a governed-executor substrate into reverse engineering." The
substrate is not beside the RE goal. It is the part of the RE goal that nobody
has built, that the one paid vendor in the field decided not to build, and that
the field's own evaluation methodology (REFORGE) is independently converging on.
Reframing would forfeit the one genuinely open flank while gaining nothing that
the reframed sentence does not already say.

**What is lost by not reframing:** the ability to say "we are a reverse-engineering
tool" for as long as that remains false. **What is gained:** a first increment
that is real, provable, free to build, and cannot be shipped by anyone else,
because it requires VOID's specific existing assets — the opaque-body hash chain,
the attribution pattern from `63dbd2c`, the out-of-band anchor in
`void export verify`, and the dependency-free standalone verifier — used together
in a combination that has no other holder.

---

## 5. The smallest first increment that could ship

**Name: an evidence-bound assertion record and its offline re-derivation.**

It touches no third-party tool. It requires no licence, no account, no paid
analyser, and no hardware. It establishes the load-bearing half of everything in
Option B, and Option A later plugs into it.

### 5.1 What it does

1. A new ledger body shape, `kind: "analysis.assertion"`, carrying:
   - `subject`: `{ fileSha256, fileName, format, arch }` — the binary, pinned by
     content digest, never by path.
   - `claim`: `{ statement, kind: "function"|"type"|"xref"|"string"|"dataflow" }`
     — what the agent asserted, in its own words, plus a structured slot.
   - `evidence`: an array of `{ offset, length, sha256 }` byte ranges of the
     subject file, plus `{ tool, toolVersion, analysisConfig }` and
     `{ model, modelVersion, promptSha256 }`.
   - `derivation`: `{ procedure, inputs, output }` — enough to *redo* the
     derivation, not just to observe it.
   - `confidence`: the analyser's own declared confidence, carried verbatim and
     never recomputed by VOID.
2. A named refusal in the verifier, mirroring `packages/ledger/src/attribution.ts`:
   a **missing** assertion field passes (pre-existing entries), a **malformed**
   one is a named finding that fails the chain, and a **rewritten** one fails
   because the whole-file rewrite changes every hash. Three states, kept apart by
   construction — the same three-state discipline `63dbd2c` established.
3. **One re-derivation procedure VOID ships and can always run**, with no third
   party: `sha256(file, offset, length)`. It is trivial, deterministic, and it is
   the honest minimum. The point is not that `sha256` is a hard analysis. The
   point is that the *machinery* — a claim bound to bytes, a third-party
   re-derivation that either reproduces the claim or refuses — exists and is
   proven end to end before anyone depends on it.
4. A CLI surface: `void assertion add`, `void assertion verify --standalone`,
   and the existing `void verify --standalone` extended to the new body shape.

### 5.2 The files it touches

Verified to exist at `63dbd2c`. All are additive; **no existing file's behaviour
changes**, and no frozen recovery format moves.

| File | Change |
|---|---|
| `packages/ledger/src/assertion.ts` | **New.** `AssertionBody` type, the `parseAssertion` / `findingsFor` pair, exported from `index.ts` exactly as `attribution.ts` is. |
| `packages/ledger/src/assertion.test.ts` | **New.** The three-state matrix plus the whole-file rewrite under an attacker key. |
| `packages/ledger/src/index.ts` | One export line (mirrors the `63dbd2c` diff). |
| `packages/ledger/src/verify.ts` | Route the new finding into `verifyChain`, mirroring the four-line attribution hook. |
| `packages/ledger/src/store.ts` | Route the new finding into the store's own check, so the feed refuses exactly what the verifier refuses. |
| `packages/ledger/src/feed.ts` | Same routing on the read path. |
| `packages/verifier/verify-ledger.mjs` | Re-implement the assertion parse and the `sha256(range)` re-derivation with **no VOID imports**, and pin the vectors in the existing `--selftest`. |
| `packages/cli/src/assert.ts` | **New.** `add` and `verify` subcommands. |
| `packages/cli/bin/void.mjs` | Two dispatch lines. |
| `packages/policy/src/attribution.ts` | **No change.** An assertion is not a tool call, so no policy decision exists. It is appended directly, and the record says so in a field the verifier checks, so a host cannot synthesise a policy-attributed assertion. |
| `fixtures/` | **New.** A checked-in, minimal, *real* ELF with magic bytes and one function — see §5.4. |

**Not touched:** `packages/policy/src/grammar.ts`, `packages/policy/src/rules.ts`,
`packages/policy/packs/*`, `packages/registry/src/registry.ts`,
`packages/connectors/**`, `packages/proxy/src/forward/tools.ts`,
`packages/cli/src/recovery-mcp.ts`. The capability introduces **no new effect
class**, no new policy key, no new tool, and no new adapter. That is the point:
the first increment is entirely inside the ledger and the CLI.

### 5.3 How it is proven

Four proofs, in increasing hostility. Every one is a command, not a claim.

1. **Round trip.** `void assertion add` on the fixture, then
   `node packages/verifier/verify-ledger.mjs <bundle> --public-key <spki>`
   → `VERIFIED n entries, head <hash> (signatures and hash links)`, exit 0.
   Proves the new body shape is hashed, chained and signed by the existing
   machinery with no format change.
2. **Re-derivation succeeds.** `void assertion verify --standalone` recomputes
   `sha256` over every declared `(offset, length)` range of the fixture and
   matches every declared digest. Proves the evidence binding is real, not a
   label.
3. **Re-derivation refuses.** Change one byte in the fixture (in a `mkdtemp`
   copy, never the checked-in one) and re-run. Non-zero exit, named reason.
   This is the proof that matters: it is the property no RE tool has.
4. **Adversarial rewrite.** The scenario `packages/ledger/src/attribution.test.ts`
   already implements, repeated for the assertion body: rewrite the *whole* file
   the way an attacker holding their own key would — every body changed, every
   hash recomputed, every link re-pointed, every entry re-signed with a real
   key — then assert the rewrite **verifies under the attacker's key and fails
   under the operator's**. What is proven is the signature, not a shape test.
   `scripts/ledger-verify.mjs` is the existing harness and is the template.

Additionally, and this is a requirement not a nicety: the same rewrite must be
caught by the **dependency-free** verifier with no VOID on the path. If the
standalone script can be made to pass a rewritten chain, the increment is not
done.

### 5.4 The fixture, and a correctness point about it

There is **no existing binary-fixture idiom in this repository**, and I want to
be explicit about that rather than imply I am following one. `fixtures/` contains
exactly one subdirectory, `fixtures/registry/` (two JSON files), plus five text
fixtures. The `disassembly.bin` that appears in
`packages/cli/src/mcp-reverse-exercise.ts:51` and
`scripts/src/agentic-reverse-exercise.mjs:51` is **not a binary at all** — it is
an 11-byte hand-written literal, `Buffer.from([0x00, 0x0d, 0x1b, 0x5b, 0x33,
0x31, 0x6d, 0xe2, 0x9c, 0x93, 0x0a])`, created in a `mkdtemp` at run time and
never checked in. The comment above it explains the intent: "Bytes chosen so an
accidental restore is obvious … so a byte-for-byte comparison means something."
It is an opaque-bytes fixture, not a binary fixture.

So this increment **establishes** the idiom. The right choice, given what
§3.1 says about survivorship bias and hidden denominators, is a **real, minimal,
checked-in object with magic bytes** — a tiny ELF with one known function, whose
`fileSha256` a verifier can pin and whose byte ranges mean something. A fixture
that is arbitrary bytes cannot support the claim the increment is making, and
would reproduce exactly the methodological problem REFORGE criticises: a
verifier that cannot tell "the fixture" from "anything".

### 5.5 What it costs

Stated as scope, not as an estimate I cannot support.

- **No spend.** No licence, no account, no hardware, no cloud. The re-derivation
  procedure is `node:crypto`.
- **No new dependencies.** The standalone verifier already imports only
  `node:crypto` and `node:fs`; the new procedure must keep it that way, or it
  stops being the third-party verifier.
- **Build:** one new ledger module, one test module mirroring an existing 329-line
  one, four small edits to existing files that mirror a 4-line and a 7-line diff
  from `63dbd2c`, a new CLI module, two dispatch lines, and a small addition to
  a script that already has a `--selftest` harness.
- **Regression risk: near zero, and here is why I can say that.** Every change to
  an existing file is additive to a body that is typed `unknown`, and
  `63dbd2c`'s own message records that a ledger written before the change hashes
  the same bytes and keeps verifying. The verification surfaces already handle a
  missing attribution by passing rather than failing; the assertion finding
  must do the same, and proof 1 must run against a ledger produced by the
  *previous* commit to demonstrate it.
- **What it does not cost:** it does not make VOID able to analyse anything. It
  makes VOID able to *say what an agent claimed, about which bytes, from which
  tool version, and let a third party check that binding.* Every RE capability
  built on top of it inherits the property for free; without it, none of them
  have it.

### 5.6 The second increment, named so it is not lost

Only after the first is proven: govern angr's `rename` / `set_type` /
`set_comments` over its own MCP server, which is **BSD-2-Clause**, free, and
already in angr mainline. This is the first genuinely new governed effect class
— a durable, batched, partially-failing write to *analysis state* rather than to
a file or a row — and it is the first place angr's documented "edits already
applied are NOT rolled back" becomes VOID's problem to solve. It will require a
new effect class in `packages/policy/src/grammar.ts` and `rules.ts` and a new
tool in `packages/cli/src/recovery-mcp.ts`, because those vocabularies are
closed in code by design. That cost is real and is why it is second.

---

## 6. The counter-case, taken seriously

I was asked to look for evidence that agentic RE is a losing bet or that the
value sits in a layer underneath the tools. I found a great deal of it, and one
piece of it argues against my own recommendation.

**The strongest evidence that the layer underneath is the right place — and
therefore that Option B is the right choice.** Vector 35 has been building
Binary Ninja for ten years, has a shipped, versioned, marketed agentic RE
product, and *chose* to make its transaction record a local SQLite table in
`workspaces.db` that its own documentation marks "Moved with BNDB? No. Backed up
by BN? No.", with `Ctrl+Z` as the undo and a gist as the public evidence
artefact. Hex-Rays, having built a first-party MIT MCP server, published
"sandbox it yourself" as its security posture and shipped a Code Mode design
whose write surface is arbitrary Python. angr, with 9,114 stars and a
BSD-2-Clause licence and the strongest research pedigree in the field, has one
middleware and it is about stdout. **The three best-resourced teams in
commercial and academic binary analysis have all independently declined to build
this, and all three documented why in their own words.** Either the market does
not care — in which case Option B is not a business — or the market cares and
nobody has served it, which is the only position from which a small project can
win.

**The strongest evidence that agentic RE itself is a losing bet.** The best
published precision figure I found is 72.3% (FORGE) with no recall and no
per-claim checkability. The field's own evaluation methodology paper says
published accuracies are computed over undisclosed denominators with survivorship
bias and an 87.2%→65.9% confidence-yield decay. Models are brittle on
commercial obfuscation. Consumer-grade open models "get stuck and overthink" and
the ones that work "require dedicated hardware". Frontier models get
"cybersecurity safeguards [that] frequently interrupt work". mrexodia's guidance
to 12,347 users is essentially "never let the model do arithmetic" and "strip
the obfuscation yourself first". **A capability that needs its obfuscation
removed by hand before it works, cannot be evaluated reproducibly, and produces
one false positive in four at its best published result, is not a product.** It
is a research demo with a good demo.

**The strongest evidence that the *value* sits underneath, specifically, and not
in a RE product.** The three failure modes that recur across every source I read
— torn batch edits with no rollback, dry-runs with side effects, and claims that
cannot be attributed to a tool version or a denominator — are not RE problems.
They are *ledger* problems. They have the same shape as the ones
`VOID-FUTURE-DIRECTION.md` §2.5 documents in offensive agents ("nobody can read
what they did") and §3 discusses for the ledger generally. Reverse engineering is
simply the domain where these failures are most expensive and most visible,
because the output is a claim about someone else's code and the person who has
to trust it did not write the code and cannot re-run the analysis cheaply.

**What all of this does not settle.** None of it tells us whether a *signed,
re-derivable* RE record is worth anything to a buyer, because no one has built
one to price. I have no customer, no interview, no letter of intent, and no
revenue data. I am not going to manufacture one.

---

## 7. What I could not determine

- Whether Binary Ninja's MCP write surface is real (release post) or absent
  (current docs). **Unresolved, and it changes Option A's viability.**
- Whether Sidekick's transaction history is ever exported, synced, or signed in
  any edition I did not read. The documentation I read says it is not.
- Whether the IDA Nexus multi-agent concurrency layer has any inter-agent
  ordering guarantee that could be mistaken for a journal. I read the
  documentation; I did not read `HexRaysSA/ida-nexus` source.
- Whether anyone in the market would pay for re-derivable RE evidence. Unknown.
  See §6.
- Whether the AAT draft's requirement — that the recorder run under a different
  OS principal holding a key the agent cannot read — can be met on macOS in a
  shipping product. `VOID-FUTURE-DIRECTION.md` §1.4 says every 2026 governance
  tool has the same gap. I did not re-verify that survey and it is the single
  most consequential unknown for this document; see §8.
- Whether Ghidra 12.1.4's `analyzeHeadless` output is stable enough to be a
  re-derivation target across versions. This matters for the *second* increment
  and I have not tested it.

---

## 8. The strongest evidence against this recommendation

**From this repository, as of the commit that introduced attribution.**

`63dbd2c` added the rule that every verification surface states what a signature
establishes: a chain signature "proves the bytes came from a process holding a
key and that the chain is internally consistent, and **it does not prove nobody
rewrote the history, since in every shipped topology the recorder, the signer
and the verifier are one principal**." Every VOID verification surface now says
`integrity only` alongside its claim, and `docs/OPERATIONS.md:374-376` scopes the
anchor as detecting "tampering by a third party, **not by the agent itself, not
non-repudiation**, and not a claim of trust level L2."

Now put the wedge next to that. A ledger whose contents are database mutations
and file writes is a ledger whose most valuable forgery target is a row. A ledger
that also carries "this function at `0x401000` decodes AES-GCM and is reached
from the network handler" is a ledger whose most valuable forgery target is an
intelligence product, and **the only thing standing between a rewritten chain
and a passing verification is a signature from the same principal that chose
which tool to run.** I would be adding the highest-value, least-verifiable
content to a substrate whose own commit message says the signature is
`integrity only`, and whose documented scope explicitly excludes the agent.

And the asymmetry that makes it worse: **you can restore a row. You cannot
restore the truth of a claim.** VOID's undo story works because the inverse of
`postgres.row.update` is a write. The inverse of a *true* function analysis does
not exist — the only available action is to re-run the analysis, with a possibly
different tool version, a possibly different model, and a decompiler that is
deterministic only in the sense that it is deterministic for one build of one
tool. So the one thing this wedge produces is precisely the one kind of artefact
VOID cannot make reversible, and it is the one kind that matters most.

If the AAT-style trust model in `VOID-FUTURE-DIRECTION.md` §1.4 is right — and
every competitor has the same gap, which is the only reason I do not treat it as
fatal — then the honest sequencing is that the **trust-model fix gates this
wedge, and the wedge gates Option A.** That is why the first increment is the
record shape and the re-derivation, on bytes, in a chain that is already
honest about what it is: get the structure right now, while the content is
worth nothing, and add the high-value claim types only when a third party can
verify them by a route that does not run through the agent's own key.

I would rather ship a claim record that proves nothing today and can be upgraded
to prove something tomorrow, than ship a claim record that proves something
today and cannot be upgraded.

---

## 9. Corrections to existing documents

Reported, not edited, per the standing instruction.

1. **`docs/VOID-FUTURE-DIRECTION.md` §2.4** — "Binary Ninja shipped a first-party
   MCP server on 2026-09-03 (in every edition, including free)". True of the
   **GUI HTTP** variant only. The headless `binaryninja_mcp` stdio binary is
   "Included with Binary Ninja Commercial or Ultimate" and, stated twice in
   Vector 35's own docs, "**not available in Binary Ninja Free or Personal**".
   Binary Ninja Free is also "Not for commercial purposes" and has "No API /
   plugin access". The claim as written would lead a reader to think a free,
   headless, agent-drivable decompiler exists. It does not.
2. **`docs/VOID-FUTURE-DIRECTION.md` §2.4** — the same section names Hex-Rays'
   IDA MCP and GhidraMCP but **omits `mrexodia/ida-pro-mcp` entirely**, which is
   MIT, has **12,347★** (as of 2026-09-26), is pushed today, and is the
   incumbent that Hex-Rays' own new first-party server is displacing — its
   README now opens by recommending the official one. For a market-adoption
   argument, 12,347★ is the more important number and it is missing.
3. **`docs/VOID-FUTURE-DIRECTION.md` §2.4** — "angr merged an MCP server into
   mainline" is correct and materially understates it. `angr/mcp/` contains
   `edit_tools.py` with batched `rename` / `set_type` / `set_comments` over
   named kinds, `dry_run`, `stop_on_error`, `allow_overwrite`, per-item
   `old`/`new`/status results, and `restore_user_edits` imported. The write
   surface is the entire wedge and the document does not mention that it exists.
4. **`docs/VOID-FUTURE-DIRECTION.md` §2.3** — "Hex-Rays explicitly warns you to
   sandbox them yourself". **Verified verbatim** and stronger than stated: the
   warning is attached specifically to the fact that "IDA does not yet isolate
   its Python interpreter from the wider system, [so] the agent can evaluate
   scripts that reach beyond IDA's database." I also verified the same absence
   for angr: `angr/mcp/server.py` registers exactly one middleware,
   `StdoutGuardMiddleware`, whose only job is keeping analysis output off
   stdout.
5. **New, and not in either document: the docs/post disagree about Binary
   Ninja's MCP write surface.** The 6.0 release post says the server "can rename
   objects, create and apply types, and create data variables"; the current
   reference documentation at `docs.binary.ninja/guide/mcp.html` describes
   "read-only BinaryView information" three times and warns "The exact tool list
   may change as the MCP server develops." I could not resolve this and it
   should be recorded as unresolved rather than assumed.
6. **`docs/VOID-FUTURE-DIRECTION.md` §2.4** — Ghidra "12.1.4 (2026-09-21)".
   **Confirmed exactly**: tag `Ghidra_12.1.4_build`, published 2026-09-21T17:38:59Z.
7. **Unconfirmed by me, flagged not corrected:** the Sidekick price figures
   ("$0 / $30 / $100 / $300 per month … $5,000 per concurrent user per year")
   in §2.4. I verified Binary Ninja's *licence* pricing in full and it is
   different in kind; I could not find a Sidekick price list, and the only
   Sidekick pricing statement I read says free credits are now available to all
   Binary Ninja users with active support, refilling monthly. Also unconfirmed:
   the Doyensec measurement and the ProjectDiscovery 54-target audit, both of
   which I took at second hand and did not lean on.
8. **`docs/PREMISE-VERIFICATION.md`** — I did not re-check its §2a/§2m MCP
   findings, which are outside my question, except to confirm incidentally that
   `packages/cli/src/recovery-mcp.ts` does not contain the string
   `protocolVersion` and that `new Server(` occurs exactly once across
   `packages/`, at `recovery-mcp.ts:298`. Consistent with its verdict.

---

## Appendix — primary sources read, 2026-09-26

Vendor, first-party:

- `binary.ninja/2026/09/03/binary-ninja-6.0-krypton.html` — 6.0 release, MCP
  section, packaging and licensing, free-edition section
- `binary.ninja/2026/07/28/pricing-changes.html` — licence pricing, perpetual
  licensing, renewals, enterprise
- `binary.ninja/free/` — free-edition features and limitations
- `docs.binary.ninja/guide/mcp.html` — the MCP server reference, both variants
- `docs.sidekick.binary.ninja/guide/suggestions.html` — the five Suggest
  operations, their workflows, the Transaction Log, undo semantics
- `docs.sidekick.binary.ninja/reference/data_storage.html` — storage locations
  and the "Moved with BNDB? / Backed up by BN?" table
- `hex-rays.com/blog/hex-rays-ida-mcp-server` — launch post, Code Mode, the
  sandbox recommendation, the IDAPython write surface, model guidance
- `docs.hex-rays.com/core/mcp/overview.md` — licence and edition gating
- `docs.hex-rays.com/core/mcp/concepts/where-mcp-fits.md` — the three AI surfaces

Open source, primary:

- `raw.githubusercontent.com/HexRaysSA/ida-mcp/main/README.md`
- `raw.githubusercontent.com/mrexodia/ida-pro-mcp/main/README.md`
- `raw.githubusercontent.com/angr/angr/master/angr/mcp/server.py`
- `raw.githubusercontent.com/angr/angr/master/angr/mcp/edit_tools.py`
- `raw.githubusercontent.com/radareorg/radare2/master/COPYING.md`
- `api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest`
- `api.github.com/repos/angr/angr`, `/radareorg/radare2`,
  `/HexRaysSA/ida-mcp`, `/LaurieWired/GhidraMCP`, `/mrexodia/ida-pro-mcp`
- `api.github.com/repos/angr/angr/git/trees/master?recursive=1`
- `api.github.com/search/repositories` — `binary ninja mcp`, `ida pro mcp
  server`, `ida-pro-mcp`

Research:

- arXiv **2607.07738** — REFORGE, benchmark ground-truth reliability
- arXiv **2606.29155** — OASIF, obfuscation brittleness
- arXiv **2604.15136** — FORGE, feedback-driven binary analysis, 72.3% precision
- arXiv **2509.23970** — binary diff summarization, FSS
- arXiv **2605.07737** — neuro-symbolic supply-chain analysis (background)

Local, at `63dbd2c`:

- `packages/ledger/src/store.ts:30-46` (`JsonlEntry.body: unknown`),
  `:91-138` (`appendInner` / `append`), `:159-172` (store-side check),
  `:210` (workspace-field requirement)
- `packages/ledger/src/index.ts:32-51` (`LedgerStore`), `:69` (`signingPreimage`)
- `packages/verifier/verify-ledger.mjs` (dependency-free verifier shape)
- `packages/policy/src/grammar.ts:1-53` (closed match keys, decisions, classes)
- `packages/policy/src/rules.ts:136-147` (accepted class set)
- `packages/cli/src/recovery-mcp.ts:162-172` (closed tool-name union)
- `fixtures/` (registry JSON plus five text fixtures; no binary fixture)
- `packages/cli/src/mcp-reverse-exercise.ts:14-18,51-52` and
  `scripts/src/agentic-reverse-exercise.mjs:35-40,51-52` (the 11-byte literal)
- `LICENSE`, `NOTICE` (Apache-2.0, `Copyright 2026 the VOID authors`)
