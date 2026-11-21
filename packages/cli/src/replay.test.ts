import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASK, RUN_VERSION, buildReport, type Exchange } from "@gerra/core";
import { isUnsafeAllowed, looksLocal, replayTape } from "./replay.js";
import { exitCodeFor, formatReport } from "./report.js";
import { latestRunPath, loadRun, saveRun } from "./runs.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

function serve(handler: Handler): Promise<{ server: http.Server; url: string; seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] }> {
  const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, body, res);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })),
  );
}

function ex(id: string, method: string, path: string, response: unknown, extra: Partial<Exchange["request"]> = {}, status = 200): Exchange {
  return {
    v: 1,
    id,
    at: "2026-11-20T10:00:00.000Z",
    request: { method, path, query: "", headers: { accept: "*/*", host: "localhost:8080" }, body: null, ...extra },
    response: { status, headers: { "content-type": "application/json; charset=utf-8" }, body: { encoding: "utf8", data: JSON.stringify(response) } },
    latencyMs: 5,
  };
}

// A "rewrite" that is mostly right: one rounding difference, gzip on one route, and a slow endpoint.
const candidateHandler: Handler = (req, body, res) => {
  const json = (status: number, v: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(v));
  };
  if (req.url === "/products/1") return json(200, { id: 1, price: 24.99 });
  if (req.url === "/products?category=coffee") {
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    return res.end(gzipSync(JSON.stringify([{ id: 1 }, { id: 4 }])));
  }
  if (req.url === "/cart/price") return json(200, { total: JSON.parse(body).qty * 9.42 });
  if (req.url === "/me") return req.headers.authorization === "Bearer test" ? json(200, { id: 42, email: "ada@example.com" }) : json(401, { error: "no" });
  if (req.url === "/slow") return setTimeout(() => json(200, {}), 500);
  json(404, { error: "not found" });
};

let candidate: Awaited<ReturnType<typeof serve>>;
let dir: string;

beforeEach(async () => {
  candidate = await serve(candidateHandler);
  dir = await mkdtemp(join(tmpdir(), "gerra-replay-"));
});

