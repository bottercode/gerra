import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startShadow, type Shadow, type ShadowOptions } from "./shadow.js";
import { formatShadowState, isAlive, readShadowState } from "./shadow-status.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

async function serve(handler: Handler) {
  const seen: { method?: string; url?: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (res: http.ServerResponse, v: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(v));
};

// Primary and candidate agree except on /price (a rounding bug) and /me's email (masked, so never compared).
const primaryHandler: Handler = (req, body, res) => {
  if (req.url === "/price") return json(res, { total: 9.41, at: new Date().toISOString() });
  if (req.url === "/me") return json(res, { email: "ada@example.com", plan: "pro" });
  if (req.url === "/orders") return json(res, { created: JSON.parse(body || "{}") }, 201);
  json(res, { ok: true });
};
const candidateHandler = (delayMs = 0): Handler => (req, body, res) => {
  const reply = () => {
    if (req.url === "/price") return json(res, { total: 9.42, at: new Date(Date.now() + 5).toISOString() });
    if (req.url === "/me") return json(res, { email: "someone@else.com", plan: "pro" });
    if (req.url === "/orders") return json(res, { created: JSON.parse(body || "{}") }, 201);
    json(res, { ok: true });
  };
  if (delayMs) setTimeout(reply, delayMs);
  else reply();
};

let dir: string;
let servers: http.Server[] = [];
let shadow: Shadow | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-shadow-"));
});
afterEach(async () => {
  await shadow?.close(500);
  shadow = undefined;
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

async function setup(candidate: Handler | null, opts: Partial<ShadowOptions> = {}) {
  const p = await serve(primaryHandler);
  const c = candidate ? await serve(candidate) : null;
  servers = [p.server, ...(c ? [c.server] : [])];
  shadow = await startShadow({
    primary: p.url,
    candidate: c?.url ?? "http://127.0.0.1:1",
    port: 0,
    dir: join(dir, "default"),
    name: "default",
    stateIntervalMs: 20,
    ...opts,
  });
  return { p, c, sh: shadow };
}

const until = async (check: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("startShadow", () => {
  it("serves the primary's answer, mirrors to the candidate and counts differences", async () => {
    const { sh, c } = await setup(candidateHandler());
    const res = await fetch(`${sh.url}/price`);
    expect((await res.json()).total).toBe(9.41);
    await fetch(`${sh.url}/health`);
    await until(() => sh.state().counts.compared === 2);

    expect(c?.seen.map((s) => s.url)).toEqual(["/price", "/health"]);
    const s = sh.state();
    expect(s.counts).toEqual({ requests: 2, compared: 2, identical: 1, different: 1, candidateErrors: 0, skipped: 0, dropped: 0 });
    const price = s.routes[0];
    expect(price?.route).toBe("GET /price");
    expect(price?.mismatches).toEqual([{ at: "body $.total", count: 1 }]);
    expect(price?.ignored).toEqual([{ at: "body $.at", reason: "timestamps", count: 1 }]);
    expect(s.recent[0]?.mismatches?.[0]).toMatchObject({ at: "body $.total", original: 9.41, candidate: 9.42 });
  });

  it("never makes users wait for a slow candidate", async () => {
    const { sh } = await setup(candidateHandler(800), { timeoutMs: 2000 });
    const started = Date.now();
    const res = await fetch(`${sh.url}/price`);
    await res.json();
    expect(Date.now() - started).toBeLessThan(300);
    expect(sh.state().counts.compared).toBe(0);
    await until(() => sh.state().counts.compared === 1);
  });

  it("counts candidate errors without affecting users", async () => {
    const { sh } = await setup(null);
    const res = await fetch(`${sh.url}/health`);
    expect(await res.json()).toEqual({ ok: true });
    await until(() => sh.state().counts.candidateErrors === 1);
    expect(sh.state().routes[0]?.errors).toEqual([{ message: "connection refused", count: 1 }]);
    expect(sh.state().recent[0]?.error).toBe("connection refused");
  });

  it("drops mirrors beyond --max-inflight instead of queueing", async () => {
    const { sh } = await setup(candidateHandler(300), { maxInFlight: 1 });
    await Promise.all([1, 2, 3].map(() => fetch(`${sh.url}/health`).then((r) => r.json())));
    const c = sh.state().counts;
    expect(c.requests).toBe(3);
    expect(c.dropped).toBe(2);
    await until(() => sh.state().counts.compared === 1);
  });

  it("only mirrors non-idempotent requests when opted in, with their body", async () => {
    const first = await setup(candidateHandler());
    await fetch(`${first.sh.url}/orders`, { method: "POST", body: '{"qty":1}', headers: { "content-type": "application/json" } });
    await until(() => first.sh.state().counts.skipped === 1);
    expect(first.c?.seen).toEqual([]);
    expect(first.sh.state().routes[0]?.skipReasons).toEqual({ "POST not mirrored without --unsafe-methods": 1 });
    await first.sh.close();
    for (const s of servers) s.closeAllConnections();

    const second = await setup(candidateHandler(), { unsafe: ["POST /orders"] });
    await fetch(`${second.sh.url}/orders`, { method: "POST", body: '{"qty":1}', headers: { "content-type": "application/json" } });
    await until(() => second.sh.state().counts.identical === 1);
    expect(second.c?.seen[0]).toMatchObject({ method: "POST", body: '{"qty":1}' });
  });

  it("sends real credentials to the candidate but masks everything it writes or compares", async () => {
    const { sh, c } = await setup(candidateHandler(), { maskFields: ["email"] });
    await fetch(`${sh.url}/me`, { headers: { authorization: "Bearer real-token" } });
    await fetch(`${sh.url}/price`, { headers: { authorization: "Bearer real-token" } });
    await until(() => sh.state().counts.compared === 2);
    expect(c?.seen[0]?.headers.authorization).toBe("Bearer real-token");
    // The email differs but is masked, so /me is identical.
    expect(sh.state().routes.find((r) => r.route === "GET /me")?.identical).toBe(1);
    await sh.close();
    const log = await readFile(join(dir, "default", "diffs.jsonl"), "utf8");
    expect(log.split("\n").filter(Boolean)).toHaveLength(1);
    expect(log).toContain("[gerra:masked]");
    expect(log).not.toContain("real-token");
    expect(log).not.toContain("ada@example.com");
  });

  it("applies compare rules per route", async () => {
    const { sh } = await setup(candidateHandler(), { rulesFor: (route) => (route === "GET /price" ? { noise: ["$.total"] } : {}) });
    await fetch(`${sh.url}/price`);
    await until(() => sh.state().counts.compared === 1);
    expect(sh.state().counts.identical).toBe(1);
    expect(sh.state().routes[0]?.ignored.map((i) => i.reason).sort()).toEqual(["noise", "timestamps"]);
  });

  it("finishes candidate calls on close and writes a final stopped state", async () => {
    const { sh } = await setup(candidateHandler(200));
    await fetch(`${sh.url}/price`).then((r) => r.json());
    await sh.close(2000);
    const state = await readShadowState(join(dir, "default"));
    expect(state?.running).toBe(false);
    expect(state?.counts.different).toBe(1);
    expect(state?.pid).toBe(process.pid);
  });

  it("rotates the diff log", async () => {
    const { sh } = await setup(candidateHandler(), { maxLogBytes: 200 });
    for (let i = 0; i < 3; i++) await fetch(`${sh.url}/price`).then((r) => r.json());
    await until(() => sh.state().counts.different === 3);
    await sh.close();
    expect((await readdir(join(dir, "default"))).sort()).toEqual(["diffs.1.jsonl", "diffs.jsonl", "state.json"]);
  });
});

describe("shadow status", () => {
  it("formats a stopped shadow and detects dead processes", async () => {
    const { sh } = await setup(candidateHandler());
    await fetch(`${sh.url}/price`).then((r) => r.json());
    await until(() => sh.state().counts.compared === 1);
    const text = formatShadowState(sh.state(), true);
    expect(text).toMatch(/^shadow "default": running \(pid \d+\)/);
    expect(text).toContain("1 requests: 1 compared, 0 identical, 1 different (100%), 0 candidate errors, 0 skipped, 0 dropped");
    expect(text).toContain("  ✗ GET /price  (1 compared, 1 different (100%))");
    expect(text).toContain("      body $.total  ×1");
    expect(text).toMatch(/GET \/price {2}body \$\.total: 9\.41 → 9\.42 {3}\[ex_/);
    expect(formatShadowState({ ...sh.state(), running: true }, false)).toContain("not running (process exited without stopping cleanly)");
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
    expect(await readShadowState(join(dir, "nope"))).toBeNull();
  });
});
