# gerra — plan

**Current milestone: M6 — agent loop** (M0, M1 done 2026-11-20; M2–M5 done 2026-11-21)

Goal for the first public launch (end of M7): port a popular open-source Node service to Go with an agent, verified by gerra, and post the result ("N× faster, X real requests replayed, byte-identical").

## Milestones

### M0 — Scaffold ✅
- [x] pnpm monorepo, TypeScript strict, vitest
- [x] `core`: tape schema + basic JSON diff with tests
- [x] `cli`: `gerra` entry with subcommand stubs

### M1 — record ✅
- [x] `gerra record --target http://localhost:3000 --port 8080 --tape checkout`
- [x] Reverse proxy (`node:http`) that forwards transparently (streaming, keep-alive, all methods)
- [x] Writes one JSONL exchange per request: method, path, query, filtered headers, body (utf8 or base64), status, response headers/body, latency
- [x] PII masking for configured headers/JSON fields
- [x] Graceful shutdown flushes the tape; `gerra tapes` lists tapes with counts per route
- [x] Example app in `examples/express-pricing` to record against

### M2 — replay + diff ✅
- [x] `gerra replay checkout --against http://localhost:4000`
- [x] Concurrency control, timeouts, only idempotent methods by default (`--unsafe-methods` to opt in per route)
- [x] Structural JSON diff, text/byte diff for non-JSON; status + selected headers compared
- [x] Report: summary (identical / different / errors), differences grouped by route + JSON path, sample requests
- [x] `--json` output and non-zero exit on real differences (CI-ready)
- [x] `gerra diff <tape>` rebuilds the report from the last saved run; `examples/express-pricing/rewrite.js` as a demo candidate

### M3 — noise filtering ✅
- [x] Replay against the original twice; auto-mark volatile JSON paths as noise (`gerra replay --original`)
- [x] Built-in normalizers: ISO timestamps, UUIDs, numeric IDs (opt-in), array-order-insensitive compare (opt-in per path)
- [x] `gerra.config.json`: ignore paths, normalizers, masked fields, per-route rules (documented in `docs/config.md`)

### M4 — shadow ✅
- [x] `gerra shadow --primary :3000 --candidate :4000 --port 8080`
- [x] Users always get the primary response; candidate called async, never blocks
- [x] Live counters + rolling diff log; `gerra shadow status`

### M5 — cutover ✅
- [x] Weighted routing with steps (1,10,50,100) and hold durations
- [x] Auto-rollback on diff rate / error rate / p99 thresholds
- [x] `gerra cutover status` / `gerra cutover rollback` (manual rollback via SIGUSR2)

### M6 — agent loop
- [ ] Claude Code skill: rewrite one route at a time, run `gerra replay --route`, fix until clean
- [ ] MCP server exposing tapes, replay, and diff results to agents

### M7 — launch demo
- [ ] Pick a popular OSS Node service, record realistic traffic, port to Go with the agent loop
- [ ] Benchmark + parity numbers, GIF, README, launch post

### Later (not before M7)
- Node SDK to capture DB queries and outbound HTTP (for side-effect isolation and deeper diffs)
- Dashboard UI; hosted version (paid) — decide after launch

