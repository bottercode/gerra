// Programmatic API behind `gerra replay`, `gerra diff` and `gerra tapes`, shared with the MCP server
// (packages/mcp). Functions return data; formatting and exit codes are up to the caller.
import { readFile } from "node:fs/promises";
import {
  RUN_VERSION,
  buildReport,
  compareResponses,
  foldStatus,
  learnNoise,
  matchesRoute,
  parseTape,
  realMismatches,
  replayableRoutes,
  routeOf,
  rulesFor,
  type Exchange,
  type GerraConfig,
  type Mismatch,
  type NoiseProfile,
  type RecordedResponse,
  type ReplayReport,
  type ReplayResult,
} from "gerra-core";
import { loadConfig } from "./config.js";
import { DEFAULT_NOISE_DIR, loadNoise, saveNoise } from "./noise.js";
import { looksLocal, replayTape } from "./replay.js";
import { exitCodeFor, formatReport } from "./report.js";
import { DEFAULT_RUNS_DIR, latestRunPath, loadRun, saveRun } from "./runs.js";
import { DEFAULT_TAPES_DIR, listTapes, tapePath, type TapeInfo } from "./tapes.js";

export { exitCodeFor, formatReport, listTapes, looksLocal, type TapeInfo };
export { formatExchangeComparison } from "./report.js";
export { formatTapes } from "./tapes.js";

/** A mistake in what was asked for (bad flag, refused target): the CLI exits 2 for these. */
export class UsageError extends Error {}

export interface Dirs {
  tapes?: string;
  runs?: string;
  noise?: string;
}

/** Accept the shorthand ":3000" / "localhost:3000" as well as full URLs. */
export function normalizeUrl(value: string): string {
  if (/^https?:\/\//.test(value)) return value;
  return `http://${value.startsWith(":") ? `localhost${value}` : value}`;
}

export function assertLocal(url: string, flag: string, allowProd: boolean): void {
  const host = new URL(url).hostname;
  if (!allowProd && !looksLocal(host)) {
    throw new UsageError(`refusing to send ${flag} traffic to "${host}", which doesn't look local or internal. Pass --allow-prod if you're sure.`);
  }
}

export async function loadTape(name: string, dir = DEFAULT_TAPES_DIR): Promise<{ path: string; exchanges: Exchange[] }> {
  const path = tapePath(dir, name);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`no tape "${name}" at ${path}`);
    throw err;
  }
  return { path, exchanges: parseTape(contents) };
}

/** Keep exchanges matching any of the route filters (all of them when there are none). */
export function filterRoutes(exchanges: readonly Exchange[], routes: readonly string[] = []): Exchange[] {
  if (routes.length === 0) return [...exchanges];
  return exchanges.filter((ex) => routes.some((r) => matchesRoute(r, ex.request.method, ex.request.path)));
}

function buildWithRules(exchanges: readonly Exchange[], results: readonly ReplayResult[], config: GerraConfig, noise: NoiseProfile | null, extraHeaders: readonly string[]) {
  return buildReport(exchanges, results, { rulesFor: (route) => rulesFor(config, route, noise, extraHeaders) });
}

export interface ReplayParams {
  tape: string;
  against: string;
  /** Learn noise by also sending each request to the original twice. */
  original?: string;
  /** Only replay these routes (see `matchesRoute`). */
  routes?: readonly string[];
  unsafe?: readonly string[];
  /** Header values sent on every request, e.g. a test `authorization`. */
  headers?: Readonly<Record<string, string>>;
  concurrency?: number;
  timeoutMs?: number;
  compareHeaders?: readonly string[];
  /** Config file; `./gerra.config.json` is used if present when omitted. */
  config?: string;
  noNoise?: boolean;
  allowProd?: boolean;
  dirs?: Dirs;
  /** Progress messages (stderr in the CLI). */
  onNote?: (message: string) => void;
}

export interface ReportMeta {
  tape: string;
  against: string;
  run: string;
  startedAt: string;
  config: string | null;
  noise: NoiseProfile | null;
  /** Route filters this report was limited to. */
  routes: string[];
}

export interface ReplayOutcome extends ReportMeta {
  report: ReplayReport;
  droppedMaskedHeaders: string[];
  /** With `original`: what was learned and where it was saved. */
  learned?: { places: number; samples: number; path: string; originalErrors: number };
}

