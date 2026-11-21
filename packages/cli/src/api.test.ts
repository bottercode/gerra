import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeExchange, type Exchange } from "@gerra/core";
import { UsageError, compareExchange, getExchanges, runDiff, runReplay } from "./api.js";
import { loadNoise } from "./noise.js";
import { formatExchangeComparison, formatReportMarkdown } from "./report.js";

const ex = (id: string, method: string, path: string, body: unknown): Exchange => ({
  v: 1,
  id,
  at: "2026-11-20T10:00:00.000Z",
  request: { method, path, query: "", headers: {}, body: null },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: JSON.stringify(body) } },
  latencyMs: 1,
});

const tape = [
  ex("ex_aaaa1111-0000-0000-0000-000000000001", "GET", "/products/1", { id: 1, price: 24.99 }),
  ex("ex_aaaa2222-0000-0000-0000-000000000002", "GET", "/products/2", { id: 2, price: 59.5 }),
  ex("ex_bbbb3333-0000-0000-0000-000000000003", "GET", "/health", { ok: true, n: 0 }),
];

// The candidate gets product 2's price wrong; /health returns a counter that changes every call (noise).
let counter = 0;
let server: http.Server;
let url: string;
let dir: string;
let dirs: { tapes: string; runs: string; noise: string };

beforeEach(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/products/1") return res.end(JSON.stringify({ id: 1, price: 24.99 }));
    if (req.url === "/products/2") return res.end(JSON.stringify({ id: 2, price: 59.95 }));
    res.end(JSON.stringify({ ok: true, n: ++counter }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(join(tmpdir(), "gerra-api-"));
  dirs = { tapes: join(dir, "tapes"), runs: join(dir, "runs"), noise: join(dir, "noise") };
  await mkdir(dirs.tapes, { recursive: true });
  await writeFile(join(dirs.tapes, "shop.jsonl"), tape.map(serializeExchange).join("\n") + "\n");
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("runReplay", () => {
  it("limits a replay to the given routes", async () => {
    const o = await runReplay({ tape: "shop", against: url, routes: ["GET /products/:id"], dirs });
    expect(o.report.summary).toEqual({ total: 2, identical: 1, different: 1, errors: 0, skipped: 0 });
    expect(o.routes).toEqual(["GET /products/:id"]);
    const health = await runReplay({ tape: "shop", against: url, routes: ["/health"], dirs });
    expect(health.report.summary.total).toBe(1);
  });

  it("refuses filters that match nothing, and non-local targets", async () => {
    await expect(runReplay({ tape: "shop", against: url, routes: ["POST /nope"], dirs })).rejects.toThrow(UsageError);
    await expect(runReplay({ tape: "shop", against: "https://api.example.com", dirs })).rejects.toThrow(/doesn't look local/);
  });

  it("keeps noise learned for other routes when learning on a subset", async () => {
    await runReplay({ tape: "shop", against: url, original: url, dirs });
    expect((await loadNoise(dirs.noise, "shop"))?.routes).toEqual({ "GET /health": ["body $.n"] });
    await runReplay({ tape: "shop", against: url, original: url, routes: ["GET /products/:id"], dirs });
    expect((await loadNoise(dirs.noise, "shop"))?.routes).toEqual({ "GET /health": ["body $.n"] });
    const o = await runReplay({ tape: "shop", against: url, routes: ["/health"], dirs });
    expect(o.report.summary.identical).toBe(1);
  });
});

describe("runDiff and compareExchange", () => {
  it("filters the last run by route and explains a single exchange", async () => {
    await runReplay({ tape: "shop", against: url, dirs });
    const d = await runDiff({ tape: "shop", routes: ["GET /health"], dirs, noNoise: true });
    expect(d.report.summary).toMatchObject({ total: 1, different: 1 });

    const c = await compareExchange({ tape: "shop", id: "ex_aaaa2222", dirs });
    expect(c).toMatchObject({ route: "GET /products/:id", outcome: "replayed" });
    expect(c.mismatches).toEqual([{ at: "body $.price", kind: "changed", original: 59.5, candidate: 59.95 }]);
    const text = formatExchangeComparison(c);
    expect(text).toContain("Recorded answer: 200 application/json");
    expect(text).toContain('"price": 59.95');
    expect(text).toContain("✗ body $.price: 59.5 → 59.95");

    await expect(compareExchange({ tape: "shop", id: "ex_aaaa", dirs })).rejects.toThrow(/matches 2 exchanges/);
    await expect(compareExchange({ tape: "shop", id: "ex_zzz", dirs })).rejects.toThrow(/no exchange/);
  });
});

describe("formatReportMarkdown", () => {
  it("gives a verdict, a route table and the differences with an example", async () => {
    const o = await runReplay({ tape: "shop", against: url, routes: ["GET /products/:id"], dirs });
    const md = formatReportMarkdown(o.report, o);
    expect(md).toContain("### gerra replay: `shop`");
    expect(md).toContain("❌ **Not equivalent**: 1 different, 0 errors out of 2 replayed");
    expect(md).toContain("| ❌ | `GET /products/:id` | 1 | 1 | 0 | 0 |");
    expect(md).toContain("- `body $.price` ×1 e.g. `GET /products/2`: `59.5` → `59.95` (ex_aaaa2222)");
    expect(md).toContain(`<sub>Run saved to \`${o.run}\`</sub>`);

    const passing = { summary: { total: 1, identical: 1, different: 0, errors: 0, skipped: 0 }, latency: { original: null, candidate: null }, routes: [] };
    const okMd = formatReportMarkdown(passing, { tape: "a|b", against: url });
    expect(okMd).toContain("✅ **All 1 replayed exchanges match the tape**");
    expect(okMd).toContain("`a\\|b`");
    expect(okMd).not.toContain("<details>");
  });
});

describe("getExchanges", () => {
  it("returns recorded exchanges for routes, limited", async () => {
    const r = await getExchanges({ tape: "shop", routes: ["GET /products/:id"], limit: 1, dirs });
    expect(r.total).toBe(2);
    expect(r.exchanges.map((e) => e.request.path)).toEqual(["/products/1"]);
  });
});

describe("stateful replay", () => {
  // A todo service whose state lives in a file, so a shell command can reset it.
  let todos: http.Server;
  let todosUrl: string;
  let stateFile: string;
  beforeEach(async () => {
    stateFile = join(dir, "todos.json");
    await writeFile(stateFile, "[]");
    const { readFile } = await import("node:fs/promises");
    todos = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", async () => {
        const items = JSON.parse(await readFile(stateFile, "utf8")) as { id: number; title: string }[];
        if (req.method === "POST") {
          const item = { id: items.length + 1, title: (JSON.parse(body) as { title: string }).title };
          await writeFile(stateFile, JSON.stringify([...items, item]));
          res.writeHead(201, { "content-type": "application/json" });
          return res.end(JSON.stringify(item));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(items));
      });
    });
    await new Promise<void>((r) => todos.listen(0, "127.0.0.1", r));
    todosUrl = `http://127.0.0.1:${(todos.address() as AddressInfo).port}`;
    const post = (id: string, title: string, n: number): Exchange => ({
      ...ex(id, "POST", "/todos", { id: n, title }),
      request: { method: "POST", path: "/todos", query: "", headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: JSON.stringify({ title }) } },
      response: { status: 201, headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: JSON.stringify({ id: n, title }) } },
    });
    const recorded = [
      post("ex_w1", "milk", 1),
      post("ex_w2", "eggs", 2),
      post("ex_w3", "bread", 3),
      ex("ex_r1", "GET", "/todos", [{ id: 1, title: "milk" }, { id: 2, title: "eggs" }, { id: 3, title: "bread" }]),
    ];
    await writeFile(join(dirs.tapes, "todos.jsonl"), recorded.map(serializeExchange).join("\n") + "\n");
  });
  afterEach(async () => {
    todos.closeAllConnections();
    await new Promise((r) => todos.close(r));
  });

  it("replays writes in recorded order and resets state first", async () => {
    const notes: string[] = [];
    const reset = `node -e "require('fs').writeFileSync(process.argv[1], '[]')" ${JSON.stringify(stateFile)}`;
    const first = await runReplay({ tape: "todos", against: todosUrl, unsafe: ["POST"], reset, dirs, onNote: (m) => notes.push(m) });
    expect(first.report.summary).toMatchObject({ total: 4, identical: 4 });
    expect(notes.some((n) => n.startsWith("Resetting:"))).toBe(true);
    expect(notes.some((n) => /3 writes: sending requests one at a time/.test(n))).toBe(true);

    // Without a reset the second run sees the first run's todos: ids 4, 5, 6 and six items.
    const dirty = await runReplay({ tape: "todos", against: todosUrl, unsafe: ["POST"], dirs });
    expect(dirty.report.summary.different).toBe(4);
    const again = await runReplay({ tape: "todos", against: todosUrl, unsafe: ["POST"], reset, dirs });
    expect(again.report.summary.identical).toBe(4);
  });

  it("reads reset from the config and stops when it fails", async () => {
    const config = join(dir, "gerra.config.json");
    await writeFile(config, JSON.stringify({ reset: "echo seeding failed >&2; exit 3" }));
    await expect(runReplay({ tape: "todos", against: todosUrl, unsafe: ["POST"], config, dirs })).rejects.toThrow(/exited with code 3: .*\nseeding failed/s);
    expect(await readdirOrEmpty(dirs.runs)).toEqual([]);
  });
});

async function readdirOrEmpty(path: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  return readdir(path).catch(() => []);
}
