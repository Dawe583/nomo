#!/bin/sh
# The clock NOMO does not own.
#
# `nomo schedule run-due` asks the workbench for one due evaluation and is
# designed to be called by a timer; NOMO itself owns no clock. This installs
# that timer as a per-user launchd job, which runs only while this account is
# logged in. Each tick proposes pending nodes from observed gaps, retires a
# schedule whose node is finished, records one for the next ready node, and asks
# the workbench for one due evaluation. It runs no model of its own and holds no
# prompt: the bounds live in the schedule record.
#
#   scripts/src/nomo-autoloop-install.sh install [interval-seconds]
#   scripts/src/nomo-autoloop-install.sh status
#   scripts/src/nomo-autoloop-install.sh uninstall
set -eu

LABEL="ai.nomo.autoloop"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NOMO_HOME="${NOMO_HOME:-$HOME/Developer/Claude-Projects/NOMO}"
NOMO_BIN="$NOMO_HOME/packages/cli/bin/nomo.mjs"
INTERVAL="${2:-900}"

case "${1:-status}" in
  install)
    test -x "$(command -v node)" || { echo "node is not on PATH" >&2; exit 1; }
    test -f "$NOMO_BIN" || { echo "no nomo at $NOMO_BIN" >&2; exit 1; }
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>node scripts/src/nomo-autoloop-cycle.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$NOMO_HOME</string>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/nomo-autoloop.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/nomo-autoloop.log</string>
</dict>
</plist>
PLIST_END
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed $LABEL, every ${INTERVAL}s, calling nomo-autoloop-cycle.mjs"
    ;;
  status)
    if test -f "$PLIST"; then
      launchctl list "$LABEL" 2>/dev/null | sed -n '1,6p' || echo "plist exists but the job is not loaded"
    else
      echo "not installed"
    fi
    ;;
  uninstall)
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed $LABEL. The schedule records remain: nomo schedule list"
    ;;
  *)
    echo "usage: $0 install|status|uninstall [interval-seconds]" >&2
    exit 2
    ;;
esac
