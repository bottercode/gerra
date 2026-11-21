#!/usr/bin/env node
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import {
  DEFAULT_COMPARED_HEADERS,
  DEFAULT_MASKED_HEADERS,
  TAPE_VERSION,
  replayableRoutes,
  rulesFor,
  type NoiseProfile,
} from "gerra-core";
import { UsageError, compareExchange, exitCodeFor, normalizeUrl, reportText, runDiff, runReplay } from "./api.js";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { formatExchangeComparison } from "./report.js";
import { DEFAULT_NOISE_DIR, loadNoise } from "./noise.js";
import { DEFAULT_MAX_BODY_BYTES, TapeExistsError, startRecorder } from "./record.js";
import { DEFAULT_RUNS_DIR } from "./runs.js";
import { DEFAULT_SHADOW_DIR, shadowDir, startShadow, type RecentEntry } from "./shadow.js";
import { formatShadowState, isAlive, readShadowState } from "./shadow-status.js";
import { DEFAULT_CUTOVER_DIR, DEFAULT_STEPS, DEFAULT_THRESHOLDS, cutoverDir, startCutover } from "./cutover.js";
import { formatCutoverState, parseDuration, parseP99, parseRate, parseSteps, progressLine, readCutoverState } from "./cutover-status.js";
import { DEFAULT_TAPES_DIR, formatTapes, listTapes, readTapeInfo, tapePath } from "./tapes.js";

const HELP = `gerra — rewrite your backend with AI, and prove nothing broke.

Usage: gerra <command> [options]

Commands:
  record    Proxy an existing service and record its traffic to a tape
  tapes     List recorded tapes with request counts per route
  replay    Replay a tape against a candidate service and report differences
  diff      Re-show the report for the last replay of a tape
  shadow    Serve live traffic from the primary, mirror it to a candidate, compare
            (gerra shadow status shows live counters)
  cutover   Shift live traffic to the candidate step by step, roll back automatically
            (gerra cutover status / gerra cutover rollback)

Options:
  -h, --help     Show help (also: gerra <command> --help)
  -v, --version  Show version

Status: early development. See docs/PLAN.md.`;

const RECORD_HELP = `Usage: gerra record --target <url> [options]

Runs a reverse proxy that forwards every request to --target and writes
each request/response pair to .gerra/tapes/<tape>.jsonl. Stop with Ctrl-C;
in-flight requests finish and the tape is flushed before exit.

Options:
  --target <url>          Service to record (required), e.g. http://localhost:3000
  --port <n>              Port to listen on (default 8080)
  --host <addr>           Address to bind (default 127.0.0.1; use 0.0.0.0 to expose)
  --tape <name>           Tape name (default "default")
  --append                Add to the tape if it already exists
  --overwrite             Replace the tape if it already exists (without either, an existing tape is an error)
  --dir <path>            Tapes directory (default ${DEFAULT_TAPES_DIR})
  --mask-header <name>    Extra header to mask (repeatable). Always masked: ${DEFAULT_MASKED_HEADERS.join(", ")}
  --mask-field <name>     JSON body field to mask at any depth (repeatable), e.g. password, email
  --max-body-bytes <n>    Record at most n bytes per body (default ${DEFAULT_MAX_BODY_BYTES}); clients still get everything
  --config <path>         Config file (default ./${DEFAULT_CONFIG_FILE} if present); its mask.headers/fields are added
  --quiet                 Don't print a line per request`;

const TAPES_HELP = `Usage: gerra tapes [name] [options]

Lists tapes with exchange counts per route (ids like /products/42 are grouped as /products/:id).

Options:
  --dir <path>   Tapes directory (default ${DEFAULT_TAPES_DIR})
  --json         Machine-readable output`;

const COMPARE_HELP = `How responses are compared:
  status, the headers ${DEFAULT_COMPARED_HEADERS.join(" and ")} (add more with --compare-header), and the body after
  undoing content-encoding: JSON structurally (key order ignored), text by first differing line,
  anything else byte by byte. Values masked in the tape match anything.

What doesn't count as a difference (listed under "ignored" in the report):
  - noise: places that changed between two responses of the original (learned with --original)
  - ISO date-times with the same format and UUIDs with the same case (normalizers; ids is opt-in)
  - ignore rules and unordered arrays from ./${DEFAULT_CONFIG_FILE} (see docs/config.md)`;

