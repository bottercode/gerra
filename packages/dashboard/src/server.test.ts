import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReplay } from "@gerra/cli/api";
import { serializeExchange, type Exchange } from "@gerra/core";
import { startDashboard, type Dashboard } from "./server.js";

const ex = (id: string, path: string, body: unknown): Exchange => ({
  v: 1,
  id,
  at: "2026-11-21T10:00:00.000Z",
  request: { method: "GET", path, query: "", headers: {}, body: null },
  response: { status: 200, headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: JSON.stringify(body) } },
  latencyMs: 1,
});

let dir: string;
let candidate: http.Server;
let dash: Dashboard;
let runFile: string;
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${dash.url}${path}`, { headers });
// fetch won't let a caller set Host, so raw requests check the rebinding guard.
const rawGet = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: dash.port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on("error", reject);
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-dash-"));
  const dirs = { tapes: join(dir, "tapes"), runs: join(dir, "runs"), noise: join(dir, "noise"), shadow: join(dir, "shadow"), cutover: join(dir, "cutover") };
  await mkdir(dirs.tapes, { recursive: true });
  await writeFile(join(dirs.tapes, "shop.jsonl"), [ex("ex_1", "/a", { n: 1 }), ex("ex_2", "/b", { n: 2 })].map(serializeExchange).join("\n") + "\n");
  candidate = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ n: req.url === "/a" ? 1 : 3 }));
  });
  await new Promise<void>((r) => candidate.listen(0, "127.0.0.1", r));
  const run = await runReplay({ tape: "shop", against: `http://127.0.0.1:${(candidate.address() as AddressInfo).port}`, dirs });
  runFile = run.run.split(/[\\/]/).at(-1) as string;
  dash = await startDashboard({ port: 0, dirs });
});
afterAll(async () => {
  await dash.close();
  candidate.closeAllConnections();
  await new Promise((r) => candidate.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("dashboard API", () => {
  it("lists tapes with their runs", async () => {
    const tapes = (await (await get("/api/tapes")).json()) as { name: string; runs: { file: string; summary: { identical: number; different: number } }[] }[];
    expect(tapes).toHaveLength(1);
    expect(tapes[0]?.name).toBe("shop");
    expect(tapes[0]?.runs).toEqual([expect.objectContaining({ file: runFile, summary: expect.objectContaining({ identical: 1, different: 1 }) })]);
  });

  it("serves a run's report and one exchange in detail", async () => {
    const r = (await (await get(`/api/tapes/shop/runs/${runFile}`)).json()) as { report: { summary: { different: number } } };
    expect(r.report.summary.different).toBe(1);
    const c = (await (await get(`/api/tapes/shop/runs/${runFile}/exchanges/ex_2`)).json()) as { mismatches: { at: string }[] };
    expect(c.mismatches.map((m) => m.at)).toEqual(["body $.n"]);
  });

  it("serves the UI and refuses what it shouldn't answer", async () => {
    const page = await get("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("gerra dashboard");
    expect((await get("/app.js")).status).toBe(200);
    expect((await get("/api/tapes/nope")).status).toBe(404);
    expect((await get("/api/tapes/shop/runs/..%2F..%2Fsecret.jsonl")).status).toBe(400);
    expect((await get("/api/tapes/..%2Fx")).status).toBe(404);
    expect((await get("/%2E%2E/package.json")).status).toBe(404);
    expect((await fetch(`${dash.url}/api/tapes`, { method: "POST" })).status).toBe(405);
    expect(await rawGet("/api/tapes", "attacker.example")).toBe(403);
    expect(await rawGet("/api/tapes", `localhost:${dash.port}`)).toBe(200);
    expect(await (await get("/api/live")).json()).toEqual([]);
  });
});
