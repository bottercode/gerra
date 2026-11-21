// gerra dashboard: a local, read-only web view of .gerra/ (tapes, replay runs, single exchanges side by
// side, learned noise, live shadow and cutover sessions). Plain node:http and static files, no dependencies.
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareExchange, listRunFiles, liveSessions, loadNoise, runDiff, tapesSummary, type Dirs } from "@gerra/cli/api";
import { parseRun, type Counts, type RunHeader } from "@gerra/core";

export interface DashboardOptions {
  /** Port to listen on (default 7700; 0 picks a free one). */
  port?: number;
  /** Interface to listen on (default 127.0.0.1). The dashboard shows recorded traffic, so keep it local. */
  host?: string;
  dirs?: Dirs & { shadow?: string; cutover?: string };
  /** Config file used to rebuild reports (default ./gerra.config.json if present). */
  config?: string;
}

export interface Dashboard {
  url: string;
  port: number;
  close(): Promise<void>;
}

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RUN_FILE = /^[\w.:-]+\.jsonl$/;

export interface RunSummary {
  file: string;
  startedAt: string;
  against: string;
  reset?: string;
  routes?: string[];
  summary: Counts;
}

export async function startDashboard(opts: DashboardOptions = {}): Promise<Dashboard> {
  const dirs = opts.dirs ?? {};
  // Rebuilding a report reads the whole tape; runs don't change once written, so cache them by file.
  type Cached = Awaited<ReturnType<typeof runDiff>> & { header: RunHeader };
  const reportCache = new Map<string, { mtimeMs: number; value: Cached }>();
  const report = async (tape: string, path: string): Promise<Cached> => {
    const { mtimeMs } = await stat(path);
    const hit = reportCache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const diff = await runDiff({ tape, run: path, dirs, ...(opts.config ? { config: opts.config } : {}) });
    const value = { ...diff, header: parseRun(await readFile(path, "utf8")).header };
    reportCache.set(path, { mtimeMs, value });
    return value;
  };
  const runPath = async (tape: string, file: string) => {
    if (!RUN_FILE.test(file)) throw new HttpError(400, "bad run name");
    const run = (await listRunFiles(dirs.runs ?? join(".gerra", "runs"), tape)).find((r) => r.file === file);
    if (!run) throw new HttpError(404, `no run ${file} for tape ${tape}`);
    return run.path;
  };
  const runSummaries = async (tape: string, limit = 50): Promise<RunSummary[]> => {
    const files = (await listRunFiles(dirs.runs ?? join(".gerra", "runs"), tape)).slice(0, limit);
    const out: RunSummary[] = [];
    for (const f of files) {
      try {
        const r = await report(tape, f.path);
        const header = r.header;
        out.push({
          file: f.file,
          startedAt: r.startedAt,
          against: r.against,
          ...(header.reset ? { reset: header.reset } : {}),
          ...(header.routes ? { routes: header.routes } : {}),
          summary: r.report.summary,
        });
      } catch {
        // A run of an older tape that no longer matches is skipped rather than failing the page.
      }
    }
    return out;
  };

  const api = async (parts: string[], query: URLSearchParams): Promise<unknown> => {
    const [first, tape, kind, id, sub, exchange] = parts;
    if (first === "tapes" && tape === undefined) {
      const tapes = await tapesSummary(dirs.tapes);
      return Promise.all(tapes.map(async (t) => ({ ...t, runs: t.error ? [] : await runSummaries(t.name, 30) })));
    }
    if (first === "tapes" && tape !== undefined) {
      if (kind === undefined) {
        const t = (await tapesSummary(dirs.tapes)).find((x) => x.name === tape);
        if (!t) throw new HttpError(404, `no tape ${tape}`);
        return { ...t, runs: await runSummaries(tape), noise: await loadNoise(dirs.noise ?? join(".gerra", "noise"), tape) };
      }
      if (kind === "runs" && id !== undefined && sub === undefined) {
        const { header: _header, ...r } = await report(tape, await runPath(tape, id));
        const routes = query.getAll("route");
        if (routes.length === 0) return r;
        return runDiff({ tape, run: await runPath(tape, id), routes, dirs, ...(opts.config ? { config: opts.config } : {}) });
      }
      if (kind === "runs" && id !== undefined && sub === "exchanges" && exchange !== undefined) {
        return compareExchange({ tape, id: exchange, run: await runPath(tape, id), dirs, ...(opts.config ? { config: opts.config } : {}) });
      }
    }
    if (first === "live") return liveSessions(dirs);
    throw new HttpError(404, "not found");
  };

  const server = http.createServer(async (req, res) => {
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      res.end(body);
    };
    try {
      // Only answer requests addressed to this machine by name, so a web page can't reach the dashboard
      // through a DNS-rebound hostname.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new HttpError(403, "the dashboard only answers on localhost");
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "read-only");
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        const parts = url.pathname.slice("/api/".length).split("/").filter(Boolean).map(decodeURIComponent);
        return send(200, "application/json; charset=utf-8", JSON.stringify(await api(parts, url.searchParams)));
      }
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^[\w-]+\.(html|js|css|svg)$/.test(file)) throw new HttpError(404, "not found");
      return send(200, TYPES[extname(file)] ?? "application/octet-stream", await readFile(join(UI_DIR, file)));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
      send(status, "application/json; charset=utf-8", JSON.stringify({ error: (err as Error).message }));
    }
  });
  server.listen(opts.port ?? 7700, opts.host ?? "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
