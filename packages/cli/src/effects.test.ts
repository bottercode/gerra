import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EFFECTS_HEADER, encodeEffects, parseTape, type Effect } from "@gerra/core";
import { runReplay } from "./api.js";
import { startRecorder } from "./record.js";

// A service that reports effects itself (any language can: it's one response header).
function service(effectsFor: (path: string) => Effect[] | null) {
  const seen: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers[EFFECTS_HEADER] as string | undefined);
    const effects = effectsFor(req.url ?? "/");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (req.headers[EFFECTS_HEADER] === "1" && effects) headers[EFFECTS_HEADER] = encodeEffects(effects);
    res.writeHead(200, headers);
    res.end('{"done":true}');
  });
  return new Promise<{ server: http.Server; url: string; seen: typeof seen }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen })),
  );
}

const webhook: Effect = { type: "http", method: "POST", url: "http://hooks.test/done", body: { id: 1 }, status: 202 };
let dir: string;
const servers: http.Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gerra-effects-"));
  await mkdir(join(dir, "tapes"), { recursive: true });
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await rm(dir, { recursive: true, force: true });
});

describe("effects", () => {
  it("are recorded from the original, hidden from clients, and compared on replay", async () => {
    const original = await service(() => [webhook]);
    servers.push(original.server);
    const tapePath = join(dir, "tapes", "todos.jsonl");
    const rec = await startRecorder({ target: original.url, tapePath, port: 0 });
    const res = await fetch(`${rec.url}/todos/1/done`);
    expect(res.headers.get(EFFECTS_HEADER)).toBeNull();
    expect(await res.json()).toEqual({ done: true });
    await rec.close();
    expect(original.seen).toEqual(["1"]);
    const [ex] = parseTape(await readFile(tapePath, "utf8"));
    expect(ex?.response.effects).toEqual([webhook]);
    expect(ex?.response.headers[EFFECTS_HEADER]).toBeUndefined();

    const dirs = { tapes: join(dir, "tapes"), runs: join(dir, "runs"), noise: join(dir, "noise") };
    // A rewrite that answers the same but forgets the webhook.
    const forgetful = await service(() => []);
    servers.push(forgetful.server);
    const bad = await runReplay({ tape: "todos", against: forgetful.url, dirs });
    expect(bad.report.summary.different).toBe(1);
    expect(bad.report.routes[0]?.mismatches[0]).toMatchObject({ at: "effects $[*]", count: 1 });

    // A rewrite without the SDK says nothing about effects, which isn't a difference.
    const silent = await service(() => null);
    servers.push(silent.server);
    expect((await runReplay({ tape: "todos", against: silent.url, dirs })).report.summary.identical).toBe(1);

    const faithful = await service(() => [webhook]);
    servers.push(faithful.server);
    expect((await runReplay({ tape: "todos", against: faithful.url, dirs })).report.summary.identical).toBe(1);
  });
});
