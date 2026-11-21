# python-todos (example)

A todo API in plain Python (standard library, SQLite) and its rewrite in Node (`node:http` + `node:sqlite`, no dependencies), checked with gerra. It shows three things the express-pricing example doesn't:

- **Another language.** The original is Python. gerra works at the HTTP layer, so it doesn't care.
- **Writes.** The traffic creates, edits, completes and deletes todos, and later reads depend on those writes. `gerra.config.json` opts the write routes in to replay and sets `"reset"` to reseed the rewrite's database before every replay, so it starts in the state the Python service was recorded in. Writes are replayed one at a time in recorded order.
- **Side effects.** Completing a todo POSTs a `todo.completed` webhook. The Python app reports it with [effects.py](effects.py), a 20-line implementation of gerra's [effects protocol](../../docs/effects.md). The rewrite reports its own with `node --import @gerra/sdk-node/register`, without code changes. gerra compares the two, so a rewrite that answered correctly but forgot the webhook would fail.

## Run it

Needs Python 3.9+ and Node 24+. From the repo root, `pnpm install && pnpm build`, then:

```bash
cd examples/python-todos
./demo.sh
```

It seeds the database, starts the Python service and a webhook sink, records 25 requests through gerra ([traffic.mjs](traffic.mjs)), then starts the rewrite and replays the tape against it:

```
Resetting: python3 seed.py data/rewrite.db
Replaying 25 exchanges from .gerra/tapes/todos.jsonl against http://localhost:4200…
Replaying 12 writes: sending requests one at a time in recorded order.
  25 exchanges: 23 identical, 2 different, 0 errors, 0 skipped

✗ GET /stats  (3 identical, 2 different)
    body $.percent_done  ×2
      e.g. GET /stats: 12 → 13
✓ PATCH /todos/:id  (7 identical)
✓ GET /todos  (4 identical)
✓ GET /todos/:id  (3 identical)
✓ POST /todos  (3 identical)
✓ DELETE /todos/:id  (2 identical)
✓ GET /todos/  (1 identical)
```

Everything matches, webhooks included, except one thing an AI port easily gets wrong: Python's `round()` rounds halves to even (`round(12.5) == 12`, `round(62.5) == 62`), while JavaScript's `Math.round` rounds them up (13, 63). Whether that's a bug to fix in the rewrite or in the original is your call, but now it's a decision rather than a surprise.

To see a side-effect difference, start the rewrite without `WEBHOOK_URL` and replay again: every completion is reported as `effects $[*]`, with the webhook the original sent and the rewrite didn't. `npx @gerra/dashboard` (or `node ../../packages/dashboard/dist/index.js`) in this folder shows both side by side.

## Running the pieces yourself

```bash
pnpm sink                 # webhook receiver on :9900
pnpm seed && pnpm start   # Python original on :3200
python3 seed.py data/rewrite.db && pnpm start:rewrite   # Node rewrite on :4200
node ../../packages/cli/dist/index.js record --target :3200 --port 8200 --tape todos
node ../../packages/cli/dist/index.js replay todos --against :4200
```