afterEach(async () => {
  candidate.server.closeAllConnections();
  await new Promise((r) => candidate.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const tape: Exchange[] = [
  ex("ex_p1", "GET", "/products/1", { id: 1, price: 24.99 }),
  ex("ex_list", "GET", "/products", [{ id: 1 }, { id: 4 }], { query: "category=coffee" }),
  ex("ex_cart", "POST", "/cart/price", { total: 9.41 }, { body: { encoding: "utf8", data: '{"qty":1}' }, headers: { "content-type": "application/json" } }),
  ex("ex_me", "GET", "/me", { id: 42, email: MASK }, { headers: { authorization: MASK } }),
];

describe("replayTape", () => {
  it("replays safe requests, skips unsafe ones, and finds real differences", async () => {
    const { results, droppedMaskedHeaders } = await replayTape({ against: candidate.url, exchanges: tape });
    expect(results.map((r) => [r.id, r.outcome])).toEqual([
      ["ex_p1", "replayed"],
      ["ex_list", "replayed"],
      ["ex_cart", "skipped"],
      ["ex_me", "replayed"],
    ]);
    // The masked authorization header is not sent as "[gerra:masked]".
    expect(droppedMaskedHeaders).toEqual(["authorization"]);
    expect(candidate.seen.find((s) => s.url === "/me")?.headers.authorization).toBeUndefined();
    // Host is the candidate's, not the recorded one.
    expect(candidate.seen[0]?.headers.host).toBe(new URL(candidate.url).host);

    const report = buildReport(tape, results);
    expect(report.summary).toEqual({ total: 4, identical: 2, different: 1, errors: 0, skipped: 1 });
    const me = report.routes.find((r) => r.route === "GET /me");
    expect(me?.mismatches.map((m) => [m.at, m.samples[0]?.note])).toEqual([["status", "+2 other differences in this response"]]);
    expect(exitCodeFor(report)).toBe(1);
  });

  it("sends opted-in unsafe requests with their body, and header overrides", async () => {
    const { results } = await replayTape({
      against: candidate.url,
      exchanges: tape,
      unsafe: ["post /cart/price"],
      setHeaders: { authorization: "Bearer test" },
    });
    const cart = candidate.seen.find((s) => s.url === "/cart/price");
    expect(cart?.method).toBe("POST");
    expect(cart?.body).toBe('{"qty":1}');
    expect(cart?.headers["content-length"]).toBe("9");

    const report = buildReport(tape, results);
    expect(report.summary).toEqual({ total: 4, identical: 3, different: 1, errors: 0, skipped: 0 });
    const groups = report.routes[0]?.mismatches;
    expect(report.routes[0]?.route).toBe("POST /cart/price");
    expect(groups?.[0]?.samples[0]).toMatchObject({ original: 9.41, candidate: 9.42, requestBody: '{"qty":1}' });

    const text = formatReport(report, { tape: "checkout", against: candidate.url });
    expect(text).toContain("✗ POST /cart/price  (1 different)");
    expect(text).toContain("body $.total  ×1");
    expect(text).toContain("e.g. POST /cart/price: 9.41 → 9.42   [ex_cart]");
    expect(text).toContain("✓ GET /me  (1 identical)");
    expect(text).toContain("✗ Not equivalent: 1 different, 0 errors out of 4 replayed.");
  });

  it("reports timeouts and unreachable targets as errors, keeping tape order under concurrency", async () => {
    const slow = [ex("ex_slow", "GET", "/slow", {}), ex("ex_fast", "GET", "/products/1", { id: 1, price: 24.99 })];
    const { results } = await replayTape({ against: candidate.url, exchanges: slow, timeoutMs: 100, concurrency: 2 });
    expect(results.map((r) => r.id)).toEqual(["ex_slow", "ex_fast"]);
    expect(results[0]).toMatchObject({ outcome: "error", error: "timed out after 100ms" });
    expect(results[1]?.outcome).toBe("replayed");

    const down = await replayTape({ against: "http://127.0.0.1:1", exchanges: slow });
    expect(down.results.map((r) => (r.outcome === "error" ? r.error : r.outcome))).toEqual(["connection refused", "connection refused"]);
    expect(exitCodeFor(buildReport(slow, down.results))).toBe(1);
  });

  it("passes when everything matches, and fails when nothing was compared", async () => {
    const ok = await replayTape({ against: candidate.url, exchanges: tape.slice(0, 2) });
    const report = buildReport(tape, ok.results);
    expect(exitCodeFor(report)).toBe(0);
    expect(formatReport(report, { tape: "t", against: candidate.url })).toContain("✓ All 2 replayed exchanges match the tape.");

    const none = await replayTape({ against: candidate.url, exchanges: [tape[2] as Exchange] });
    expect(exitCodeFor(buildReport(tape, none.results))).toBe(1);
  });

  it("honors a path prefix on the target", async () => {
    await replayTape({ against: `${candidate.url}/v2/`, exchanges: [tape[0] as Exchange] });
    expect(candidate.seen[0]?.url).toBe("/v2/products/1");
  });
});

describe("isUnsafeAllowed", () => {
  const post = ex("e", "POST", "/items/42", {});
  it.each([
    [[], false],
    [["*"], true],
    [["post"], true],
    [["PUT"], false],
    [["POST /items/:id"], true],
    [["POST  /items/42"], true],
    [["POST /items"], false],
  ])("%j → %s", (rules, allowed) => {
    expect(isUnsafeAllowed(post, rules)).toBe(allowed);
  });
  it("always allows safe methods", () => {
    expect(isUnsafeAllowed(ex("e", "HEAD", "/", {}), [])).toBe(true);
  });
});

describe("looksLocal", () => {
  it.each(["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.9", "[::1]", "candidate", "api.internal", "svc.test"])(
    "%s is local",
    (h) => expect(looksLocal(h)).toBe(true),
  );
  it.each(["api.example.com", "8.8.8.8", "172.32.0.1", "2001:db8::1"])("%s is not", (h) => expect(looksLocal(h)).toBe(false));
});

describe("runs", () => {
  it("saves runs and finds the latest one", async () => {
    const runs = join(dir, "runs");
    expect(await latestRunPath(runs, "checkout")).toBeNull();
    const header = { v: RUN_VERSION, type: "run", tape: "checkout", against: "http://x" } as const;
    await saveRun(runs, { header: { ...header, startedAt: "2026-11-20T10:00:00.000Z" }, results: [] });
    const second = await saveRun(runs, {
      header: { ...header, startedAt: "2026-11-21T09:00:00.000Z" },
      results: [{ v: RUN_VERSION, type: "result", id: "a", outcome: "skipped", reason: "r" }],
    });
    expect(second).toBe(join(runs, "checkout", "2026-11-21T09-00-00.000Z.jsonl"));
    expect(await latestRunPath(runs, "checkout")).toBe(second);
    expect((await loadRun(second)).results).toHaveLength(1);
  });
});
