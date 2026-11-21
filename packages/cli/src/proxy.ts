import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { EFFECTS_HEADER, TAPE_VERSION, encodeBody, takeEffects, type Exchange, type RecordedBody } from "@gerra/core";

export interface ProxyOptions {
  /** Service to forward to (the primary), e.g. `http://localhost:3000`. A path prefix is allowed. */
  target: string;
  /** Port to listen on; 0 picks a free port. */
  port: number;
  host?: string;
  /** Bodies larger than this are captured truncated (the client still gets everything). */
  maxBodyBytes?: number;
  /**
   * Called once the client has received the full response, with the exchange as seen on the wire:
   * nothing masked, hop-by-hop headers removed. Runs after the response, so it never delays the client.
   */
  onExchange?: (ex: Exchange, meta: ServedMeta) => void;
  onError?: (err: Error, method: string, url: string) => void;
  /**
   * Ask the primary to report its side effects (`x-gerra-effects: 1`), and keep what it reports in each
   * exchange. Off for cutover, which serves production traffic. The effects header never reaches clients.
   */
  captureEffects?: boolean;
  /** A second upstream (cutover's candidate). Requests go to it when `choose` says so. */
  alternate?: string;
  /** Pick the upstream for each request. Only consulted when `alternate` is set. */
  choose?: (method: string, url: string) => Served;
  /** The alternate failed on a request that was then answered by the primary. */
  onFailover?: (err: Error, method: string, url: string) => void;
}

export type Served = "primary" | "alternate";

export interface ServedMeta {
  served: Served;
  /** Set when the alternate failed and the primary answered instead: the alternate's error. */
  failedOver?: string;
}

export interface Proxy {
  url: string;
  port: number;
  /** Stop accepting, let in-flight requests finish (up to `graceMs`), then close all connections. */
  close(graceMs?: number): Promise<void>;
}

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Largest response header block accepted from upstreams (effects can be big). */
export const MAX_HEADER_BYTES = 1024 * 1024;

// RFC 9110 §7.6.1: connection-specific headers that a proxy must not forward.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const listed = new Set(
    String(headers.connection ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(key) || listed.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Flatten Node's header object to the tape's `Record<string, string>` (multi-values joined with ", "). */
export function flattenHeaders(headers: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

/** Collects up to `max` bytes of a stream for the tape without holding up the stream itself. */
class BodyCapture {
  private chunks: Buffer[] = [];
  private size = 0;
  private truncated = false;
  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return;
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.truncated = true;
      if (room > 0) this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks);
  }

  body(): RecordedBody | null {
    const encoded = encodeBody(Buffer.concat(this.chunks));
    if (!this.truncated) return encoded;
    return { ...(encoded ?? { encoding: "utf8", data: "" }), truncated: true };
  }
}

/** Transparent reverse proxy that reports each completed exchange. Shared by `record` and `shadow`. */
interface Upstream {
  url: URL;
  transport: typeof http | typeof https;
  agent: http.Agent;
  basePath: string;
}

function upstreamFor(raw: string): Upstream {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`target must be an http(s) URL, got "${raw}"`);
  const transport = url.protocol === "https:" ? https : http;
  return { url, transport, agent: new transport.Agent({ keepAlive: true }), basePath: url.pathname.replace(/\/$/, "") };
}

