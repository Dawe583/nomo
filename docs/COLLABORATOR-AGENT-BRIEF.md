# Collaborator agent brief, NOMO

You are a second coding agent working **alongside another agent** on this
repository. You have no shared conversation with them. Everything you need is
in this file plus the repository itself.

Read `AGENTS.md` then `AGENTS.local.md` before touching anything. They carry
project conventions and hard constraints that override anything you infer.

---

## 1. The repository

- Path: `/Users/dawe/Developer/Claude-Projects/NOMO`
- Remote: `https://github.com/Dawe583/void.git` (`sitespot/void`)
- TypeScript monorepo, `pnpm` workspaces, `node --test`.
- The site deploys to Vercel **on push to `main`**. Do not also run
  `vercel --prod`; that is a second deployment.

## 2. Branch policy (changed 2026-10-05, this supersedes older guidance)

`AGENTS.local.md` says "work directly on `main`". That is **no longer the
policy**. The current rule, stated by the owner:

- `main` is the integration branch and the only long-lived branch.
- All work happens on **feature branches cut from `main`**.
- When a feature is verified, it is **merged to `main` and the branch is
  deleted**. Branches do not accumulate.
- Never work directly on `main`.

Correct sequence:

```bash
git fetch origin
git switch main && git pull --ff-only
git switch -c <short-slug>     # e.g. ui/compact-table
# ... work, verify ...
git add -A && git commit
git push -u origin <short-slug>
# merge + cleanup (see §6) once verified
```

## 3. State as of this brief

- `main` = `88ad279`.
- `harness/hooks` = `6481578`, five commits ahead of `main`, **ready to merge**:
  `c4187d1` hook execution on the live dispatch path, plus four follow-ups
  (the `attest()` regression test, a house-style lookup helper, and a test
  that pins the provider dispatch path into the signed chain).
- `ui/compact-redesign` = `88ad279`, identical to `main`, no unique commits , 
  a leftover to delete.
- `packages/workbench`: 146 tests, 0 failures. Typecheck clean.

## 4. The active work item: vendor and rebrand two upstream projects

Two repositories are to be copied into NOMO and rebranded:

- `https://github.com/can1357/oh-my-pi`
- `https://github.com/PrimeIntellect-ai/prime-agent`

Target branding: **"omp"** for the first (the CLI/agent runtime, package name
and binary `omp`), **"prime agent"** for the second (the Prime Agent side).

Open questions you must resolve with the owner, not guess:

1. **Where the code lands.** In-tree under `packages/`? A vendored directory? A
   separate repository? This changes the licence and packaging story, so ask.
2. **Licence.** Both upstreams must be checked for licence terms before their
   code is vendored into a project with a different licence. Report what each
   one allows. Do not copy code before this is answered.
3. **How deep the rebrand goes.** Package name, binary, config directory,
   user-facing strings, telemetry endpoints, and the identity/prompt text are
   five different depths. Ask which are in scope.

Do not assume a rebrand is a find-and-replace. Read both projects first.

## 5. Division of work between the two agents

You share one working tree. To avoid clobbering each other:

- **Claim a path before editing it.** Announce it, and do not edit outside
  your claim.
- **One agent at a time per path.** If you need a path the other agent is
  working in, wait, do not create a second branch and race.
- Never `git checkout`, `git reset --hard`, `git stash`, or `git clean` in this
  repo without confirming the other agent's work is committed first. Those
  destroy uncommitted work that nobody else can recover.
- Branch per feature, as in §2. Two agents must never share a branch name.

## 6. Merging and cleaning up branches

Once a feature branch is verified:

```bash
git switch main && git pull --ff-only
git merge --no-ff <branch>        # keep the feature boundary visible
git push origin main
git push origin --delete <branch> # only after the merge is on origin
```

Never delete a branch that is not merged into `main` on the remote. Verify
with `git branch --merged main` first. If a branch holds work nobody merged,
merge it or ask, do not drop it.

## 7. Verification before you claim anything works

```bash
pnpm install
pnpm --filter @nomo/workbench run typecheck
cd packages/workbench && node --test src/*.test.ts
```

Claim only what you ran. If you changed a surface you cannot exercise, say so
plainly instead of implying it passed.

Bugs: reproduce before, confirm after. Keep a regression test when it can fail
for a real reason. A test that passes both before and after a change proves
nothing, check that.

## 8. Hard constraints

- **Never commit secrets.** Twelve `.env` files exist locally; all are
  gitignored and none were ever committed. No credentials in source, docs,
  browser storage, or logs.
- **Never regenerate the Prime Agent retained recovery key** and never widen
  its filesystem scope. That MCP is confined to
  `~/.local/share/void-prime-dogfood/project` with a five-tool allowlist.
- Built-in TUI text stays **English**. `NOMO_TUI_COLOR=0` is the explicit
  monochrome option; the full theme is the default even under `NO_COLOR=1`.
- Default provider is NVIDIA, model `z-ai/glm-5.3-flash`, endpoint
  `https://integrate.api.nvidia.com/v1`, key only from `NVIDIA_API_KEY` or
  approved local secret storage. Never fall back silently to another provider.
- `npm` packages ship only what `files:` allows, currently `dist/` alone.
  Anything else in the repo is not in the tarball.
- Communicate with the owner in concise Czech, preserving full technical
  detail in plans and reports.

## 9. Reporting

State what changed, what you ran, what you observed. If you hit a decision the
owner has to make, list the options with tradeoffs and stop on that one item
rather than guessing and continuing past it.