const REPLAY_HELP = `Usage: gerra replay <tape> --against <url> [options]

Sends every recorded request to --against and compares each response with the
recorded one. Only GET, HEAD and OPTIONS are replayed unless you opt in with
--unsafe-methods. Exits 1 if any response differs or fails (or nothing was
compared), so it can gate CI. Each run is saved to ${DEFAULT_RUNS_DIR}/<tape>/.

Options:
  --against <url>          Candidate service (required), e.g. http://localhost:4000
  --route <route>          Only replay this route (repeatable), as gerra tapes lists it:
                           "POST /cart/price", "GET /products/:id", or a path for any method
  --unsafe-methods <rule>  Also replay non-idempotent requests (repeatable): "*" for all,
                           a method ("POST"), or a route as listed by gerra tapes ("POST /cart/price")
  --header "<name>: <v>"   Set a request header on every request (repeatable); use it to supply
                           credentials for headers that were masked in the tape
  --concurrency <n>        Requests in flight at once (default 8)
  --timeout <ms>           Per-request timeout (default 10000)
  --compare-header <name>  Also compare this response header (repeatable)
  --original <url>         Also send each request to the original service twice and learn the places
                           that change between its own responses as noise. Saved to
                           ${DEFAULT_NOISE_DIR}/<tape>.json and applied to later replays and diffs.
                           Opted-in unsafe requests then reach the original twice too.
  --no-noise               Don't apply learned noise
  --allow-prod             Allow targets that don't look local or internal
  --config <path>          Config file (default ./${DEFAULT_CONFIG_FILE} if present)
  --json                   Machine-readable report
  --dir <path>             Tapes directory (default ${DEFAULT_TAPES_DIR})
  --runs-dir <path>        Where runs are saved (default ${DEFAULT_RUNS_DIR})
  --noise-dir <path>       Where learned noise is kept (default ${DEFAULT_NOISE_DIR})

${COMPARE_HELP}`;

const DIFF_HELP = `Usage: gerra diff <tape> [options]

Rebuilds the report from the tape and its latest saved replay run, without
sending any traffic, using the current config and the noise recorded with the
run (or, if it had none, the tape's learned noise). Same output and exit code as gerra replay.

Options:
  --run <path>             Use this run file instead of the latest
  --route <route>          Only report on this route (repeatable)
  --exchange <id>          Show one exchange in full: request, recorded and candidate answers,
                           and the differences (an id prefix like ex_3f445aac is enough)
  --compare-header <name>  Also compare this response header (repeatable)
  --no-noise               Don't apply learned noise
  --config <path>          Config file (default ./${DEFAULT_CONFIG_FILE} if present); edit it and re-run diff
  --json                   Machine-readable report
  --dir <path>             Tapes directory (default ${DEFAULT_TAPES_DIR})
  --runs-dir <path>        Where runs are saved (default ${DEFAULT_RUNS_DIR})

${COMPARE_HELP}`;

const SHADOW_HELP = `Usage: gerra shadow --primary <url> --candidate <url> [options]
       gerra shadow status [--name <name>] [--json]

Runs a reverse proxy in front of --primary. Users always get the primary's
response. After each response has been sent, a copy of the request goes to
--candidate and the two answers are compared. The candidate never delays or
changes what users get: it's called afterwards, with at most --max-inflight
calls at once (the rest are dropped and counted), and its errors only count.

Live counters go to ${DEFAULT_SHADOW_DIR}/<name>/state.json (read them with
gerra shadow status) and each difference to ${DEFAULT_SHADOW_DIR}/<name>/diffs.jsonl,
which rotates at 10 MiB. Headers and fields are masked as in record before
anything is compared or written.

Options:
  --primary <url>          Service users are served by (required)
  --candidate <url>        Rewrite to compare against (required)
  --port <n>               Port to listen on (default 8080)
  --host <addr>            Address to bind (default 127.0.0.1)
  --name <name>            Name of this shadow, for status (default "default")
  --unsafe-methods <rule>  Also mirror non-idempotent requests (repeatable; same rules as replay).
                           Only do this if the candidate has its own data: the write happens twice.
  --noise <tape>           Ignore the noise learned for this tape (gerra replay --original)
  --timeout <ms>           Candidate timeout (default 5000)
  --max-inflight <n>       Candidate calls in flight at most (default 64)
  --compare-header <name>  Also compare this response header (repeatable)
  --mask-header <name>     Extra header to mask (repeatable)
  --mask-field <name>      JSON field to mask (repeatable)
  --max-body-bytes <n>     Larger requests aren't mirrored (default ${DEFAULT_MAX_BODY_BYTES})
  --config <path>          Config file (default ./${DEFAULT_CONFIG_FILE} if present)
  --dir <path>             Shadow state directory (default ${DEFAULT_SHADOW_DIR})
  --quiet                  Don't print differences as they happen`;

