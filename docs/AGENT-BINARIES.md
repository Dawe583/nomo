# External agent binaries

NOMO orchestrates two agent CLIs that live outside this repository and are
never vendored into it. This page names what they are, where they come from,
how to update them safely, and the exact contract NOMO relies on. The
decision behind this arrangement, with the rejected alternatives and their
measured costs, is in `docs/DECISIONS.md` (entry dated 2026-10-05) and
`docs/VENDORING-DECISION.md`.

## oh-my-pi (`omp`)

| Field             | Value                                  |
| ----------------- | -------------------------------------- |
| Binary            | `omp`                                  |
| Installed version | `omp/18.6.1`, measured 2026-10-05      |
| Source            | `~/.local/bin/omp`, resolved from PATH |
| How to update     | see Provenance and verification        |

NOMO consumes nothing from `omp` in code: no import, no spawn, no lockfile
entry. `.omp/config.yml` and `.omp/WATCHDOG.md` are operator tooling
configuration in this tree, classified open by the licence-line gate. If the
upstream binary changes behaviour, NOMO is unaffected; if it is absent, NOMO
runs unchanged.

## prime-agent (`prime`)

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| Binary            | `prime` (the `prime-agent` package build)       |
| Installed version | `Prime CLI version: 0.9.1`, measured 2026-10-05 |
| Source            | `~/.local/bin/prime`, resolved from PATH        |
| How to update     | see Provenance and verification                 |

NOMO consumes `prime-agent` as an external process through three narrow
surfaces, and nothing else:

1. `scripts/src/prime-bridge.mjs` spawns the binary with a claimed job
   (`primeArguments`), parses its NDJSON stdout (`primeEvent`), reads
   `~/.prime/agent/settings.json`, `auth.json`, `models.json` and
   `~/.prime/config.json`, and reports the answer back to the cloud.
2. `cloud/prime.mjs` queues work for the local worker via a session
   `agent: "prime-agent"`, and `scripts/team/prime-spawn.sh` spawns
   `prime-agent -p --autonomous` for free-tier team members.
3. The TUI `/harness cloud | prime-agent` switch routes new conversations
   to whichever harness is selected; the web chat catalog mirrors the same
   choice.

The contract is a CLI process plus four config files. It is deliberately not
a versioned code surface. Two failure shapes are permanent and deliberate:
when provider credentials are missing the provider layer reports
`setup-required` rather than falling back, and when no prime worker is
connected the session stays `queued` with an event naming it (see
`cloud/prime.mjs`) rather than silently switching harness.

## Local clones

`/Users/dawe/Developer/upstream/omp-src` (18.6.2) and
`/Users/dawe/Developer/upstream/prime-src` (0.9.8) exist on this machine for
reference. Neither is referenced by the build, the lockfile or the test
driver, and nothing in this repository should import from them.

## Provenance and verification

Neither binary is fetched, pinned or verified by anything in this repository.
There is no checksum, no signature and no lockfile entry for either one. What
follows is where each came from, what has actually been recorded about it, and
where the record stops being evidence.

### `omp` (oh-my-pi)

Upstream is `https://github.com/can1357/oh-my-pi`, named in
`docs/COLLABORATOR-AGENT-BRIEF.md`. The install is a regular file at
`~/.local/bin/omp`.

The `omp/18.6.1` recorded above was read on 2026-10-05. **It is not verified,
and this page cannot verify it.** The file's modification time is later than
that reading, so the file has been written to since. A newer timestamp is not
proof that the version changed, and nothing in this repository holds a checksum
or a build to compare the file against, so which version sits on the machine
now is unknown to everything in the tree. Read the number as a dated
observation, not as the current state.

`docs/VENDORING-DECISION.md` recorded three version identifiers for this
project on that same date — installed `18.6.1`, npm `18.6.1`, cloned source
`18.6.2` — and observed that the clone is ahead of what is published. All
three were measurements taken on 2026-10-05. None of them is pinned here, and
they are reproduced as that day's evidence rather than restated as current.

### `prime` (prime-agent)

Upstream is `https://github.com/PrimeIntellect-ai/prime-agent`, named in the
same brief; nothing here verifies that the binary on this machine was built
from that repository. **`~/.local/bin/prime` is a symlink**, and that is the
part worth knowing: it resolves to
`/Users/dawe/.local/share/uv/tools/prime/bin/prime`, under uv's tool
directory rather than a plain file. That is why "the upstream installer" was
unusable — nothing on this machine pointed at the command that manages that
directory. `uv tool upgrade prime` is how uv updates a tool installed that
way. It is recorded here as where the next reader should start, not as a
command this page has run.

`Prime CLI version: 0.9.1` carries the same limit as the `omp` reading: it
was measured on 2026-10-05 and is a dated observation, not a verified current
state. The local clone is at `0.9.8` and nothing here keeps the installed
binary in step with it, which is one of the recorded reasons not to vendor: a
vendored tree would ship code nobody has installed.

### Checking, and the limit of this page

```
omp --version
prime --version
ls -l ~/.local/bin/prime
uv tool upgrade prime
```

Neither binary has a `pnpm-lock.yaml` entry, `scripts/src/check-tests.mjs` names
neither of them, and `scripts/src/prime-bridge.mjs` spawns whatever path its
`executable` config names rather than a fixed binary. Nothing in the suite
therefore pins or checks the installed version, so a binary that has been
replaced, downgraded or removed is invisible to the tests. That is what this
page cannot do: it records what was reviewed on a date, and only the commands
above tell you what is installed now.
