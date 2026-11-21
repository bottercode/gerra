import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MASK, decodeBody, parseTape, type Exchange } from "@gerra/core";
import { TapeExistsError, startRecorder, type Recorder } from "./record.js";

/** Upstream used by the tests. Each route exercises one proxy behavior. */
function startUpstream(): Promise<{ server: http.Server; url: string; seen: http.IncomingHttpHeaders[] }> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.url === "/binary") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0xff, 0x00, 0xfe, 0x81]));
      } else if (req.url === "/slow-stream") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first;");
        setTimeout(() => res.end("second"), 150);
      } else if (req.url === "/login") {
        res.writeHead(200, { "content-type": "application/json", "set-cookie": ["sid=secret; HttpOnly", "x=1"] });
        res.end(JSON.stringify({ user: { email: "a@b.c", name: "Ada" }, token: "t0k" }));
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(100));
      } else {
        res.writeHead(req.url?.startsWith("/missing") ? 404 : 200, { "content-type": "application/json", "x-upstream": "yes" });
        res.end(JSON.stringify({ method: req.method, url: req.url, echoed: body.toString("utf8") }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }),
    ),
  );
}

let dir: string;
let tape: string;
let upstream: Awaited<ReturnType<typeof startUpstream>>;
let recorder: Recorder | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-record-"));
  tape = join(dir, "tapes", "t.jsonl");
  upstream = await startUpstream();
});

afterEach(async () => {
  await recorder?.close();
  recorder = undefined;
  upstream.server.closeAllConnections();
  await new Promise((r) => upstream.server.close(r));
  await rm(dir, { recursive: true, force: true });
});

async function readTape(): Promise<Exchange[]> {
  return parseTape(await readFile(tape, "utf8"));
}

