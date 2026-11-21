#!/usr/bin/env bash
# Record a small "checkout" tape from the original pricing API (used by CI to exercise the GitHub Action).
# Run from this folder after `pnpm install && pnpm build` at the repo root.
set -euo pipefail
gerra=(node ../../packages/cli/dist/index.js)
PORT=3000 node server.js >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
until curl -s -o /dev/null localhost:3000/health; do sleep 0.2; done
"${gerra[@]}" record --target :3000 --port 8080 --tape checkout --overwrite >/dev/null &
recorder=$!
until curl -s -o /dev/null localhost:8080/health; do sleep 0.2; done
curl -s localhost:8080/products >/dev/null
curl -s "localhost:8080/products?category=coffee" >/dev/null
curl -s localhost:8080/products/2 >/dev/null
curl -s localhost:8080/me -H 'authorization: Bearer abc' >/dev/null
curl -s -X POST localhost:8080/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"productId":1,"qty":2},{"productId":3,"qty":1}],"coupon":"WELCOME10"}' >/dev/null
curl -s -X POST localhost:8080/cart/price -H 'content-type: application/json' \
  -d '{"items":[{"productId":4,"qty":7}],"coupon":"WELCOME10"}' >/dev/null
kill -INT $recorder
wait $recorder || true
"${gerra[@]}" tapes checkout