## Decisions
- 2026-11-20 — Name: **gerra** (repo folder name; working name, can change before launch).
- 2026-11-20 — Stack: TypeScript on Node 24, pnpm workspaces. Ships via `npx gerra`. Revisit a Go/Rust proxy only if shadow-mode overhead becomes a problem.
- 2026-11-20 — License: MIT.
- 2026-11-20 — HTTP-layer, zero-code-change recording first; SDKs later.
- 2026-11-20 — Recorder proxy rewrites `Host` to the target (adds `X-Forwarded-Host/For/Proto`) and drops hop-by-hop headers both on the wire and in the tape. No WebSocket/`Upgrade` support yet.
- 2026-11-20 — Tape v1 gains optional `body.truncated: true` (non-breaking): bodies over `--max-body-bytes` (default 10 MiB) are recorded as a prefix; the client always gets the full body.
- 2026-11-20 — Bodies are recorded as raw bytes on the wire: gzip/br responses land as base64 and masked bodies keep the original `content-length` header. Replay/diff (M2) must decode `content-encoding` and recompute `content-length` rather than trust the tape's.
- 2026-11-20 — Proxy errors (upstream unreachable → 502) and client aborts are not recorded, because they aren't the service's behavior.
- 2026-11-20 — Routes in `gerra tapes` group id-like path segments (numeric, UUID, 24+ hex) as `:id`. `routeOf` in core is the shared definition for later per-route reports.
- 2026-11-20 — `examples/*` is part of the pnpm workspace (example apps get their deps from `pnpm install`). Express is a dependency of the example only.
- 2026-11-21 — Replay compares status, `content-type` and `location` by default (`--compare-header` adds more). Date, etag, server etc. are expected to differ in a rewrite. `content-type` is compared case/space-insensitively, and `charset=utf-8` on JSON types is ignored (RFC 8259: JSON is UTF-8), because Express adds it and most other stacks don't.
- 2026-11-21 — Bodies are compared after undoing `content-encoding` (gzip, deflate, br, zstd): JSON structurally, text by first differing line, binary by size + first differing byte. A truncated tape body is compared against the same-length prefix of the candidate's.
- 2026-11-21 — Masked values: a `[gerra:masked]` value in the tape matches anything. Masked request headers are not sent on replay (sending the placeholder is never right); `--header "name: value"` supplies test credentials, and replay prints a note naming the dropped headers.
- 2026-11-21 — When the status differs, that exchange is counted only under `status`, with "+N other differences" as a note, since a 200 → 401 changes the whole body. Other differences are grouped by route + location with array indices collapsed (`$.lines[*].total`).
- 2026-11-21 — Each replay is saved to `.gerra/runs/<tape>/<startedAt>.jsonl` (run format v1, header line + one result per exchange, schema in `core/src/report.ts`). `gerra diff` rebuilds the report from tape + run without sending traffic, so M3's noise rules can be re-applied to an existing run.
- 2026-11-21 — Exit code 1 for differences or errors, and also when nothing was compared (e.g. every exchange was a skipped POST), so a CI gate can't pass vacuously. 2 for usage errors.
- 2026-11-21 — Production guard: replay refuses targets that don't look local or internal (loopback, private IPs, `localhost`, single-label names like docker-compose services, `.local/.internal/.test`) unless `--allow-prod`.
- 2026-11-21 — Latency (recorded vs candidate p50/p95) is always in `--json`, but the human report only shows it with ≥ 20 replayed requests: small replays are dominated by connection setup and warm-up, and the recorded numbers were measured through the proxy. It's indicative, not a benchmark (M7 does real benchmarks).
- 2026-11-21 — Noise is learned from the original's two responses only (Diffy), not from tape vs. original. Otherwise drift since recording, or a masked auth header making the original return 401, would be learned as "noise" and hide real problems. While learning, normalizers are off, so what's learned is explicit. Learning happens inside `gerra replay --original` (original A, original B, then candidate, per exchange), not in a separate command. Results go to `.gerra/noise/<tape>.json` and are reused by later replays and diffs, so an agent loop (M6) can iterate without the original running. Each run's header records the noise it used, so `gerra diff` reproduces it.
- 2026-11-21 — Timestamp and UUID normalizers are on by default but compare *format* (digits may differ, shape may not), so the common rewrite bugs (ms precision, `Z` vs `+00:00`, UUID case) are still reported. Date-only values are never normalized, because a wrong delivery date is a real bug. The `ids` normalizer is opt-in.
- 2026-11-21 — Ignored differences are never silent: every report lists them per route with the reason (noise, config, timestamp, uuid, id), and `--json` includes them.
- 2026-11-21 — Ignore rules use the same names the report prints (`body $.x`, `header x`, `status`), with `[*]` for any index, `..` for any depth, and prefix coverage. Config keys are validated strictly (unknown keys are errors). Route keys are normalized via `routeOf`, so `GET /products/42` and `GET /products/:id` are the same entry.
- 2026-11-21 — Run file format stays v1: `noise` is an optional header field. `CompareOptions` is now `CompareRules`, and `compareResponses` returns ignored differences marked with `ignored` (`realMismatches` filters them).
- 2026-11-21 — `record` and `shadow` share one transparent proxy (`cli/src/proxy.ts`). It reports each exchange unmasked after the client's response has finished. The recorder masks it before writing (`maskExchange` in core); shadow mirrors it.
- 2026-11-21 — Shadow calls the candidate only after the user's response has finished, with at most `--max-inflight` (64) calls at once. Beyond that, mirrors are dropped and counted, never queued, so a slow or dead candidate can't build up memory or delay users. Candidate timeouts default to 5 s. Non-idempotent requests are mirrored only with `--unsafe-methods` or config `replay: true` (same rules as replay), because the write would happen twice if both services share data.
- 2026-11-21 — Shadow sends the real request (including credentials) to the candidate, but masks both responses (default headers + `mask` config) *before* comparing and writing anything. Masked fields therefore aren't compared live, the same as with tapes, and no secrets or PII reach `diffs.jsonl` or `state.json`.
- 2026-11-21 — Shadow noise: config rules and normalizers always apply, and `--noise <tape>` reuses noise learned by `replay --original`. Live learning (a secondary primary, like Diffy's) is not implemented. It would double load on the primary, or need a second instance.
- 2026-11-21 — Live state is a file, not an HTTP endpoint: `.gerra/shadow/<name>/state.json`, rewritten atomically (tmp + rename) at most once a second while traffic flows, and with `running: false` on shutdown. `gerra shadow status` checks the pid, so a crashed shadow shows as "not running". An admin endpoint would have taken a path in the user's URL space. Differences go to `diffs.jsonl`, which rotates to `diffs.1.jsonl` at 10 MiB. Latency percentiles cover the last 1000 compared requests.
- 2026-11-21 — Measured overhead on a laptop with everything on one machine (2000 GETs, 20 concurrent, Express example). Direct: p50 0.99 ms / p95 2.8 ms. Through shadow with a healthy candidate: p50 3.2 ms / p95 12.7 ms. Through shadow with a candidate that hangs: p50 1.5 ms / p95 4.3 ms, and 1936 of 2000 mirrors dropped as designed. Most of the gap with a healthy candidate is the mirror calls and comparisons running on the proxy's event loop, plus the candidate competing for the same CPU. Revisit (worker thread for mirroring, or the Go proxy noted above) if this matters in real deployments.
- 2026-11-21 — Cutover routes each request at random by the step's weight (no sticky sessions yet). A rollback is final for the run: weight 0, and comparisons continue in the background like shadow. Resuming means restarting the cutover. After the last step it's "complete" and keeps serving 100% from the candidate until stopped. DNS/load-balancer changes are up to the user.
- 2026-11-21 — Comparisons during cutover go both ways: requests the candidate served are re-sent to the primary, and vice versa. The primary's answer is always the reference. Only GET/HEAD/OPTIONS are compared by default (writes are routed but never duplicated), with opt-in via `--unsafe-methods` or config `replay: true`.
- 2026-11-21 — Thresholds are judged per step, only after `--min-samples` (20) observations, so one early failure can't roll back. A step needs both its hold time and `min-samples` candidate calls before moving on. If no GET/HEAD/OPTIONS traffic arrives, steps advance on error rate and p99 alone. Error rate counts connection errors, timeouts, failovers, and candidate 5xx that the primary didn't also return.
- 2026-11-21 — Both p99s are measured from requests served to users through the proxy, so they're comparable. The candidate's covers the current step; the primary's is a 1000-request window across steps, so a baseline still exists at 100%. A first version used direct comparison calls for the primary and proxied requests for the candidate, which was biased against the candidate; the demo exposed it.
- 2026-11-21 — Failover: if the candidate fails before sending response headers on a GET/HEAD/OPTIONS, the proxy answers from the primary (the user sees no error) and counts it as a candidate error. Writes are never retried on the other service; they get a 502.
- 2026-11-21 — Manual rollback is `gerra cutover rollback`. It sends SIGUSR2 to the pid in `state.json` and waits for the state to confirm. SIGUSR1 is avoided because Node uses it for the inspector. This is POSIX-only; Windows isn't supported. `gerra cutover status` exits 3 when rolled back, so scripts can check without parsing.