export async function runReplay(p: ReplayParams): Promise<ReplayOutcome> {
  const against = normalizeUrl(p.against);
  assertLocal(against, "--against", p.allowProd ?? false);
  const original = p.original ? normalizeUrl(p.original) : undefined;
  if (original) assertLocal(original, "--original", p.allowProd ?? false);
  if (original && p.noNoise) throw new UsageError("--original learns noise, so it can't be combined with --no-noise");
  const routes = [...(p.routes ?? [])];
  const tapesDir = p.dirs?.tapes ?? DEFAULT_TAPES_DIR;
  const noiseDir = p.dirs?.noise ?? DEFAULT_NOISE_DIR;

  const tape = await loadTape(p.tape, tapesDir);
  const exchanges = filterRoutes(tape.exchanges, routes);
  if (exchanges.length === 0) {
    throw new UsageError(`no exchanges in tape "${p.tape}" match ${routes.map((r) => `"${r}"`).join(", ")}; see gerra tapes ${p.tape}`);
  }
  const { config, path: configPath } = await loadConfig(p.config);
  const extraHeaders = [...(p.compareHeaders ?? [])];
  const startedAt = new Date().toISOString();
  const also = original ? ` (and twice against ${original} to learn noise)` : "";
  const scope = routes.length > 0 ? ` (${exchanges.length} of ${tape.exchanges.length}, routes: ${routes.join(", ")})` : "";
  p.onNote?.(`Replaying ${exchanges.length} exchanges from ${tape.path}${scope} against ${against}${also}…`);

  const { results, droppedMaskedHeaders, originalPairs, originalErrors } = await replayTape({
    against,
    ...(original ? { original } : {}),
    exchanges,
    ...(p.concurrency !== undefined ? { concurrency: p.concurrency } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    unsafe: [...(p.unsafe ?? []), ...replayableRoutes(config)],
    setHeaders: p.headers ?? {},
  });
  if (droppedMaskedHeaders.length > 0) {
    p.onNote?.(
      `Note: ${droppedMaskedHeaders.join(", ")} ${droppedMaskedHeaders.length === 1 ? "was" : "were"} masked in the tape and not sent. ` +
        `Supply test values with --header "${droppedMaskedHeaders[0]}: …" if the candidate needs them.`,
    );
  }

  let noise: NoiseProfile | null = null;
  let learned: ReplayOutcome["learned"];
  if (original) {
    noise = learnNoise(exchanges, originalPairs, { learnedFrom: original, learnedAt: startedAt, headers: rulesFor(config, "", null, extraHeaders).headers ?? [] });
    // Learning from a subset of routes keeps what was learned for the others.
    if (routes.length > 0) {
      const previous = await loadNoise(noiseDir, p.tape);
      if (previous) {
        const kept = Object.fromEntries(Object.entries(previous.routes).filter(([route]) => !exchanges.some((ex) => routeOf(ex.request.method, ex.request.path) === route)));
        noise = { ...noise, routes: { ...kept, ...noise.routes } };
      }
    }
    const path = await saveNoise(noiseDir, p.tape, noise);
    const places = Object.values(noise.routes).reduce((sum, r) => sum + r.length, 0);
    learned = { places, samples: noise.samples, path, originalErrors };
    p.onNote?.(`Learned ${places} noisy place${places === 1 ? "" : "s"} from ${noise.samples} exchanges on the original; saved to ${path}`);
    if (originalErrors > 0) p.onNote?.(`Warning: ${originalErrors} requests to the original failed and weren't used for learning.`);
  } else if (!p.noNoise) {
    noise = await loadNoise(noiseDir, p.tape);
  }

  const run = await saveRun(p.dirs?.runs ?? DEFAULT_RUNS_DIR, {
    header: { v: RUN_VERSION, type: "run", tape: p.tape, against, startedAt, ...(noise ? { noise } : {}) },
    results,
  });
  const report = buildWithRules(exchanges, results, config, noise, extraHeaders);
  return { tape: p.tape, against, run, startedAt, config: configPath, noise, routes, droppedMaskedHeaders, report, ...(learned ? { learned } : {}) };
}

export interface DiffParams {
  tape: string;
  /** Run file; the latest run of the tape when omitted. */
  run?: string;
  routes?: readonly string[];
  compareHeaders?: readonly string[];
  config?: string;
  noNoise?: boolean;
  dirs?: Dirs;
}

async function openRun(tape: string, run: string | undefined, dirs: Dirs | undefined) {
  const runFile = run ?? (await latestRunPath(dirs?.runs ?? DEFAULT_RUNS_DIR, tape));
  if (!runFile) throw new Error(`no replay runs for "${tape}" yet. Run: gerra replay ${tape} --against <url>`);
  return { runFile, run: await loadRun(runFile) };
}

export async function runDiff(p: DiffParams): Promise<ReportMeta & { report: ReplayReport }> {
  const tape = await loadTape(p.tape, p.dirs?.tapes ?? DEFAULT_TAPES_DIR);
  const { runFile, run } = await openRun(p.tape, p.run, p.dirs);
  const routes = [...(p.routes ?? [])];
  const exchanges = filterRoutes(tape.exchanges, routes);
  const { config, path: configPath } = await loadConfig(p.config);
  const noise = p.noNoise ? null : (run.header.noise ?? (await loadNoise(p.dirs?.noise ?? DEFAULT_NOISE_DIR, p.tape)));
  const report = buildWithRules(exchanges, run.results, config, noise, p.compareHeaders ?? []);
  return { tape: p.tape, against: run.header.against, run: runFile, startedAt: run.header.startedAt, config: configPath, noise, routes, report };
}

/** One recorded exchange next to what the candidate answered in a run, with the differences that count. */
export interface ExchangeComparison {
  id: string;
  route: string;
  request: Exchange["request"];
  recorded: RecordedResponse;
  run: string;
  outcome: ReplayResult["outcome"] | "not in run";
  candidate?: RecordedResponse;
  error?: string;
  reason?: string;
  mismatches: Mismatch[];
  ignored: Mismatch[];
}

/** Look at a single exchange in detail: what was recorded, what the candidate returned, and why they differ. */
export async function compareExchange(p: { tape: string; id: string; run?: string; config?: string; noNoise?: boolean; dirs?: Dirs }): Promise<ExchangeComparison> {
  const tape = await loadTape(p.tape, p.dirs?.tapes ?? DEFAULT_TAPES_DIR);
  // Ids are long; accept a unique prefix such as the `ex_3f445aac` shown in reports.
  const matches = tape.exchanges.filter((ex) => ex.id === p.id || ex.id.startsWith(p.id));
  if (matches.length === 0) throw new Error(`no exchange "${p.id}" in tape "${p.tape}"`);
  if (matches.length > 1) throw new Error(`"${p.id}" matches ${matches.length} exchanges; use a longer id`);
  const ex = matches[0] as Exchange;
  const route = routeOf(ex.request.method, ex.request.path);
  const { runFile, run } = await openRun(p.tape, p.run, p.dirs);
  const result = run.results.find((r) => r.id === ex.id);
  const base = { id: ex.id, route, request: ex.request, recorded: ex.response, run: runFile };
  if (!result) return { ...base, outcome: "not in run", mismatches: [], ignored: [] };
  if (result.outcome === "error") return { ...base, outcome: "error", error: result.error, mismatches: [], ignored: [] };
  if (result.outcome === "skipped") return { ...base, outcome: "skipped", reason: result.reason, mismatches: [], ignored: [] };
  const { config } = await loadConfig(p.config);
  const noise = p.noNoise ? null : (run.header.noise ?? (await loadNoise(p.dirs?.noise ?? DEFAULT_NOISE_DIR, p.tape)));
  const all = compareResponses(ex.response, result.response, rulesFor(config, route, noise));
  return { ...base, outcome: "replayed", candidate: result.response, mismatches: foldStatus(realMismatches(all)), ignored: all.filter((m) => m.ignored) };
}

/** Recorded exchanges of a tape, optionally limited to routes, for an agent to read what the service must do. */
export async function getExchanges(p: { tape: string; routes?: readonly string[]; limit?: number; dirs?: Dirs }): Promise<{ total: number; exchanges: Exchange[] }> {
  const tape = await loadTape(p.tape, p.dirs?.tapes ?? DEFAULT_TAPES_DIR);
  const matching = filterRoutes(tape.exchanges, p.routes);
  return { total: matching.length, exchanges: matching.slice(0, p.limit ?? 20) };
}

export async function tapesSummary(dir = DEFAULT_TAPES_DIR): Promise<TapeInfo[]> {
  return listTapes(dir);
}

/** Human-readable report text with where it came from, as `gerra replay` prints it. */
export function reportText(o: ReportMeta & { report: ReplayReport }, saved: boolean): string {
  const scope = o.routes.length > 0 ? `\nLimited to routes: ${o.routes.join(", ")}` : "";
  return `${formatReport(o.report, o)}${scope}\n${saved ? "Run saved to" : "From run"} ${o.run}`;
}
