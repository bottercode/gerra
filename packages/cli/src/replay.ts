import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import {
  MASK,
  RUN_VERSION,
  decodeBody,
  encodeBody,
  routeOf,
  type Exchange,
  type RecordedResponse,
  type ReplayResult,
} from "@gerra/core";

/** Methods that are safe to repeat against a service (RFC 9110 §9.2.1). Others need an explicit opt-in. */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface ReplayOptions {
  /** Candidate service, e.g. `http://localhost:4000`. A path prefix is allowed. */
  against: string;
  exchanges: readonly Exchange[];
  /** Requests in flight at once (default 8). */
  concurrency?: number;
  /** Per-request timeout in ms (default 10000). */
  timeoutMs?: number;
  /**
   * Opt-ins for non-idempotent methods: `*` (everything), a method (`POST`), or a route as shown by
   * `gerra tapes` (`POST /cart/price`, `DELETE /items/:id`).
   */
  unsafe?: readonly string[];
  /**
   * The original service. When set, each replayed request is also sent to it twice to learn noise;
   * see {@link ReplayStats.originalPairs}.
   */
  original?: string;
  /** Headers to set on every request (name → value), e.g. a test `authorization` to replace a masked one. */
  setHeaders?: Readonly<Record<string, string>>;
  onResult?: (result: ReplayResult, ex: Exchange) => void;
}

export interface ReplayStats {
  results: ReplayResult[];
  /** Header names that were masked in the tape and dropped from requests (no `setHeaders` value given). */
  droppedMaskedHeaders: string[];
  /** With `original`: both original responses for each exchange where both requests succeeded. */
  originalPairs: OriginalPair[];
  /** With `original`: exchanges where a request to the original failed (not used for learning). */
  originalErrors: number;
}

// Recomputed or connection-specific: never copied from the tape.
const DROP_REQUEST_HEADERS = new Set(["host", "content-length"]);

export function isUnsafeAllowed(ex: Exchange, unsafe: readonly string[]): boolean {
  const method = ex.request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return true;
  const route = routeOf(method, ex.request.path);
  const exact = `${method} ${ex.request.path}`;
  return unsafe.some((u) => {
    const rule = u.trim().replace(/\s+/g, " ");
    const [m = "", ...rest] = rule.split(" ");
    const normalized = [m.toUpperCase(), ...rest].join(" ");
    return rule === "*" || normalized === method || normalized === route || normalized === exact;
  });
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\.0\.0\.0$/];

/**
 * Whether a host looks like a local or internal service rather than production: loopback, private
 * addresses, `localhost`, single-label names (e.g. a docker-compose service) and `.local/.internal/.test`.
 */
export function looksLocal(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return PRIVATE_V4.some((re) => re.test(host));
  if (isIP(host) === 6) return host === "::1" || /^f[cd]/.test(host) || host.startsWith("fe80:");
  if (!host.includes(".")) return true;
  return /\.(local|internal|test|localdomain)$/.test(host);
}

export function requestHeaders(ex: Exchange, set: Readonly<Record<string, string>>, dropped: Set<string>, bodyLength: number) {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(ex.request.headers)) {
    const key = name.toLowerCase();
    if (DROP_REQUEST_HEADERS.has(key)) continue;
    if (value === MASK) {
      if (!(key in set)) dropped.add(key);
      continue;
    }
    out[key] = value;
  }
  for (const [name, value] of Object.entries(set)) out[name.toLowerCase()] = value;
  if (bodyLength > 0) out["content-length"] = bodyLength;
  return out;
}

/** Flatten Node's response headers to the tape's `Record<string, string>`. */
function flatten(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
  return out;
}

export interface Target {
  transport: typeof http | typeof https;
  url: URL;
  basePath: string;
  agent: http.Agent;
}

