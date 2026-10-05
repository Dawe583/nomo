# External agent binaries

VOID orchestrates two agent CLIs that live outside this repository and are
never vendored into it. This page names what they are, where they come from,
how to update them safely, and the exact contract VOID relies on. The
decision behind this arrangement, with the rejected alternatives and their
measured costs, is in `docs/DECISIONS.md` (entry dated 2026-10-05) and
`docs/VENDORING-DECISION.md`.

## oh-my-pi (`omp`)

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| Binary            | `omp`                                           |
| Installed version | `omp/18.6.1`, measured 2026-10-05               |
| Source            | `~/.local/bin/omp`, resolved from PATH          |
| How to update     | the upstream installer; VOID does not manage it |

VOID consumes nothing from `omp` in code: no import, no spawn, no lockfile
entry. `.omp/config.yml` and `.omp/WATCHDOG.md` are operator tooling
configuration in this tree, classified open by the licence-line gate. If the
upstream binary changes behaviour, VOID is unaffected; if it is absent, VOID
runs unchanged.

## prime-agent (`prime`)

| Field             | Value                                           |
| ----------------- | ----------------------------------------------- |
| Binary            | `prime` (the `prime-agent` package build)       |
| Installed version | `Prime CLI version: 0.9.1`, measured 2026-10-05 |
| Source            | `~/.local/bin/prime`, resolved from PATH        |
| How to update     | the upstream installer; VOID does not manage it |

VOID consumes `prime-agent` as an external process through three narrow
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
