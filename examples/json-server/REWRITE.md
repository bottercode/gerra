# Rewrite checklist: json-server 1.0.0-beta.15 → Go

Kept as the `gerra-rewrite` skill asks: every route gerra recorded, its status, and anything worth knowing.

- **Original:** `npx json-server data/db.json` (Node 24, port 3000). It is the reference and stays unchanged.
- **Candidate:** `go/` (Go, standard library plus `golang.org/x/text` for collation, port 4000).
- **Tapes:**
  - `jsonserver-reads`: 2000 exchanges, the read mix `traffic.mjs reads` sends.
  - `jsonserver-writes`: 28 exchanges, a fixed write sequence.
  - `jsonserver-edges`: 61 exchanges of odd but legal requests.
- **Pre-check:** the original passes all three of its own tapes. Replaying the reads tape against it with `--original` learned no noise.
- **Compared:** status, `content-type`, `location`, `content-length`, the three CORS headers, and the body.

## Routes

| Route (as `gerra tapes` lists it) | reads | writes | edges | Status | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| GET /posts | 1093 | 2 | 22 | passing | filters, operators, `_where`, sort, pagination, `_embed` |
| GET /posts/:id | 433 | 2 | 4 | passing | `_embed` one and many, escaped path (`/po%73ts/%32`) |
| GET /comments | 175 | | 4 | passing | |
| GET /users | 87 | | 3 | passing | nested-field filter and sort |
| GET /users/:id | 57 | 1 | 1 | passing | |
| GET /profile | 52 | 1 | 1 | passing | object resource |
| GET /, HEAD / | 25 | 1 | 5 | passing | HTML index page, ETag, 304 on `If-None-Match` |
| OPTIONS /posts, /, /posts/:id | 25 | | 2 | passing | see "Copied quirks" |
| HEAD /posts, /posts/:id, /comments, /users, /users/:id | 35 | | | passing | no `Content-Length`, like Node |
| GET /profile/:id, /posts/:id/comments, /nope, //posts | 18 | | 1 | passing | JSON and plain-text 404s |
| GET /posts/, /posts/:id/, /posts/%E0%A4 | | | 3 | passing | trailing slash, bad UTF-8 escape (400) |
| POST /posts, /comments | | 5 | 6 | passing | `$.id` ignored: json-server generates a random id per call |
| PUT, PATCH, DELETE on items, `/profile`, `/posts` | | 13 | 5 | passing | |
| POST /, /nope, /profile, /posts/:id; PURGE /, /posts | | 3 | 3 | passing | |
| GET /%zz | | | 1 | **different** | see "Known difference" |

Total: 2088 of 2089 recorded exchanges are identical.

## Copied quirks (the original's behavior, kept on purpose)

These look wrong or surprising, but they're what json-server does, so the port does the same. Changing any of them is a product decision, not part of the rewrite.

- **`?id=1`, `?userId=3` and `?postId=4` match nothing.** Query values that look numeric become numbers, but json-server stores ids as strings, so `"3" === 3` fails. Filtering by id or foreign key always returns `[]`.
- **`_limit` (v0.17) is treated as a filter.** No item has that field, so `?userId=3&_limit=1` is `[]`.
- **Sorting puts missing values last (first when descending).** Strings compare with `localeCompare` (Unicode collation, `apple < Banana < banana < édition`), not byte order.
- **A malformed JSON body is a 500, not a 400.** The body is V8's error message, HTML-escaped (`Unexpected token &#39;o&#39;, &quot;not json&quot; is not valid JSON`). The body is parsed whatever its `content-type` (including `text/plain`) and for every write method on every path. Bodies over 100 KiB get a 500 `Payload too large`.
- **An empty POST creates an item with only an id.** A POST body's own `id` is replaced.
- **Deleting an item nulls every foreign key that pointed at it, in every collection.** `?_dependent=comments` then deletes every comment whose `postId` is null, including ones that were null before.
- **The CORS preflight's 204 carries `Content-Length: 0`.** RFC 9110 says a server must not send it, and Go's `net/http` strips it. The port sets it under a raw lowercase header key so it goes out anyway.
- **Error 500s and the plain-text 404 are sent chunked** (no `Content-Length`).

## Known difference

- **`GET /%zz` (an invalid percent-escape in the path).** Go's `net/http` rejects the request line before any handler runs and answers `400 Bad Request` with body `400 Bad Request` and no CORS headers. json-server answers 400 with body `Bad Request` and CORS headers. The status matches. Making the body match would mean replacing Go's HTTP request parser; I left that for you to decide.

## Not covered by the tapes (unverified)

- **Static files:** `./public` and `--static` are not ported (`--static` exits with a message), and JSON5 database files aren't either.
- **Reloading the database file when someone else edits it:** the port polls every 500 ms. In a manual test it picked up every edit. json-server (chokidar) missed the first edit right after an API write, then picked up the next. This is timing-dependent and gerra can't replay it.
- **Text the data doesn't contain:**
  - Greek final sigma in `contains`/`startsWith`/`endsWith` (Go lowercases Σ to σ; JavaScript uses ς at word end).
  - Lone surrogates and invalid UTF-8 in request bodies.
- **Collation in other locales:** `localeCompare` matches Node running in an English or unset locale (root collation). Node under, say, a Swedish locale sorts differently.
- **Cosmetic differences:** the startup banner, and the `X-Powered-By: tinyhttp` header (deliberately not sent).

## JavaScript behavior checked outside the tapes

`go test` (in `go/`) compares the port with fixtures Node itself produced (`go/testdata/gen-fixtures.mjs`). They cover:
- `JSON.parse` error messages for 51 malformed inputs;
- `Number#toString` on 28 numbers;
- `Number()` on 28 strings;
- `localeCompare` order on 47 words;
- pluralize/singularize on 52 nouns.

The inflection rules are generated from the JS package (`go/gen-inflection.mjs`).
