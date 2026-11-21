#!/usr/bin/env bash
# Benchmarks json-server (Node) against the Go port on the recorded GET traffic.
# Each server runs alone on a fresh copy of the seed data; 3 rounds each, median reported.
#   ./bench.sh [tape] [connections] [seconds]
set -euo pipefail
cd "$(dirname "$0")"
TAPE=${1:-../../.gerra/tapes/jsonserver-reads.jsonl}
CONNS=${2:-32}
SECS=${3:-10}
OUT=$(mktemp -d)
BIN="$OUT/bin"; mkdir -p "$BIN"
(cd go && go build -o "$BIN/json-server-go" . && go build -o "$BIN/bench" ./cmd/bench)
JSON_SERVER=$(node -p 'require.resolve("json-server/package.json").replace("package.json", "lib/bin.js")')

run() { # name, command...
  local name=$1; shift
  node seed.mjs >/dev/null
  cp data/db.json "$OUT/db.json"
  "$@" "$OUT/db.json" >"$OUT/$name.log" 2>&1 &
  local pid=$!
  for _ in $(seq 50); do curl -sf -o /dev/null http://localhost:5050/profile && break; sleep 0.1; done
  for round in 1 2 3; do
    "$BIN/bench" -tape "$TAPE" -target http://localhost:5050 -c "$CONNS" -d "${SECS}s" >"$OUT/$name.$round.json"
  done
  local rss_kb; rss_kb=$(ps -o rss= -p "$pid")
  kill "$pid"; wait "$pid" 2>/dev/null || true
  node -e '
    const [name, dir, rss] = process.argv.slice(1);
    const runs = [1, 2, 3].map((i) => require(`${dir}/${name}.${i}.json`)).sort((a, b) => a.rps - b.rps);
    const m = runs[1];
    console.log(JSON.stringify({ name, rps: Math.round(m.rps), p50_ms: m.p50_ms, p99_ms: m.p99_ms, errors: runs.reduce((n, r) => n + r.errors, 0), rss_mb: Math.round(rss / 1024), all_rps: runs.map((r) => Math.round(r.rps)) }));
  ' "$name" "$OUT" "$rss_kb"
}

run node node "$JSON_SERVER" --port 5050
run go "$BIN/json-server-go" --port 5050
GOMAXPROCS=1 run go-1core "$BIN/json-server-go" --port 5050
echo "machine: $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m), $(getconf _NPROCESSORS_ONLN) cores; node $(node -v); $(go version | cut -d' ' -f3); $CONNS connections, ${SECS}s x 3 rounds" >&2
