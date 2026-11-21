# json-server → Go (gerra's launch demo)

[json-server](https://github.com/typicode/json-server) (`1.0.0-beta.15`, the version `npx json-server` installs today) ported to Go. The port was written route by route with the [`gerra-rewrite`](../../skills/gerra-rewrite/SKILL.md) workflow and checked against traffic recorded from the original.

## Result

| | |
| --- | --- |
| Recorded exchanges replayed against the Go port | **2089** (2000 reads, 28 writes, 61 edge cases) |
| Identical | **2088**: status, `content-type`, `content-length`, CORS headers and body |
| Different | 1: a malformed `%zz` path escape, which Go's HTTP server rejects before the app sees it ([details](REWRITE.md#known-difference)) |
| Database file after the write sequence | identical to json-server's, apart from the random ids it generates |

Throughput on the recorded GET mix (`./bench.sh`: 32 keep-alive connections, 10 s × 3 rounds, median, each server alone on fresh data):

| | requests/s | p50 | p99 | memory after the run |
| --- | ---: | ---: | ---: | ---: |
| json-server (Node 24) | 1,963 | 15.1 ms | 43.9 ms | 257 MB |
| Go port | 12,588 (**6.4×**) | 1.1 ms | 19.4 ms | 30 MB |
| Go port, `GOMAXPROCS=1` | 4,153 (**2.1×**) | 7.3 ms | 22.8 ms | 19 MB |

These were measured on an Apple M2 (8 cores) with Go 1.27. Node serves from one thread, so the one-core row is the like-for-like comparison. The client ran on the same machine.

## What it took

`REWRITE.md` is the checklist kept during the port: per-route status, the quirks copied on purpose, and what the tapes don't cover.

- **Most of the work was JavaScript semantics, not routing.** The port re-implements the pieces whose output reaches the wire:
  - `JSON.stringify(x, null, 2)`, including JS number formatting;
  - `JSON.parse` with V8's exact error messages, since a malformed body comes back in a 500;
  - JS comparison and coercion rules, and `localeCompare` collation for sorting;
  - the `inflection` rules used by `_embed`, generated from the JS package.

  `go test` checks these against fixtures Node produced.
- **json-server's quirks were copied, not fixed.** For example, `?userId=3` never matches anything (string ids compared to a number), and a malformed JSON body is a 500. Each is listed in `REWRITE.md`.
- **gerra caught differences that a hand-written test suite would likely have missed:**
  - Go's `net/http` strips `Content-Length: 0` from 204 responses; json-server sends it on CORS preflights.
  - `fetch()` silently turns conditional requests into `no-cache`, so the first edge-case tape never exercised the 304 path. Fixed by sending those requests with `node:http`.

## Reproduce

Needs Node 24, pnpm and Go 1.24+.

```bash
pnpm install && pnpm build                   # from the repo root
cd examples/json-server
./verify.sh                                  # records the three tapes from json-server, replays them against the Go port
./bench.sh                                   # the benchmark above
pnpm test:go                                 # JS-semantics tests against Node's own output
```

`verify.sh` exits 1 because of the one known difference. The replay reports are printed at the end.

To do it by hand:

```bash
pnpm seed                                    # data/db.json and data/db-go.json, same deterministic data
pnpm start                                   # json-server on :3000
pnpm start:go                                # the Go port on :4000

# from the repo root
pnpm gerra record --target http://localhost:3000 --port 8080 --tape jsonserver-reads
node examples/json-server/traffic.mjs reads  # then Ctrl-C the recorder
pnpm gerra replay jsonserver-reads --against :4000 --config examples/json-server/gerra.config.json

# writes change the data: re-seed and restart both servers before recording or replaying them
pnpm gerra replay jsonserver-writes --against :4000 --config examples/json-server/gerra.writes.json \
  --unsafe-methods "*" --concurrency 1
```

| File | What it is |
| --- | --- |
| `seed.mjs` | Deterministic data: 400 posts, 1600 comments, 10 users, a profile object |
| `traffic.mjs` | The recorded traffic, deterministic: `reads` (a weighted frontend mix), `writes`, `edges` |
| `gerra.config.json` | Also compares `content-length` and the CORS headers |
| `gerra.writes.json` | Same, plus ignores the random `id` json-server gives new items |
| `go/` | The port: about 2,600 lines of hand-written Go, plus generated inflection rules, tests and the benchmark client (`cmd/bench`) |

`go/` contains json-server's index page template (MIT, © typicode), embedded so the HTML matches byte for byte.
