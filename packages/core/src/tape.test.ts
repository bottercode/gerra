import { describe, expect, it } from "vitest";
import { MASK, decodeBody, encodeBody, maskBodyFields, maskHeaders, maskJsonFields, parseTape, serializeExchange, type Exchange } from "./tape.js";

const sample: Exchange = {
  v: 1,
  id: "ex_1",
  at: "2026-11-20T10:00:00.000Z",
  request: { method: "POST", path: "/cart/price", query: "", headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: '{"qty":2}' } },
  response: { status: 200, headers: {}, body: { encoding: "utf8", data: '{"total":100}' } },
  latencyMs: 12,
};

describe("tape", () => {
  it("round-trips exchanges through JSONL", () => {
    const tape = [sample, { ...sample, id: "ex_2" }].map(serializeExchange).join("\n") + "\n";
    expect(parseTape(tape).map((e) => e.id)).toEqual(["ex_1", "ex_2"]);
  });

  it("rejects unknown versions", () => {
    expect(() => parseTape(JSON.stringify({ ...sample, v: 99 }))).toThrow(/unsupported version/);
  });

  it("masks sensitive headers case-insensitively", () => {
    expect(maskHeaders({ Authorization: "Bearer x", accept: "*/*" })).toEqual({ Authorization: MASK, accept: "*/*" });
  });

  it("stores text as utf8 and binary as base64, losslessly", () => {
    const text = Buffer.from("héllo");
    const bin = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
    expect(encodeBody(text)?.encoding).toBe("utf8");
    expect(encodeBody(bin)?.encoding).toBe("base64");
    expect(decodeBody(encodeBody(bin)).equals(bin)).toBe(true);
    expect(encodeBody(Buffer.alloc(0))).toBeNull();
  });

  it("masks JSON fields at any depth, case-insensitively", () => {
    const input = { user: { Email: "a@b.c", name: "A" }, items: [{ password: "x", qty: 1 }] };
    expect(maskJsonFields(input, ["email", "password"])).toEqual({
      user: { Email: MASK, name: "A" },
      items: [{ password: MASK, qty: 1 }],
    });
  });

  it("returns the same reference when no field matched", () => {
    const input = { a: [1, { b: 2 }] };
    expect(maskJsonFields(input, ["email"])).toBe(input);
  });

  it("masks JSON bodies but leaves non-JSON and unmatched bodies byte-identical", () => {
    const pretty = { encoding: "utf8" as const, data: '{ "email": "a@b.c", "n": 1 }' };
    expect(maskBodyFields(pretty, ["email"])).toEqual({ encoding: "utf8", data: `{"email":"${MASK}","n":1}` });
    const untouched = { encoding: "utf8" as const, data: '{ "n": 1 }' };
    expect(maskBodyFields(untouched, ["email"])).toBe(untouched);
    const text = { encoding: "utf8" as const, data: "email=a@b.c" };
    expect(maskBodyFields(text, ["email"])).toBe(text);
    expect(maskBodyFields(null, ["email"])).toBeNull();
  });
});
