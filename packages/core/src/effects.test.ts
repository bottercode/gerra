import { describe, expect, it } from "vitest";
import { compareResponses, realMismatches } from "./compare.js";
import { EFFECTS_HEADER, decodeEffects, encodeEffects, takeEffects, type Effect } from "./effects.js";
import type { RecordedResponse } from "./tape.js";

const hook: Effect = { type: "http", method: "POST", url: "http://hooks.test/done", body: { id: 3, event: "todo.completed" }, status: 204 };
const query: Effect = { type: "query", db: "sqlite", query: "update todos set done = 1 where id = ?", params: [3] };
const res = (effects?: Effect[]): RecordedResponse => ({
  status: 200,
  headers: { "content-type": "application/json" },
  body: { encoding: "utf8", data: '{"ok":true}' },
  ...(effects ? { effects } : {}),
});

describe("effects header", () => {
  it("round-trips and rejects anything that isn't a list of typed effects", () => {
    expect(decodeEffects(encodeEffects([hook, query]))).toEqual([hook, query]);
    expect(decodeEffects(encodeEffects([]))).toEqual([]);
    expect(decodeEffects(undefined)).toBeNull();
    expect(decodeEffects("not base64 json")).toBeNull();
    expect(decodeEffects(Buffer.from('[{"no":"type"}]').toString("base64url"))).toBeNull();
    expect(decodeEffects(Buffer.from('{"type":"x"}').toString("base64url"))).toBeNull();
  });

  it("takes the header out of a response's headers", () => {
    const headers: Record<string, string> = { "content-type": "text/plain", "X-Gerra-Effects": encodeEffects([hook]) };
    expect(takeEffects(headers)).toEqual([hook]);
    expect(headers).toEqual({ "content-type": "text/plain" });
    expect(takeEffects(headers)).toBeNull();
    expect(EFFECTS_HEADER).toBe("x-gerra-effects");
  });
});

describe("comparing effects", () => {
  it("only compares when both sides reported effects", () => {
    expect(compareResponses(res([hook]), res())).toEqual([]);
    expect(compareResponses(res(), res([hook]))).toEqual([]);
  });

  it("ignores order but reports a missing call and a changed payload", () => {
    expect(compareResponses(res([hook, query]), res([query, hook]))).toEqual([]);
    const missing = realMismatches(compareResponses(res([hook, query]), res([query])));
    expect(missing.map((m) => m.at)).toContain("effects $[1]");
    const changed = realMismatches(compareResponses(res([hook]), res([{ ...hook, body: { id: 3, event: "todo.done" } }])));
    expect(changed).toEqual([{ at: "effects $[0].body.event", kind: "changed", original: "todo.completed", candidate: "todo.done" }]);
  });

  it("applies ignore rules and normalizers to effects", () => {
    const a = res([{ type: "http", method: "POST", url: "http://x.test", body: { at: "2026-11-21T10:00:00.000Z", traceId: "a" } }]);
    const b = res([{ type: "http", method: "POST", url: "http://x.test", body: { at: "2026-11-22T11:30:00.000Z", traceId: "b" } }]);
    const all = compareResponses(a, b, { ignore: ["effects $[*].body.traceId"] });
    expect(realMismatches(all)).toEqual([]);
    expect(all.map((m) => [m.at, m.ignored])).toEqual([
      ["effects $[0].body.at", "timestamps"],
      ["effects $[0].body.traceId", "config"],
    ]);
  });
});