const CUTOVER_HELP = `Usage: gerra cutover --primary <url> --candidate <url> [options]
       gerra cutover status [--name <name>] [--json]
       gerra cutover rollback [--name <name>]

Runs a reverse proxy that sends a growing share of live traffic to --candidate:
${DEFAULT_STEPS.join("% → ")}% by default, holding each step for --hold. Users routed to the
candidate get the candidate's answer. Every GET/HEAD/OPTIONS request is also sent
to the other service afterwards and the answers are compared, with the primary's
as the reference.

All traffic goes back to the primary immediately (rollback) when, within the current
step and with at least --min-samples observations:
  - the share of compared answers that differ exceeds --max-diff-rate
  - the candidate's error rate (connection errors, timeouts, 5xx the primary didn't
    return) exceeds --max-error-rate
  - the candidate's p99 latency exceeds --max-p99
A rollback is final for this run. If the candidate fails before answering a
GET/HEAD/OPTIONS request, the primary answers it instead and it counts as an error.
At the last step the cutover is complete and keeps serving 100% from the candidate.

Options:
  --primary <url>          The service being replaced (required)
  --candidate <url>        The rewrite (required)
  --port <n>               Port to listen on (default 8080)
  --host <addr>            Address to bind (default 127.0.0.1)
  --steps <list>           Candidate share per step (default ${DEFAULT_STEPS.join(",")})
  --hold <duration>        Time per step before moving on (default 5m), e.g. 30s, 10m, 1h
  --max-diff-rate <pct>    Default ${DEFAULT_THRESHOLDS.maxDiffRate * 100}%
  --max-error-rate <pct>   Default ${DEFAULT_THRESHOLDS.maxErrorRate * 100}%
  --max-p99 <limit>        250ms, 2x (relative to the primary), or off (default 2x)
  --min-samples <n>        Observations per step before judging or moving on (default ${DEFAULT_THRESHOLDS.minSamples})
  --name <name>            Name of this cutover, for status/rollback (default "default")
  --unsafe-methods <rule>  Also compare non-idempotent requests by sending them to both services
                           (repeatable). Only if the services don't share data.
  --noise <tape>           Ignore the noise learned for this tape
  --compare-header <name>  Also compare this response header (repeatable)
  --mask-header <name>     Extra header to mask (repeatable)
  --mask-field <name>      JSON field to mask (repeatable)
  --timeout <ms>           Timeout for comparison calls (default 5000)
  --max-inflight <n>       Comparison calls in flight at most (default 64)
  --config <path>          Config file (default ./${DEFAULT_CONFIG_FILE} if present)
  --dir <path>             State directory (default ${DEFAULT_CUTOVER_DIR})
  --quiet                  Only print step changes and rollbacks

Rollback by hand at any time with: gerra cutover rollback (or kill -USR2 <pid>).`;

const NOT_YET = new Set<string>();

function parsePositiveInt(value: string, flag: string, allowZero = false): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) throw new UsageError(`${flag} must be a ${allowZero ? "non-negative" : "positive"} integer, got "${value}"`);
  return n;
}