export function makeTarget(raw: string, flag: string, maxSockets: number): Target {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${flag} must be an http(s) URL, got "${raw}"`);
  const transport = url.protocol === "https:" ? https : http;
  return { transport, url, basePath: url.pathname.replace(/\/$/, ""), agent: new transport.Agent({ keepAlive: true, maxSockets }) };
}

export type Sent = { ok: true; response: RecordedResponse; latencyMs: number } | { ok: false; error: string; latencyMs: number };

export function send(target: Target, ex: Exchange, headers: http.OutgoingHttpHeaders, body: Buffer, timeoutMs: number): Promise<Sent> {
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 100) / 100;
  return new Promise((resolve) => {
    const req = target.transport.request({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port,
      method: ex.request.method,
      path: target.basePath + ex.request.path + (ex.request.query ? `?${ex.request.query}` : ""),
      headers,
      agent: target.agent,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const failed = (err: Error) => resolve({ ok: false, error: describeError(err, timeoutMs), latencyMs: elapsed() });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          ok: true,
          response: { status: res.statusCode ?? 0, headers: flatten(res.headers), body: encodeBody(Buffer.concat(chunks)) },
          latencyMs: elapsed(),
        }),
      );
      res.on("error", failed);
    });
    req.on("error", failed);
    req.end(body);
  });
}

/** Two responses from the original service for the same recorded request. */
export interface OriginalPair {
  id: string;
  a: RecordedResponse;
  b: RecordedResponse;
}

/**
 * Replay every exchange against the candidate. Results come back in tape order.
 * With `original`, each replayed request is first sent to the original twice (one after the other), so that
 * places that change between two runs of the same service can be learned as noise.
 */
export async function replayTape(opts: ReplayOptions): Promise<ReplayStats> {
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const candidate = makeTarget(opts.against, "--against", concurrency);
  const original = opts.original ? makeTarget(opts.original, "--original", concurrency) : null;
  const setHeaders = opts.setHeaders ?? {};
  const dropped = new Set<string>();
  const results: ReplayResult[] = new Array(opts.exchanges.length);
  const pairs: OriginalPair[] = [];
  let originalErrors = 0;

  const one = async (ex: Exchange): Promise<ReplayResult> => {
    const base = { v: RUN_VERSION, type: "result", id: ex.id } as const;
    if (!isUnsafeAllowed(ex, opts.unsafe ?? [])) {
      return { ...base, outcome: "skipped", reason: `${ex.request.method} not replayed without --unsafe-methods` };
    }
    if (ex.request.body?.truncated) {
      return { ...base, outcome: "skipped", reason: "request body was truncated in the tape" };
    }
    const body = decodeBody(ex.request.body);
    const headers = requestHeaders(ex, setHeaders, dropped, body.length);
    if (original) {
      const a = await send(original, ex, headers, body, timeoutMs);
      const b = await send(original, ex, headers, body, timeoutMs);
      if (a.ok && b.ok) pairs.push({ id: ex.id, a: a.response, b: b.response });
      else originalErrors++;
    }
    const sent = await send(candidate, ex, headers, body, timeoutMs);
    return sent.ok
      ? { ...base, outcome: "replayed", response: sent.response, latencyMs: sent.latencyMs }
      : { ...base, outcome: "error", error: sent.error, latencyMs: sent.latencyMs };
  };

  let next = 0;
  const worker = async () => {
    while (next < opts.exchanges.length) {
      const i = next++;
      const ex = opts.exchanges[i] as Exchange;
      const result = await one(ex);
      results[i] = result;
      opts.onResult?.(result, ex);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, opts.exchanges.length) }, worker));
  } finally {
    candidate.agent.destroy();
    original?.agent.destroy();
  }
  return { results, droppedMaskedHeaders: [...dropped].sort(), originalPairs: pairs, originalErrors };
}

function describeError(err: Error, timeoutMs: number): string {
  if (err.name === "TimeoutError" || (err.name === "AbortError" && String(err.cause ?? "").includes("Timeout"))) {
    return `timed out after ${timeoutMs}ms`;
  }
  const code = (err as NodeJS.ErrnoException).code;
  // Keep messages stable across requests so errors group well (no ports or addresses).
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "ENOTFOUND") return "host not found";
  return code ? `${code}: ${err.message}` : err.message;
}
