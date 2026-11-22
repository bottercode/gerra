# Launch plan and posts

**Posted 2026-11-22:** post A with `gerra-launch.mp4`, and its reply: https://x.com/botter_code/status/2124505812324454674

**Never put `@gerra/…` in post text.** X turns it into a mention of @gerra, an unrelated person's account. Package names stay in the videos and on GitHub; in text, write "gerra on npm" or link the repo.

## What works on X (researched 2026-11-22)

- **The dev-tool launch template.** Aiden Bai's launches get 5–10K likes and 0.6–1M views each, all in the same shape:
  "Introducing X" / one line of pain / "Fully open source" / `npx x@latest` / a 10–15 s screen video. No hashtags, no thread, no link in the post.
- **Relaunch the same tool from new angles.** React Doctor launched in February (10K likes, 1M views), then came back as v2, as an agent skill, for React Native and for performance. Each was a new "Introducing…" post, a few weeks apart. One product can carry many launches.
- **AI rewrites are a hot topic right now.**
  - A Go port of an AI assistant, with before/after numbers (boot 500 s → 1 s, a $599 Mac mini → a $9.90 board): 8.2K likes, 2.7M views.
  - "Bun rewrote itself from Zig to Rust. AI did most of the work": widely shared.
  - **Oct 30:** "Anthropic rewrote its Messages API in Rust. Zero Rust devs… humans wrote the plan and checked old vs new matched on real traffic. CPU dropped 40–50%. 'Never do the big rewrite' is dead advice." 2.9K likes, 750K views, from a Latent Space clip, and quoted by others as "humans owned the plan and **traffic parity**".
  - That is gerra's exact thesis. The conversation already exists; gerra is the open-source tool for the part the humans did.
- **Numbers beat adjectives.** The posts that spread lead with before → after figures.
- **Hacker News "Show HN"** posts that do well are personal and candid: why you built it, what's rough, and what feedback you want.

## Plan

1. **Day 1 — main launch on X** (post A), with `docs/launch/gerra-launch.mp4`. Put the repo link in the first reply.
   Stay online for the first 2 hours and answer every reply.
2. **Day 1 — quote-post the rewrite conversation** (post B): quote the Anthropic "traffic parity" post, or a recent one like it.
   - Don't claim Anthropic uses gerra.
   - Reply with substance, not a pitch, to people currently posting about AI rewrites.
3. **Day 1 or 2 — Show HN** (post E). Weekday, around 8–10am US Eastern. Answer every comment.
4. **Following weeks — one angle per post**, each with its own 10–15 s video (the launch pipeline in `docs/launch/` can render each):
   - **C:** side effects ("your AI rewrite answered every request right and forgot the webhook");
   - **D:** the Python → Node port (`round(12.5)`);
   - the dashboard;
   - the GitHub Action;
   - a written thread on the json-server port.