async function record(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      tape: { type: "string", default: "default" },
      dir: { type: "string", default: DEFAULT_TAPES_DIR },
      "mask-header": { type: "string", multiple: true, default: [] as string[] },
      "mask-field": { type: "string", multiple: true, default: [] as string[] },
      "max-body-bytes": { type: "string", default: String(DEFAULT_MAX_BODY_BYTES) },
      config: { type: "string" },
      append: { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(RECORD_HELP);
    return 0;
  }
  if (!values.target) throw new UsageError(`--target is required\n\n${RECORD_HELP}`);
  if (values.append && values.overwrite) throw new UsageError("--append and --overwrite can't be used together");
  const target = normalizeUrl(values.target);
  const path = tapePath(values.dir, values.tape);
  const { config } = await loadConfig(values.config);

  const recorder = await startRecorder({
    target,
    tapePath: path,
    ifExists: values.append ? "append" : values.overwrite ? "overwrite" : "error",
    port: parsePositiveInt(values.port, "--port", true),
    host: values.host,
    maskHeaders: [...(config.mask?.headers ?? []), ...values["mask-header"]],
    maskFields: [...(config.mask?.fields ?? []), ...values["mask-field"]],
    maxBodyBytes: parsePositiveInt(values["max-body-bytes"], "--max-body-bytes"),
    onExchange: values.quiet
      ? undefined
      : (ex) => {
          const q = ex.request.query ? `?${ex.request.query}` : "";
          console.log(`  ${ex.request.method} ${ex.request.path}${q} → ${ex.response.status}  ${ex.latencyMs}ms`);
        },
    onError: (err, method, url) => console.error(`  ${method} ${url} → upstream error: ${err.message} (not recorded)`),
  }).catch((err: unknown) => {
    if (err instanceof TapeExistsError) {
      throw new UsageError(`tape "${values.tape}" already exists (${path}). Use --append to add to it or --overwrite to replace it.`);
    }
    throw err;
  });

  console.log(`gerra recording ${target} → ${path}`);
  console.log(`Send traffic to ${recorder.url}  (Ctrl-C to stop)\n`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        console.error("\nForced exit; the last in-flight requests may be missing from the tape.");
        process.exit(130);
      }
      stopping = true;
      console.log("\nStopping: finishing in-flight requests and flushing the tape…");
      recorder.close().then(resolve, (err: Error) => {
        console.error(`gerra record: failed to write tape: ${err.message}`);
        process.exitCode = 1;
        resolve();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

  console.log(`Recorded ${recorder.recorded} exchange${recorder.recorded === 1 ? "" : "s"} to ${path}`);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function tapes(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      dir: { type: "string", default: DEFAULT_TAPES_DIR },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(TAPES_HELP);
    return 0;
  }
  const [name] = positionals;
  let list;
  if (name === undefined) {
    list = await listTapes(values.dir);
  } else {
    const path = tapePath(values.dir, name);
    try {
      list = [await readTapeInfo(path)];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`gerra tapes: no tape "${name}" at ${path}`);
        return 1;
      }
      throw err;
    }
  }
  console.log(values.json ? JSON.stringify(list, null, 2) : formatTapes(list, values.dir));
  return list.some((t) => t.error) ? 1 : 0;
}

const compareOptions = {
  "compare-header": { type: "string", multiple: true, default: [] as string[] },
  config: { type: "string" },
  "no-noise": { type: "boolean", default: false },
  "noise-dir": { type: "string", default: DEFAULT_NOISE_DIR },
  json: { type: "boolean", default: false },
  dir: { type: "string", default: DEFAULT_TAPES_DIR },
  "runs-dir": { type: "string", default: DEFAULT_RUNS_DIR },
  help: { type: "boolean", short: "h", default: false },
} as const;

function printOutcome(o: Parameters<typeof reportText>[0], saved: boolean, json: boolean, extra: Record<string, unknown> = {}): number {
  if (json) console.log(JSON.stringify({ ...o, ...extra }, null, 2));
  else console.log(reportText(o, saved));
  return exitCodeFor(o.report);
}

