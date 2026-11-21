import { groupKey } from "./diff.js";
import { routeOf } from "./summary.js";

/**
 * Built-in normalizers: a changed JSON value that they consider equivalent is ignored, not reported.
 * They match on *format*, so a rewrite that emits `2026-11-20T10:00:00Z` where the original emitted
 * `2026-11-20T10:00:00.000Z` is still reported.
 */
export interface Normalizers {
  /** ISO-8601 date-times with the same format (digits may differ). Date-only values are not touched. */
  timestamps: boolean;
  /** UUIDs with the same letter case. */
  uuids: boolean;
  /** Values of id-named fields (`id`, `userId`, `user_id`) with the same JSON type. Off by default. */
  ids: boolean;
}

export const DEFAULT_NORMALIZERS: Readonly<Normalizers> = { timestamps: true, uuids: true, ids: false };

/** Why a difference was not counted. */
export type IgnoreReason = "config" | "noise" | keyof Normalizers;

/** Everything that decides how one route's responses are compared. */
export interface CompareRules {
  /** Response headers to compare. */
  headers?: readonly string[];
  /** Places to ignore, written like the report shows them: `body $.quoteId`, `header x-request-id`, `$..traceId`. */
  ignore?: readonly string[];
  /** Places learned as noise (same syntax as `ignore`). */
  noise?: readonly string[];
  normalizers?: Partial<Normalizers>;
  /** JSON paths of arrays to compare ignoring order, e.g. `$.tags` or `body $.orders[*].items`. */
  unordered?: readonly string[];
}

/** Compared by default: what a client actually depends on. Date, etag, server etc. are expected to differ. */
export const DEFAULT_COMPARED_HEADERS = ["content-type", "location"] as const;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Case matters: `orderId`, `order_id`, `order-ID` are ids, `paid` and `valid` are not.
const ID_KEY = /^(id|Id|ID)$|[a-z0-9](Id|ID)$|[_-](id|ID)$/;

function lastKey(path: string): string | null {
  const m = /\.([A-Za-z_$][\w$]*)$/.exec(path) ?? /\["((?:[^"\\]|\\.)*)"\]$/.exec(path);
  return m?.[1] ?? null;
}

/** Which normalizer, if any, treats a changed body value as equivalent. `at` is the mismatch location (`body $.x`). */
export function normalizedBy(at: string, original: unknown, candidate: unknown, normalizers: Partial<Normalizers> = {}): keyof Normalizers | null {
  const n = { ...DEFAULT_NORMALIZERS, ...normalizers };
  if (!at.startsWith("body $") && !at.startsWith("effects $")) return null;
  if (typeof original === "string" && typeof candidate === "string") {
    if (n.timestamps && ISO_DATETIME.test(original) && ISO_DATETIME.test(candidate)) {
      if (original.replace(/\d/g, "0") === candidate.replace(/\d/g, "0")) return "timestamps";
    }
    if (n.uuids && UUID.test(original) && UUID.test(candidate)) {
      const lower = (s: string) => s === s.toLowerCase();
      if (lower(original) === lower(candidate)) return "uuids";
    }
  }
  if (n.ids && typeof original === typeof candidate && (typeof original === "number" || typeof original === "string")) {
    const key = lastKey(at.slice(at.indexOf(" ") + 1));
    if (key !== null && ID_KEY.test(key)) return "ids";
  }
  return null;
}

/** `$.x` is shorthand for `body $.x`; header names are case-insensitive. */
export function normalizeRule(rule: string): string {
  const r = rule.trim().replace(/\s+/g, " ");
  if (r.startsWith("$")) return `body ${r}`;
  if (r.toLowerCase().startsWith("header ")) return r.toLowerCase();
  return r;
}

const ruleCache = new Map<string, RegExp>();

