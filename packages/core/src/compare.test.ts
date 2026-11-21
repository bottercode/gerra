import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compareResponses, decodedBody, realMismatches } from "./compare.js";
import { MASK, encodeBody, type RecordedResponse } from "./tape.js";

const json = (status: number, value: unknown, headers: Record<string, string> = {}): RecordedResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: { encoding: "utf8", data: JSON.stringify(value) },
});

describe("compareResponses", () => {
  it("treats identical responses as equal even when unimportant headers differ", () => {
    const a = json(200, { total: 54.69 }, { date: "Fri", etag: 'W/"1"' });
    const b = json(200, { total: 54.69 }, { date: "Sat", etag: 'W/"2"', server: "go" });
    expect(compareResponses(a, b)).toEqual([]);
  });

  it("reports status, content-type and JSON body differences with paths", () => {
    const a = json(200, { lines: [{ total: 1 }, { total: 2 }], discount: 9.41 });
    const b: RecordedResponse = {
      ...json(201, { lines: [{ total: 1 }, { total: 3 }], discount: 9.42 }),
      headers: { "content-type": "text/json" },
    };
    expect(compareResponses(a, b)).toEqual([
      { at: "status", kind: "changed", original: 200, candidate: 201 },
      { at: "header content-type", kind: "changed", original: "application/json; charset=utf-8", candidate: "text/json" },
      { at: "body $.discount", kind: "changed", original: 9.41, candidate: 9.42 },
      { at: "body $.lines[1].total", kind: "changed", original: 2, candidate: 3 },
    ]);
  });

  it("normalizes content-type case, spacing and the redundant JSON charset", () => {
    const a = json(200, {}, { "content-type": "application/json; charset=utf-8" });
    expect(compareResponses(a, json(200, {}, { "content-type": "application/json;charset=UTF-8" }))).toEqual([]);
    expect(compareResponses(a, json(200, {}, { "content-type": "application/json" }))).toEqual([]);
    const text = (ct: string): RecordedResponse => ({ status: 200, headers: { "content-type": ct }, body: null });
    expect(compareResponses(text("text/html; charset=utf-8"), text("text/html"))).toHaveLength(1);
  });

  it("compares extra headers on request, and reports missing ones", () => {
    const a = json(200, {}, { "cache-control": "no-store" });
    const b = json(200, {});
    expect(compareResponses(a, b, { headers: ["Cache-Control"] })).toEqual([
      { at: "header cache-control", kind: "missing", original: "no-store", candidate: undefined },
    ]);
  });

  it("accepts any candidate value where the tape was masked", () => {
    const a = json(200, { email: MASK, plan: "pro" }, { "set-cookie": MASK });
    const b = json(200, { email: "ada@example.com", plan: "pro" }, { "set-cookie": "sid=1" });
    expect(compareResponses(a, b, { headers: ["content-type", "set-cookie"] })).toEqual([]);
  });

  it("reports the first differing line of text bodies", () => {
    const text = (s: string): RecordedResponse => ({ status: 200, headers: { "content-type": "text/plain" }, body: encodeBody(Buffer.from(s)) });
    expect(compareResponses(text("a\nb\nc"), text("a\nB\nc"))).toEqual([
      { at: "body (text)", kind: "changed", original: "b", candidate: "B", note: "line 2" },
    ]);
  });

  it("reports binary bodies by size and first differing byte", () => {
    const bin = (b: number[]): RecordedResponse => ({ status: 200, headers: {}, body: encodeBody(Buffer.from(b)) });
    expect(compareResponses(bin([0xff, 0, 1]), bin([0xff, 0, 2, 3]))).toEqual([
      { at: "body (bytes)", kind: "changed", original: "3 bytes", candidate: "4 bytes", note: "first difference at byte 2" },
    ]);
  });

  it("reports a change in kind of body, e.g. JSON vs empty", () => {
    const empty: RecordedResponse = { status: 200, headers: { "content-type": "application/json" }, body: null };
    expect(compareResponses(json(200, { ok: true }), empty)).toEqual([
      { at: "body", kind: "type", original: "JSON, 11 bytes", candidate: "empty" },
    ]);
  });

  it("undoes content-encoding before comparing", () => {
    const gz: RecordedResponse = {
      status: 200,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: encodeBody(gzipSync(JSON.stringify({ total: 1 }))),
    };
    expect(decodedBody(gz).bytes.toString()).toBe('{"total":1}');
    expect(compareResponses(gz, json(200, { total: 1 }, { "content-type": "application/json" }))).toEqual([]);
    expect(compareResponses(gz, json(200, { total: 2 }, { "content-type": "application/json" }))).toHaveLength(1);
  });

  it("compares only the recorded prefix when the tape body was truncated", () => {
    const a: RecordedResponse = { status: 200, headers: {}, body: { encoding: "utf8", data: "xxxx", truncated: true } };
    const ok: RecordedResponse = { status: 200, headers: {}, body: { encoding: "utf8", data: "xxxxyyyy" } };
    const bad: RecordedResponse = { status: 200, headers: {}, body: { encoding: "utf8", data: "xxzzyyyy" } };
    expect(compareResponses(a, ok)).toEqual([]);
    expect(compareResponses(a, bad)[0]?.at).toBe("body (text)");
  });

  describe("rules", () => {
    const quote = (quoteId: string, at: string, total: number, extra: Record<string, unknown> = {}) =>
      json(200, { quoteId, generatedAt: at, total, ...extra });
    const a = quote("c7473343-f04c-444c-9205-c3be42b95b9c", "2026-11-20T10:00:00.000Z", 10, { validUntil: 1, tags: ["x", "y"] });
    const b = quote("26009104-2ed2-4d10-b4f3-bd99a5232324", "2026-11-21T11:00:00.000Z", 11, { validUntil: 2, tags: ["y", "x"] });

    it("marks normalized, configured and noisy places as ignored and keeps the real ones", () => {
      const ms = compareResponses(a, b, { ignore: ["$.tags"], noise: ["body $.validUntil"] });
      expect(ms.map((m) => [m.at, m.ignored])).toEqual([
        ["body $.generatedAt", "timestamps"],
        ["body $.quoteId", "uuids"],
        ["body $.tags[0]", "config"],
        ["body $.tags[1]", "config"],
        ["body $.total", undefined],
        ["body $.validUntil", "noise"],
      ]);
      expect(realMismatches(ms).map((m) => m.at)).toEqual(["body $.total"]);
    });

    it("reports everything with normalizers off", () => {
      const ms = compareResponses(a, b, { normalizers: { timestamps: false, uuids: false } });
      expect(realMismatches(ms)).toHaveLength(6);
    });

    it("compares unordered arrays without order", () => {
      const ms = compareResponses(a, b, { unordered: ["$.tags"], noise: ["$.validUntil"] });
      expect(realMismatches(ms).map((m) => m.at)).toEqual(["body $.total"]);
    });
  });
});