async function replay(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...compareOptions,
      against: { type: "string" },
      route: { type: "string", multiple: true, default: [] as string[] },
      "unsafe-methods": { type: "string", multiple: true, default: [] as string[] },
      header: { type: "string", multiple: true, default: [] as string[] },
      concurrency: { type: "string", default: "8" },
      timeout: { type: "string", default: "10000" },
      "allow-prod": { type: "boolean", default: false },
      original: { type: "string" },
    },
  });
  if (values.help) {
    console.log(REPLAY_HELP);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError(`expected one tape name, got ${positionals.length}\n\n${REPLAY_HELP}`);
  const name = positionals[0];
  if (!name) throw new UsageError(`missing tape name\n\n${REPLAY_HELP}`);
  if (!values.against) throw new UsageError(`--against is required\n\n${REPLAY_HELP}`);
  const headers: Record<string, string> = {};
  for (const h of values.header) {
    const i = h.indexOf(":");
    if (i <= 0) throw new UsageError(`--header must look like "name: value", got "${h}"`);
    headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }
  const outcome = await runReplay({
    tape: name,
    against: values.against,
    ...(values.original ? { original: values.original } : {}),
    routes: values.route,
    unsafe: values["unsafe-methods"],
    headers,
    concurrency: parsePositiveInt(values.concurrency, "--concurrency"),
    timeoutMs: parsePositiveInt(values.timeout, "--timeout"),
    compareHeaders: values["compare-header"],
    ...(values.config ? { config: values.config } : {}),
    noNoise: values["no-noise"],
    allowProd: values["allow-prod"],
    dirs: { tapes: values.dir, runs: values["runs-dir"], noise: values["noise-dir"] },
    ...(values.json ? {} : { onNote: (m: string) => console.error(m) }),
  });
  return printOutcome(outcome, true, values.json);
}

async function diff(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ...compareOptions,
      run: { type: "string" },
      route: { type: "string", multiple: true, default: [] as string[] },
      exchange: { type: "string" },
    },
  });
  if (values.help) {
    console.log(DIFF_HELP);
    return 0;
  }
  if (positionals.length > 1) throw new UsageError(`expected one tape name, got ${positionals.length}\n\n${DIFF_HELP}`);
  const name = positionals[0];
  if (!name) throw new UsageError(`missing tape name\n\n${DIFF_HELP}`);
  const dirs = { tapes: values.dir, runs: values["runs-dir"], noise: values["noise-dir"] };
  const common = { tape: name, ...(values.run ? { run: values.run } : {}), ...(values.config ? { config: values.config } : {}), noNoise: values["no-noise"], dirs };
  if (values.exchange) {
    const c = await compareExchange({ ...common, id: values.exchange });
    console.log(values.json ? JSON.stringify(c, null, 2) : formatExchangeComparison(c));
    return c.outcome === "replayed" && c.mismatches.length === 0 ? 0 : 1;
  }
  const outcome = await runDiff({ ...common, routes: values.route, compareHeaders: values["compare-header"] });
  return printOutcome(outcome, false, values.json);
}

async function shadowStatus(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string", default: "default" },
      dir: { type: "string", default: DEFAULT_SHADOW_DIR },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(SHADOW_HELP);
    return 0;
  }
  const dir = shadowDir(values.dir, values.name);
  const state = await readShadowState(dir);
  if (!state) {
    console.error(`gerra shadow status: no shadow "${values.name}" in ${values.dir}. Start one with: gerra shadow --primary <url> --candidate <url>`);
    return 1;
  }
  const alive = isAlive(state.pid);
  if (values.json) console.log(JSON.stringify({ ...state, running: state.running && alive }, null, 2));
  else console.log(formatShadowState(state, alive));
  return 0;
}

function differenceLine(e: RecentEntry): string {
  if (e.error) return `  ✗ ${e.request}  candidate error: ${e.error}`;
  const m = e.mismatches?.[0];
  const show = (v: unknown) => (v === undefined ? "(none)" : JSON.stringify(v).slice(0, 60));
  const more = (e.mismatches?.length ?? 0) > 1 ? `  (+${(e.mismatches?.length ?? 1) - 1} more)` : "";
  return `  ✗ ${e.request}  ${m?.at}: ${show(m?.original)} → ${show(m?.candidate)}${more}`;
}