5. **Tag people only where it's true:**
   - @typicode on the json-server results (it's their project);
   - the people in the rewrite conversation, when replying to them.
6. **Also post on** r/golang and r/node (the json-server port), and lobste.rs if you have an invite.

Decided: the posts name Claude. It's accurate (Claude did both ports), people search for it, and the rewrite conversation is about Claude.

---

## A. Main post (attach `docs/launch/gerra-launch.mp4`)

> Introducing gerra
>
> Rewrite your backend with AI. Prove nothing broke.
>
> Record real traffic → replay it against the rewrite → your agent fixes every difference
>
> We had Claude port json-server to Go: 2088/2089 requests identical, 6.4× faster
>
> Fully open source

(Posted without the `npx @gerra/cli` line, because of the mention problem above; the video shows the command.)

First reply:

> github.com/bottercode/gerra
>
> Works with any language (it sits in front of your services as a proxy). CLI, MCP server for Claude Code / Codex, GitHub Action, and a dashboard.

## B. Quote post (on the "AI rewrote X in Rust / traffic parity" conversation)

> The hard part of a Claude rewrite isn't the code anymore, it's proving the new service answers exactly like the old one.
>
> I open-sourced a tool for that: record real traffic, replay it against the rewrite, see every difference, then cut over 1% → 100% with auto-rollback.
>
> github.com/bottercode/gerra

## C. Follow-up: side effects (attach `docs/launch/gerra-effects.mp4`)

> Claude rewrote our backend
>
> Every response matched
>
> It still forgot to send the webhook
>
> gerra now checks what your service did (outbound calls, queries), not just what it answered
>
> One line in Node, a header in any other language

## D. Follow-up: the Python → Node port (attach `docs/launch/gerra-rounding.mp4`)

> We had Claude port a Python API to Node
>
> Every response matched except one:
>
> Python: round(12.5) = 12
> JavaScript: Math.round(12.5) = 13
>
> Your tests won't catch this. Real traffic does.

## E. Show HN

**Title:** Show HN: Gerra – prove an AI-rewritten backend answers exactly like the old one

**Text:**

> Hi HN. AI agents can now rewrite a backend (Node to Go, Python to Rust) in days. What they can't do is tell you the new service behaves the same. Its own new tests mostly test what the agent understood.
>
> gerra is an open-source CLI that sits in front of your existing service as a proxy and records real requests and responses. It then replays them against the rewrite and reports every difference, grouped by route and place (`body $.total 91.73 → 91.72`). Values that differ between two calls to the original itself (timestamps, IDs) are learned as noise, so they don't clutter the report. After that come `shadow` (mirror live traffic; users always get the old answer) and `cutover` (1% → 100% with automatic rollback on difference rate, errors or p99). It works at the HTTP layer, so the languages don't matter.
>
> To test it, I had Claude Code port json-server (75K stars) to Go one route at a time. A route only counted as done when its recorded traffic replayed clean. The result: 2088 of 2089 requests identical, including headers and byte-exact bodies, and 6.4× the throughput. The one remaining difference is documented. The interesting part was what replay caught: Go's net/http silently drops `Content-Length: 0` on 204s; V8's exact `JSON.parse` error messages had to be reproduced; and `fetch()` was quietly adding `cache-control: no-cache`, so our own 304 tests never ran.
>
> Newer: services can report side effects (outbound calls, queries) with one response header, so "answered right but forgot the webhook" is caught. There's a Node SDK and a 20-line Python example. There's also a GitHub Action and a local dashboard.
>
> What's rough: getting realistic traffic to record is up to you (staging or a traffic script is the usual start); outbound calls are compared, not stubbed, during replay; and it's young.
>
> I'd love to hear from anyone who has done a big rewrite: what broke that you wish you'd caught earlier?
>
> https://github.com/bottercode/gerra

---

## Long version (blog, or a written X article)

## An AI ported json-server to Go. Here's the proof it answers the same.

Rewriting a backend with AI is easy now. Knowing that the rewrite behaves the same is the hard part. A new service passing its new tests isn't evidence; the old service's behavior on real traffic is.

gerra is an open-source tool for that. It sits in front of your existing service as a proxy and records real requests and responses, then replays them against the rewrite and reports every difference. When you're ready it shadows live traffic, and then shifts traffic over 1% → 100% with automatic rollback. It works at the HTTP layer, so the two services can be in any language.

To test it, we had Claude Code port [json-server](https://github.com/typicode/json-server) (75.8K★, about 440K npm downloads a week; `npx json-server` installs `1.0.0-beta.15`) from Node to Go, one route at a time, using gerra's rewrite skill. A route only counted as done once `gerra replay` passed.

**Result**

- **2089 recorded requests replayed, 2088 identical.** That covers status, `content-type`, `content-length`, CORS headers and body bytes. The traffic was 2000 reads from a realistic frontend mix, 28 writes and 61 edge cases.
- **The one difference** is a malformed `%zz` in the URL. Go's HTTP server rejects it before application code runs, so the port answers 400 with a different body. It's documented, not hidden.
- **Speed:** 6.4× the throughput on the recorded traffic, and 2.1× on a single core. Median latency went from 15.1 ms to 1.1 ms, and memory from 257 MB to 30 MB.

**What gerra caught along the way**

- **Copied quirks.** json-server's own quirks have to be copied, not fixed, or clients break:
  - `?userId=3` never matches, because ids are strings and the query value becomes a number.
  - A malformed JSON body gets a 500 carrying V8's exact error message.
  - Sorting uses Unicode collation, so `apple < Banana < édition`.

  The port re-implements `JSON.parse` errors, JS number formatting, JS comparison rules and the `inflection` package. Its tests check these against output generated by Node itself.
- **Go's `net/http` strips `Content-Length: 0` from 204 responses.** json-server sends it on every CORS preflight. Caught on the first full replay.
- **Our own traffic generator was wrong.** `fetch()` silently adds `cache-control: no-cache` to conditional requests, so the 304 path had never been exercised. Once fixed, it was replayed and matches.
- **What isn't covered is listed:** static file serving, JSON5, locales other than English, and a timing difference in reloading the file after outside edits.

**Try it**

`npx @gerra/cli --help`, or reproduce the demo:

```bash
git clone https://github.com/bottercode/gerra && cd gerra && pnpm install && pnpm build
cd examples/json-server && ./verify.sh && ./bench.sh
```

The checklist kept during the port, with every route, every copied quirk and every gap, is in `examples/json-server/REWRITE.md`.

gerra is MIT-licensed and has no runtime dependencies. Since the port it has gained side-effect checks (outbound calls and queries, with a Node SDK), stateful replay with `--reset`, a GitHub Action and a local dashboard.

---
Before publishing:
- re-run `bench.sh` on the machine you quote;
- check that the video, GIF and numbers match the README.
