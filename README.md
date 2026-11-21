# gerra

**Rewrite your backend with AI, and prove nothing broke.**

gerra records how your existing service behaves on real traffic, replays that traffic against the rewritten version, shows you every difference, and then moves traffic over gradually with automatic rollback.

> AI writes the new code. gerra is the proof that makes it safe to ship.

## How it works

```bash
gerra record  --target http://localhost:3000 --tape checkout      # watch the old service
gerra replay  checkout --against http://localhost:4000            # test the rewrite on real requests
gerra shadow  --primary :3000 --candidate :4000                   # compare on live traffic, users unaffected
gerra cutover --primary :3000 --candidate :4000 --hold 10m        # switch 1% → 10% → 50% → 100%, auto-rollback
```

Works at the HTTP layer, so the old and new services can be in any language.

## Install

Requires Node 24+.

```bash
npx @gerra/cli --help            # run without installing
npm install -g @gerra/cli        # or install the `gerra` command
```

The examples below use `pnpm gerra` because they run from a clone of this repo; with npm, use `gerra` (or `npx @gerra/cli`) instead.

## Demo: json-server, ported to Go

[examples/json-server](examples/json-server) is [json-server](https://github.com/typicode/json-server) rewritten in Go by an agent, one route at a time, using the gerra workflow:

- **2089 recorded requests replayed:** 2088 identical, down to `content-length`, CORS headers and V8's error messages.
- **The one difference is documented:** a malformed URL escape that Go's HTTP server rejects before the app sees it.
- **Faster:** 6.4× the throughput on the recorded traffic (2.1× on a single core), p50 15 ms → 1.1 ms, 257 MB → 30 MB.

`./verify.sh` and `./bench.sh` in that folder reproduce it.

## Usable today: record

```bash
pnpm install && pnpm build

# put gerra in front of your service; send traffic to :8080 instead of :3000
pnpm gerra record --target http://localhost:3000 --port 8080 --tape checkout --mask-field email
# Ctrl-C finishes in-flight requests, flushes the tape, and exits

pnpm gerra tapes            # list tapes with request counts per route (--json for machines)
```

Each request/response pair is one JSON line in `.gerra/tapes/<tape>.jsonl`: method, path, query, headers, body (UTF-8 or base64), status, response headers and body, and latency. `authorization`, `cookie` and `set-cookie` are always masked in the tape. Add more with `--mask-header` and mask JSON body fields with `--mask-field`. Your clients still get the real, unmasked responses. An existing tape is never mixed into silently: pass `--append` to add to it or `--overwrite` to replace it. `gerra record --help` lists all options.

## Usable today: replay and diff

```bash
# send the recorded requests to the rewrite and compare every response with the recorded one
pnpm gerra replay checkout --against http://localhost:4000

# POST/PUT/PATCH/DELETE are only replayed if you opt in ("*", a method, or a route from `gerra tapes`)
pnpm gerra replay checkout --against :4000 --unsafe-methods "POST /cart/price" \
  --header "authorization: Bearer test-token"     # masked headers aren't replayed; supply test values

pnpm gerra diff checkout    # show the report for the last run again, without sending traffic
```

The report lists each route and where its responses differ, e.g. `body $.discount  9.41 → 9.42`, with a sample request you can reproduce. Status, `content-type`, `location` and the body are compared. JSON is compared structurally, after undoing gzip/br. Fields that were masked in the tape match anything. `--json` gives a machine-readable report. The exit code is non-zero if anything differs or fails, so you can use it in CI. Replay refuses targets that don't look local or internal unless you pass `--allow-prod`.

### Noise

Real services return values that change on every request: timestamps, generated IDs, expiry times. gerra keeps them out of the way three ways, and the report always lists what it ignored and why:

- **Normalizers:** ISO date-times and UUIDs that keep the same format are treated as equal (on by default). Values of id-named fields can be too, but only if you turn that on.
- **Learned noise:** `gerra replay checkout --against :4000 --original :3000` sends each request to the original twice. Fields that differ between the original's own two answers are treated as noise. They're saved to `.gerra/noise/checkout.json` and reused by later replays.
- **Config:** use `gerra.config.json` for ignore rules, unordered arrays, masking and per-route settings. See [docs/config.md](docs/config.md).

## Usable today: shadow

```bash
# users talk to :8080 and always get the original's answer; a copy of each request goes to the rewrite
pnpm gerra shadow --primary http://localhost:3000 --candidate http://localhost:4000 --port 8080 --noise checkout

pnpm gerra shadow status    # live counters, per-route differences, latest examples (--json for machines)
```

The rewrite is called only after the user's response has been sent, at most 64 calls at a time (extra copies are dropped and counted), so a slow or broken rewrite never affects users. Only GET/HEAD/OPTIONS are mirrored unless you opt in, because a mirrored POST would write twice if both services share a database. Responses are masked before they're compared or written. Differences are logged to `.gerra/shadow/<name>/diffs.jsonl`. `--noise <tape>` reuses noise learned with `replay --original`.

## Usable today: cutover

```bash
pnpm gerra cutover --primary http://localhost:3000 --candidate http://localhost:4000 --port 8080 \
  --steps 1,10,50,100 --hold 10m --noise checkout

pnpm gerra cutover status      # current step, rates, recent differences, event history (exit 3 if rolled back)
pnpm gerra cutover rollback    # send everything back to the original right now
```

Users routed to the rewrite get the rewrite's answer. Every GET/HEAD/OPTIONS request is also sent to the other service afterwards, and the two answers are compared. The share of traffic going to the rewrite goes up one step at a time once a step has held for `--hold` with enough traffic. All traffic goes back to the original immediately if, in the current step, the rate of different answers (`--max-diff-rate`, default 1%), the rewrite's error rate (`--max-error-rate`, default 1%) or its p99 latency (`--max-p99`, default 2× the original's) crosses its threshold. If the rewrite fails before answering a GET, the original answers instead, so users don't see the failure. Writes are routed but never duplicated for comparison unless you opt in.

## Usable today: the agent loop

gerra gives coding agents a way to check their own work. An agent rewrites one route, replays that route's recorded traffic, reads exactly what differs, fixes it, and only moves on when it passes.

```bash
pnpm gerra replay checkout --against :4000 --route "POST /cart/price"   # one route at a time
pnpm gerra diff checkout --exchange ex_3f445aac                          # one difference in full
```

- **Skill:** [skills/gerra-rewrite/SKILL.md](skills/gerra-rewrite/SKILL.md) is the workflow and its rules (never hide a difference; copy the original's bugs and report them). For Claude Code, copy it to `.claude/skills/gerra-rewrite/` in the project you're rewriting.
- **MCP server:** gives agents `gerra_list_tapes`, `gerra_get_exchanges`, `gerra_replay`, `gerra_diff` and `gerra_explain_exchange`. Run it from the project that holds `.gerra/`:

  ```bash
  claude mcp add gerra -- npx -y @gerra/mcp --root "$PWD"
  ```

  The MCP tools only replay against local or internal targets.

Try all of this on the example app and its deliberately imperfect rewrite in [examples/express-pricing](examples/express-pricing).

## Status

Early development. Every command works: `record`, `tapes`, `replay` (with noise filtering), `diff`, `shadow` and `cutover`. So does the agent loop (skill and MCP server), and the json-server demo above was built with it. See [docs/PLAN.md](docs/PLAN.md).

## License

MIT
