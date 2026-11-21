import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { groupKey } from "./diff.js";
import { buildReport, parseRun, serializeRun, type ReplayResult } from "./report.js";
import { parseTape } from "./tape.js";

// A recorded checkout tape and a replay of it against an imperfect rewrite.
const tape = parseTape(readFileSync(new URL("./fixtures/checkout.jsonl", import.meta.url), "utf8"));
const run = parseRun(readFileSync(new URL("./fixtures/checkout-run.jsonl", import.meta.url), "utf8"));

describe("run files", () => {
  it("round-trip and validate the header", () => {
    expect(parseRun(serializeRun(run))).toEqual(run);
    expect(() => parseRun('{"v":1,"type":"result"}')).toThrow(/no header/);
    expect(() => parseRun('{"v":7,"type":"run"}')).toThrow(/unsupported version/);
  });
});

describe("groupKey", () => {
  it("collapses array indices", () => {
    expect(groupKey("body $.lines[3].items[0].total")).toBe("body $.lines[*].items[*].total");
  });
});

describe("buildReport", () => {
  const report = buildReport(tape, run.results);

  it("counts outcomes", () => {
    expect(report.summary).toEqual({ total: 6, identical: 2, different: 2, errors: 1, skipped: 1 });
  });

  it("lists routes with problems first and groups differences by place", () => {
    expect(report.routes.map((r) => [r.route, r.identical, r.different, r.errors, r.skipped])).toEqual([
      ["GET /products/:id", 1, 1, 0, 0],
      ["GET /me", 0, 0, 1, 0],
      ["GET /products", 0, 1, 0, 0],
      ["GET /health", 1, 0, 0, 0],
      ["POST /cart/price", 0, 0, 0, 1],
    ]);
    const products = report.routes.find((r) => r.route === "GET /products");
    expect(products?.mismatches).toEqual([
      {
        at: "body $[*].price",
        count: 1,
        samples: [{ exchangeId: "ex_list", request: "GET /products?category=coffee", at: "body $[1].price", kind: "changed", original: 13.45, candidate: 13.5 }],
      },
    ]);
    const byId = report.routes.find((r) => r.route === "GET /products/:id");
    // The 404 → 400 change also changed the body; that's reported as part of the status difference.
    expect(byId?.mismatches).toEqual([
      {
        at: "status",
        count: 1,
        samples: [{ exchangeId: "ex_p99", request: "GET /products/99", kind: "changed", original: 404, candidate: 400, note: "+1 other difference in this response" }],
      },
    ]);
  });

  it("keeps errors and skip reasons per route", () => {
    const me = report.routes.find((r) => r.route === "GET /me");
    expect(me?.errorGroups).toEqual([{ message: "timed out after 5000ms", count: 1, samples: [{ exchangeId: "ex_me", request: "GET /me" }] }]);
    const cart = report.routes.find((r) => r.route === "POST /cart/price");
    expect(cart?.skipReasons).toEqual({ "unsafe method": 1 });
  });

  it("reports latency percentiles over replayed exchanges only", () => {
    expect(report.latency.original).toEqual({ count: 4, p50: 2, p95: 10 });
    expect(report.latency.candidate).toEqual({ count: 4, p50: 0.5, p95: 1 });
  });

  it("caps samples and ignores results for unknown exchanges", () => {
    const many: ReplayResult[] = [...run.results, { v: 1, type: "result", id: "nope", outcome: "skipped", reason: "x" }];
    const r = buildReport(tape, many, { samples: 0 });
    expect(r.summary.total).toBe(6);
    expect(r.routes.every((route) => route.mismatches.every((g) => g.samples.length === 0))).toBe(true);
  });

  it("applies per-route rules and lists what was ignored", () => {
    const r = buildReport(tape, run.results, {
      rulesFor: (route) => (route === "GET /products" ? { ignore: ["$[*].price"] } : {}),
    });
    const products = r.routes.find((x) => x.route === "GET /products");
    expect([products?.identical, products?.different]).toEqual([1, 0]);
    expect(products?.ignored).toEqual([{ at: "body $[*].price", reason: "config", count: 1 }]);
    expect(r.summary.different).toBe(1);
  });
});
