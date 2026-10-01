#!/usr/bin/env bash
# install-void.sh - install VOID as a real `void` command on this machine.
#
# Usage:
#   ./scripts/install-void.sh        run from anywhere; script resolves its own repo root
#   bash scripts/install-void.sh     same, via explicit shell
#   ./scripts/install-void.sh --help print this usage and exit
#
# What it does:
#   Step 1: check prereqs (node >= 24, git, pnpm with corepack fallback).
#   Step 2: put the VOID tree at $VOID_HOME (default ~/.local/share/void-cli).
#           Cloned shallow on first run; an existing tree is reused untouched,
#           because `void update` owns fetching new commits.
#   Step 3: pnpm install --frozen-lockfile inside the tree, but only when
#           node_modules is absent or older than the lockfile.
#   Step 4: write the launcher at ~/.local/bin/void, which execs the CLI entry
#           from $VOID_HOME and passes every argument through untouched.
#
# Environment:
#   VOID_HOME   tree location, default $HOME/.local/share/void-cli. The
#               launcher reads the same variable, so a custom tree needs no
#               edit. The default is deliberately not ~/.local/share/void,
#               which on some machines already holds unrelated state.
#
# Exit codes:
#   0  install finished; `void` is runnable.
#   1  prereq failure, a refused overwrite, a failed clone, or a failed install.
set -euo pipefail

# Every comment line above set -euo, so editing the header cannot quietly
# truncate the help the way a fixed line range would.
usage() {
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
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

VOID_HOME="${VOID_HOME:-$HOME/.local/share/void-cli}"
launcher_dir="$HOME/.local/bin"
launcher="$launcher_dir/void"
entry="packages/cli/bin/void.mjs"
# The launcher recognises its own kind by this line. Anything else at that path
# is somebody else's file and is never overwritten.
marker="installed by scripts/install-void.sh"

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
if [ -e "$VOID_HOME" ] && [ ! -f "$VOID_HOME/$entry" ]; then
  # The collision this refuses is real: a machine can already keep unrelated
  # state where the tree was going to go, and a clone into it leaves two
  # unrelated trees mixed in one directory with no clean way back. The test is
  # for the CLI entry rather than for .git, because the entry is what the
  # launcher needs, and a stray .git is not evidence of a VOID checkout.
  echo "error: $VOID_HOME already exists but holds no VOID checkout" >&2
  echo "       (no $entry inside it). Refusing to clone into it." >&2
  echo "       Set VOID_HOME to an empty directory, or move that one aside:" >&2
  echo "       mv \"$VOID_HOME\" \"${VOID_HOME}.old\"" >&2
  exit 1
fi

if [ -d "$VOID_HOME/.git" ]; then
  echo "reusing existing VOID tree at $VOID_HOME"
else
  mkdir -p "$(dirname "$VOID_HOME")"
  echo "cloning VOID into $VOID_HOME ..."
  # `set -e` would let git's own 128 escape here, and this script documents 1
  # for a failed clone. A caller checking one exit code must not have to know
  # which tool failed.
  if ! git clone --depth 1 https://github.com/Dawe583/void.git "$VOID_HOME"; then
    echo "error: cloning VOID into $VOID_HOME failed." >&2
    echo "       Check the network, and check that you can reach a private" >&2
    echo "       repository. If VOID_HOME was created by a failed earlier run," >&2
    echo "       remove it and run this again." >&2
    exit 1
  fi
fi

if [ ! -f "$VOID_HOME/$entry" ]; then
  echo "error: $VOID_HOME/$entry is missing after the clone; not a VOID checkout" >&2
  exit 1
fi

# Step 3: dependencies, only when they are actually missing or out of date.
if [ ! -d "$VOID_HOME/node_modules" ] || [ "$VOID_HOME/pnpm-lock.yaml" -nt "$VOID_HOME/node_modules" ]; then
  echo "installing dependencies ..."
  # Non-interactive: pnpm may need to purge a stale modules dir (e.g. after a
  # Node major change) and refuses to ask without a TTY.
  (cd "$VOID_HOME" && CI=true pnpm install --frozen-lockfile)
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
# void launcher, $marker. Do not edit, re-run the installer instead.
set -eu
VOID_HOME="\${VOID_HOME:-\$HOME/.local/share/void-cli}"
entry="\$VOID_HOME/$entry"
if [ ! -f "\$entry" ]; then
  echo "error: no VOID install at \$VOID_HOME (\$entry is missing)" >&2
  echo "       run scripts/install-void.sh from a VOID checkout, or clone the tree yourself:" >&2
  echo "       git clone https://github.com/Dawe583/void.git \"\$VOID_HOME\"" >&2
  exit 1
fi
# exec, not a subshell: the TUI owns the terminal, so this process must keep
# stdin, the signals, and the exit status of the CLI itself.
exec node "\$entry" "\$@"
LAUNCHER
chmod +x "$launcher"

echo ""
echo "installed."
echo "  tree:     $VOID_HOME"
echo "  launcher: $launcher"
echo ""
echo "Next step: open a new terminal so PATH picks up $launcher_dir, then run:"
echo "  void"
echo ""
echo "To reinstall after a tree change, re-run:"
echo "  bash $repo_root/scripts/install-void.sh"