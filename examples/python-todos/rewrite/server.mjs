// The todo API rewritten from Python to Node (node:http + node:sqlite, no dependencies): the "candidate".
//
//   python3 seed.py data/rewrite.db
//   DB=data/rewrite.db WEBHOOK_URL=http://127.0.0.1:9900/hooks PORT=4200 \
//     node --import @gerra/sdk-node/register rewrite/server.mjs
//
// `--import @gerra/sdk-node/register` makes it report its outbound calls (the webhook) to gerra without
// any code here knowing about it.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DB ?? "data/rewrite.db");
const webhookUrl = process.env.WEBHOOK_URL ?? "";

const todo = (row) => ({ id: row.id, title: row.title, done: Boolean(row.done) });
const byId = db.prepare("select * from todos where id = ?");

async function notify(event, item) {
  if (!webhookUrl) return;
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event, todo: item }),
    signal: AbortSignal.timeout(5000),
  });
}

async function handle(method, path, query, body) {
  if (path === "/todos" && method === "GET") {
    const filter = query === "done=true" ? 1 : query === "done=false" ? 0 : null;
    const rows = filter === null ? db.prepare("select * from todos order by id").all() : db.prepare("select * from todos where done = ? order by id").all(filter);
    return [200, rows.map(todo)];
  }
  if (path === "/todos" && method === "POST") {
    const title = body?.title;
    if (typeof title !== "string" || title.trim() === "") return [400, { error: "title is required" }];
    const { lastInsertRowid } = db.prepare("insert into todos (title) values (?)").run(title.trim());
    return [201, todo(byId.get(lastInsertRowid))];
  }
  if (path === "/stats" && method === "GET") {
    const { total, done } = db.prepare("select count(*) as total, coalesce(sum(done), 0) as done from todos").get();
    return [200, { total, done, open: total - done, percent_done: total ? Math.round((done * 100) / total) : 0 }];
  }
  const m = /^\/todos\/(\d+)$/.exec(path);
  if (!m) return [404, { error: "not found" }];
  const row = byId.get(Number(m[1]));
  if (!row) return [404, { error: `todo ${m[1]} not found` }];
  if (method === "GET") return [200, todo(row)];
  if (method === "DELETE") {
    db.prepare("delete from todos where id = ?").run(row.id);
    return [204, null];
  }
  if (method === "PATCH") {
    if (body === null) return [400, { error: "expected a JSON object" }];
    const title = body.title ?? row.title;
    const done = body.done ?? Boolean(row.done);
    if (typeof title !== "string" || typeof done !== "boolean") return [400, { error: "title must be a string and done a boolean" }];
    db.prepare("update todos set title = ?, done = ? where id = ?").run(title, done ? 1 : 0, row.id);
    const item = todo(byId.get(row.id));
    if (done && !row.done) await notify("todo.completed", item);
    return [200, item];
  }
  return [405, { error: "method not allowed" }];
}

function parseObject(text) {
  try {
    const v = JSON.parse(text || "null");
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const [path, query = ""] = (req.url ?? "/").split("?", 2);
    try {
      const [status, value] = await handle(req.method ?? "GET", path, query, parseObject(Buffer.concat(chunks).toString("utf8")));
      if (value === null) return res.writeHead(status).end();
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    } catch (err) {
      console.error(err);
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "internal error" }));
    }
  });
});

const port = Number(process.env.PORT ?? 4200);
server.listen(port, "127.0.0.1", () => console.log(`todos (Node rewrite) listening on http://localhost:${port}`));
