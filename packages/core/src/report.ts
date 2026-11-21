import { groupKey } from "./diff.js";
import { compareResponses, realMismatches, type CompareOptions, type Mismatch } from "./compare.js";
import { noiseFromMismatches, type IgnoreReason, type NoiseProfile } from "./rules.js";
import { routeOf } from "./summary.js";
import type { Exchange, RecordedResponse } from "./tape.js";

/** Version of the replay-run file format (`.gerra/runs/<tape>/<time>.jsonl`). */
export const RUN_VERSION = 1;

/** First line of a run file. */
export interface RunHeader {
  v: typeof RUN_VERSION;
  type: "run";
  tape: string;
  against: string;
  startedAt: string;
  /** Reset command that ran before the replay, if any. */
  reset?: string;
  /** Route filters the replay was limited to, if any. */
  routes?: string[];
  /** Noise profile that was applied to this run, so `gerra diff` reproduces the same report. */
  noise?: NoiseProfile;
}

/** What happened when one tape exchange was replayed. One line per exchange after the header. */
export type ReplayResult =
  | { v: typeof RUN_VERSION; type: "result"; id: string; outcome: "replayed"; response: RecordedResponse; latencyMs: number }
  | { v: typeof RUN_VERSION; type: "result"; id: string; outcome: "error"; error: string; latencyMs: number }
  | { v: typeof RUN_VERSION; type: "result"; id: string; outcome: "skipped"; reason: string };

export interface Run {
  header: RunHeader;
  results: ReplayResult[];
}

export function serializeRun(run: Run): string {
  return [run.header, ...run.results].map((l) => JSON.stringify(l)).join("\n") + "\n";
}

export function parseRun(contents: string): Run {
  const lines = contents.split("\n").filter((l) => l.trim() !== "");
  const parsed = lines.map((l, i) => {
    const v = JSON.parse(l) as { v?: unknown; type?: unknown };
    if (v.v !== RUN_VERSION) throw new Error(`run line ${i + 1}: unsupported version ${String(v.v)}`);
    return v;
  });
  const [header, ...rest] = parsed;
  if (header?.type !== "run") throw new Error("run file has no header line");
  return { header: header as RunHeader, results: rest as ReplayResult[] };
}

export type Verdict = "identical" | "different" | "error" | "skipped";

export interface Counts {
  total: number;
  identical: number;
  different: number;
  errors: number;
  skipped: number;
}

/** One concrete request that showed a problem, so it can be reproduced. */
export interface Sample {
  exchangeId: string;
  /** e.g. `POST /cart/price?debug=1` */
  request: string;
  /** Request body, shortened to 300 characters. */
  requestBody?: string;
  /** The exact location (array indices kept), when it differs from the group's `at`. */
  at?: string;
  kind?: Mismatch["kind"];
  original?: unknown;
  candidate?: unknown;
  note?: string;
}

/** Differences at the same place (array indices collapsed to `[*]`) across a route's exchanges. */
export interface MismatchGroup {
  at: string;
  /** Number of exchanges that differ here. */
  count: number;
  samples: Sample[];
}

export interface ErrorGroup {
  message: string;
  count: number;
  samples: Sample[];
}

export interface RouteReport extends Counts {
  route: string;
  mismatches: MismatchGroup[];
  errorGroups: ErrorGroup[];
  /** Skip reason → count. */
  skipReasons: Record<string, number>;
  /** Differences that were expected and not counted, by place and reason. */
  ignored: IgnoredGroup[];
}

export interface IgnoredGroup {
  at: string;
  reason: IgnoreReason;
  /** Number of exchanges where this place differed but was ignored. */
  count: number;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
}

export interface ReplayReport {
  summary: Counts;
  /** Over exchanges that were replayed successfully: recorded latency vs candidate latency. */
  latency: { original: LatencyStats | null; candidate: LatencyStats | null };
  /** Routes with problems first, then by volume. */
  routes: RouteReport[];
}

export interface ReportOptions extends CompareOptions {
  /** Samples kept per group (default 3). */
  samples?: number;
  /** Per-route rules (e.g. from gerra.config.json and learned noise); overrides the options above when given. */
  rulesFor?: (route: string) => CompareOptions;
}

function otherDifferences(n: number): string | undefined {
  return n === 0 ? undefined : `+${n} other difference${n === 1 ? "" : "s"} in this response`;
}

/**
 * A different status is the cause; the body and headers differing too is a consequence (e.g. 200 → 401
 * changes the whole body). So when the status differs, only it is kept, with the rest summarized in its note.
 */
export function foldStatus(mismatches: readonly Mismatch[]): Mismatch[] {
  const status = mismatches.find((m) => m.at === "status");
  if (!status) return [...mismatches];
  const note = otherDifferences(mismatches.length - 1);
  return [note ? { ...status, note } : status];
}


function requestLine(ex: Exchange): string {
  return `${ex.request.method} ${ex.request.path}${ex.request.query ? `?${ex.request.query}` : ""}`;
}

function requestBody(ex: Exchange): string | undefined {
  const body = ex.request.body;
  if (!body) return undefined;
  if (body.encoding === "base64") return `(${Buffer.from(body.data, "base64").length} bytes binary)`;
  return body.data.length > 300 ? `${body.data.slice(0, 300)}…` : body.data;
}

