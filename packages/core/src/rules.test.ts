import { describe, expect, it } from "vitest";
import {
  DEFAULT_NORMALIZERS,
  noiseFromMismatches,
  normalizeRouteKey,
  normalizedBy,
  parseConfig,
  replayableRoutes,
  ruleMatches,
  rulesFor,
} from "./rules.js";

describe("normalizedBy", () => {
  it("treats ISO date-times with the same format as equal, but not a format change or date-only values", () => {
    expect(normalizedBy("body $.at", "2026-11-20T10:00:00.123Z", "2026-11-21T09:59:01.999Z")).toBe("timestamps");
    expect(normalizedBy("body $.at", "2026-11-20T10:00:00.123Z", "2026-11-20T10:00:00Z")).toBeNull();
    expect(normalizedBy("body $.at", "2026-11-20T10:00:00Z", "2026-11-20T10:00:00+00:00")).toBeNull();
    expect(normalizedBy("body $.deliveryDate", "2026-11-25", "2026-11-26")).toBeNull();
  });

  it("treats UUIDs with the same case as equal", () => {
    const a = "c7473343-f04c-444c-9205-c3be42b95b9c";
    const b = "26009104-2ed2-4d10-b4f3-bd99a5232324";
    expect(normalizedBy("body $.quoteId", a, b)).toBe("uuids");
    expect(normalizedBy("body $.quoteId", a, b.toUpperCase())).toBeNull();
    expect(normalizedBy("body $.quoteId", a, b, { uuids: false })).toBeNull();
  });

  it("only normalizes id-named fields of the same type when ids is on", () => {
    expect(DEFAULT_NORMALIZERS.ids).toBe(false);
    expect(normalizedBy("body $.orderId", 41, 42)).toBeNull();
    const ids = { ids: true };
    expect(normalizedBy("body $.orderId", 41, 42, ids)).toBe("ids");
    expect(normalizedBy("body $.items[0].id", 1, 2, ids)).toBe("ids");
    expect(normalizedBy("body $.user_id", "a", "b", ids)).toBe("ids");
    expect(normalizedBy('body $["order-ID"]', 1, 2, ids)).toBe("ids");
    expect(normalizedBy("body $.orderId", 41, "41", ids)).toBeNull();
    expect(normalizedBy("body $.paid", 1, 2, ids)).toBeNull();
    expect(normalizedBy("header x-id", "1", "2", ids)).toBeNull();
  });
});

describe("ruleMatches", () => {
  it.each([
    ["body $.quoteId", "body $.quoteId", true],
    ["$.quoteId", "body $.quoteId", true],
    ["$.quoteId", "body $.quoteIds", false],
    ["$.meta", "body $.meta.took", true],
    ["$.lines[*].note", "body $.lines[3].note", true],
    ["$.lines[0].note", "body $.lines[0].note", true],
    ["$.lines[0].note", "body $.lines[1].note", false],
    ["$..traceId", "body $.traceId", true],
    ["$..traceId", "body $.spans[2].traceId", true],
    ["$..traceId", "body $.spans[2].traceIds", false],
    ["header X-Request-Id", "header x-request-id", true],
    ["body", "body $.anything", true],
    ["body", "body (text)", true],
    ["status", "status", true],
    ["status", "header content-type", false],
  ])("%s covers %s: %s", (rule, at, expected) => {
    expect(ruleMatches(rule, at)).toBe(expected);
  });
});

describe("noiseFromMismatches", () => {
  it("groups places per route with array indices collapsed", () => {
    expect(
      noiseFromMismatches([
        { route: "POST /cart/price", at: ["body $.quoteId", "body $.lines[0].reservedAt"] },
        { route: "POST /cart/price", at: ["body $.lines[2].reservedAt"] },
        { route: "GET /health", at: [] },
      ]),
    ).toEqual({ "POST /cart/price": ["body $.lines[*].reservedAt", "body $.quoteId"] });
  });
});

describe("parseConfig", () => {
  const full = {
    $schema: "x",
    mask: { headers: ["x-api-key"], fields: ["email"] },
    compare: { headers: ["cache-control"] },
    ignore: ["header x-request-id"],
    unordered: ["$.tags"],
    normalizers: { ids: true },
    routes: {
      "post /cart/price": { ignore: ["$.validUntil"], replay: true },
      "GET /products/42": { normalizers: { timestamps: false }, unordered: ["$.related"] },
    },
  };

  it("accepts a full config and normalizes route keys", () => {
    const c = parseConfig(JSON.stringify(full));
    expect(Object.keys(c.routes ?? {})).toEqual(["POST /cart/price", "GET /products/:id"]);
    expect(replayableRoutes(c)).toEqual(["POST /cart/price"]);
  });

  it.each([
    ["{", /invalid JSON/],
    ["[]", /must be a JSON object/],
    ['{"ignor":[]}', /config\.ignor: unknown key/],
    ['{"ignore":"$.x"}', /ignore: must be an array/],
    ['{"normalizers":{"dates":true}}', /normalizers\.dates: unknown key/],
    ['{"normalizers":{"ids":"yes"}}', /normalizers\.ids: must be true or false/],
    ['{"routes":{"/cart":{}}}', /expected "<METHOD> \/path"/],
    ['{"routes":{"GET /a":{"replay":1}}}', /replay: must be true or false/],
    ['{"routes":{"GET /a/1":{},"GET /a/2":{}}}', /duplicates another entry for GET \/a\/:id/],
  ])("rejects %s", (text, error) => {
    expect(() => parseConfig(text, "my.json")).toThrow(error);
    expect(() => parseConfig(text, "my.json")).toThrow(/^my\.json: /);
  });

  it("resolves per-route rules on top of global ones, plus learned noise", () => {
    const c = parseConfig(JSON.stringify(full));
    const noise = { learnedFrom: "http://localhost:3000", learnedAt: "t", samples: 3, routes: { "POST /cart/price": ["body $.quoteId"] } };
    expect(rulesFor(c, "POST /cart/price", noise, ["X-Extra"])).toEqual({
      headers: ["content-type", "location", "cache-control", "x-extra"],
      ignore: ["header x-request-id", "$.validUntil"],
      noise: ["body $.quoteId"],
      unordered: ["$.tags"],
      normalizers: { timestamps: true, uuids: true, ids: true },
    });
    expect(rulesFor(c, "GET /products/:id").normalizers).toEqual({ timestamps: false, uuids: true, ids: true });
    expect(rulesFor({}, "GET /x")).toMatchObject({ ignore: [], noise: [], normalizers: DEFAULT_NORMALIZERS });
  });

  it("normalizes route keys like gerra tapes shows them", () => {
    expect(normalizeRouteKey("delete   /items/0123456789abcdef01234567")).toBe("DELETE /items/:id");
  });
});
