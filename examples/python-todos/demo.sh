#!/usr/bin/env bash
# The whole loop for this example, start to finish:
#   1. seed the Python service's database and record real traffic through gerra
#   2. replay that traffic, writes included, against the Node rewrite, reseeding its database first
# Run from this folder after `pnpm install && pnpm build` at the repo root.
set -euo pipefail
cd "$(dirname "$0")"
gerra=(node ../../packages/cli/dist/index.js)
pids=()
cleanup() { for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
wait_for() { until curl -s -o /dev/null "$1"; do sleep 0.2; done; }

mkdir -p data
node webhook-sink.mjs >/dev/null & pids+=($!)
python3 seed.py data/todos.db
DB=data/todos.db WEBHOOK_URL=http://127.0.0.1:9900/hooks PORT=3200 python3 app.py >/dev/null & pids+=($!)
wait_for http://127.0.0.1:9900/ ; wait_for http://127.0.0.1:3200/todos

echo "== Recording traffic to the Python service"
"${gerra[@]}" record --target :3200 --port 8200 --tape todos --overwrite >data/record.log & recorder=$!
# Wait for its startup line rather than probing the port, which would put the probe on the tape.
until grep -q "Send traffic to" data/record.log 2>/dev/null; do sleep 0.2; done
node traffic.mjs http://127.0.0.1:8200 >/dev/null
kill -INT $recorder; wait $recorder || true
"${gerra[@]}" tapes todos

echo
echo "== Replaying it against the Node rewrite"
python3 seed.py data/rewrite.db
DB=data/rewrite.db WEBHOOK_URL=http://127.0.0.1:9900/hooks PORT=4200 node --import @gerra/sdk-node/register rewrite/server.mjs >/dev/null & pids+=($!)
wait_for http://127.0.0.1:4200/todos
"${gerra[@]}" replay todos --against :4200
