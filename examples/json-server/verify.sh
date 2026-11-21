#!/usr/bin/env bash
# Reproduces the launch demo end to end: records the three tapes from json-server, then replays
# each one against the Go port on fresh data. Run from anywhere after `pnpm install && pnpm build`.
#   ./verify.sh            record + replay
#   ./verify.sh --replay   replay existing tapes only
set -uo pipefail
cd "$(dirname "$0")"
ROOT=$(cd ../.. && pwd)
GERRA="node $ROOT/packages/cli/dist/index.js"
ORIG=3100; GO=4100; PROXY=8180
LOGS=$(mktemp -d)
JSON_SERVER=$(node -p 'require.resolve("json-server/package.json").replace("package.json", "lib/bin.js")')
(cd go && go build -o json-server-go .) || exit 2

pids=()
cleanup() { for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
wait_for() { for _ in $(seq 100); do curl -sf -o /dev/null "http://localhost:$1/profile" && return; sleep 0.1; done; echo "server on :$1 didn't start (logs in $LOGS)"; exit 2; }
start_original() { node seed.mjs >/dev/null; node "$JSON_SERVER" --port $ORIG data/db.json >>"$LOGS/original.log" 2>&1 & pids+=($!); wait_for $ORIG; }
start_go() { node seed.mjs >/dev/null; go/json-server-go --port $GO data/db-go.json >>"$LOGS/go.log" 2>&1 & pids+=($!); wait_for $GO; }
stop_all() { cleanup; pids=(); }

record() { # tape, traffic mode
  start_original
  : >"$LOGS/record.log"
  (cd "$ROOT" && exec $GERRA record --target http://localhost:$ORIG --port $PROXY --tape "$1" --overwrite >>"$LOGS/record.log" 2>&1) & local rec=$!
  # wait for the proxy without sending a request through it (it would be recorded)
  for _ in $(seq 100); do grep -q "Send traffic" "$LOGS/record.log" && break; sleep 0.1; done
  node traffic.mjs "$2" "http://localhost:$PROXY" >/dev/null
  kill -INT $rec; wait $rec
  stop_all
  echo "recorded $(wc -l <"$ROOT/.gerra/tapes/$1.jsonl" | tr -d ' ') exchanges → .gerra/tapes/$1.jsonl"
}

if [ "${1:-}" != "--replay" ]; then
  record jsonserver-reads reads
  record jsonserver-writes writes
  record jsonserver-edges edges
fi

status=0
replay() { # tape, extra args...
  local tape=$1; shift
  start_go
  (cd "$ROOT" && $GERRA replay "$tape" --against :$GO "$@") >"$LOGS/$tape.txt" 2>&1 || status=1
  stop_all
  echo "$tape: $(sed -n 3p "$LOGS/$tape.txt" | sed 's/^ *//')"
}
replay jsonserver-reads --config examples/json-server/gerra.config.json
replay jsonserver-writes --config examples/json-server/gerra.writes.json --unsafe-methods "*" --concurrency 1
replay jsonserver-edges --config examples/json-server/gerra.writes.json --unsafe-methods "*" --concurrency 1
echo "full reports: $LOGS/*.txt"
exit $status
