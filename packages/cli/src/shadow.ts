import { createWriteStream, mkdirSync, renameSync, statSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MASKED_HEADERS,
  compareResponses,
  decodeBody,
  foldStatus,
  maskExchange,
  realMismatches,
  routeOf,
  type CompareRules,
  type Exchange,
  type IgnoreReason,
  type LatencyStats,
  type Mismatch,
  type RecordedResponse,
} from "@gerra/core";
import { startProxy } from "./proxy.js";
import { isUnsafeAllowed, makeTarget, requestHeaders, send } from "./replay.js";

export const DEFAULT_SHADOW_DIR = join(".gerra", "shadow");
export const SHADOW_STATE_VERSION = 1;

export interface ShadowOptions {
  /** The service users are served by. */
  primary: string;
  /** The rewrite that gets a copy of each request; its answers are only compared, never returned. */
  candidate: string;
  port: number;
  host?: string;
  /** Directory for this shadow's `state.json` and `diffs.jsonl`, e.g. `.gerra/shadow/default`. */
  dir: string;
  name: string;
  /** Non-idempotent requests mirrored anyway (same rules as replay's `--unsafe-methods`). */
  unsafe?: readonly string[];
  rulesFor?: (route: string) => CompareRules;
  maskHeaders?: readonly string[];
  maskFields?: readonly string[];
  /** Candidate request timeout (default 5000 ms). */
  timeoutMs?: number;
  /** Candidate requests in flight at most; more are dropped, never queued (default 64). */
  maxInFlight?: number;
  maxBodyBytes?: number;
  /** `diffs.jsonl` is rotated to `diffs.1.jsonl` past this size (default 10 MiB). */
  maxLogBytes?: number;
  /** How often `state.json` is rewritten while traffic flows (default 1000 ms). */
  stateIntervalMs?: number;
  onDifference?: (entry: RecentEntry) => void;
  onError?: (err: Error, method: string, url: string) => void;
}

/** A recent difference or candidate error, as kept in `state.json`. */
export interface RecentEntry {
  time: string;
  id: string;
  route: string;
  request: string;
  mismatches?: Mismatch[];
  error?: string;
}

export interface ShadowCounts {
  requests: number;
  compared: number;
  identical: number;
  different: number;
  candidateErrors: number;
  skipped: number;
  dropped: number;
}

export interface ShadowRoute extends ShadowCounts {
  route: string;
  mismatches: { at: string; count: number }[];
  ignored: { at: string; reason: IgnoreReason; count: number }[];
  errors: { message: string; count: number }[];
  skipReasons: Record<string, number>;
}

/** Contents of `state.json`, read by `gerra shadow status`. */
export interface ShadowState {
  v: typeof SHADOW_STATE_VERSION;
  name: string;
  pid: number;
  running: boolean;
  listen: string;
  primary: string;
  candidate: string;
  startedAt: string;
  updatedAt: string;
  counts: ShadowCounts;
  latency: { primary: LatencyStats | null; candidate: LatencyStats | null };
  routes: ShadowRoute[];
  recent: RecentEntry[];
  log: string;
}

export interface Shadow {
  url: string;
  port: number;
  state(): ShadowState;
  /** Stop accepting, finish in-flight user requests and candidate calls (up to `graceMs`), write final state. */
  close(graceMs?: number): Promise<void>;
}

const RECENT = 20;
const LATENCY_WINDOW = 1000;

function emptyCounts(): ShadowCounts {
  return { requests: 0, compared: 0, identical: 0, different: 0, candidateErrors: 0, skipped: 0, dropped: 0 };
}

function bump<T extends { count: number }>(list: T[], match: (x: T) => boolean, create: () => T): void {
  const found = list.find(match);
  if (found) found.count++;
  else list.push(create());
}

/** Last `LATENCY_WINDOW` samples, so long-running shadows report current latency, not lifetime latency. */
export class Window {
  private values: number[] = [];
  private i = 0;
  add(v: number): void {
    if (this.values.length < LATENCY_WINDOW) this.values.push(v);
    else this.values[this.i++ % LATENCY_WINDOW] = v;
  }
  get size(): number {
    return this.values.length;
  }
  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
  }
  stats(): LatencyStats | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
    return { count: sorted.length, p50: at(50), p95: at(95) };
  }
}