describe("startRecorder", () => {
  it("forwards requests transparently and records each exchange", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });

    const get = await fetch(`${recorder.url}/products/7?currency=EUR&x=1`);
    expect(get.status).toBe(200);
    expect(get.headers.get("x-upstream")).toBe("yes");
    expect(await get.json()).toEqual({ method: "GET", url: "/products/7?currency=EUR&x=1", echoed: "" });

    const post = await fetch(`${recorder.url}/cart/price`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"qty":2}',
    });
    expect((await post.json()).echoed).toBe('{"qty":2}');

    const missing = await fetch(`${recorder.url}/missing`, { method: "DELETE" });
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();

    await recorder.close();
    const exchanges = await readTape();
    expect(exchanges.map((e) => `${e.request.method} ${e.request.path} ${e.response.status}`)).toEqual([
      "GET /products/7 200",
      "POST /cart/price 200",
      "DELETE /missing 404",
    ]);
    const [g, p] = exchanges as [Exchange, Exchange];
    expect(g.request.query).toBe("currency=EUR&x=1");
    expect(g.request.body).toBeNull();
    expect(g.response.headers["x-upstream"]).toBe("yes");
    expect(JSON.parse(g.response.body?.data ?? "")).toMatchObject({ url: "/products/7?currency=EUR&x=1" });
    expect(g.latencyMs).toBeGreaterThanOrEqual(0);
    expect(g.id).toMatch(/^ex_/);
    expect(p.request.body).toEqual({ encoding: "utf8", data: '{"qty":2}' });
    expect(new Set(exchanges.map((e) => e.id)).size).toBe(3);
  });

  it("rewrites Host, adds X-Forwarded-*, and strips hop-by-hop headers", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    // fetch() refuses to send hop-by-hop headers, so use node:http directly.
    await new Promise<void>((resolve, reject) => {
      http
        .get(
          `${recorder!.url}/h`,
          { headers: { "x-custom": "1", connection: "keep-alive, x-hop", "keep-alive": "timeout=5", "x-hop": "1" } },
          (res) => res.resume().on("end", resolve),
        )
        .on("error", reject);
    });
    const seen = upstream.seen[0]!;
    expect(seen.host).toBe(new URL(upstream.url).host);
    expect(seen["x-forwarded-host"]).toBe(new URL(recorder.url).host);
    expect(seen["x-forwarded-for"]).toBeDefined();
    expect(seen["x-custom"]).toBe("1");
    expect(seen["keep-alive"]).toBeUndefined();
    expect(seen["x-hop"]).toBeUndefined(); // named in Connection, so hop-by-hop too

    await recorder.close();
    const [ex] = await readTape();
    expect(ex?.request.headers["x-custom"]).toBe("1");
    for (const h of ["connection", "keep-alive", "x-hop"]) expect(ex?.request.headers[h]).toBeUndefined();
    for (const h of ["connection", "keep-alive", "transfer-encoding"]) expect(ex?.response.headers[h]).toBeUndefined();
  });

  it("masks default headers, extra headers and JSON fields in the tape only", async () => {
    recorder = await startRecorder({
      target: upstream.url,
      tapePath: tape,
      port: 0,
      maskHeaders: ["X-Api-Key"],
      maskFields: ["email", "token", "password"],
    });
    const res = await fetch(`${recorder.url}/login`, {
      method: "POST",
      headers: { authorization: "Bearer real", "x-api-key": "k", "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.c", password: "hunter2" }),
    });
    // The client still sees the real response.
    expect(await res.json()).toEqual({ user: { email: "a@b.c", name: "Ada" }, token: "t0k" });
    expect(upstream.seen[0]?.authorization).toBe("Bearer real");

    await recorder.close();
    const [ex] = await readTape();
    expect(ex?.request.headers.authorization).toBe(MASK);
    expect(ex?.request.headers["x-api-key"]).toBe(MASK);
    expect(ex?.response.headers["set-cookie"]).toBe(MASK);
    expect(JSON.parse(ex?.request.body?.data ?? "")).toEqual({ email: MASK, password: MASK });
    expect(JSON.parse(ex?.response.body?.data ?? "")).toEqual({ user: { email: MASK, name: "Ada" }, token: MASK });
    expect(await readFile(tape, "utf8")).not.toMatch(/hunter2|Bearer real|a@b\.c|sid=secret/);
  });

  it("records binary bodies as base64, losslessly", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    const res = await fetch(`${recorder.url}/binary`);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0xff, 0x00, 0xfe, 0x81]));
    await recorder.close();
    const [ex] = await readTape();
    expect(ex?.response.body?.encoding).toBe("base64");
    expect(decodeBody(ex?.response.body ?? null)).toEqual(Buffer.from([0xff, 0x00, 0xfe, 0x81]));
  });

  it("streams the response instead of buffering it", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    const res = await fetch(`${recorder.url}/slow-stream`);
    const reader = res.body!.getReader();
    const t0 = performance.now();
    const first = await reader.read();
    const firstAfter = performance.now() - t0;
    expect(Buffer.from(first.value!).toString()).toBe("first;");
    expect(firstAfter).toBeLessThan(120); // upstream holds the rest for 150ms
    while (!(await reader.read()).done);
    await recorder.close();
    const [ex] = await readTape();
    expect(ex?.response.body?.data).toBe("first;second");
  });

  it("truncates oversized bodies in the tape but not for the client", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0, maxBodyBytes: 10 });
    expect(await (await fetch(`${recorder.url}/big`)).text()).toHaveLength(100);
    await recorder.close();
    const [ex] = await readTape();
    expect(ex?.response.body).toEqual({ encoding: "utf8", data: "xxxxxxxxxx", truncated: true });
  });

  it("returns 502 and records nothing when the target is down", async () => {
    const errors: string[] = [];
    recorder = await startRecorder({
      target: "http://127.0.0.1:1",
      tapePath: tape,
      port: 0,
      onError: (_err, method, url) => errors.push(`${method} ${url}`),
    });
    const res = await fetch(`${recorder.url}/x`);
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/unreachable/);
    await recorder.close();
    expect(errors).toEqual(["GET /x"]);
    expect(await readTape()).toEqual([]);
  });

  it("finishes in-flight requests on close and flushes them to the tape", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    const pending = fetch(`${recorder.url}/slow-stream`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50)); // request is now mid-flight
    await recorder.close();
    expect(await pending).toBe("first;second");
    expect((await readTape()).map((e) => e.request.path)).toEqual(["/slow-stream"]);
    expect(recorder.recorded).toBe(1);
  });

  it("refuses an existing tape unless asked to append or overwrite", async () => {
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    await (await fetch(`${recorder.url}/a`)).text();
    await recorder.close();
    await expect(startRecorder({ target: upstream.url, tapePath: tape, port: 0 })).rejects.toBeInstanceOf(TapeExistsError);
    expect((await readTape()).map((e) => e.request.path)).toEqual(["/a"]);

    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0, ifExists: "append" });
    await (await fetch(`${recorder.url}/b`)).text();
    await recorder.close();
    expect((await readTape()).map((e) => e.request.path)).toEqual(["/a", "/b"]);

    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0, ifExists: "overwrite" });
    await (await fetch(`${recorder.url}/c`)).text();
    await recorder.close();
    expect((await readTape()).map((e) => e.request.path)).toEqual(["/c"]);
  });

  it("records into an existing empty tape without asking", async () => {
    await mkdir(join(dir, "tapes"));
    await writeFile(tape, "");
    recorder = await startRecorder({ target: upstream.url, tapePath: tape, port: 0 });
    await (await fetch(`${recorder.url}/a`)).text();
    await recorder.close();
    expect((await readTape()).map((e) => e.request.path)).toEqual(["/a"]);
  });

  it("rejects non-http targets", async () => {
    await expect(startRecorder({ target: "ftp://x", tapePath: tape, port: 0 })).rejects.toThrow(/http\(s\) URL/);
  });
});
