import { describe, expect, it } from "vitest";
import { canonicalJson, diffJson } from "./diff.js";

describe("diffJson", () => {
  it("returns nothing for identical values, ignoring key order", () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  });

  it("reports changed scalars with their path", () => {
    expect(diffJson({ total: 1049.5 }, { total: 1049.49 })).toEqual([
      { path: "$.total", kind: "changed", original: 1049.5, candidate: 1049.49 },
    ]);
  });

  it("reports missing and added keys", () => {
    const d = diffJson({ a: 1, gone: true }, { a: 1, extra: "x" });
    expect(d).toEqual([
      { path: "$.extra", kind: "added", original: undefined, candidate: "x" },
      { path: "$.gone", kind: "missing", original: true, candidate: undefined },
    ]);
  });

  it("reports type mismatches without descending", () => {
    expect(diffJson({ discount: null }, { discount: 0 })).toEqual([
      { path: "$.discount", kind: "type", original: null, candidate: 0 },
    ]);
  });

  it("treats array order as significant and reports length differences", () => {
    expect(diffJson([1, 2, 3], [1, 3])).toEqual([
      { path: "$[1]", kind: "changed", original: 2, candidate: 3 },
      { path: "$[2]", kind: "missing", original: 3, candidate: undefined },
    ]);
  });

  it("skips ignored paths", () => {
    const ignorePaths = new Set(["$.generatedAt", "$.items[0].id"]);
    const a = { generatedAt: "2026-11-20T10:00:00Z", items: [{ id: "x1", qty: 2 }] };
    const b = { generatedAt: "2026-11-20T10:00:05Z", items: [{ id: "y9", qty: 2 }] };
    expect(diffJson(a, b, { ignorePaths })).toEqual([]);
  });

  it("quotes keys that are not identifiers", () => {
    expect(diffJson({ "content-type": "a" }, { "content-type": "b" })[0]?.path).toBe('$["content-type"]');
  });

  it("treats a masked original value as matching anything, including a missing key", () => {
    const a = { email: "[gerra:masked]", user: { token: "[gerra:masked]" }, plan: "pro" };
    const b = { email: "ada@example.com", user: {}, plan: "free" };
    expect(diffJson(a, b, { maskedValue: "[gerra:masked]" })).toEqual([
      { path: "$.plan", kind: "changed", original: "pro", candidate: "free" },
    ]);
  });

  it("compares arrays at unordered paths regardless of order", () => {
    const a = { tags: ["b", "a"], orders: [{ items: [{ id: 2 }, { id: 1 }] }] };
    const b = { tags: ["a", "b"], orders: [{ items: [{ id: 1 }, { id: 2 }] }] };
    const unorderedPaths = new Set(["$.tags", "$.orders[*].items"]);
    expect(diffJson(a, b, { unorderedPaths })).toEqual([]);
    expect(diffJson(a, b)).toHaveLength(4);
    // Still reports real differences after sorting.
    expect(diffJson({ tags: ["a", "b"] }, { tags: ["c", "a"] }, { unorderedPaths })).toEqual([
      { path: "$.tags[1]", kind: "changed", original: "b", candidate: "c" },
    ]);
  });

  it("serializes canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { y: 1, x: 2 }] } })).toBe('{"a":{"c":[2,{"x":2,"y":1}],"d":1},"b":1}');
  });
});
