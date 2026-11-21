import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildReport, learnNoise, rulesFor, type Exchange } from "gerra-core";
import { loadConfig } from "./config.js";
import { loadNoise, noisePath, saveNoise } from "./noise.js";
import { replayTape } from "./replay.js";
import { formatReport } from "./report.js";

// The "original": every quote has a fresh epoch-ms validUntil (noise no normalizer knows) and a fresh UUID.
// `rewrite` is a candidate that gets the total wrong.
function quoteServer(total: number): Promise<{ server: http.Server; url: string; hits: () => number }> {
  let hits = 0;
  let tick = 0;
  const server = http.createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ quoteId: crypto.randomUUID(), validUntil: 1_800_000_000_000 + ++tick, total, tags: ["b", "a"] }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits })),
  );
}

const recorded: Exchange = {
  v: 1,
  id: "ex_q",
  at: "2026-11-20T10:00:00.000Z",
  request: { method: "GET", path: "/quote", query: "", headers: {}, body: null },
  response: {
    status: 200,
    headers: { "content-type": "application/json" },
    body: { encoding: "utf8", data: JSON.stringify({ quoteId: "c7473343-f04c-444c-9205-c3be42b95b9c", validUntil: 1_700_000_000_000, total: 10, tags: ["a", "b"] }) },
  },
  latencyMs: 1,
};

let servers: http.Server[] = [];
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-noise-"));
});
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

describe("noise learning", () => {
  it("learns what changes between two runs of the original and ignores it for the candidate", async () => {
    const original = await quoteServer(10);
    const good = await quoteServer(10);
    const bad = await quoteServer(11);
    servers = [original.server, good.server, bad.server];

    // Without noise, the epoch timestamp is reported (the UUID is handled by a normalizer).
    const plain = await replayTape({ against: good.url, exchanges: [recorded] });
    expect(plain.originalPairs).toEqual([]);
    const before = buildReport([recorded], plain.results);
    expect(before.routes[0]?.mismatches.map((m) => m.at)).toEqual(["body $.tags[*]", "body $.validUntil"]);

    const learned = await replayTape({ against: good.url, original: original.url, exchanges: [recorded] });
    expect(original.hits()).toBe(2);
    const noise = learnNoise([recorded], learned.originalPairs, { learnedFrom: original.url, learnedAt: "t" });
    // Normalizers are off while learning, so the UUID is learned too.
    expect(noise).toEqual({ learnedFrom: original.url, learnedAt: "t", samples: 1, routes: { "GET /quote": ["body $.quoteId", "body $.validUntil"] } });

    // Tag order is still reported until configured as unordered; then the good candidate is clean.
    const config = { routes: { "GET /quote": { unordered: ["$.tags"] } } };
    const ok = buildReport([recorded], learned.results, { rulesFor: (route) => rulesFor(config, route, noise) });
    expect(ok.summary.identical).toBe(1);
    expect(ok.routes[0]?.ignored).toEqual([
      { at: "body $.quoteId", reason: "noise", count: 1 },
      { at: "body $.validUntil", reason: "noise", count: 1 },
    ]);
    const text = formatReport(ok, { tape: "t", against: good.url, noise, config: "gerra.config.json" });
    expect(text).toContain(`  noise    2 places learned from ${original.url} at t`);
    expect(text).toContain("  config   gerra.config.json");
    expect(text).toContain("    ignored: body $.quoteId ×1 (noise), body $.validUntil ×1 (noise)");

    // A real difference still shows.
    const wrong = await replayTape({ against: bad.url, exchanges: [recorded] });
    const r = buildReport([recorded], wrong.results, { rulesFor: (route) => rulesFor(config, route, noise) });
    expect(r.routes[0]?.mismatches.map((m) => m.at)).toEqual(["body $.total"]);
  });

  it("counts failed original requests and doesn't learn from them", async () => {
    const good = await quoteServer(10);
    servers = [good.server];
    const r = await replayTape({ against: good.url, original: "http://127.0.0.1:1", exchanges: [recorded] });
    expect(r.originalPairs).toEqual([]);
    expect(r.originalErrors).toBe(1);
    expect(r.results[0]?.outcome).toBe("replayed");
  });
});

describe("noise store", () => {
  it("saves and loads per tape", async () => {
    const noiseDir = join(dir, "noise");
    expect(await loadNoise(noiseDir, "checkout")).toBeNull();
    const profile = { learnedFrom: "http://x", learnedAt: "t", samples: 1, routes: { "GET /a": ["body $.b"] } };
    expect(await saveNoise(noiseDir, "checkout", profile)).toBe(noisePath(noiseDir, "checkout"));
    expect(await loadNoise(noiseDir, "checkout")).toEqual(profile);
    expect(() => noisePath(noiseDir, "../x")).toThrow(/invalid tape name/);
  });
});

describe("loadConfig", () => {
  it("is optional by default but required when given explicitly", async () => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await loadConfig()).toEqual({ config: {}, path: null });
      await expect(loadConfig("nope.json")).rejects.toThrow(/config file not found: nope\.json/);
      await writeFile("gerra.config.json", '{"ignore":["$.x"],"bogus":1}');
      await expect(loadConfig()).rejects.toThrow(/gerra\.config\.json: config\.bogus: unknown key/);
      await writeFile("gerra.config.json", '{"mask":{"fields":["email"]}}');
      expect(await loadConfig()).toEqual({ config: { mask: { fields: ["email"] } }, path: "gerra.config.json" });
    } finally {
      process.chdir(cwd);
    }
  });
});