function ruleRegex(rule: string): RegExp {
  let re = ruleCache.get(rule);
  if (!re) {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // `..` means "at any depth": `$..traceId` matches `$.traceId` and `$.spans[*].traceId`.
    const body = normalizeRule(rule).split("..").map(escape).join(".*\\.");
    // A rule also covers everything below it: `body $.meta` ignores `body $.meta.took`.
    re = new RegExp(`^${body}(?:[.\\[ ].*)?$`);
    ruleCache.set(rule, re);
  }
  return re;
}

/** Whether an ignore/noise rule covers a mismatch location (with or without concrete array indices). */
export function ruleMatches(rule: string, at: string): boolean {
  const re = ruleRegex(rule);
  return re.test(at) || re.test(groupKey(at));
}

/** Noise learned by replaying the original twice: per route, the places whose value changed between runs. */
export interface NoiseProfile {
  learnedFrom: string;
  learnedAt: string;
  /** Exchanges that contributed (both original requests succeeded). */
  samples: number;
  routes: Record<string, string[]>;
}

/** Collect, per route, the (grouped) places where two responses from the original differ. */
export function noiseFromMismatches(observations: readonly { route: string; at: readonly string[] }[]): Record<string, string[]> {
  const byRoute = new Map<string, Set<string>>();
  for (const { route, at } of observations) {
    if (at.length === 0) continue;
    let set = byRoute.get(route);
    if (!set) byRoute.set(route, (set = new Set()));
    for (const a of at) set.add(groupKey(a));
  }
  return Object.fromEntries([...byRoute].sort(([a], [b]) => a.localeCompare(b)).map(([route, set]) => [route, [...set].sort()]));
}

// ---------------------------------------------------------------------------------------------
// gerra.config.json

export interface RouteConfig {
  ignore?: string[];
  unordered?: string[];
  normalizers?: Partial<Normalizers>;
  /** Replay this route even if its method isn't idempotent (same as `--unsafe-methods "<route>"`). */
  replay?: boolean;
}

export interface GerraConfig {
  /**
   * Shell command run before every replay to put the services back in the state the tape was recorded
   * in (reseed a database, restore a snapshot). Same as `gerra replay --reset "<cmd>"`.
   */
  reset?: string;
  mask?: { headers?: string[]; fields?: string[] };
  compare?: { headers?: string[] };
  ignore?: string[];
  unordered?: string[];
  normalizers?: Partial<Normalizers>;
  /** Keyed by route as `gerra tapes` shows it, e.g. `POST /cart/price` or `GET /products/:id`. */
  routes?: Record<string, RouteConfig>;
}

class ConfigError extends Error {}

