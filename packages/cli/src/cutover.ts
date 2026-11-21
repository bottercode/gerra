import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  type Mismatch,
  type RecordedResponse,
} from "gerra-core";
import { startProxy, type ServedMeta } from "./proxy.js";
import { isUnsafeAllowed, makeTarget, requestHeaders, send, type Target } from "./replay.js";
import { RollingLog, Window } from "./shadow.js";

export const DEFAULT_CUTOVER_DIR = join(".gerra", "cutover");
export const CUTOVER_STATE_VERSION = 1;
export const DEFAULT_STEPS = [1, 10, 50, 100];

/** When to roll back. Rates are fractions (0.01 = 1%) of the current step's observations. */
export interface Thresholds {
  /** Compared requests whose answers differ. */
  maxDiffRate: number;
  /** Candidate calls that failed (connection error, timeout) or returned 5xx where the primary didn't. */
  maxErrorRate: number;
  /** Candidate p99 latency limit: absolute, or relative to the primary's p99 in the same step. Null = off. */
  p99: { ms: number } | { ratio: number } | null;
  /** Observations needed before a rate or p99 is judged, and before a step can complete. */
  minSamples: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { maxDiffRate: 0.01, maxErrorRate: 0.01, p99: { ratio: 2 }, minSamples: 20 };

export interface CutoverOptions {
  primary: string;
  candidate: string;
  port: number;
  host?: string;
  dir: string;
  name: string;
  /** Percent of traffic the candidate serves at each step, ascending, e.g. [1, 10, 50, 100]. */
  steps?: readonly number[];
  /** How long each step must run (and collect `minSamples`) before moving on. */
  holdMs: number;
  thresholds?: Partial<Thresholds>;
  /** Non-idempotent requests also compared (mirrored to the other service). Routing applies to all methods. */
  unsafe?: readonly string[];
  rulesFor?: (route: string) => CompareRules;
  maskHeaders?: readonly string[];
  maskFields?: readonly string[];
  /** Timeout for comparison calls (default 5000 ms). */
  timeoutMs?: number;
  /** Comparison calls in flight at most; more are skipped (default 64). */
  maxInFlight?: number;
  maxBodyBytes?: number;
  stateIntervalMs?: number;
  /** How often thresholds and step timing are checked (default 250 ms). */
  tickMs?: number;
  /** Injected for tests; returns [0, 1). */
  random?: () => number;
  onEvent?: (event: CutoverEvent) => void;
  onError?: (err: Error, method: string, url: string) => void;
}

export type Phase = "stepping" | "complete" | "rolled_back";

export interface CutoverEvent {
  time: string;
  type: "start" | "step" | "complete" | "rollback";
  weight: number;
  reason?: string;
}

export interface StepStats {
  /** Requests answered for users by each service in this step. */
  servedPrimary: number;
  servedCandidate: number;
  /** Candidate failed on a GET/HEAD/OPTIONS and the primary answered instead. */
  failovers: number;
  compared: number;
  different: number;
  /** Candidate calls of any kind (serving users or comparisons) and how many failed. */
  candidateCalls: number;
  candidateErrors: number;
  /** Candidate: requests it served in this step. Primary: requests it served, last 1000 across steps. */
  p99: { primary: number | null; candidate: number | null };
}

export interface CutoverRoute {
  route: string;
  servedPrimary: number;
  servedCandidate: number;
  compared: number;
  different: number;
  candidateErrors: number;
  mismatches: { at: string; count: number }[];
}

export interface RecentDifference {
  time: string;
  id: string;
  request: string;
  /** Which service the user got the answer from. */
  served: "primary" | "candidate";
  mismatches?: Mismatch[];
  error?: string;
}

/** Contents of `state.json`, read by `gerra cutover status`. */
export interface CutoverState {
  v: typeof CUTOVER_STATE_VERSION;
  name: string;
  pid: number;
  running: boolean;
  listen: string;
  primary: string;
  candidate: string;
  startedAt: string;
  updatedAt: string;
  phase: Phase;
  /** Percent of traffic the candidate serves right now. */
  weight: number;
  steps: number[];
  stepIndex: number;
  stepStartedAt: string;
  holdMs: number;
  thresholds: Thresholds;
  step: StepStats;
  rollback?: { time: string; reason: string; atWeight: number };
  events: CutoverEvent[];
  routes: CutoverRoute[];
  recent: RecentDifference[];
  log: string;
}

export interface Cutover {
  url: string;
  port: number;
  state(): CutoverState;
  /** Send all traffic back to the primary and stop stepping. */
  rollback(reason: string): void;
  close(graceMs?: number): Promise<void>;
}

class StepCounter {
  servedPrimary = 0;
  servedCandidate = 0;
  failovers = 0;
  compared = 0;
  different = 0;
  candidateCalls = 0;
  candidateErrors = 0;
  /** Latency of requests the candidate served for users in this step. */
  candidateLatency = new Window();
  constructor(
    /** Latency of requests the primary served for users, across steps (the baseline). */
    readonly primaryLatency: Window,
  ) {}
  snapshot(): StepStats {
    return {
      servedPrimary: this.servedPrimary,
      servedCandidate: this.servedCandidate,
      failovers: this.failovers,
      compared: this.compared,
      different: this.different,
      candidateCalls: this.candidateCalls,
      candidateErrors: this.candidateErrors,
      p99: { primary: this.primaryLatency.percentile(99), candidate: this.candidateLatency.percentile(99) },
    };
  }
}

function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

/** Why the current step breaks a threshold, or null. Only judged once there are enough samples. */
export function breach(step: StepStats, t: Thresholds, samples: { primary: number; candidate: number }): string | null {
  if (step.candidateCalls >= t.minSamples) {
    const rate = step.candidateErrors / step.candidateCalls;
    if (rate > t.maxErrorRate) return `candidate error rate ${pct(rate)} > ${pct(t.maxErrorRate)} (${step.candidateErrors}/${step.candidateCalls})`;
  }
  if (step.compared >= t.minSamples) {
    const rate = step.different / step.compared;
    if (rate > t.maxDiffRate) return `diff rate ${pct(rate)} > ${pct(t.maxDiffRate)} (${step.different}/${step.compared})`;
  }
  const p99 = step.p99;
  if (t.p99 && p99.candidate !== null && samples.candidate >= t.minSamples) {
    if ("ms" in t.p99 && p99.candidate > t.p99.ms) return `candidate p99 ${p99.candidate.toFixed(1)}ms > ${t.p99.ms}ms`;
    if ("ratio" in t.p99 && p99.primary !== null && samples.primary >= t.minSamples && p99.candidate > p99.primary * t.p99.ratio) {
      return `candidate p99 ${p99.candidate.toFixed(1)}ms > ${t.p99.ratio}× primary p99 ${p99.primary.toFixed(1)}ms`;
    }
  }
  return null;
}

export function cutoverDir(root: string, name: string): string {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`invalid cutover name "${name}": use letters, digits, ".", "_" or "-"`);
  return join(root, name);
}

