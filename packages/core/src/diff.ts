/** A single difference between the original and candidate value at a JSON path. */
export interface Difference {
  /** JSON path like `$.items[2].total`. */
  path: string;
  kind: "changed" | "missing" | "added" | "type";
  original: unknown;
  candidate: unknown;
}

export interface DiffOptions {
  /** Exact JSON paths to skip (e.g. noise detected by replaying the original twice). */
  ignorePaths?: ReadonlySet<string>;
  /**
   * An original value equal to this string matches any candidate value. Used for fields masked at
   * record time (`[gerra:masked]`), whose real value is unknown.
   */
  maskedValue?: string;
  /**
   * Arrays at these paths are compared ignoring order (indices written as `[*]`, e.g. `$.orders[*].tags`).
   * Both sides are sorted by a canonical JSON form before comparing element by element.
   */
  unorderedPaths?: ReadonlySet<string>;
}

/** Collapse array indices so `$.lines[0].total` and `$.lines[3].total` name the same place. */
export function groupKey(path: string): string {
  return path.replace(/\[\d+\]/g, "[*]");
}

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Structural diff of two JSON values. Returns an empty array when identical.
 * Object key order is ignored; array order is significant unless the path is in `unorderedPaths`.
 */
export function diffJson(original: Json, candidate: Json, options: DiffOptions = {}): Difference[] {
  const out: Difference[] = [];
  const ctx: Ctx = {
    ignore: options.ignorePaths ?? new Set(),
    masked: options.maskedValue,
    unordered: options.unorderedPaths ?? new Set(),
    out,
  };
  walk(original, candidate, "$", ctx);
  return out;
}

interface Ctx {
  ignore: ReadonlySet<string>;
  masked: string | undefined;
  unordered: ReadonlySet<string>;
  out: Difference[];
}

function walk(a: Json, b: Json, path: string, ctx: Ctx): void {
  const { ignore, out } = ctx;
  if (ignore.has(path)) return;
  if (ctx.masked !== undefined && a === ctx.masked) return;

  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) {
    out.push({ path, kind: "type", original: a, candidate: b });
    return;
  }

  if (ta === "array") {
    let xs = a as Json[];
    let ys = b as Json[];
    if (ctx.unordered.size > 0 && ctx.unordered.has(groupKey(path))) {
      const sorted = (arr: Json[]) =>
        arr.map((v) => [canonicalJson(v), v] as const).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, v]) => v);
      xs = sorted(xs);
      ys = sorted(ys);
    }
    const len = Math.max(xs.length, ys.length);
    for (let i = 0; i < len; i++) {
      const p = `${path}[${i}]`;
      if (i >= ys.length) out.push({ path: p, kind: "missing", original: xs[i], candidate: undefined });
      else if (i >= xs.length) out.push({ path: p, kind: "added", original: undefined, candidate: ys[i] });
      else walk(xs[i] as Json, ys[i] as Json, p, ctx);
    }
    return;
  }

  if (ta === "object") {
    const oa = a as Record<string, Json>;
    const ob = b as Record<string, Json>;
    const keys = new Set([...Object.keys(oa), ...Object.keys(ob)]);
    for (const key of [...keys].sort()) {
      const p = /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
      if (ignore.has(p)) continue;
      if (ctx.masked !== undefined && oa[key] === ctx.masked) continue;
      if (!(key in ob)) out.push({ path: p, kind: "missing", original: oa[key], candidate: undefined });
      else if (!(key in oa)) out.push({ path: p, kind: "added", original: undefined, candidate: ob[key] });
      else walk(oa[key] as Json, ob[key] as Json, p, ctx);
    }
    return;
  }

  if (a !== b) out.push({ path, kind: "changed", original: a, candidate: b });
}

export type { Json };
