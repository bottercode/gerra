import http from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EFFECTS_HEADER, encodeEffects, install, instrumentQueries, instrumentSqlite, isCapturing, recordEffect, type Effect } from "./index.js";

const listen = async (handler: http.RequestListener) => {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const decode = (value: string | null): Effect[] | null => (value === null ? null : (JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Effect[]));

let uninstall: () => void;
let hooks: Awaited<ReturnType<typeof listen>>;
let app: Awaited<ReturnType<typeof listen>>;
const db = instrumentSqlite(new DatabaseSync(":memory:"));
db.exec("create table todos (id integer primary key, title text)");
const fakePg = instrumentQueries({ query: async (_text: unknown, _values?: unknown[]) => ({ rows: [] }) }, { db: "postgres" });

beforeAll(async () => {
  uninstall = install();
  hooks = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(req.url === "/missing" ? 404 : 202);
      res.end();
    });
  });
  app = await listen((req, res) => {
    // Do the work once the body has arrived, as most frameworks do: the collector has to survive that.
    req.resume();
    req.on("end", () => void handle(req, res));
  });
});

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/todos") {
      db.prepare("insert into todos (title) values (?)").run(url.searchParams.get("title") ?? "");
      await fetch(`${hooks.url}/created`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: url.searchParams.get("title") }) });
      await new Promise<void>((resolve) => {
        const r = http.request(`${hooks.url}/missing`, { method: "PUT" }, (hr) => {
          hr.resume();
          hr.on("end", resolve);
        });
        r.write("plain ");
        r.end("text");
      });
      await fakePg.query("select 1 where $1", [true]);
      recordEffect({ type: "queue", topic: "todos", capturing: isCapturing() });
      res.writeHead(201, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (url.pathname === "/stream") {
      res.write("partial");
      await fetch(`${hooks.url}/after-headers`, { method: "POST" });
      return res.end();
    }
    res.end("plain");
}
afterAll(async () => {
  uninstall();
  for (const s of [app, hooks]) {
    s.server.closeAllConnections();
    await new Promise((r) => s.server.close(r));
  }
});

describe("install", () => {
  it("reports outbound calls and queries made while answering a request gerra asked about", async () => {
    const res = await fetch(`${app.url}/todos?title=milk`, { headers: { [EFFECTS_HEADER]: "1" } });
    expect(res.status).toBe(201);
    expect(decode(res.headers.get(EFFECTS_HEADER))).toEqual([
      { type: "query", db: "sqlite", query: "insert into todos (title) values (?)", params: ["milk"] },
      { type: "http", method: "POST", url: `${hooks.url}/created`, body: { title: "milk" }, status: 202 },
      { type: "http", method: "PUT", url: `${hooks.url}/missing`, body: "plain text", status: 404 },
      { type: "query", db: "postgres", query: "select 1 where $1", params: [true] },
      { type: "queue", topic: "todos", capturing: true },
    ]);
  });

  it("keeps concurrent requests apart and leaves other requests alone", async () => {
    const [a, b, plain] = await Promise.all([
      fetch(`${app.url}/todos?title=a`, { headers: { [EFFECTS_HEADER]: "1" } }),
      fetch(`${app.url}/todos?title=b`, { headers: { [EFFECTS_HEADER]: "1" } }),
      fetch(`${app.url}/todos?title=c`),
    ]);
    expect(decode(a.headers.get(EFFECTS_HEADER))?.[0]?.params).toEqual(["a"]);
    expect(decode(b.headers.get(EFFECTS_HEADER))?.[0]?.params).toEqual(["b"]);
    expect(plain.headers.get(EFFECTS_HEADER)).toBeNull();
  });

  it("reports an empty list when nothing happened, and only what came before the headers", async () => {
    const none = await fetch(`${app.url}/`, { headers: { [EFFECTS_HEADER]: "1" } });
    expect(decode(none.headers.get(EFFECTS_HEADER))).toEqual([]);
    const late = await fetch(`${app.url}/stream`, { headers: { [EFFECTS_HEADER]: "1" } });
    expect(await late.text()).toBe("partial");
    expect(decode(late.headers.get(EFFECTS_HEADER))).toEqual([]);
  });
});

describe("encodeEffects", () => {
  it("drops bodies, then effects, to fit the size limit", () => {
    const big = Array.from({ length: 50 }, (_, i): Effect => ({ type: "http", method: "POST", url: `http://x.test/${i}`, body: "x".repeat(200) }));
    expect(decode(encodeEffects(big, 100_000))).toHaveLength(50);
    const noBodies = decode(encodeEffects(big, 2_000)) ?? [];
    expect(noBodies.every((e) => !("body" in e))).toBe(true);
    const cut = decode(encodeEffects(big, 400)) ?? [];
    expect(cut.at(-1)).toMatchObject({ type: "gerra.truncated" });
    expect(cut.length).toBeLessThan(50);
  });
});