async function shadow(args: string[]): Promise<number> {
  if (args[0] === "status") return shadowStatus(args.slice(1));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      primary: { type: "string" },
      candidate: { type: "string" },
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      name: { type: "string", default: "default" },
      "unsafe-methods": { type: "string", multiple: true, default: [] as string[] },
      noise: { type: "string" },
      timeout: { type: "string", default: "5000" },
      "max-inflight": { type: "string", default: "64" },
      "compare-header": { type: "string", multiple: true, default: [] as string[] },
      "mask-header": { type: "string", multiple: true, default: [] as string[] },
      "mask-field": { type: "string", multiple: true, default: [] as string[] },
      "max-body-bytes": { type: "string", default: String(DEFAULT_MAX_BODY_BYTES) },
      config: { type: "string" },
      dir: { type: "string", default: DEFAULT_SHADOW_DIR },
      "noise-dir": { type: "string", default: DEFAULT_NOISE_DIR },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(SHADOW_HELP);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\n\n${SHADOW_HELP}`);
  if (!values.primary || !values.candidate) throw new UsageError(`--primary and --candidate are required\n\n${SHADOW_HELP}`);
  const primary = normalizeUrl(values.primary);
  const candidate = normalizeUrl(values.candidate);
  const { config, path: configPath } = await loadConfig(values.config);
  let noise: NoiseProfile | null = null;
  if (values.noise) {
    noise = await loadNoise(values["noise-dir"], values.noise);
    if (!noise) throw new Error(`no learned noise for tape "${values.noise}". Learn it with: gerra replay ${values.noise} --against <url> --original <url>`);
  }
  const dir = shadowDir(values.dir, values.name);
  const extraHeaders = values["compare-header"];

  const sh = await startShadow({
    primary,
    candidate,
    port: parsePositiveInt(values.port, "--port", true),
    host: values.host,
    dir,
    name: values.name,
    unsafe: [...values["unsafe-methods"], ...replayableRoutes(config)],
    rulesFor: (route) => rulesFor(config, route, noise, extraHeaders),
    maskHeaders: [...(config.mask?.headers ?? []), ...values["mask-header"]],
    maskFields: [...(config.mask?.fields ?? []), ...values["mask-field"]],
    timeoutMs: parsePositiveInt(values.timeout, "--timeout"),
    maxInFlight: parsePositiveInt(values["max-inflight"], "--max-inflight"),
    maxBodyBytes: parsePositiveInt(values["max-body-bytes"], "--max-body-bytes"),
    ...(values.quiet ? {} : { onDifference: (e: RecentEntry) => console.log(differenceLine(e)) }),
    onError: (err, method, url) => console.error(`  ${method} ${url} → primary error: ${err.message}`),
  });

  console.log(`gerra shadow "${values.name}": users → ${sh.url} → ${primary}; copies → ${candidate}`);
  if (configPath) console.log(`config ${configPath}`);
  if (noise) console.log(`ignoring noise learned from ${noise.learnedFrom} (tape "${values.noise}")`);
  console.log(`Status: gerra shadow status${values.name === "default" ? "" : ` --name ${values.name}`}   (Ctrl-C to stop)\n`);

  let last = "";
  const ticker = setInterval(() => {
    const c = sh.state().counts;
    const line = `  [${new Date().toISOString().slice(11, 19)}] ${c.requests} requests · ${c.compared} compared · ${c.different} different · ${c.candidateErrors} candidate errors · ${c.skipped} skipped · ${c.dropped} dropped`;
    if (line.slice(13) !== last.slice(13) && !values.quiet) console.log(line);
    last = line;
  }, 10_000);
  ticker.unref();

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(130);
      stopping = true;
      clearInterval(ticker);
      console.log("\nStopping: finishing in-flight requests and candidate calls…");
      sh.close().then(resolve, (err: Error) => {
        console.error(`gerra shadow: ${err.message}`);
        process.exitCode = 1;
        resolve();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  console.log(`\n${formatShadowState(sh.state(), false)}`);
  return typeof process.exitCode === "number" ? process.exitCode : 0;
}

async function cutoverStatus(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string", default: "default" },
      dir: { type: "string", default: DEFAULT_CUTOVER_DIR },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(CUTOVER_HELP);
    return 0;
  }
  const state = await readCutoverState(cutoverDir(values.dir, values.name));
  if (!state) {
    console.error(`gerra cutover status: no cutover "${values.name}" in ${values.dir}`);
    return 1;
  }
  const alive = isAlive(state.pid);
  if (values.json) console.log(JSON.stringify({ ...state, running: state.running && alive }, null, 2));
  else console.log(formatCutoverState(state, alive));
  // Scripts can check for a rollback without parsing.
  return state.phase === "rolled_back" ? 3 : 0;
}

async function cutoverRollback(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string", default: "default" },
      dir: { type: "string", default: DEFAULT_CUTOVER_DIR },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(CUTOVER_HELP);
    return 0;
  }
  const dir = cutoverDir(values.dir, values.name);
  const state = await readCutoverState(dir);
  if (!state) throw new Error(`no cutover "${values.name}" in ${values.dir}`);
  if (state.phase === "rolled_back") {
    console.log(`cutover "${values.name}" is already rolled back: ${state.rollback?.reason}`);
    return 0;
  }
  if (!state.running || !isAlive(state.pid)) throw new Error(`cutover "${values.name}" is not running (pid ${state.pid})`);
  process.kill(state.pid, "SIGUSR2");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const now = await readCutoverState(dir);
    if (now?.phase === "rolled_back") {
      console.log(`Rolled back: all traffic goes to ${now.primary} again.`);
      return 0;
    }
  }
  throw new Error(`sent SIGUSR2 to pid ${state.pid} but the cutover didn't confirm a rollback within 5s`);
}

