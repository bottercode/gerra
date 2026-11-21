# Side effects

Comparing responses catches a rewrite that answers differently. It doesn't catch one that answers correctly but stops sending the "order shipped" email, calls the payment provider twice, or writes to the wrong table. For that, the service tells gerra what it did while answering each request, and gerra compares that too.

## Protocol

It's one header in each direction, so any language can implement it.

1. On every request it records (`gerra record`), replays (`gerra replay`) or mirrors (`gerra shadow`), gerra sends the request header `x-gerra-effects: 1`.
2. While handling such a request, the service collects its effects in order.
3. When it sends the response headers, it adds `x-gerra-effects: <value>`, where the value is the base64url encoding (padding optional) of a JSON array of effects. A service that did nothing sends `[]`.

gerra removes the header from the response before it reaches a client, stores the effects with the exchange (`response.effects` in the tape) and compares them with the candidate's. Requests without `x-gerra-effects: 1` are left alone, so the instrumentation can stay in production. `gerra cutover` serves real users and doesn't ask for effects.

An effect is any JSON object with a string `type`. The usual shapes:

```json
{ "type": "http", "method": "POST", "url": "https://hooks.example.com/orders", "body": { "event": "order.paid", "id": 42 }, "status": 202 }
{ "type": "query", "db": "postgres", "query": "update orders set paid = true where id = $1", "params": [42] }
{ "type": "queue", "topic": "emails", "message": { "template": "receipt", "orderId": 42 } }
```

Effects that happen after the response headers are sent (fire-and-forget work, streaming responses) can't be reported this way and are left out.

## Comparing

- Effects are compared only when **both** sides reported them. A candidate without instrumentation isn't penalized, so you can add the SDK to the rewrite when you get to it.
- Order is ignored. Concurrent calls finish in any order, and what matters is that the same calls were made with the same payloads. Both lists are sorted the same way before comparing, so `effects $[0]` in a report refers to that sorted order (the dashboard shows them sorted).
- Differences appear in reports at `effects $[i]…`, e.g. `effects $[0].body.event`, and work with every noise mechanism: ignore rules (`"ignore": ["effects $[*].body.traceId"]`), learned noise (`replay --original`) and the timestamp and UUID normalizers.

## Node: @gerra/sdk-node

```bash
npm install @gerra/sdk-node
node --import @gerra/sdk-node/register server.js
```

That's all it takes to report outbound `fetch` and `node:http`/`node:https` calls (method, URL, request body, status), via Node's `diagnostics_channel`. Or call `install()` yourself:

```js
import { install, instrumentQueries, instrumentSqlite, recordEffect } from "@gerra/sdk-node";

install({ ignoreUrl: (url) => url.startsWith("https://telemetry.") });

instrumentQueries(pool, { db: "postgres" });        // pg, mysql2: query(text | { text, values }, values?)
instrumentQueries(conn, { db: "mysql", methods: ["query", "execute"] });
instrumentSqlite(db);                                // node:sqlite DatabaseSync: prepare(...).run/get/all, exec

recordEffect({ type: "queue", topic: "emails", message }); // anything else; a no-op outside a gerra request
```

Database queries are opt-in because a rewrite rarely produces the same SQL text as the original. They are most useful when the rewrite stays in Node (a refactor, a framework migration) or with ignore rules on `effects $[*].query`.

Bodies over 16 KB are cut, and if the header would exceed 256 KB, bodies are dropped and then the last effects, with a final `{ "type": "gerra.truncated", "dropped": n }`. Both limits are options of `install()`. gerra accepts response headers up to 1 MB.

## Other languages

[examples/python-todos/effects.py](../examples/python-todos/effects.py) implements the protocol for a Python service in about 20 lines; the app records its webhook calls with it, and gerra checks that the Node rewrite (using @gerra/sdk-node) sends the same webhooks.