function percentile(sorted: readonly number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? 0;
}

function stats(values: number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

/**
 * Compare each replayed response with the recorded one and summarize by route and by where responses differ.
 * Exchanges with no result (e.g. an interrupted run) are left out.
 */
export function buildReport(exchanges: readonly Exchange[], results: readonly ReplayResult[], options: ReportOptions = {}): ReplayReport {
  const maxSamples = options.samples ?? 3;
  const byId = new Map(exchanges.map((ex) => [ex.id, ex]));
  const summary: Counts = { total: 0, identical: 0, different: 0, errors: 0, skipped: 0 };
  const routes = new Map<string, RouteReport>();
  const originalLatency: number[] = [];
  const candidateLatency: number[] = [];

  for (const result of results) {
    const ex = byId.get(result.id);
    if (!ex) continue;
    const route = routeOf(ex.request.method, ex.request.path);
    let r = routes.get(route);
    if (!r) {
      r = { route, total: 0, identical: 0, different: 0, errors: 0, skipped: 0, mismatches: [], errorGroups: [], skipReasons: {}, ignored: [] };
      routes.set(route, r);
    }
    r.total++;
    summary.total++;
    const base: Sample = { exchangeId: ex.id, request: requestLine(ex) };
    const body = requestBody(ex);
    if (body !== undefined) base.requestBody = body;

    if (result.outcome === "skipped") {
      r.skipped++;
      summary.skipped++;
      r.skipReasons[result.reason] = (r.skipReasons[result.reason] ?? 0) + 1;
      continue;
    }
    if (result.outcome === "error") {
      r.errors++;
      summary.errors++;
      let g = r.errorGroups.find((e) => e.message === result.error);
      if (!g) r.errorGroups.push((g = { message: result.error, count: 0, samples: [] }));
      g.count++;
      if (g.samples.length < maxSamples) g.samples.push(base);
      continue;
    }

    originalLatency.push(ex.latencyMs);
    candidateLatency.push(result.latencyMs);
    const all = compareResponses(ex.response, result.response, options.rulesFor ? options.rulesFor(route) : options);
    const seenIgnored = new Set<string>();
    for (const m of all) {
      if (!m.ignored) continue;
      const at = groupKey(m.at);
      const key = `${m.ignored} ${at}`;
      if (seenIgnored.has(key)) continue;
      seenIgnored.add(key);
      const g = r.ignored.find((x) => x.at === at && x.reason === m.ignored);
      if (g) g.count++;
      else r.ignored.push({ at, reason: m.ignored, count: 1 });
    }
    const mismatches = realMismatches(all);
    if (mismatches.length === 0) {
      r.identical++;
      summary.identical++;
      continue;
    }
    r.different++;
    summary.different++;
    const counted = foldStatus(mismatches);
    // Count each exchange once per group, keeping the first concrete mismatch as the sample.
    const seen = new Set<string>();
    for (const m of counted) {
      const key = groupKey(m.at);
      if (seen.has(key)) continue;
      seen.add(key);
      let g = r.mismatches.find((x) => x.at === key);
      if (!g) r.mismatches.push((g = { at: key, count: 0, samples: [] }));
      g.count++;
      if (g.samples.length < maxSamples) {
        const sample: Sample = { ...base, kind: m.kind, original: m.original, candidate: m.candidate };
        if (m.at !== key) sample.at = m.at;
        if (m.note) sample.note = m.note;
        g.samples.push(sample);
      }
    }
  }

  for (const r of routes.values()) {
    r.mismatches.sort((a, b) => b.count - a.count || a.at.localeCompare(b.at));
    r.errorGroups.sort((a, b) => b.count - a.count);
    r.ignored.sort((a, b) => b.count - a.count || a.at.localeCompare(b.at));
  }
  const problems = (r: RouteReport) => r.different + r.errors;
  return {
    summary,
    latency: { original: stats(originalLatency), candidate: stats(candidateLatency) },
    routes: [...routes.values()].sort(
      (a, b) => Number(problems(b) > 0) - Number(problems(a) > 0) || b.total - a.total || a.route.localeCompare(b.route),
    ),
  };
}

/**
 * Learn noise the Diffy way: for each exchange the original answered twice, every place where its two
 * responses differ is noise for that route. Normalizers are off here so that what's learned is explicit.
 */
export function learnNoise(
  exchanges: readonly Exchange[],
  pairs: readonly { id: string; a: RecordedResponse; b: RecordedResponse }[],
  meta: { learnedFrom: string; learnedAt: string; headers?: readonly string[] },
): NoiseProfile {
  const byId = new Map(exchanges.map((ex) => [ex.id, ex]));
  const observations: { route: string; at: string[] }[] = [];
  for (const { id, a, b } of pairs) {
    const ex = byId.get(id);
    if (!ex) continue;
    const off = { timestamps: false, uuids: false, ids: false };
    const options = meta.headers ? { headers: meta.headers, normalizers: off } : { normalizers: off };
    observations.push({ route: routeOf(ex.request.method, ex.request.path), at: compareResponses(a, b, options).map((m) => m.at) });
  }
  return { learnedFrom: meta.learnedFrom, learnedAt: meta.learnedAt, samples: observations.length, routes: noiseFromMismatches(observations) };
}
