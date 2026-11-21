import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { breach, startCutover, type Cutover, type CutoverOptions, type StepStats } from "./cutover.js";
import { formatCutoverState, parseDuration, parseP99, parseRate, parseSteps, readCutoverState } from "./cutover-status.js";

type Behavior = { value?: number; status?: number; delayMs?: number };

async function service(name: string, behavior: Behavior = {}) {
  const hits: { method?: string; url?: string }[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url });
      const reply = () => {
        res.writeHead(behavior.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: behavior.value ?? 1, served: name }));
      };
      if (behavior.delayMs) setTimeout(reply, behavior.delayMs);
      else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let dir: string;
let servers: http.Server[] = [];
let co: Cutover | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-cutover-"));
});
afterEach(async () => {
  await co?.close(500);
  co = undefined;
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

// `served` differs on purpose (it says which service answered), so it's ignored in every test.
const rules = { rulesFor: () => ({ ignore: ["$.served"] }) };

async function setup(candidate: Behavior | null, opts: Partial<CutoverOptions> = {}) {
  const p = await service("primary");
  const c = candidate ? await service("candidate", candidate) : null;
  servers = [p.server, ...(c ? [c.server] : [])];
  co = await startCutover({
    primary: p.url,
    candidate: c?.url ?? "http://127.0.0.1:1",
    port: 0,
    dir: join(dir, "default"),
    name: "default",
    holdMs: 60_000,
    tickMs: 10,
    stateIntervalMs: 20,
    thresholds: { minSamples: 5, p99: null },
    ...rules,
    ...opts,
  });
  return { p, c, co };
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const hit = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return { status: r.status, body: r.status < 500 ? ((await r.json()) as { served: string; value: number }) : null };
};

describe("startCutover", () => {
  it("routes by weight, serves users from the chosen service, and compares both ways", async () => {
    let n = 0;
    const { co, p, c } = await setup({}, { steps: [50, 100], random: () => (n++ % 2 === 0 ? 0.1 : 0.9) });
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push((await hit(`${co.url}/a`)).body?.served);
    expect(answers).toEqual(["candidate", "primary", "candidate", "primary"]);
    await until(() => co.state().step.compared === 4);
    // Each service saw its 2 user requests plus 2 comparison copies.
    expect(p.hits).toHaveLength(4);
    expect(c?.hits).toHaveLength(4);
    expect(co.state().step).toMatchObject({ servedCandidate: 2, servedPrimary: 2, compared: 4, different: 0, candidateCalls: 4, candidateErrors: 0 });
  });

  it("moves through the steps after each hold and completes at the last one", async () => {
    const { co } = await setup({}, { steps: [10, 100], holdMs: 100, random: () => 0.5 });
    for (let i = 0; i < 6; i++) await hit(`${co.url}/a`);
    await until(() => co.state().weight === 100);
    expect(co.state().step.servedCandidate).toBe(0); // fresh counters for the new step
    for (let i = 0; i < 6; i++) expect((await hit(`${co.url}/a`)).body?.served).toBe("candidate");
    await until(() => co.state().phase === "complete");
    expect(co.state().events.map((e) => [e.type, e.weight]).reverse()).toEqual([
      ["start", 10],
      ["step", 100],
      ["complete", 100],
    ]);
  });

  it("doesn't move on without enough samples, however long the hold", async () => {
    const { co } = await setup({}, { steps: [10, 100], holdMs: 30 });
    await new Promise((r) => setTimeout(r, 150));
    expect(co.state()).toMatchObject({ phase: "stepping", weight: 10 });
  });

  it("rolls back when answers differ too often, then sends everyone to the primary", async () => {
    const { co } = await setup({ value: 2 }, { steps: [50, 100], random: () => 0.9 });
    for (let i = 0; i < 5; i++) await hit(`${co.url}/a`);
    await until(() => co.state().phase === "rolled_back");
    const s = co.state();
    expect(s.weight).toBe(0);
    expect(s.rollback?.reason).toBe("diff rate 100% > 1% (5/5)");
    expect(s.rollback?.atWeight).toBe(50);
    expect(s.routes[0]?.mismatches).toEqual([{ at: "body $.value", count: 5 }]);
    expect(s.recent[0]).toMatchObject({ request: "GET /a", served: "primary" });
    // random() < weight would now pick the candidate, but after a rollback nobody gets it.
    for (let i = 0; i < 3; i++) expect((await hit(`${co.url}/a`)).body?.served).toBe("primary");
  });

  it("rolls back on candidate 5xx the primary doesn't return", async () => {
    const { co } = await setup({ status: 503 }, { steps: [100], random: () => 0 });
    const users = [];
    for (let i = 0; i < 5; i++) users.push((await hit(`${co.url}/a`)).status);
    expect(users).toEqual([503, 503, 503, 503, 503]);
    await until(() => co.state().phase === "rolled_back");
    // A 5xx counts once the primary has been asked too, so the last comparison may still be in flight.
    expect(co.state().rollback?.reason).toMatch(/^candidate error rate (80|100)% > 1% \(\d\/5\)/);
    expect((await hit(`${co.url}/a`)).status).toBe(200);
  });

  it("answers from the primary when the candidate is down for a GET, and counts it", async () => {
    const { co } = await setup(null, { steps: [100], random: () => 0 });
    const r = await hit(`${co.url}/a`);
    expect(r).toMatchObject({ status: 200, body: { served: "primary" } });
    const s = co.state();
    expect(s.step).toMatchObject({ failovers: 1, candidateErrors: 1, servedPrimary: 1 });
    expect(s.recent[0]?.error).toBe("connect ECONNREFUSED 127.0.0.1:1 (answered by primary)");
  });

  it("doesn't retry writes on the primary: a failed POST to the candidate is a 502", async () => {
    const { co, p } = await setup(null, { steps: [100], random: () => 0 });
    const r = await fetch(`${co.url}/orders`, { method: "POST", body: "{}" });
    expect(r.status).toBe(502);
    expect(p.hits).toHaveLength(0);
  });

  it("routes writes but doesn't duplicate them for comparison unless opted in", async () => {
    const { co, p, c } = await setup({}, { steps: [100], random: () => 0 });
    await fetch(`${co.url}/orders`, { method: "POST", body: "{}" }).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    expect(c?.hits.map((h) => h.method)).toEqual(["POST"]);
    expect(p.hits).toHaveLength(0);
    expect(co.state().step.compared).toBe(0);
  });

  it("rolls back when the candidate is much slower than the primary", async () => {
    // Both p99s come from requests each service served to users, so alternate between them.
    let n = 0;
    const random = () => (n++ % 2 === 0 ? 0.1 : 0.9);
    const { co } = await setup({ delayMs: 40 }, { steps: [50], random, thresholds: { minSamples: 5, p99: { ratio: 2 } } });
    for (let i = 0; i < 12; i++) await hit(`${co.url}/a`);
    await until(() => co.state().phase === "rolled_back");
    expect(co.state().rollback?.reason).toMatch(/^candidate p99 \d+\.\dms > 2× primary p99/);
  });

  it("rolls back by hand and records the final state on close", async () => {
    const { co } = await setup({}, { steps: [1, 100] });
    co.rollback("manual rollback (test)");
    expect(co.state()).toMatchObject({ phase: "rolled_back", weight: 0 });
    await co.close();
    const s = await readCutoverState(join(dir, "default"));
    expect(s).toMatchObject({ running: false, phase: "rolled_back", rollback: { reason: "manual rollback (test)", atWeight: 1 } });
    const text = formatCutoverState(s!, false);
    expect(text).toContain("ROLLED BACK at 1%: manual rollback (test)");
    expect(text).toMatch(/rollback +0% +manual rollback \(test\) \(was at 1%\)/);
    const events = (await readFile(join(dir, "default", "events.jsonl"), "utf8")).trim().split("\n");
    expect(events.map((e) => JSON.parse(e).type)).toEqual(["start", "rollback"]);
  });

  it("rejects bad steps", async () => {
    await expect(setup({}, { steps: [10, 5] })).rejects.toThrow(/ascending/);
  });
});

describe("breach", () => {
  const stats = (s: Partial<StepStats>): StepStats => ({
    servedPrimary: 0, servedCandidate: 0, failovers: 0, compared: 0, different: 0, candidateCalls: 0, candidateErrors: 0,
    p99: { primary: null, candidate: null }, ...s,
  });
  const t = { maxDiffRate: 0.01, maxErrorRate: 0.05, p99: { ms: 100 }, minSamples: 10 };
  it("waits for enough samples", () => {
    expect(breach(stats({ compared: 9, different: 9, candidateCalls: 9, candidateErrors: 9 }), t, { primary: 0, candidate: 9 })).toBeNull();
  });
  it("judges error rate, then diff rate, then p99", () => {
    expect(breach(stats({ candidateCalls: 100, candidateErrors: 6 }), t, { primary: 0, candidate: 0 })).toBe("candidate error rate 6% > 5% (6/100)");
    expect(breach(stats({ candidateCalls: 100, candidateErrors: 5, compared: 100, different: 1 }), t, { primary: 0, candidate: 0 })).toBeNull();
    expect(breach(stats({ compared: 100, different: 2 }), t, { primary: 0, candidate: 0 })).toBe("diff rate 2% > 1% (2/100)");
    expect(breach(stats({ p99: { primary: 10, candidate: 150 } }), t, { primary: 10, candidate: 10 })).toBe("candidate p99 150.0ms > 100ms");
  });
});

describe("parsers", () => {
  it("parse durations, rates, p99 limits and steps", () => {
    expect([parseDuration("90"), parseDuration("30s"), parseDuration("5m"), parseDuration("1h"), parseDuration("250ms")]).toEqual([90_000, 30_000, 300_000, 3_600_000, 250]);
    expect(() => parseDuration("soon")).toThrow(/invalid duration/);
    expect([parseRate("1%"), parseRate("0.5"), parseRate("0")]).toEqual([0.01, 0.005, 0]);
    expect(() => parseRate("150%")).toThrow(/invalid rate/);
    expect([parseP99("250ms"), parseP99("250"), parseP99("1.5x"), parseP99("off")]).toEqual([{ ms: 250 }, { ms: 250 }, { ratio: 1.5 }, null]);
    expect(() => parseP99("fast")).toThrow(/invalid --max-p99/);
    expect(parseSteps("1, 10,50%,100")).toEqual([1, 10, 50, 100]);
  });
});
