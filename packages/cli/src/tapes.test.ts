import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeExchange, type Exchange } from "gerra-core";
import { formatTapes, listTapes, tapePath } from "./tapes.js";

function ex(method: string, path: string, status: number, at: string): Exchange {
  return {
    v: 1,
    id: `ex_${method}${path}${at}`,
    at,
    request: { method, path, query: "", headers: {}, body: null },
    response: { status, headers: {}, body: null },
    latencyMs: 1,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-tapes-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("tapes", () => {
  it("returns no tapes for a missing directory", async () => {
    expect(await listTapes(join(dir, "nope"))).toEqual([]);
    expect(formatTapes([], ".gerra/tapes")).toMatch(/No tapes/);
  });

  it("lists tapes with per-route counts and formats them", async () => {
    const lines = [
      ex("GET", "/products/1", 200, "2026-11-20T10:00:00.000Z"),
      ex("GET", "/products/2", 200, "2026-11-20T10:00:01.000Z"),
      ex("GET", "/products/99", 404, "2026-11-20T10:00:02.000Z"),
      ex("POST", "/cart/price", 200, "2026-11-20T10:00:03.000Z"),
    ].map(serializeExchange);
    await writeFile(join(dir, "checkout.jsonl"), lines.join("\n") + "\n");
    await writeFile(join(dir, "empty.jsonl"), "");
    await writeFile(join(dir, "notes.txt"), "ignored");

    const tapes = await listTapes(dir);
    expect(tapes.map((t) => [t.name, t.exchanges])).toEqual([
      ["checkout", 4],
      ["empty", 0],
    ]);
    expect(tapes[0]).toMatchObject({
      firstAt: "2026-11-20T10:00:00.000Z",
      lastAt: "2026-11-20T10:00:03.000Z",
      routes: [
        { route: "GET /products/:id", count: 3, statuses: { "200": 2, "404": 1 } },
        { route: "POST /cart/price", count: 1, statuses: { "200": 1 } },
      ],
    });

    const text = formatTapes(tapes, dir);
    expect(text).toContain("checkout  4 exchanges, 2 routes");
    expect(text).toContain("  3  GET /products/:id  200×2 404×1");
    expect(text).toContain("  1  POST /cart/price   200×1");
  });

  it("reports an unreadable tape instead of failing the whole listing", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "broken.jsonl"), '{"v":1,"id":"x"\n');
    const [t] = await listTapes(dir);
    expect(t?.error).toBeDefined();
    expect(formatTapes([t!], dir)).toMatch(/unreadable/);
  });

  it("rejects tape names that could escape the tapes directory", () => {
    expect(tapePath("d", "checkout-v2.1")).toBe(join("d", "checkout-v2.1.jsonl"));
    expect(() => tapePath("d", "../etc/passwd")).toThrow(/invalid tape name/);
    expect(() => tapePath("d", "")).toThrow(/invalid tape name/);
  });
});
