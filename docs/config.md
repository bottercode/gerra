# gerra.config.json

Optional. `gerra record`, `replay` and `diff` read `./gerra.config.json` if it exists, or the file given with `--config <path>`. Unknown keys are errors, so a typo fails loudly instead of silently doing nothing.

```json
{
  "reset": "npm run seed:test",
  "mask": { "headers": ["x-api-key"], "fields": ["email", "password"] },
  "compare": { "headers": ["cache-control"] },
  "ignore": ["header x-request-id", "$..traceId"],
  "unordered": ["$.tags"],
  "normalizers": { "timestamps": true, "uuids": true, "ids": false },
  "routes": {
    "POST /cart/price": { "replay": true, "ignore": ["$.debug"] },
    "GET /orders/:id": { "unordered": ["$.items"], "normalizers": { "ids": true } }
  }
}
```

| Key | Used by | Meaning |
| --- | --- | --- |
| `reset` | replay | Shell command run before every replay to put the services in the recorded state, like `--reset` (which overrides it). A failing reset stops the replay. |
| `mask.headers`, `mask.fields` | record | Added to `--mask-header` / `--mask-field`. `authorization`, `cookie` and `set-cookie` are always masked. |
| `compare.headers` | replay, diff | Response headers compared in addition to `content-type` and `location`. |
| `ignore` | replay, diff | Places whose differences don't count. |
| `unordered` | replay, diff | JSON arrays compared without regard to order. |
| `normalizers` | replay, diff | See below. |
| `routes` | all | Per-route overrides, keyed by route as `gerra tapes` shows it (`GET /products/42` is the same key as `GET /products/:id`). `ignore` and `unordered` add to the global lists; `normalizers` overrides individual switches; `replay: true` replays a non-idempotent route, like `--unsafe-methods "<route>"`. |

## Places

`ignore` entries use the same names the report prints:

- `status`, `header <name>`, `body` (the whole body), `body (text)`, `body (bytes)`
- `effects $[*].body.traceId` and the like for [side effects](effects.md)
- `body $.path.to.field`, or just `$.path.to.field`
- `[*]` for any array index (`$.lines[*].note`), `..` for any depth (`$..traceId`)
- A place covers everything under it: `$.meta` ignores `$.meta.took`.

## Normalizers

A changed value that a normalizer considers equivalent doesn't count. Normalizers compare *format*, so a rewrite that changes how values are written is still caught.

| Normalizer | Default | Equivalent when |
| --- | --- | --- |
| `timestamps` | on | Both are ISO-8601 date-times with the same format (`2026-11-20T10:00:00.123Z` vs `2026-11-21T09:00:01.456Z`). A format change, such as dropping milliseconds or `Z` → `+00:00`, is still reported. Date-only values (`2026-11-20`) are never normalized. |
| `uuids` | on | Both are UUIDs with the same letter case. |
| `ids` | off | The field is id-named (`id`, `orderId`, `order_id`) and both values have the same JSON type. Turn it on per route when the candidate has its own database and generates its own ids. |

## Learned noise

`gerra replay <tape> --against <candidate> --original <original>` also sends each request to the original twice. Every place where the original's two responses differ is noise for that route. Noise is saved to `.gerra/noise/<tape>.json`, applied to later replays and diffs of that tape, and recorded in each run. `--no-noise` turns it off. The report lists everything it ignored and why.
