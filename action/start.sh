#!/usr/bin/env bash
# Start the candidate in the background and wait until it answers HTTP at $AGAINST.
#   START    command that starts the candidate
#   AGAINST  URL (or :port shorthand) the replay targets
#   WAIT     seconds to wait for it (default 60)
#   LOG      where its output goes
set -euo pipefail
url="$AGAINST"
case "$url" in
  http://*|https://*) ;;
  :*) url="http://localhost$url" ;;
  *) url="http://$url" ;;
esac
nohup bash -c "$START" >"$LOG" 2>&1 &
pid=$!
echo "Started the candidate (pid $pid): $START"
deadline=$(( $(date +%s) + ${WAIT:-60} ))
until curl -s -o /dev/null --max-time 2 "$url"; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "::error::The candidate exited before answering on $url. Its output:"
    cat "$LOG"
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::The candidate didn't answer on $url within ${WAIT:-60}s. Its output so far:"
    cat "$LOG"
    exit 1
  fi
  sleep 1
done
echo "The candidate is answering on $url"