function fail(where: string, message: string): never {
  throw new ConfigError(`${where}: ${message}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkKeys(v: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(v)) {
    if (!allowed.includes(key)) fail(`${where}.${key}`, `unknown key (expected one of: ${allowed.join(", ")})`);
  }
}

function stringList(v: unknown, where: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) fail(where, "must be an array of non-empty strings");
  return v as string[];
}

function normalizersOf(v: unknown, where: string): Partial<Normalizers> | undefined {
  if (v === undefined) return undefined;
  if (!isObject(v)) fail(where, "must be an object");
  checkKeys(v, Object.keys(DEFAULT_NORMALIZERS), where);
  for (const [k, b] of Object.entries(v)) if (typeof b !== "boolean") fail(`${where}.${k}`, "must be true or false");
  return v as Partial<Normalizers>;
}

/** Canonical form of a route key: `post  /cart/price` and `GET /products/42` → `POST /cart/price`, `GET /products/:id`. */
export function normalizeRouteKey(key: string): string {
  const [method = "", ...rest] = key.trim().split(/\s+/);
  const path = rest.join(" ");
  if (!path.startsWith("/")) throw new ConfigError(`routes["${key}"]: expected "<METHOD> /path", e.g. "POST /cart/price"`);
  return routeOf(method, path);
}

/** Parse and validate `gerra.config.json`. Unknown keys are errors, so typos don't silently do nothing. */
export function parseConfig(text: string, source = "gerra.config.json"): GerraConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: invalid JSON: ${(err as Error).message}`);
  }
  try {
    if (!isObject(raw)) fail("config", "must be a JSON object");
    checkKeys(raw, ["$schema", "reset", "mask", "compare", "ignore", "unordered", "normalizers", "routes"], "config");
    const config: GerraConfig = {};
    if (raw.reset !== undefined) {
      if (typeof raw.reset !== "string" || raw.reset.trim() === "") fail("reset", "must be a non-empty shell command");
      config.reset = raw.reset;
    }
    if (raw.mask !== undefined) {
      if (!isObject(raw.mask)) fail("mask", "must be an object");
      checkKeys(raw.mask, ["headers", "fields"], "mask");
      config.mask = {};
      const headers = stringList(raw.mask.headers, "mask.headers");
      const fields = stringList(raw.mask.fields, "mask.fields");
      if (headers) config.mask.headers = headers;
      if (fields) config.mask.fields = fields;
    }
    if (raw.compare !== undefined) {
      if (!isObject(raw.compare)) fail("compare", "must be an object");
      checkKeys(raw.compare, ["headers"], "compare");
      const headers = stringList(raw.compare.headers, "compare.headers");
      config.compare = headers ? { headers } : {};
    }
    const ignore = stringList(raw.ignore, "ignore");
    const unordered = stringList(raw.unordered, "unordered");
    const normalizers = normalizersOf(raw.normalizers, "normalizers");
    if (ignore) config.ignore = ignore;
    if (unordered) config.unordered = unordered;
    if (normalizers) config.normalizers = normalizers;
    if (raw.routes !== undefined) {
      if (!isObject(raw.routes)) fail("routes", "must be an object keyed by route");
      config.routes = {};
      for (const [key, value] of Object.entries(raw.routes)) {
        const where = `routes["${key}"]`;
        if (!isObject(value)) fail(where, "must be an object");
        checkKeys(value, ["ignore", "unordered", "normalizers", "replay"], where);
        const rc: RouteConfig = {};
        const ri = stringList(value.ignore, `${where}.ignore`);
        const ru = stringList(value.unordered, `${where}.unordered`);
        const rn = normalizersOf(value.normalizers, `${where}.normalizers`);
        if (ri) rc.ignore = ri;
        if (ru) rc.unordered = ru;
        if (rn) rc.normalizers = rn;
        if (value.replay !== undefined) {
          if (typeof value.replay !== "boolean") fail(`${where}.replay`, "must be true or false");
          rc.replay = value.replay;
        }
        const route = normalizeRouteKey(key);
        if (config.routes[route]) fail(where, `duplicates another entry for ${route}`);
        config.routes[route] = rc;
      }
    }
    return config;
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`${source}: ${err.message}`);
    throw err;
  }
}

/** The rules for one route: global config, then the route's own entry, plus learned noise. */
export function rulesFor(config: GerraConfig, route: string, noise?: NoiseProfile | null, extraHeaders: readonly string[] = []): CompareRules {
  const rc = config.routes?.[route] ?? {};
  return {
    headers: [...new Set([...DEFAULT_COMPARED_HEADERS, ...(config.compare?.headers ?? []), ...extraHeaders].map((h) => h.toLowerCase()))],
    ignore: [...(config.ignore ?? []), ...(rc.ignore ?? [])],
    noise: noise?.routes[route] ?? [],
    unordered: [...(config.unordered ?? []), ...(rc.unordered ?? [])],
    normalizers: { ...DEFAULT_NORMALIZERS, ...config.normalizers, ...rc.normalizers },
  };
}

/** Routes the config opts in to replaying despite a non-idempotent method. */
export function replayableRoutes(config: GerraConfig): string[] {
  return Object.entries(config.routes ?? {})
    .filter(([, rc]) => rc.replay === true)
    .map(([route]) => route);
}
