---
name: gerra-rewrite
description: Rewrite or port a backend service (e.g. Node to Go) one route at a time, proving each route answers exactly like the original by replaying real recorded traffic with gerra until it passes. Use when asked to rewrite, port or migrate an HTTP service and a gerra tape exists (or can be recorded).
---

# Rewrite a service route by route, verified by gerra

gerra recorded real requests to the original service and its exact answers (a *tape*). A route is done when `gerra replay` sends those requests to your rewrite (the *candidate*) and every answer matches. Work one route at a time and don't move on until it passes.

The steps below use the CLI (`gerra …`; inside the gerra repo itself, `pnpm gerra …`). If the gerra MCP server is connected, use the matching tools instead: `gerra_list_tapes`, `gerra_get_exchanges`, `gerra_replay`, `gerra_diff`, `gerra_explain_exchange`.

## Before the first route

1. **Agree on the target** with the user: language, framework, where the candidate lives, and the port it runs on (e.g. `:4000`, next to the original on `:3000`). Ask how to run the original if you don't know.
2. **Take inventory.** `gerra tapes <tape>` lists routes with request counts and status codes. If there's no tape, ask the user to record one: `gerra record --target <original> --tape <name>`, then send realistic traffic through it.
3. **Check the tape against the original itself, and learn noise:**
   `gerra replay <tape> --against <original> --original <original>`
   This must PASS. Values that change on every call (ids, timestamps, expiry times) are learned as noise and ignored from now on. If it doesn't pass, stop and tell the user. A tape the original can't pass can't judge a rewrite.
4. **Write a checklist** in `REWRITE.md`: every route from step 2 with its request count, and a status column (todo / passing / notes). Order it so read-only routes with the most traffic come first and writes come last. Update it as you go; it's how work resumes in a later session.

## For each route

1. **Read what it must do.**
   - Recorded exchanges: `gerra_get_exchanges` with `routes: ["GET /products/:id"]`, or read the lines for that path in `.gerra/tapes/<tape>.jsonl`.
   - The original's source for that route. The tape shows behavior only for the inputs that were recorded; the source shows the rest (validation, error branches).
2. **Implement it in the candidate**, matching observable behavior exactly:
   - status codes, `content-type`, `location`
   - JSON field names, types and `null` vs missing
   - number formatting (`59.5`, not `59.50`)
   - error bodies and messages
   - array order
   - rounding

   Key order and whitespace in JSON don't matter.
3. **Run the candidate and replay just that route:**
   `gerra replay <tape> --against :4000 --route "GET /products/:id"`
   - Add `--unsafe-methods "POST /cart/price"` only for write routes that are safe to repeat against the candidate's data (a local or test database).
   - Add `--header "authorization: Bearer <test token>"` when the tape shows `[gerra:masked]` credentials.
4. **If it fails, look at one difference in full:** `gerra diff <tape> --exchange ex_3f445aac` (the id from the report). It shows the request, both answers and exactly where they differ. Fix and replay again. "Close enough" is not passing.
5. **When it passes,** replay the whole tape (`gerra replay <tape> --against :4000`) to catch regressions in routes that already passed. Then mark the route in `REWRITE.md` and commit, e.g. `GET /products/:id matches the original (12/12 recorded requests)`.

## Rules

- **Never make a replay pass by hiding a difference.** Don't edit tapes. Don't add `ignore` rules, normalizers or `unordered` paths to `gerra.config.json` unless the value really changes between two runs of the original. If you think something is noise but `--original` didn't learn it, ask the user first.
- **Match the original, bugs included, and say so.** If the original looks wrong (e.g. float rounding that loses a cent), copy its behavior so the replay passes. Then tell the user and note it in `REWRITE.md`. Changing behavior is the user's decision, not part of the rewrite.
- **Only verified behavior counts as verified.** Routes or inputs that aren't in the tape weren't checked. List them for the user and suggest recording more traffic for them.
- **Local targets only.** Never replay against production. gerra refuses non-local targets anyway; don't work around that.
- **Keep the original running and unchanged** while you work; it's the reference.

## Done

The whole tape passes against the candidate. Report to the user:
- routes passing and recorded requests replayed
- behavior you copied that looked wrong
- routes or cases the tape doesn't cover

Then suggest the next steps:
1. `gerra shadow --primary <original> --candidate <candidate>` to compare on live traffic with users unaffected.
2. `gerra cutover --primary <original> --candidate <candidate>` to move traffic over gradually with automatic rollback.
