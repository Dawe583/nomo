#!/usr/bin/env bash
# install-nomo.sh - install NOMO as a real `nomo` command on this machine.
#
# Usage:
#   ./scripts/install-nomo.sh        run from anywhere; script resolves its own repo root
#   bash scripts/install-nomo.sh     same, via explicit shell
#   ./scripts/install-nomo.sh --help print this usage and exit
#
# What it does:
#   Step 1: check prereqs (node >= 24, git, pnpm with corepack fallback).
#   Step 2: put the NOMO tree at $NOMO_HOME (default ~/.local/share/nomo-cli).
#           Cloned shallow on first run; an existing tree is reused untouched,
#           because `nomo update` owns fetching new commits.
#   Step 3: pnpm install --frozen-lockfile inside the tree, but only when
#           node_modules is absent or older than the lockfile.
#   Step 4: write the launcher at ~/.local/bin/nomo, which execs the CLI entry
#           from $NOMO_HOME and passes every argument through untouched.
#
# Environment:
#   NOMO_HOME   tree location, default $HOME/.local/share/nomo-cli. The
#               launcher reads the same variable, so a custom tree needs no
#               edit. The default is deliberately not ~/.local/share/nomo,
#               which on some machines already holds unrelated state.
#               The legacy VOID_HOME is still accepted, and is read only when
#               NOMO_HOME is absent. An explicitly empty NOMO_HOME is honoured
#               as written and is never replaced by the legacy value.
# Exit codes:
#   0  install finished; `nomo` is runnable.
#   1  prereq failure, a refused overwrite, a failed clone, or a failed install.
set -euo pipefail

# Every comment line above set -euo, so editing the header cannot quietly
# truncate the help the way a fixed line range would.
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
}

# Resolve one owned `NOMO_*` name, falling back to its legacy `VOID_*` spelling.
#
# This is the same rule the TypeScript runtimes use in
# `packages/ledger/src/env-compat.ts`, which plain shell cannot import, so the
# lookup is written out here once for both this script and the launcher it
# writes. An owned name that is present wins, including when its value is the
# empty string, because an operator who exported an empty value chose it and
# silently reading the legacy value would run with a setting nobody typed. Only
# an absent owned name falls back.
#
# A name that does not start with NOMO_ is never looked up, which is what keeps
# an unrelated variable out of it: VOID_HOME would otherwise answer for a HOME
# the product does not own.
owned_env() {
  local current="$1" legacy
  legacy="VOID_${current#NOMO_}"
  if [ -n "${!current+set}" ]; then
    printf '%s' "${!current}"
  else
    printf '%s' "${!legacy-}"
  fi
}

case "${1:-}" in
  "") ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "error: unknown argument $1 (try --help)" >&2
    exit 1
    ;;
esac

script_dir="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

# The documented default applies only when neither spelling names a tree. An
# empty NOMO_HOME stays empty here, so the checks below refuse it instead of
# cloning into a path the operator never named.
if [ -z "${NOMO_HOME+set}" ] && [ -z "${VOID_HOME+set}" ]; then
  NOMO_HOME="$HOME/.local/share/nomo-cli"
else
  NOMO_HOME="$(owned_env NOMO_HOME)"
fi

if [ -z "$NOMO_HOME" ]; then
  echo "error: NOMO_HOME is set but empty; that is a choice, so nothing is installed." >&2
  echo "       Unset it to use the default (\$HOME/.local/share/nomo-cli), or set it" >&2
  echo "       to the tree you want." >&2
  exit 1
fi
launcher_dir="$HOME/.local/bin"
launcher="$launcher_dir/nomo"
entry="packages/cli/bin/nomo.mjs"
# The launcher recognises its own kind by this line. Anything else at that path
# is somebody else's file and is never overwritten.
marker="installed by scripts/install-nomo.sh"

# Step 1: prereqs.
if ! command -v node >/dev/null 2>&1; then
  echo "error: node is not installed or not on PATH (need node >= 24)" >&2
  exit 1
fi
node_version="$(node --version)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || [ "$node_major" -lt 24 ]; then
  echo "error: node >= 24 is required (found $node_version)" >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is not installed or not on PATH" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found, trying corepack fallback..." >&2
  if ! corepack enable && corepack prepare pnpm@10.33.0 --activate; then
    echo "error: pnpm is not installed and corepack fallback failed (need pnpm@10.33.0)" >&2
    exit 1
  fi
fi

