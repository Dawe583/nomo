#!/bin/zsh
# Poll all running prime-spawn jobs. Usage: prime-poll.sh
for pidfile in /tmp/prime-*.pid(N); do
  name="${pidfile:t:r:s/prime-//}"
  pid="$(cat $pidfile 2>/dev/null)"
  if kill -0 "$pid" 2>/dev/null; then
    echo "$name: RUNNING (pid $pid)"
  else
    echo "$name: DONE, tail:"
    tail -5 "/tmp/prime-${name}.log" 2>/dev/null | sed 's/^/    /'
  fi
done
