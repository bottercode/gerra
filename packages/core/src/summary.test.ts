import { describe, expect, it } from "vitest";
import { matchesRoute, routeOf, summarizeRoutes } from "./summary.js";
import type { Exchange } from "./tape.js";

function ex(method: string, path: string, status: number): Exchange {
  return {
    v: 1,
    id: `${method}${path}${status}`,
    at: "2026-11-20T10:00:00.000Z",
    request: { method, path, query: "", headers: {}, body: null },
    response: { status, headers: {}, body: null },
    latencyMs: 1,
  };
}

describe("routeOf", () => {
  it("collapses numeric, uuid and long-hex segments to :id", () => {
    expect(routeOf("get", "/products/42")).toBe("GET /products/:id");
    expect(routeOf("GET", "/orders/3f2b8c1e-9d4a-4c6b-8e2f-1a2b3c4d5e6f/items")).toBe("GET /orders/:id/items");
    expect(routeOf("GET", "/users/507f1f77bcf86cd799439011")).toBe("GET /users/:id");
  });

  it("keeps word segments and the root path", () => {
    expect(routeOf("POST", "/cart/price")).toBe("POST /cart/price");
    expect(routeOf("GET", "/v2/items")).toBe("GET /v2/items");
    expect(routeOf("GET", "/")).toBe("GET /");
  });
});

describe("summarizeRoutes", () => {
  it("counts exchanges and statuses per route, most frequent first", () => {
    const summary = summarizeRoutes([
      ex("GET", "/products/1", 200),
      ex("GET", "/products/2", 200),
      ex("GET", "/products/999", 404),
      ex("POST", "/cart/price", 200),
      ex("GET", "/health", 200),
    ]);
    expect(summary).toEqual([
      { route: "GET /products/:id", count: 3, statuses: { "200": 2, "404": 1 } },
      { route: "GET /health", count: 1, statuses: { "200": 1 } },
      { route: "POST /cart/price", count: 1, statuses: { "200": 1 } },
    ]);
  });
});

describe("matchesRoute", () => {
  it.each([
    ["POST /cart/price", "POST", "/cart/price", true],
    ["post  /cart/price", "POST", "/cart/price", true],
    ["GET /cart/price", "POST", "/cart/price", false],
    ["/cart/price", "POST", "/cart/price", true],
    ["GET /products/:id", "GET", "/products/42", true],
    ["GET /products/7", "GET", "/products/42", true],
    ["GET /products", "GET", "/products/42", false],
    ["GET /products/:id", "GET", "/products/42/reviews", false],
    ["GET", "GET", "/", false],
  ])("%s ~ %s %s → %s", (filter, method, path, expected) => {
    expect(matchesRoute(filter, method, path)).toBe(expected);
  });
});