/**
 * Route a growing share of live traffic to the candidate, step by step, and roll back to the primary as soon
 * as the candidate's answers differ too often, it errors too often, or it gets too slow.
 *
 * Every GET/HEAD/OPTIONS request is also sent to the *other* service after the user has their answer, and the
 * two answers are compared (the primary's is the reference). Writes are routed but not compared unless opted in.
 */
export async function startCutover(opts: CutoverOptions): Promise<Cutover> {
  const steps = [...(opts.steps ?? DEFAULT_STEPS)];
  if (steps.length === 0 || steps.some((w, i) => !(w > 0 && w <= 100) || (i > 0 && w <= (steps[i - 1] as number)))) {
    throw new Error(`steps must be ascending percentages in (0, 100], got ${steps.join(",")}`);
  }
  const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const random = opts.random ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxInFlight = opts.maxInFlight ?? 64;
  const maskedHeaders = [...DEFAULT_MASKED_HEADERS, ...(opts.maskHeaders ?? [])];
  const maskFields = opts.maskFields ?? [];
  const primaryTarget = makeTarget(opts.primary, "--primary", maxInFlight);
  const candidateTarget = makeTarget(opts.candidate, "--candidate", maxInFlight);
  mkdirSync(opts.dir, { recursive: true });
  const statePath = join(opts.dir, "state.json");
  const diffs = new RollingLog(join(opts.dir, "diffs.jsonl"), 10 * 1024 * 1024);
  const eventLog = new RollingLog(join(opts.dir, "events.jsonl"), 10 * 1024 * 1024);

  const startedAt = new Date().toISOString();
  let phase: Phase = "stepping";
  let stepIndex = 0;
  let weight = steps[0] as number;
  let stepStartedAt = Date.now();
  // Both p99s come from requests served to users through this proxy, so they're measured the same way. The
  // primary's window spans steps, so there's still a baseline at 100%.
  const primaryBaseline = new Window();
  let step = new StepCounter(primaryBaseline);
  let rollbackInfo: CutoverState["rollback"];
  const events: CutoverEvent[] = [];
  const routes = new Map<string, CutoverRoute>();
  const recent: RecentDifference[] = [];
  let inFlight = 0;
  let idle: (() => void) | null = null;
  let dirty = true;
  let running = true;
  let listen = "";

  const emit = (type: CutoverEvent["type"], reason?: string) => {
    const event: CutoverEvent = { time: new Date().toISOString(), type, weight, ...(reason ? { reason } : {}) };
    events.unshift(event);
    if (events.length > 20) events.pop();
    eventLog.write(event);
    dirty = true;
    opts.onEvent?.(event);
  };

  const rollback = (reason: string) => {
    if (phase === "rolled_back") return;
    rollbackInfo = { time: new Date().toISOString(), reason, atWeight: weight };
    phase = "rolled_back";
    const was = weight;
    weight = 0;
    emit("rollback", `${reason} (was at ${was}%)`);
  };

  const routeStats = (ex: Exchange) => {
    const route = routeOf(ex.request.method, ex.request.path);
    let r = routes.get(route);
    if (!r) routes.set(route, (r = { route, servedPrimary: 0, servedCandidate: 0, compared: 0, different: 0, candidateErrors: 0, mismatches: [] }));
    return r;
  };
  const request = (ex: Exchange) => `${ex.request.method} ${ex.request.path}${ex.request.query ? `?${ex.request.query}` : ""}`;
  const remember = (d: RecentDifference) => {
    recent.unshift(d);
    if (recent.length > 20) recent.pop();
  };
  const candidateError = (r: CutoverRoute, s: StepCounter) => {
    s.candidateErrors++;
    r.candidateErrors++;
  };

  const compare = (raw: Exchange, primary: RecordedResponse, candidate: RecordedResponse, served: "primary" | "candidate", r: CutoverRoute, s: StepCounter) => {
    const p = maskExchange({ ...raw, response: primary }, maskedHeaders, maskFields);
    const c = maskExchange({ ...raw, response: candidate }, maskedHeaders, maskFields).response;
    if (candidate.status >= 500 && primary.status < 500) candidateError(r, s);
    const real = foldStatus(realMismatches(compareResponses(p.response, c, opts.rulesFor?.(r.route) ?? {})));
    s.compared++;
    r.compared++;
    if (real.length === 0) return;
    s.different++;
    r.different++;
    for (const m of real) {
      const g = r.mismatches.find((x) => x.at === m.at);
      if (g) g.count++;
      else r.mismatches.push({ at: m.at, count: 1 });
    }
    const entry: RecentDifference = { time: new Date().toISOString(), id: raw.id, request: request(raw), served, mismatches: real };
    remember(entry);
    diffs.write({ ...entry, exchange: p, candidate: { response: c } });
  };

  /** After the user has their answer, ask the other service the same question. */
  const mirror = (raw: Exchange, to: Target, served: "primary" | "candidate", r: CutoverRoute, s: StepCounter) => {
    if (!isUnsafeAllowed(raw, opts.unsafe ?? []) || raw.request.body?.truncated || inFlight >= maxInFlight) {
      if (served === "candidate" && raw.response.status >= 500) candidateError(r, s);
      return;
    }
    inFlight++;
    if (to === candidateTarget) s.candidateCalls++;
    const body = decodeBody(raw.request.body);
    void send(to, raw, requestHeaders(raw, {}, new Set(), body.length), body, timeoutMs)
      .then((sent) => {
        if (!sent.ok) {
          if (to === candidateTarget) {
            candidateError(r, s);
            remember({ time: new Date().toISOString(), id: raw.id, request: request(raw), served, error: sent.error });
          }
          return;
        }
        if (served === "primary") compare(raw, raw.response, sent.response, served, r, s);
        else compare(raw, sent.response, raw.response, served, r, s);
      })
      .catch((err: Error) => opts.onError?.(err, raw.request.method, raw.request.path))
      .finally(() => {
        inFlight--;
        dirty = true;
        if (inFlight === 0) idle?.();
      });
  };

  const onExchange = (raw: Exchange, meta: ServedMeta) => {
    const s = step; // a request belongs to the step it started in, even if the step ends meanwhile
    const r = routeStats(raw);
    dirty = true;
    if (meta.served === "alternate") {
      s.servedCandidate++;
      r.servedCandidate++;
      s.candidateCalls++;
      s.candidateLatency.add(raw.latencyMs);
      mirror(raw, primaryTarget, "candidate", r, s);
      return;
    }
    s.servedPrimary++;
    r.servedPrimary++;
    s.primaryLatency.add(raw.latencyMs);
    if (meta.failedOver !== undefined) {
      s.failovers++;
      s.candidateCalls++;
      candidateError(r, s);
      remember({ time: new Date().toISOString(), id: raw.id, request: request(raw), served: "primary", error: `${meta.failedOver} (answered by primary)` });
      return;
    }
    mirror(raw, candidateTarget, "primary", r, s);
  };

  const proxy = await startProxy({
    target: opts.primary,
    alternate: opts.candidate,
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    choose: () => (phase !== "rolled_back" && random() * 100 < weight ? "alternate" : "primary"),
    onExchange,
  });
  listen = proxy.url;

  const tick = () => {
    if (phase === "rolled_back" || !running) return;
    const why = breach(step.snapshot(), thresholds, { primary: step.primaryLatency.size, candidate: step.candidateLatency.size });
    if (why) return rollback(why);
    if (phase !== "stepping") return;
    if (Date.now() - stepStartedAt < opts.holdMs || step.candidateCalls < thresholds.minSamples) return;
    if (stepIndex === steps.length - 1) {
      phase = "complete";
      emit("complete", `held ${weight}% for ${Math.round((Date.now() - stepStartedAt) / 1000)}s within thresholds`);
      return;
    }
    stepIndex++;
    weight = steps[stepIndex] as number;
    stepStartedAt = Date.now();
    step = new StepCounter(primaryBaseline);
    emit("step", `previous step held within thresholds`);
  };

  const state = (): CutoverState => ({
    v: CUTOVER_STATE_VERSION,
    name: opts.name,
    pid: process.pid,
    running,
    listen,
    primary: opts.primary,
    candidate: opts.candidate,
    startedAt,
    updatedAt: new Date().toISOString(),
    phase,
    weight,
    steps,
    stepIndex,
    stepStartedAt: new Date(stepStartedAt).toISOString(),
    holdMs: opts.holdMs,
    thresholds,
    step: step.snapshot(),
    ...(rollbackInfo ? { rollback: rollbackInfo } : {}),
    events: [...events],
    routes: [...routes.values()]
      .map((r) => ({ ...r, mismatches: [...r.mismatches].sort((a, b) => b.count - a.count) }))
      .sort((a, b) => Number(b.different + b.candidateErrors > 0) - Number(a.different + a.candidateErrors > 0) || b.servedPrimary + b.servedCandidate - (a.servedPrimary + a.servedCandidate)),
    recent: [...recent],
    log: diffs.path,
  });
  const writeState = () => {
    dirty = false;
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state(), null, 2) + "\n");
    renameSync(tmp, statePath);
  };

  emit("start", `steps ${steps.join("% → ")}%, hold ${Math.round(opts.holdMs / 1000)}s each`);
  writeState();
  const ticker = setInterval(tick, opts.tickMs ?? 250);
  ticker.unref();
  const stateTimer = setInterval(() => {
    if (dirty) writeState();
  }, opts.stateIntervalMs ?? 1000);
  stateTimer.unref();

  let closing: Promise<void> | null = null;
  return {
    url: proxy.url,
    port: proxy.port,
    state,
    rollback: (reason) => {
      rollback(reason);
      writeState();
    },
    close(graceMs = 5000) {
      closing ??= (async () => {
        const deadline = Date.now() + graceMs;
        clearInterval(ticker);
        await proxy.close(graceMs);
        if (inFlight > 0) {
          const left = Math.max(0, deadline - Date.now());
          await Promise.race([new Promise<void>((resolve) => (idle = resolve)), new Promise((r) => setTimeout(r, left).unref())]);
        }
        clearInterval(stateTimer);
        primaryTarget.agent.destroy();
        candidateTarget.agent.destroy();
        running = false;
        await Promise.all([diffs.close(), eventLog.close()]);
        writeState(); // keeps the phase (stepping / complete / rolled back) as the outcome
      })();
      return closing;
    },
  };
}