# Step 2: the tree.
if [ -e "$NOMO_HOME" ] && [ ! -f "$NOMO_HOME/$entry" ]; then
  # The collision this refuses is real: a machine can already keep unrelated
  # state where the tree was going to go, and a clone into it leaves two
  # unrelated trees mixed in one directory with no clean way back. The test is
  # for the CLI entry rather than for .git, because the entry is what the
  # launcher needs, and a stray .git is not evidence of a NOMO checkout.
  echo "error: $NOMO_HOME already exists but holds no NOMO checkout" >&2
  echo "       (no $entry inside it). Refusing to clone into it." >&2
  echo "       Set NOMO_HOME to an empty directory, or move that one aside:" >&2
  echo "       mv \"$NOMO_HOME\" \"${NOMO_HOME}.old\"" >&2
  exit 1
fi

if [ -d "$NOMO_HOME/.git" ]; then
  echo "reusing existing NOMO tree at $NOMO_HOME"
else
  mkdir -p "$(dirname "$NOMO_HOME")"
  echo "cloning NOMO into $NOMO_HOME ..."
  # `set -e` would let git's own 128 escape here, and this script documents 1
  # for a failed clone. A caller checking one exit code must not have to know
  # which tool failed.
  if ! git clone --depth 1 https://github.com/Dawe583/void.git "$NOMO_HOME"; then
    echo "error: cloning NOMO into $NOMO_HOME failed." >&2
    echo "       Check the network, and check that you can reach a private" >&2
    echo "       repository. If NOMO_HOME was created by a failed earlier run," >&2
    echo "       remove it and run this again." >&2
    exit 1
  fi
fi

if [ ! -f "$NOMO_HOME/$entry" ]; then
  echo "error: $NOMO_HOME/$entry is missing after the clone; not a NOMO checkout" >&2
  exit 1
fi

# Step 3: dependencies, only when they are actually missing or out of date.
if [ ! -d "$NOMO_HOME/node_modules" ] || [ "$NOMO_HOME/pnpm-lock.yaml" -nt "$NOMO_HOME/node_modules" ]; then
  echo "installing dependencies ..."
  # Non-interactive: pnpm may need to purge a stale modules dir (e.g. after a
  # Node major change) and refuses to ask without a TTY.
  (cd "$NOMO_HOME" && CI=true pnpm install --frozen-lockfile)
else
  echo "dependencies already current"
fi

# Step 4: the launcher.
mkdir -p "$launcher_dir"
if [ -e "$launcher" ] && ! grep -qF "$marker" "$launcher"; then
  echo "error: $launcher exists and was not $marker; refusing to overwrite it." >&2
  echo "       Move it aside (mv \"$launcher\" \"${launcher}.old\") and run this again." >&2
  exit 1
fi

cat >"$launcher" <<LAUNCHER
#!/bin/sh
# nomo launcher, $marker. Do not edit, re-run the installer instead.
set -eu
# The owned name wins whenever it is set, including when it is empty; only an
# absent NOMO_HOME falls back to the legacy VOID_HOME. Written out rather than
# inherited because the launcher runs from any shell, under \`set -u\`, with no
# access to the helpers above.
if [ -n "\${NOMO_HOME+set}" ]; then
  NOMO_HOME="\$NOMO_HOME"
elif [ -n "\${VOID_HOME+set}" ]; then
  NOMO_HOME="\$VOID_HOME"
else
  NOMO_HOME="\$HOME/.local/share/nomo-cli"
fi
entry="\$NOMO_HOME/$entry"
if [ ! -f "\$entry" ]; then
  echo "error: no NOMO install at \$NOMO_HOME (\$entry is missing)" >&2
  echo "       run scripts/install-nomo.sh from a NOMO checkout, or clone the tree yourself:" >&2
  echo "       git clone https://github.com/Dawe583/void.git \"\$NOMO_HOME\"" >&2
  exit 1
fi
# exec, not a subshell: the TUI owns the terminal, so this process must keep
# stdin, the signals, and the exit status of the CLI itself.
exec node "\$entry" "\$@"
LAUNCHER
chmod +x "$launcher"

echo ""
echo "installed."
echo "  tree:     $NOMO_HOME"
echo "  launcher: $launcher"
echo ""
echo "Next step: open a new terminal so PATH picks up $launcher_dir, then run:"
echo "  void"
echo ""
echo "To reinstall after a tree change, re-run:"
echo "  bash $repo_root/scripts/install-nomo.sh"