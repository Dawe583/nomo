---
name: astrophysics-delivery-rules
description: "Standing rules for the AstroPhysics workspace: publish to GitHub as Dawe583 and GitLab as Dejvyq via scripts/push-both.sh, open PRs, and write a hand-off summary/report after every finished piece of work.\""
---

# Standing rules — AstroPhysics workspace

Apply to every task here unless the user says otherwise.

## 1. Publish to both platforms, under the right account on each

Same human, two usernames:

| platform | username | email |
|---|---|---|
| GitHub | `Dawe583` | `dsak5@email.cz` |
| GitLab | `Dejvyq` | `dsak5@email.cz` |
| Vercel | linked to GitHub, inherits its authorship | — |

Projects:

| local | GitHub | GitLab |
|---|---|---|
| `~/Developer/AstroPhysics` | `Dawe583/AstroPhysics` | `Dejvyq/astrophysics` |
| `exoplanets/` | `Dawe583/AstroPhysics-exoplanets` | `Dejvyq/astrophysics-exoplanets` |
| `astro-studio/` | `Dawe583/Project_String` | `Dejvyq/astrophysics-astro-studio` |

**Always `scripts/push-both.sh <repo-path> [<branch>]`.** It pushes GitHub verbatim
and pushes GitLab with `filter-branch` rewriting every author to `Dejvyq`.

Consequence, accepted: the two remotes hold **different SHAs for identical content**.
Never compare SHAs across them. The script refuses `main`, `master` and `develop`
because the GitLab side is a force-push.

Never call `git push gitlab` directly — that is how `omp <omp@local>` commits get
there.

Repo-local git identity is `Dawe583 <dsak5@email.cz>` in all three repos.

## 1a. GitLab auth: TWO blockers, and the keychain one hides the store file

**Do not debug this from scratch.** Symptom: `push-both.sh` fails on the GitLab
side with `HTTP Basic: Access denied`, while every `glab` command works.

Cause 1 — the token in `~/.git-credentials` is only usable as
`Authorization: Bearer`, not as Basic auth. Git's HTTPS helper sends it as Basic,
so git is rejected. Meanwhile `glab` holds its own working 64-char OAuth2 token:

```
gtok=$(python3 -c "import yaml,os;d=yaml.safe_load(open(os.path.expanduser('~/Library/Application Support/glab-cli/config.yml')));print(d['hosts']['gitlab.com']['token'])")
curl -s -o /dev/null -w "PRIVATE-TOKEN %{http_code}\n" -H "PRIVATE-TOKEN: $gtok" https://gitlab.com/api/v4/user   # 401
curl -s -o /dev/null -w "Bearer        %{http_code}\n" -H "Authorization: Bearer $gtok" https://gitlab.com/api/v4/user # 200
```

Fix: rewrite every `gitlab.com` line in `~/.git-credentials` to
`https://oauth2:<glab-token>@gitlab.com`. Back the file up first.

**Cause 2 — the one that bites after you fix cause 1.** `exoplanets` has
`credential.helper = osxkeychain` listed *before* `store`, so git consults the
keychain first and never reads the file you just fixed. The keychain entry holds
an expired token (401 on both header styles). Rewriting
`~/.git-credentials` then appears to "not work", which is the confusing symptom.

```
# is the keychain token dead?
ktok=$(printf 'protocol=https\nhost=gitlab.com\n\n' | git credential-osxkeychain get | sed -n 's/^password=//p')
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $ktok" https://gitlab.com/api/v4/user   # 401 = dead
```

Fix, repo-scoped and reversible — drop the keychain from the helper list so the
store file is actually consulted:

```
git -C exoplanets config --unset-all credential.helper
git -C exoplanets config credential.helper store
git -C exoplanets ls-remote --exit-code gitlab     # must succeed
```

Verify with `git ls-remote --exit-code gitlab` before re-running the push.

Note: **`glab-auth-git-credential` does not exist on this machine.**

## 2. Pull requests

Open a PR/MR when a branch is ready, not mid-work. GitHub PR for the GitHub side;
the GitLab branch is a rewritten copy, so its MR is a formality — say so rather than
pretending the histories line up.

## 3. Vercel

`prj_FOYt3RZR3qNzagzhb9BL5Olc4zaX`, project name `astrophysics`, `outputDirectory:
web`, config in `astro-studio/vercel.json`. `VERCEL_TOKEN` is set and the CLI is at
`~/.local/bin/vercel`. Deploys come off the GitHub side, so push there first.

## 4. Summary + report on request

When the user says a piece of work is finished and wants to hand it to someone in the
field, produce a **document in the repo**, not a chat reply.

Must contain:

- **Claim first**, one sentence, so the reader can decide whether to keep reading.
- **Method** — the actual equations written out in LaTeX, not the names of them.
- **Provenance for every number**: `quoted` (published, cited) / `derived`
  (computed here from stated inputs) / `cross-check` (computed here and compared
  against an independent route that is named) / `numeric` (evaluated numerically,
  tolerance stated where it is an order of magnitude).