/** Append-only JSONL file that rotates to `<name>.1.jsonl` when it grows past `max` bytes. */
export class RollingLog {
  private stream: WriteStream;
  private size: number;
  constructor(
    readonly path: string,
    private readonly max: number,
  ) {
    try {
      this.size = statSync(path).size;
    } catch {
      this.size = 0;
    }
    this.stream = createWriteStream(path, { flags: "a" });
    this.stream.on("error", () => undefined);
  }
  write(entry: unknown): void {
    const line = JSON.stringify(entry) + "\n";
    if (this.size > 0 && this.size + line.length > this.max) {
      this.stream.end();
      try {
        renameSync(this.path, this.path.replace(/\.jsonl$/, ".1.jsonl"));
      } catch {
        // Keep appending to the current file if it can't be rotated.
      }
      this.stream = createWriteStream(this.path, { flags: "a" });
      this.stream.on("error", () => undefined);
      this.size = 0;
    }
    this.stream.write(line);
    this.size += Buffer.byteLength(line);
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

export function shadowDir(root: string, name: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`invalid shadow name "${name}": use letters, digits, ".", "_" or "-"`);
  return join(root, name);
}

/**
 * Proxy users to the primary and mirror each completed exchange to the candidate. The candidate is only
 * called after the user's response has finished, with a bounded number of calls in flight, so it can
 * never slow down or change what users get.
 */
export async function startShadow(opts: ShadowOptions): Promise<Shadow> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxInFlight = opts.maxInFlight ?? 64;
  const maskedHeaders = [...DEFAULT_MASKED_HEADERS, ...(opts.maskHeaders ?? [])];
  const maskFields = opts.maskFields ?? [];
  const candidate = makeTarget(opts.candidate, "--candidate", maxInFlight);
  mkdirSync(opts.dir, { recursive: true });
  const statePath = join(opts.dir, "state.json");
  const log = new RollingLog(join(opts.dir, "diffs.jsonl"), opts.maxLogBytes ?? 10 * 1024 * 1024);

  const counts = emptyCounts();
  const routes = new Map<string, ShadowRoute>();
  const recent: RecentEntry[] = [];
  const primaryLatency = new Window();
  const candidateLatency = new Window();
  const startedAt = new Date().toISOString();
  let inFlight = 0;
  let idle: (() => void) | null = null;
  let dirty = true;
  let running = true;
  let listen = "";

  const routeOfEx = (ex: Exchange) => {
    const route = routeOf(ex.request.method, ex.request.path);
    let r = routes.get(route);
    if (!r) routes.set(route, (r = { route, ...emptyCounts(), mismatches: [], ignored: [], errors: [], skipReasons: {} }));
    return r;
  };
  const count = (r: ShadowRoute, key: keyof ShadowCounts) => {
    counts[key]++;
    r[key]++;
    dirty = true;
  };
  const remember = (entry: RecentEntry) => {
    recent.unshift(entry);
    if (recent.length > RECENT) recent.pop();
    opts.onDifference?.(entry);
  };

  const compare = (raw: Exchange, response: RecordedResponse, latencyMs: number, r: ShadowRoute) => {
    // Both sides are masked before comparing, as in a tape: masked fields match anything and never reach disk.
    const primary = maskExchange(raw, maskedHeaders, maskFields);
    const cand = maskExchange({ ...raw, response }, maskedHeaders, maskFields).response;
    const all = compareResponses(primary.response, cand, opts.rulesFor?.(r.route) ?? {});
    count(r, "compared");
    primaryLatency.add(raw.latencyMs);
    candidateLatency.add(latencyMs);
    const seen = new Set<string>();
    for (const m of all) {
      if (!m.ignored || seen.has(`${m.ignored} ${m.at}`)) continue;
      seen.add(`${m.ignored} ${m.at}`);
      const reason = m.ignored;
      bump(r.ignored, (x) => x.at === m.at && x.reason === reason, () => ({ at: m.at, reason, count: 1 }));
    }
    const real = foldStatus(realMismatches(all));
    if (real.length === 0) return count(r, "identical");
    count(r, "different");
    for (const m of real) bump(r.mismatches, (x) => x.at === m.at, () => ({ at: m.at, count: 1 }));
    const entry: RecentEntry = {
      time: new Date().toISOString(),
      id: raw.id,
      route: r.route,
      request: `${raw.request.method} ${raw.request.path}${raw.request.query ? `?${raw.request.query}` : ""}`,
      mismatches: real,
    };
    remember(entry);
    log.write({ ...entry, exchange: primary, candidate: { response: cand, latencyMs } });
  };