async function cutover(args: string[]): Promise<number> {
  if (args[0] === "status") return cutoverStatus(args.slice(1));
  if (args[0] === "rollback") return cutoverRollback(args.slice(1));
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      primary: { type: "string" },
      candidate: { type: "string" },
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      steps: { type: "string", default: DEFAULT_STEPS.join(",") },
      hold: { type: "string", default: "5m" },
      "max-diff-rate": { type: "string", default: `${DEFAULT_THRESHOLDS.maxDiffRate * 100}%` },
      "max-error-rate": { type: "string", default: `${DEFAULT_THRESHOLDS.maxErrorRate * 100}%` },
      "max-p99": { type: "string", default: "2x" },
      "min-samples": { type: "string", default: String(DEFAULT_THRESHOLDS.minSamples) },
      name: { type: "string", default: "default" },
      "unsafe-methods": { type: "string", multiple: true, default: [] as string[] },
      noise: { type: "string" },
      "compare-header": { type: "string", multiple: true, default: [] as string[] },
      "mask-header": { type: "string", multiple: true, default: [] as string[] },
      "mask-field": { type: "string", multiple: true, default: [] as string[] },
      timeout: { type: "string", default: "5000" },
      "max-inflight": { type: "string", default: "64" },
      config: { type: "string" },
      dir: { type: "string", default: DEFAULT_CUTOVER_DIR },
      "noise-dir": { type: "string", default: DEFAULT_NOISE_DIR },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(CUTOVER_HELP);
    return 0;
  }
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"\n\n${CUTOVER_HELP}`);
  if (!values.primary || !values.candidate) throw new UsageError(`--primary and --candidate are required\n\n${CUTOVER_HELP}`);
  const usage = <T>(f: () => T): T => {
    try {
      return f();
    } catch (err) {
      throw new UsageError((err as Error).message);
    }
  };
  const steps = usage(() => parseSteps(values.steps));
  const holdMs = usage(() => parseDuration(values.hold));
  const thresholds = {
    maxDiffRate: usage(() => parseRate(values["max-diff-rate"])),
    maxErrorRate: usage(() => parseRate(values["max-error-rate"])),
    p99: usage(() => parseP99(values["max-p99"])),
    minSamples: parsePositiveInt(values["min-samples"], "--min-samples"),
  };
  const primary = normalizeUrl(values.primary);
  const candidate = normalizeUrl(values.candidate);
  const { config, path: configPath } = await loadConfig(values.config);
  let noise: NoiseProfile | null = null;
  if (values.noise) {
    noise = await loadNoise(values["noise-dir"], values.noise);
    if (!noise) throw new Error(`no learned noise for tape "${values.noise}"`);
  }
  const extraHeaders = values["compare-header"];

  const co = await startCutover({
    primary,
    candidate,
    port: parsePositiveInt(values.port, "--port", true),
    host: values.host,
    dir: cutoverDir(values.dir, values.name),
    name: values.name,
    steps,
    holdMs,
    thresholds,
    unsafe: [...values["unsafe-methods"], ...replayableRoutes(config)],
    rulesFor: (route) => rulesFor(config, route, noise, extraHeaders),
    maskHeaders: [...(config.mask?.headers ?? []), ...values["mask-header"]],
    maskFields: [...(config.mask?.fields ?? []), ...values["mask-field"]],
    timeoutMs: parsePositiveInt(values.timeout, "--timeout"),
    maxInFlight: parsePositiveInt(values["max-inflight"], "--max-inflight"),
    onEvent: (e) => {
      const time = e.time.slice(11, 19);
      if (e.type === "rollback") console.log(`\n[${time}] ✗ ROLLBACK → all traffic to the primary. ${e.reason}\n`);
      else if (e.type === "complete") console.log(`[${time}] ✓ cutover complete: candidate serves 100%. ${e.reason}`);
      else if (e.type === "step") console.log(`[${time}] → candidate now serves ${e.weight}%`);
      // "start" fires before the banner below, which reports it instead.
    },
    onError: (err, method, url) => console.error(`  ${method} ${url} → upstream error: ${err.message}`),
  });

  console.log(`gerra cutover "${values.name}": users → ${co.url} → primary ${primary} / candidate ${candidate}`);
  console.log(`Candidate serves ${steps[0]}% now; steps ${steps.join("% → ")}%, holding each for ${values.hold}.`);
  if (configPath) console.log(`config ${configPath}`);
  console.log(`Status: gerra cutover status · Roll back now: gerra cutover rollback   (Ctrl-C to stop)`);

  let last = "";
  const ticker = setInterval(() => {
    if (values.quiet) return;
    const line = progressLine(co.state());
    if (line !== last) console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
    last = line;
  }, 10_000);
  ticker.unref();

  await new Promise<void>((resolve) => {
    let stopping = false;
    process.on("SIGUSR2", () => co.rollback("manual rollback (gerra cutover rollback)"));
    const stop = () => {
      if (stopping) process.exit(130);
      stopping = true;
      clearInterval(ticker);
      console.log("\nStopping: finishing in-flight requests…");
      co.close().then(resolve, (err: Error) => {
        console.error(`gerra cutover: ${err.message}`);
        process.exitCode = 1;
        resolve();
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  const final = co.state();
  console.log(`\n${formatCutoverState(final, false)}`);
  if (typeof process.exitCode === "number") return process.exitCode;
  return final.phase === "rolled_back" ? 3 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") {
    console.log(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
    console.log(`gerra ${version} (tape format v${TAPE_VERSION})`);
    return 0;
  }
  try {
    if (command === "record") return await record(rest);
    if (command === "tapes") return await tapes(rest);
    if (command === "replay") return await replay(rest);
    if (command === "diff") return await diff(rest);
    if (command === "shadow") return await shadow(rest);
    if (command === "cutover") return await cutover(rest);
  } catch (err) {
    // parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes for bad flags.
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (err instanceof UsageError || code.startsWith("ERR_PARSE_ARGS")) {
      console.error(`gerra ${command}: ${(err as Error).message}`);
      return 2;
    }
    console.error(`gerra ${command}: ${(err as Error).message}`);
    return 1;
  }
  if (NOT_YET.has(command)) {
    console.error(`gerra ${command}: not implemented yet (see docs/PLAN.md)`);
    return 2;
  }
  console.error(`gerra: unknown command "${command}"\n\n${HELP}`);
  return 1;
}

// `pnpm gerra -- record …` passes the `--` through (pnpm 10), so drop a leading one.
const argv = process.argv.slice(2);
process.exitCode = await main(argv[0] === "--" ? argv.slice(1) : argv);