- **What is assumed** — every premise the result rests on that no file establishes.
  The section a domain expert attacks first, so it must be the most honest one.
- **What is unknown** — the specific missing measurements, and which one would move
  the answer most.
- **Reproduction** — exact commands, absolute interpreter path, library versions.

Normal English prose. Do not compress it.

## 5. Provenance discipline

- Two engines agreeing is not proof. It catches a wrong derivative, not a wrong
  premise.
- State a premise where it is used.
- A library that lost an API without warning must be verified against the
  **installed** version, never against code found online.
- **Absence of a column in a local snapshot is not absence in the source.**
  The local ECSV of PSCompPars carries no `pl_orbeccen`; the archive's `ps` table does.
  Claims about missing data must name the table they checked.
- **A value constant within a system and varying only between systems is a
  stellar parameter, not a planetary one.** This is the test that killed the
  "implied Bond albedo 0.302" result on 2026-10-05: it came out identical for
  Proxima b and d, which receive fluxes 2.83x apart. Before reading a per-object
  number as a property of that object, check whether it also holds for its
  siblings.

## 6. Where things live

- Per-system notes: `exoplanets/notes/`, `exoplanets/notes/settleable/`.
- Mission-design notes: `exoplanets/notes/mission/`.
- Catalogue data: `exoplanets/data/` (ECSV snapshots), TAP fetchers in
  `exoplanets/src/tap.py`.
- Trajectory code: `exoplanets/src/trajectory/` — `earth`, `lambert`, `kepler`,
  `hyperbolic`, `search`, `ephemeris`, `system`, `system_state`, `arrival`.
- Web app: `astro-studio/` — 41 panels, 675 checks, every plot a `CHARTS.create`
  canvas. Never a matplotlib PNG.
- Interpreter: `~/Developer/AstroPhysics/.venv/bin/python`, absolute path, never set
  `PYTHONHOME`.

## 7. GitLab CI: blocked at the account level, verified 2026-10-05

**Do not attempt to fix this from the repository.** Two independent blockers, both
diagnosed from the API:

1. **Identity verification is missing.** Every attempt to create or retry a job
   returns HTTP 403:
   ```
   glab api "projects/Dejvyq%2Fastrophysics-exoplanets/pipeline?ref=<branch>" --method POST
   -> {"base":["Identity verification is required in order to run CI jobs"]}
   ```
   This is an account-level action in the GitLab web UI. No CI-config change can
   bypass it. **Until the user confirms an unconfirmed email or phone, treat GitLab
   CI as unavailable and do not push repeatedly hoping it changes.**

2. **No Linux runner exists on this instance.** Of the 100 runners visible to
   `exoplanets`, exactly two are active, unpaused and online, and both are
   `saas-macos-medium-m1`. Every `saas-linux-*` and `shared-gitlab-org` runner
   reports `active=false, paused=true, online=false`.

   A job that requests `image: python:3.12-slim` therefore never gets a job
   created, and the pipeline shows `failed` with an **empty job list** — which
   reads like a config error and is not. `exoplanets/.gitlab-ci.yml` now targets
   macOS with no container image, so it will run once (1) is done.

CI minutes are not the problem: `ci_minutes_usage.total_minutes_used` is 0.

**The authoritative gate is local:**

```
~/Developer/AstroPhysics/.venv/bin/python exoplanets/tests/test_trajectory.py
```

70 tests. Report that, and say plainly that GitLab CI could not run and why.

The studio gate, when touching `astro-studio/`:

```
cd astro-studio && node build_web.mjs && ~/Developer/AstroPhysics/.venv/bin/python run_all.py
```

675 checks. `run_all.py` needs the workspace venv interpreter — bare `python3`
fails on a missing package and the message is in Czech.

## 8. Before claiming a number in a note is right

Compute it, don't read it. Two defects found this way on 2026-10-05, both of which
had been sitting in committed prose:

- **Mixing units across a ratio.** $R_\star$ in solar radii over $a$ in AU is high
  by $1/\sqrt{R_\odot/\mathrm{AU}} = 14.66$. Four notes carried bare equilibrium
  temperatures built that way (3390 K, 10400 K) and drew atmospheric conclusions
  from them. Convert both sides to the same unit before dividing.
- **A conversion factor applied twice.** $\mathrm{pc}\to\mathrm{ly}$ applied twice
  made every $t_\mathrm{c}$ low by 10.64, and the table's columns stayed consistent
  with each other, so nothing internal could catch it. $c = 1\ \mathrm{ly/yr}$
  exactly, so $t_\mathrm{c}$ in years *is* the distance in light-years.

When a note's claim is refuted, correct the note and check whether a **test or a
docstring asserted the wrong thing too** — in this workspace the withdrawn claim had
propagated into a test that pinned 0.302 as real, and into a module's printed
output. Replace such a test, never re-pin it.