  const mirror = (raw: Exchange) => {
    const r = routeOfEx(raw);
    count(r, "requests");
    const skip = (reason: string) => {
      count(r, "skipped");
      r.skipReasons[reason] = (r.skipReasons[reason] ?? 0) + 1;
    };
    if (!running) return skip("shadow was stopping");
    if (!isUnsafeAllowed(raw, opts.unsafe ?? [])) return skip(`${raw.request.method} not mirrored without --unsafe-methods`);
    if (raw.request.body?.truncated) return skip("request body larger than --max-body-bytes");
    if (inFlight >= maxInFlight) return count(r, "dropped");

    inFlight++;
    const body = decodeBody(raw.request.body);
    const headers = requestHeaders(raw, {}, new Set(), body.length);
    void send(candidate, raw, headers, body, timeoutMs)
      .then((sent) => {
        if (sent.ok) return compare(raw, sent.response, sent.latencyMs, r);
        count(r, "candidateErrors");
        bump(r.errors, (x) => x.message === sent.error, () => ({ message: sent.error, count: 1 }));
        remember({ time: new Date().toISOString(), id: raw.id, route: r.route, request: `${raw.request.method} ${raw.request.path}`, error: sent.error });
      })
      .catch((err: Error) => opts.onError?.(err, raw.request.method, raw.request.path))
      .finally(() => {
        inFlight--;
        if (inFlight === 0) idle?.();
      });
  };

  const proxy = await startProxy({
    target: opts.primary,
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    onExchange: mirror,
  });
  listen = proxy.url;

  const state = (): ShadowState => ({
    v: SHADOW_STATE_VERSION,
    name: opts.name,
    pid: process.pid,
    running,
    listen,
    primary: opts.primary,
    candidate: opts.candidate,
    startedAt,
    updatedAt: new Date().toISOString(),
    counts: { ...counts },
    latency: { primary: primaryLatency.stats(), candidate: candidateLatency.stats() },
    routes: [...routes.values()]
      .map((r) => ({
        ...r,
        mismatches: [...r.mismatches].sort((a, b) => b.count - a.count),
        ignored: [...r.ignored].sort((a, b) => b.count - a.count),
        errors: [...r.errors].sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => Number(b.different + b.candidateErrors > 0) - Number(a.different + a.candidateErrors > 0) || b.requests - a.requests),
    recent: [...recent],
    log: log.path,
  });
  const writeState = () => {
    dirty = false;
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state(), null, 2) + "\n");
    renameSync(tmp, statePath); // atomic: status never reads a half-written file
  };
  writeState();
  const timer = setInterval(() => {
    if (dirty) writeState();
  }, opts.stateIntervalMs ?? 1000);
  timer.unref();

  let closing: Promise<void> | null = null;
  return {
    url: proxy.url,
    port: proxy.port,
    state,
    close(graceMs = 5000) {
      closing ??= (async () => {
        const deadline = Date.now() + graceMs;
        await proxy.close(graceMs);
        running = false;
        if (inFlight > 0) {
          const left = Math.max(0, deadline - Date.now());
          await Promise.race([new Promise<void>((resolve) => (idle = resolve)), new Promise((r) => setTimeout(r, left).unref())]);
        }
        clearInterval(timer);
        candidate.agent.destroy();
        await log.close();
        writeState();
      })();
      return closing;
    },
  };
}
