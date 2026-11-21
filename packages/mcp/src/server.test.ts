import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeExchange, type Exchange } from "gerra-core";
import { PROTOCOL_VERSIONS, ToolError, createHandler, serveStdio, type Tool } from "./server.js";
import { gerraTools } from "./tools.js";

const echo: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
  run: async (args) => {
    if (args.text === "fail") throw new ToolError("nope");
    return String(args.text);
  },
};

describe("createHandler", () => {
  const handle = createHandler({ name: "t", version: "1.0.0", instructions: "hi" }, [echo]);

  it("negotiates the protocol version", async () => {
    const r = (await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } })) as { result: Record<string, unknown> };
    expect(r.result).toEqual({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "t", version: "1.0.0" }, instructions: "hi" });
    const newer = (await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })) as { result: { protocolVersion: string } };
    expect(newer.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it("answers ping, lists tools, ignores notifications, rejects unknown methods", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "ping" })).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list = (await handle({ jsonrpc: "2.0", id: 4, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(await handle({ jsonrpc: "2.0", id: 5, method: "resources/list" })).toMatchObject({ error: { code: -32601 } });
    expect(await handle({ id: 6, method: "ping" })).toMatchObject({ error: { code: -32600 } });
    expect(await handle("x")).toMatchObject({ error: { code: -32600 } });
  });

  it("returns tool output, and tool failures as isError results", async () => {
    expect(await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "echo", arguments: { text: "hey" } } })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "hey" }], isError: false },
    });
    expect(await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "echo", arguments: { text: "fail" } } })).toMatchObject({
      result: { content: [{ type: "text", text: "Error: nope" }], isError: true },
    });
    expect(await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope" } })).toMatchObject({ error: { code: -32602 } });
  });
});

// A whole session over stdio streams with the real gerra tools.
describe("gerra tools over stdio", () => {
  let server: http.Server;
  let url: string;
  let dir: string;
  const tape: Exchange[] = [
    {
      v: 1,
      id: "ex_11111111-0000-0000-0000-000000000000",
      at: "2026-11-20T10:00:00.000Z",
      request: { method: "GET", path: "/products/2", query: "", headers: {}, body: null },
      response: { status: 200, headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: '{"id":2,"price":59.5}' } },
      latencyMs: 1,
    },
    {
      v: 1,
      id: "ex_22222222-0000-0000-0000-000000000000",
      at: "2026-11-20T10:00:00.000Z",
      request: { method: "POST", path: "/cart/price", query: "", headers: {}, body: { encoding: "utf8", data: "{}" } },
      response: { status: 200, headers: { "content-type": "application/json" }, body: { encoding: "utf8", data: '{"total":1}' } },
      latencyMs: 1,
    },
  ];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(req.url === "/products/2" ? '{"id":2,"price":59.95}' : '{"total":1}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), "gerra-mcp-"));
    await mkdir(join(dir, "tapes"));
    await writeFile(join(dir, "tapes", "shop.jsonl"), tape.map(serializeExchange).join("\n") + "\n");
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("lists tapes, replays a route, explains a difference", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const dirs = { tapes: join(dir, "tapes"), runs: join(dir, "runs"), noise: join(dir, "noise") };
    const done = serveStdio({ name: "gerra", version: "0.0.0" }, gerraTools(dirs), input, output);
    const responses = new Map<number, { result: { content: { text: string }[]; isError: boolean } }>();
    let buf = "";
    output.setEncoding("utf8");
    output.on("data", (c: string) => {
      buf += c;
      for (let i; (i = buf.indexOf("\n")) !== -1; buf = buf.slice(i + 1)) {
        const msg = JSON.parse(buf.slice(0, i));
        responses.set(msg.id, msg);
      }
    });
    const send = (msg: unknown) => input.write(JSON.stringify(msg) + "\n");
    const call = (id: number, name: string, args: Record<string, unknown>) => send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    call(3, "gerra_list_tapes", {});
    call(4, "gerra_get_exchanges", { tape: "shop", routes: ["GET /products/:id"] });
    call(5, "gerra_replay", { tape: "shop", against: url, routes: ["GET /products/:id"] });
    call(6, "gerra_replay", { tape: "shop", against: "https://api.example.com" });
    input.end();
    await done;
    // The diff/explain calls read the run the replay saved, so they go in a second session.
    const text = (id: number) => responses.get(id)?.result.content[0]?.text ?? "";

    expect((responses.get(2) as unknown as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)).toEqual([
      "gerra_list_tapes",
      "gerra_get_exchanges",
      "gerra_replay",
      "gerra_diff",
      "gerra_explain_exchange",
    ]);
    expect(text(3)).toContain("shop  2 exchanges, 2 routes");
    expect(JSON.parse(text(4))).toMatchObject({ total: 1, shown: 1, exchanges: [{ id: "ex_11111111-0000-0000-0000-000000000000" }] });
    expect(text(5)).toContain("body $.price  ×1");
    expect(text(5)).toContain("Limited to routes: GET /products/:id");
    expect(text(5).trim().split("\n").at(-1)).toBe("FAIL: see the differences above.");
    expect(responses.get(6)?.result.isError).toBe(true);
    expect(text(6)).toMatch(/doesn't look local/);

    const input2 = new PassThrough();
    const output2 = new PassThrough();
    const done2 = serveStdio({ name: "gerra", version: "0.0.0" }, gerraTools(dirs), input2, output2);
    let out2 = "";
    output2.setEncoding("utf8");
    output2.on("data", (c: string) => (out2 += c));
    input2.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "gerra_explain_exchange", arguments: { tape: "shop", id: "ex_1111" } } }) + "\n");
    input2.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "gerra_diff", arguments: { tape: "shop" } } }) + "\n");
    input2.end();
    await done2;
    const [explain, diffText] = out2.trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id).map((m) => m.result.content[0].text as string);
    expect(explain).toContain("✗ body $.price: 59.5 → 59.95");
    expect(diffText).toContain("FAIL");
  });
});
