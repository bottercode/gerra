# @gerra/sdk-node

Reports what a Node service did while answering a request (outbound HTTP calls, database queries) to [gerra](https://www.npmjs.com/package/@gerra/cli), so a rewrite is checked on its side effects as well as its responses. A rewrite that answers every request correctly but forgets the webhook shows up as a difference.

```bash
npm install @gerra/sdk-node
node --import @gerra/sdk-node/register server.js
```

That reports `fetch` and `node:http`/`node:https` calls with no code changes. For databases and anything else:

```js
import { instrumentQueries, instrumentSqlite, recordEffect } from "@gerra/sdk-node";

instrumentQueries(pool, { db: "postgres" });   // pg, mysql2
instrumentSqlite(db);                           // node:sqlite
recordEffect({ type: "queue", topic: "emails", message });
```

It only does anything for requests gerra sends with `x-gerra-effects: 1` (record, replay, shadow), so it can stay installed in production. Requires Node 24+. Protocol and details: [docs/effects.md](https://github.com/bottercode/gerra/blob/main/docs/effects.md).

https://github.com/bottercode/gerra · MIT