const RETRYABLE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Transparent reverse proxy that reports each completed exchange. Shared by `record`, `shadow` and `cutover`. */
export async function startProxy(opts: ProxyOptions): Promise<Proxy> {
  const primary = upstreamFor(opts.target);
  const alternate = opts.alternate ? upstreamFor(opts.alternate) : null;
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let inFlight = 0;
  let drained: (() => void) | null = null;
  const done = () => {
    inFlight--;
    if (inFlight === 0) drained?.();
  };

  const server = http.createServer((req, res) => {
    inFlight++;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        done();
      }
    };

    const started = performance.now();
    const at = new Date().toISOString();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const q = url.indexOf("?");
    const path = q === -1 ? url : url.slice(0, q);
    const query = q === -1 ? "" : url.slice(q + 1);

    const reqBody = new BodyCapture(maxBody);
    const resBody = new BodyCapture(maxBody);
    let current: http.ClientRequest | null = null;

    const headersFor = (up: Upstream) => {
      const headers = forwardableHeaders(req.headers);
      headers.host = up.url.host;
      const remote = req.socket.remoteAddress;
      if (remote) {
        const prior = req.headers["x-forwarded-for"];
        headers["x-forwarded-for"] = prior ? `${String(prior)}, ${remote}` : remote;
      }
      if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;
      headers["x-forwarded-proto"] = "http";
      if (opts.captureEffects) headers[EFFECTS_HEADER] = "1";
      else delete headers[EFFECTS_HEADER];
      return headers;
    };

    const forward = (served: Served, failedOver?: string) => {
      const up = served === "alternate" && alternate ? alternate : primary;
      const upstream = up.transport.request({
        protocol: up.url.protocol,
        hostname: up.url.hostname,
        port: up.url.port,
        method,
        path: up.basePath + url,
        headers: headersFor(up),
        agent: up.agent,
        // Effects travel in a response header that can be larger than Node's 16 KB default.
        maxHeaderSize: MAX_HEADER_BYTES,
      });
      current = upstream;

      upstream.on("response", (upRes) => {
        const status = upRes.statusCode ?? 502;
        const resHeaders = forwardableHeaders(upRes.headers);
        const effects = takeEffects(resHeaders);
        res.writeHead(status, upRes.statusMessage, resHeaders);
        upRes.on("data", (chunk: Buffer) => resBody.push(chunk));
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());

        res.on("finish", () => {
          const ex: Exchange = {
            v: TAPE_VERSION,
            id: `ex_${randomUUID()}`,
            at,
            request: {
              method,
              path,
              query,
              // Hop-by-hop headers describe one connection, not the exchange, so they're left out.
              headers: flattenHeaders(forwardableHeaders(req.headers)),
              body: reqBody.body(),
            },
            response: { status, headers: flattenHeaders(resHeaders), body: resBody.body(), ...(effects ? { effects } : {}) },
            latencyMs: Math.round((performance.now() - started) * 100) / 100,
          };
          try {
            opts.onExchange?.(ex, failedOver === undefined ? { served } : { served, failedOver });
          } catch (err) {
            opts.onError?.(err as Error, method, url);
          }
          settle();
        });
      });

      upstream.on("error", (err) => {
        // The alternate failed before answering a request that's safe to repeat: answer from the primary instead.
        if (served === "alternate" && !res.headersSent && RETRYABLE.has(method.toUpperCase()) && !res.destroyed) {
          req.unpipe(upstream);
          const retry = () => {
            if (reqBody.isTruncated()) return fail(err, up);
            opts.onFailover?.(err, method, url);
            forward("primary", err.message);
          };
          if (req.readableEnded) retry();
          else req.once("end", retry);
          return;
        }
        fail(err, up);
      });

      // First attempt streams the request body through; a failover resends what was captured.
      if (failedOver === undefined) req.pipe(upstream);
      else upstream.end(reqBody.bytes());
    };

    const fail = (err: Error, up: Upstream) => {
      opts.onError?.(err, method, url);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`gerra: upstream ${up.url.origin} unreachable: ${err.message}\n`);
      } else {
        res.destroy();
      }
      settle();
    };

    // Client went away before the response finished: stop the upstream call, report nothing.
    res.on("close", () => {
      if (!res.writableFinished) current?.destroy();
      settle();
    });

    req.on("data", (chunk: Buffer) => reqBody.push(chunk));
    forward(alternate && opts.choose?.(method, url) === "alternate" ? "alternate" : "primary");
  });

  server.listen(opts.port, opts.host ?? "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const shownHost = opts.host && opts.host !== "0.0.0.0" && opts.host !== "::" ? opts.host : "localhost";

  let closing: Promise<void> | null = null;
  return {
    url: `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}`,
    port,
    close(graceMs = 5000) {
      closing ??= (async () => {
        const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeIdleConnections();
        if (inFlight > 0) {
          const timer = new Promise<void>((resolve) => setTimeout(resolve, graceMs).unref());
          await Promise.race([new Promise<void>((resolve) => (drained = resolve)), timer]);
        }
        server.closeAllConnections();
        await serverClosed;
        primary.agent.destroy();
        alternate?.agent.destroy();
      })();
      return closing;
    },
  };
}
